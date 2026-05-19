import { geocodeDetailed } from "./geocode.js";
import { buildCacheKey, cacheGetJson, cachePutJson } from "./cache.js";

function hasExplicitNowRequest(text) {
  const q = String(text || "").toLowerCase();
  return (
    q.includes("ahora") ||
    q.includes("ahorita") ||
    q.includes("en este momento") ||
    q.includes("ya mismo") ||
    q.includes("salir ya") ||
    q.includes("inmediatamente")
  );
}

function buildPlanningDepartureTime(localDate) {
  const base = localDate ? new Date(`${localDate}T00:00:00`) : new Date();
  if (Number.isNaN(base.getTime())) return new Date(Date.now() + 2 * 86400000).toISOString();
  base.setDate(base.getDate() + 2);
  base.setHours(9, 0, 0, 0);
  return base.toISOString();
}

async function getRoute(from, to, mode = "driving", env = null, departureTime = null) {
  try {
    const modeMap = { driving: "DRIVE", walking: "WALK", transit: "TRANSIT" };
    const travelMode = modeMap[mode] || "DRIVE";
    const body = {
      origin: { location: { latLng: { latitude: from.lat, longitude: from.lon } } },
      destination: { location: { latLng: { latitude: to.lat, longitude: to.lon } } },
      travelMode
    };
    if (departureTime && (travelMode === "DRIVE" || travelMode === "TRANSIT")) {
      body.departureTime = departureTime;
    }
    if (travelMode === "DRIVE") body.routingPreference = "TRAFFIC_AWARE";
    const fieldMask = travelMode === "TRANSIT"
      ? "routes.duration,routes.distanceMeters,routes.legs.steps.transitDetails,routes.legs.steps.staticDuration"
      : "routes.duration,routes.distanceMeters";

    const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": env?.GOOGLE_MAPS_KEY || "",
        "X-Goog-FieldMask": fieldMask
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.routes?.length) return null;

    const route = data.routes[0];
    const durationSeconds = parseInt(route.duration) || 0;
    const distanceMeters = route.distanceMeters || 0;
    const result = { mode, distance_km: distanceMeters / 1000, duration_min: durationSeconds / 60 };

    if (travelMode === "TRANSIT") {
      const steps = (route.legs?.[0]?.steps || []).filter(s => s.transitDetails).map(s => ({
        line: s.transitDetails.transitLine?.name || s.transitDetails.transitLine?.nameShort || null,
        vehicle: s.transitDetails.transitLine?.vehicle?.type || null,
        from: s.transitDetails.stopDetails?.departureStop?.name || null,
        to: s.transitDetails.stopDetails?.arrivalStop?.name || null,
        stops: s.transitDetails.stopCount || null,
        duration_min: s.staticDuration ? Math.round(parseInt(s.staticDuration) / 60) : null
      }));
      if (steps.length) result.steps = steps;
    }

    return result;
  } catch (_) {
    return null;
  }
}

function buildGoogleMapsLink(origin, destination, mode = null, departureTime = null) {
  if (!destination) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(origin || "")}`;
  let url = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin || "")}&destination=${encodeURIComponent(destination || "")}`;
  if (mode) url += `&travelmode=${encodeURIComponent(mode)}`;
  if (departureTime && (mode === "driving" || mode === "transit")) {
    const unixSeconds = Math.floor(new Date(departureTime).getTime() / 1000);
    if (Number.isFinite(unixSeconds) && unixSeconds > 0) {
      url += `&departure_time=${unixSeconds}`;
    }
  }
  return url;
}

export async function enrichWithTransportInfo(tripJson, analysis, env = null) {
  if (analysis.tool_needed !== "route" && analysis.intent !== "route") return null;
  const tripId = analysis.trip_id || "unknown";
  const explicitNow = hasExplicitNowRequest(analysis.original_question || "");
  const routeTimeBasis = explicitNow ? "realtime_now" : "planning_daytime";
  const departureTime = explicitNow ? new Date().toISOString() : buildPlanningDepartureTime(analysis.local_date || null);
  const origin = analysis.origin_query || null;
  const destination = analysis.destination_query || null;
  const requestedMode = analysis.route_mode || "all";
  const cacheKey = buildCacheKey("route", [tripId, origin || "", destination || "", requestedMode, analysis.route_direction || "unknown", routeTimeBasis, explicitNow ? "now" : (analysis.local_date || ""), "link-v2"]);
  const cached = await cacheGetJson(env, cacheKey);
  if (cached) return { ...cached, cache_hit: true };

  if (!origin && !destination) {
    return { type: "route_missing_origin_destination", route_direction: analysis.route_direction || "unknown", route_mode: requestedMode, origin: null, destination: null, place_name: analysis.place_name || null, city: analysis.city || null, note: "No se recibieron origen y destino suficientes para calcular una ruta.", route_time_basis: routeTimeBasis, route_departure_time: departureTime, cache_hit: false };
  }
  if (origin && !destination) {
    return { type: "route_without_destination", route_direction: analysis.route_direction || "unknown", route_mode: requestedMode, origin, destination: null, place_name: analysis.place_name || null, city: analysis.city || null, note: "El usuario pidió movilidad o alternativas de transporte, pero no indicó un destino concreto. No se puede calcular distancia o duración exacta sin destino.", maps_link: buildGoogleMapsLink(origin, null), route_time_basis: routeTimeBasis, route_departure_time: departureTime, cache_hit: false };
  }
  if (!origin && destination) {
    return { type: "route_without_origin", route_direction: analysis.route_direction || "unknown", route_mode: requestedMode, origin: null, destination, place_name: analysis.place_name || null, city: analysis.city || null, note: "Hay destino, pero falta origen para calcular la ruta.", maps_link: buildGoogleMapsLink(destination, null), route_time_basis: routeTimeBasis, route_departure_time: departureTime, cache_hit: false };
  }

  const originGeo = await geocodeDetailed(origin, { city: analysis.city || null, country: null }, env);
  const destinationGeo = await geocodeDetailed(destination, { city: analysis.city || null, country: null }, env);
  const originCoords = originGeo.result;
  const destinationCoords = destinationGeo.result;

  if (!originCoords || !destinationCoords) {
    const geocodeError = [
      !originCoords ? `origin: ${originGeo.error || originGeo.status}` : null,
      !destinationCoords ? `destination: ${destinationGeo.error || destinationGeo.status}` : null
    ].filter(Boolean).join(" | ");
    const payload = {
      type: "geocoding_failed",
      route_direction: analysis.route_direction || "unknown",
      route_mode: requestedMode,
      origin,
      destination,
      place_name: analysis.place_name || null,
      city: analysis.city || null,
      origin_geocoded: Boolean(originCoords),
      destination_geocoded: Boolean(destinationCoords),
      geocode_origin_display_name: originCoords?.display_name || null,
      geocode_destination_display_name: destinationCoords?.display_name || null,
      geocode_origin_attempted_query: originGeo.attempted_queries.join(" | ") || null,
      geocode_destination_attempted_query: destinationGeo.attempted_queries.join(" | ") || null,
      geocode_origin_error: !originCoords ? originGeo.error || originGeo.status || null : null,
      geocode_destination_error: !destinationCoords ? destinationGeo.error || destinationGeo.status || null : null,
      geocode_error: geocodeError || null,
      maps_link: buildGoogleMapsLink(origin, destination, requestedMode === "all" ? null : requestedMode, departureTime),
      route_time_basis: routeTimeBasis,
      route_departure_time: departureTime,
      cache_hit: false
    };
    await cachePutJson(env, cacheKey, payload, 6 * 3600);
    return payload;
  }

  const [walkingRoute, drivingRoute, transitRaw] = await Promise.all([
    getRoute(originCoords, destinationCoords, "walking", env, departureTime),
    getRoute(originCoords, destinationCoords, "driving", env, departureTime),
    getRoute(originCoords, destinationCoords, "transit", env, departureTime)
  ]);

  const transitRoute = transitRaw && drivingRoute && transitRaw.duration_min > drivingRoute.duration_min * 3 ? null : transitRaw;
  const options = {
    walking: walkingRoute ? { mode: "walking", duration_min: Math.round(walkingRoute.duration_min), distance_km: Math.round(walkingRoute.distance_km * 10) / 10, maps_link: buildGoogleMapsLink(origin, destination, "walking", departureTime) } : null,
    driving: drivingRoute ? { mode: "driving", duration_min: Math.round(drivingRoute.duration_min), distance_km: Math.round(drivingRoute.distance_km * 10) / 10, maps_link: buildGoogleMapsLink(origin, destination, "driving", departureTime) } : null,
    transit: transitRoute ? { mode: "transit", duration_min: Math.round(transitRoute.duration_min), distance_km: Math.round(transitRoute.distance_km * 10) / 10, maps_link: buildGoogleMapsLink(origin, destination, "transit", departureTime), ...(transitRoute.steps?.length ? { steps: transitRoute.steps } : {}) } : { mode: "transit", duration_min: null, distance_km: null, maps_link: buildGoogleMapsLink(origin, destination, "transit", departureTime), note: "No se encontró ruta de transporte público; consulta opciones en Google Maps." }
  };

  let routeError = null;
  if (requestedMode === "walking" && !options.walking) routeError = "walking_route_not_found";
  else if (requestedMode === "driving" && !options.driving) routeError = "driving_route_not_found";
  else if (requestedMode === "transit" && !transitRoute) routeError = "transit_route_not_found";
  else if (requestedMode === "all" && !options.walking && !options.driving && !transitRoute) routeError = "route_not_found";

  if (routeError) {
    const payload = {
      type: "route_calculation_failed",
      route_direction: analysis.route_direction || "unknown",
      route_mode: requestedMode,
      origin,
      destination,
      place_name: analysis.place_name || null,
      city: analysis.city || null,
      duration_min: null,
      distance_km: null,
      maps_link: buildGoogleMapsLink(origin, destination, requestedMode === "all" ? null : requestedMode, departureTime),
      geocode_origin_display_name: originCoords.display_name || null,
      geocode_destination_display_name: destinationCoords.display_name || null,
      geocode_origin_attempted_query: originGeo.attempted_queries.join(" | ") || originCoords.attempted_query || null,
      geocode_destination_attempted_query: destinationGeo.attempted_queries.join(" | ") || destinationCoords.attempted_query || null,
      geocode_origin_error: null,
      geocode_destination_error: null,
      geocode_error: null,
      route_error: routeError,
      options,
      route_time_basis: routeTimeBasis,
      route_departure_time: departureTime,
      cache_hit: false
    };
    await cachePutJson(env, cacheKey, payload, 6 * 3600);
    return payload;
  }

  let primary = null;
  if (requestedMode === "walking") primary = options.walking;
  else if (requestedMode === "driving") primary = options.driving;
  else if (requestedMode === "transit") primary = options.transit;
  else primary = options.driving || options.walking || (transitRoute ? options.transit : null);

  const payload = {
    type: "calculated_route",
    route_direction: analysis.route_direction || "unknown",
    route_mode: requestedMode,
    origin,
    destination,
    place_name: analysis.place_name || null,
    city: analysis.city || null,
    duration_min: primary?.duration_min || null,
    distance_km: primary?.distance_km || null,
    maps_link: primary?.maps_link || buildGoogleMapsLink(origin, destination, requestedMode === "all" ? null : requestedMode, departureTime),
    geocode_origin_display_name: originCoords.display_name || null,
    geocode_destination_display_name: destinationCoords.display_name || null,
    geocode_origin_lat: originCoords.lat || null,
    geocode_origin_lon: originCoords.lon || null,
    geocode_destination_lat: destinationCoords.lat || null,
    geocode_destination_lon: destinationCoords.lon || null,
    options,
    route_time_basis: routeTimeBasis,
    route_departure_time: departureTime,
    geocode_origin_attempted_query: originGeo.attempted_queries.join(" | ") || originCoords.attempted_query || null,
    geocode_destination_attempted_query: destinationGeo.attempted_queries.join(" | ") || destinationCoords.attempted_query || null,
    geocode_origin_error: null,
    geocode_destination_error: null,
    geocode_error: null,
    cache_hit: false
  };
  await cachePutJson(env, cacheKey, payload, 12 * 3600);
  return payload;
}
