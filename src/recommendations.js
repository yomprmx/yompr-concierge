import { normalizeText } from "./utils.js";
import { geocode } from "./geocode.js";
import { buildCacheKey, cacheGetJson, cachePutJson } from "./cache.js";

const PRICE_LEVEL_MAP = {
  "PRICE_LEVEL_FREE": "gratuito",
  "PRICE_LEVEL_INEXPENSIVE": "económico ($)",
  "PRICE_LEVEL_MODERATE": "precio moderado ($$)",
  "PRICE_LEVEL_EXPENSIVE": "caro ($$$)",
  "PRICE_LEVEL_VERY_EXPENSIVE": "muy caro ($$$$)"
};

export async function searchPlacesRecommendations(analysis, tripJson, env) {
  if (!env?.GOOGLE_MAPS_KEY) return null;
  const tripId = analysis.trip_id || "unknown";
  const query = analysis.recommendation_query;
  if (!query) return null;
  const userLocation = analysis.user_location || null;
  const userLocationBucket = getUserLocationBucket(userLocation);
  const cacheKey = buildCacheKey("places", [
    tripId,
    analysis.city || "",
    query,
    analysis.price_preference || "",
    analysis.localDate || "",
    userLocationBucket
  ]);
  const cached = await cacheGetJson(env, cacheKey);
  if (cached) return { ...cached, cache_hit: true };

  let locationBias = null;
  let locationSource = "hotel";
  let hotelAnchor = null;
  let hotelAnchorGeo = null;
  const city = analysis.city ? normalizeText(analysis.city) : null;

  if (
    userLocation &&
    Number.isFinite(userLocation.lat) &&
    Number.isFinite(userLocation.lon)
  ) {
    locationBias = {
      circle: {
        center: { latitude: userLocation.lat, longitude: userLocation.lon },
        radius: 2200
      }
    };
    locationSource = "user_location";
  }

  if (!locationBias && city) {
    const hotels = tripJson.hotelVouchers || [];
    const cityHotel = hotels.find(h =>
      normalizeText(h.accommodationAddress || "").includes(city) ||
      normalizeText(h.accommodationName || "").includes(city) ||
      normalizeText(JSON.stringify(h)).includes(city)
    );

    if (cityHotel) {
      hotelAnchor = {
        name: cityHotel.accommodationName || cityHotel.hotelName || cityHotel.name || null,
        address: cityHotel.accommodationAddress || cityHotel.address || null
      };
      const hotelQuery = [cityHotel.accommodationName, cityHotel.accommodationAddress].filter(Boolean).join(", ");
      if (hotelQuery) {
        try {
          hotelAnchorGeo = await geocode(hotelQuery, { city: analysis.city }, env);
          if (hotelAnchorGeo?.lat && hotelAnchorGeo?.lon) {
            locationBias = { circle: { center: { latitude: hotelAnchorGeo.lat, longitude: hotelAnchorGeo.lon }, radius: 2000 } };
            locationSource = "hotel";
          }
        } catch (_) {}
      }
    }
  }

  try {
    const body = { textQuery: query, maxResultCount: 8, languageCode: "es" };
    if (locationBias) body.locationBias = locationBias;
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": env.GOOGLE_MAPS_KEY,
        "X-Goog-FieldMask": [
          "places.displayName",
          "places.formattedAddress",
          "places.rating",
          "places.userRatingCount",
          "places.priceLevel",
          "places.editorialSummary",
          "places.regularOpeningHours",
          "places.currentOpeningHours",
          "places.googleMapsUri",
          "places.primaryType"
        ].join(",")
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return { places: [], query, bias_used: Boolean(locationBias), error: `Places API ${res.status}: ${errText}` };
    }

    const data = await res.json();
    if (!data.places?.length) return { places: [], query, bias_used: Boolean(locationBias), error: null };
    const placesRaw = data.places.slice(0, 6).map(p => ({
      name: p.displayName?.text || null,
      address: p.formattedAddress || null,
      rating: p.rating ? Math.round(p.rating * 10) / 10 : null,
      review_count: p.userRatingCount || null,
      price_level: PRICE_LEVEL_MAP[p.priceLevel] || null,
      description: p.editorialSummary?.text || null,
      type: p.primaryType || null,
      opening_hours: p.regularOpeningHours?.weekdayDescriptions || p.currentOpeningHours?.weekdayDescriptions || null,
      open_now: typeof p.currentOpeningHours?.openNow === "boolean" ? p.currentOpeningHours.openNow : null,
      maps_link: p.googleMapsUri || null
    }));

    const nextDayRisk = detectNextDayRisk(
      tripJson,
      analysis.localDate,
      analysis.date_reference,
      analysis.original_question
    );
    const places = await validatePlacesOperationally(
      placesRaw,
      analysis,
      env,
      hotelAnchor,
      hotelAnchorGeo,
      nextDayRisk,
      locationSource,
      userLocation
    );

    const payload = {
      places,
      query,
      bias_used: Boolean(locationBias),
      error: null,
      operational_validation: {
        hotel_anchor: hotelAnchor || null,
        next_day_risk: nextDayRisk,
        location_source: locationSource
      }
    };
    await cachePutJson(env, cacheKey, payload, 2 * 3600);
    return payload;
  } catch (e) {
    return { places: [], query, bias_used: Boolean(locationBias), error: String(e) };
  }
}

function getUserLocationBucket(userLocation) {
  if (
    !userLocation ||
    !Number.isFinite(userLocation.lat) ||
    !Number.isFinite(userLocation.lon)
  ) return "no_user_location";
  const lat = Math.round(userLocation.lat * 100) / 100;
  const lon = Math.round(userLocation.lon * 100) / 100;
  return `user:${lat},${lon}`;
}

function parseDateMaybe(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function hasExplicitTemporalReference(dateReference, originalQuestion) {
  const ref = normalizeText(dateReference || "");
  const q = normalizeText(originalQuestion || "");
  if (ref) return true;
  if (q.includes("hoy") || q.includes("mañana") || q.includes("manana")) return true;
  if (q.includes("esta noche") || q.includes("hoy en la noche")) return true;
  return false;
}

function detectNextDayRisk(tripJson, localDate, dateReference, originalQuestion) {
  if (!hasExplicitTemporalReference(dateReference, originalQuestion)) {
    return { level: "unknown", reason: "Sin referencia temporal explícita." };
  }
  if (!localDate) return { level: "unknown", reason: null };

  const day = new Date(`${localDate}T00:00:00`);
  if (Number.isNaN(day.getTime())) return { level: "unknown", reason: null };
  const nextDayStart = new Date(day);
  nextDayStart.setDate(nextDayStart.getDate() + 1);
  const nextDayEnd = new Date(nextDayStart);
  nextDayEnd.setDate(nextDayEnd.getDate() + 1);

  let hasEarlyFlight = false;
  let hasEarlyTransferOrActivity = false;

  for (const reservation of tripJson.flightReservations || []) {
    for (const segment of reservation.segments || []) {
      const dep = parseDateMaybe(segment.departureDateTime || segment.departureDate);
      if (!dep) continue;
      if (dep >= nextDayStart && dep < nextDayEnd && dep.getHours() < 10) hasEarlyFlight = true;
    }
  }

  for (const service of tripJson.serviceBookings || []) {
    if (service.category === "transfer" && service.transfer) {
      const dateOnly = String(service.transfer.date || "").split("T")[0];
      const time = service.transfer.pickupTime || "00:00";
      const dt = parseDateMaybe(`${dateOnly}T${time}:00`);
      if (dt && dt >= nextDayStart && dt < nextDayEnd && dt.getHours() < 10) hasEarlyTransferOrActivity = true;
    }
    if (service.category === "activity" && service.activity) {
      const dateOnly = String(service.activity.date || "").split("T")[0];
      const time = service.activity.time || "00:00";
      const dt = parseDateMaybe(`${dateOnly}T${time}:00`);
      if (dt && dt >= nextDayStart && dt < nextDayEnd && dt.getHours() < 10) hasEarlyTransferOrActivity = true;
    }
  }

  if (hasEarlyFlight) return { level: "high", reason: "Hay vuelo temprano al día siguiente." };
  if (hasEarlyTransferOrActivity) return { level: "medium", reason: "Hay actividad o traslado temprano al día siguiente." };
  return { level: "low", reason: "No hay eventos tempranos detectados al día siguiente." };
}

async function getRouteMinutes(from, to, mode, env) {
  try {
    const modeMap = { driving: "DRIVE", walking: "WALK" };
    const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": env?.GOOGLE_MAPS_KEY || "",
        "X-Goog-FieldMask": "routes.duration"
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: from.lat, longitude: from.lon } } },
        destination: { location: { latLng: { latitude: to.lat, longitude: to.lon } } },
        travelMode: modeMap[mode] || "DRIVE"
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const seconds = parseInt(data?.routes?.[0]?.duration) || 0;
    if (!seconds) return null;
    return Math.round(seconds / 60);
  } catch (_) {
    return null;
  }
}

function haversineKm(from, to) {
  if (!from?.lat || !from?.lon || !to?.lat || !to?.lon) return null;
  const toRad = v => (v * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(to.lat - from.lat);
  const dLon = toRad(to.lon - from.lon);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function validatePlacesOperationally(
  places,
  analysis,
  env,
  hotelAnchor,
  hotelAnchorGeo,
  nextDayRisk,
  locationSource,
  userLocation
) {
  if (!Array.isArray(places) || !places.length) return [];
  const hasHotelAnchor = hotelAnchorGeo?.lat && hotelAnchorGeo?.lon;
  const hasUserLocation = userLocation?.lat && userLocation?.lon;

  if (!hasHotelAnchor && !hasUserLocation) {
    return places.map(p => ({
      ...p,
      operational: {
        validated: false,
        location_source: locationSource || "unknown",
        open_now: p.open_now,
        travel_from_hotel_walking_min: null,
        travel_from_hotel_driving_min: null,
        travel_from_user_walking_min: null,
        travel_from_user_driving_min: null,
        distance_from_user_km: null,
        next_day_risk: nextDayRisk
      }
    }));
  }

  const enriched = [];
  for (const place of places) {
    let placeGeo = null;
    try {
      const query = [place.name, place.address, analysis.city].filter(Boolean).join(", ");
      placeGeo = await geocode(query, { city: analysis.city }, env);
    } catch (_) {}

    const hotelWalkingMin = (placeGeo && hasHotelAnchor) ? await getRouteMinutes(hotelAnchorGeo, placeGeo, "walking", env) : null;
    const hotelDrivingMin = (placeGeo && hasHotelAnchor) ? await getRouteMinutes(hotelAnchorGeo, placeGeo, "driving", env) : null;
    const userWalkingMin = (placeGeo && hasUserLocation) ? await getRouteMinutes(userLocation, placeGeo, "walking", env) : null;
    const userDrivingMin = (placeGeo && hasUserLocation) ? await getRouteMinutes(userLocation, placeGeo, "driving", env) : null;
    const userDistanceKm = (placeGeo && hasUserLocation) ? haversineKm(userLocation, placeGeo) : null;

    const distancePenalty =
      locationSource === "user_location"
        ? (userWalkingMin != null ? Math.min(userWalkingMin / 2.5, 18) : (userDistanceKm != null ? Math.min(userDistanceKm * 2.2, 18) : 8))
        : (hotelWalkingMin != null ? Math.min(hotelWalkingMin / 3, 12) : 6);

    const score =
      (place.rating || 0) * 10 +
      Math.min((place.review_count || 0) / 100, 20) +
      (place.open_now === true ? 10 : 0) -
      distancePenalty -
      (nextDayRisk.level === "high" && hotelWalkingMin != null && hotelWalkingMin > 25 ? 8 : 0);

    enriched.push({
      ...place,
      operational: {
        validated: true,
        location_source: locationSource || "hotel",
        hotel_anchor_name: hotelAnchor?.name || null,
        open_now: place.open_now,
        travel_from_hotel_walking_min: hotelWalkingMin,
        travel_from_hotel_driving_min: hotelDrivingMin,
        travel_from_user_walking_min: userWalkingMin,
        travel_from_user_driving_min: userDrivingMin,
        distance_from_user_km: userDistanceKm != null ? Math.round(userDistanceKm * 100) / 100 : null,
        next_day_risk: nextDayRisk,
        score: Math.round(score * 10) / 10
      }
    });
  }

  enriched.sort((a, b) => (b.operational?.score || 0) - (a.operational?.score || 0));
  return enriched;
}
