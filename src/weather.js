import { geocodeDetailed } from "./geocode.js";
import { normalizeText } from "./utils.js";

function firstNonEmpty(values) {
  for (const value of values) {
    if (value && String(value).trim()) return String(value).trim();
  }
  return null;
}

function findHotelByCity(tripJson, cityRaw) {
  const cityNorm = normalizeText(cityRaw || "");
  if (!cityNorm) return null;

  for (const hotel of tripJson.hotelVouchers || []) {
    const hotelCity = normalizeText(
      hotel.city || hotel.destination || hotel.accommodationCity || ""
    );
    if (hotelCity && hotelCity.includes(cityNorm)) return hotel;
  }

  return null;
}

function buildWeatherCandidates(tripJson, analysis) {
  const candidates = [];
  const city = analysis.city || null;
  const hotelInCity = findHotelByCity(tripJson, city);

  const hotelAddress = firstNonEmpty([
    hotelInCity?.accommodationAddress,
    hotelInCity?.address
  ]);
  const hotelName = firstNonEmpty([
    hotelInCity?.accommodationName,
    hotelInCity?.hotelName,
    hotelInCity?.name
  ]);

  if (hotelAddress && city) candidates.push(`${hotelAddress}, ${city}`);
  if (hotelName && city) candidates.push(`${hotelName}, ${city}`);
  if (analysis.place_name && city) candidates.push(`${analysis.place_name}, ${city}`);
  if (analysis.place_name) candidates.push(analysis.place_name);
  if (city) candidates.push(city);

  const tripDestination = firstNonEmpty([tripJson.trip?.destination]);
  if (tripDestination) {
    const firstDestination = tripDestination.split(",")[0]?.trim();
    if (firstDestination) candidates.push(firstDestination);
  }

  const unique = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const norm = normalizeText(candidate);
    if (!norm) continue;
    if (!unique.some(x => normalizeText(x) === norm)) unique.push(candidate);
  }
  return unique;
}

function parseWeatherSnapshot(payload) {
  if (!payload || typeof payload !== "object") return null;

  const speed = payload.wind?.speed;
  const windSpeed =
    typeof speed?.value === "number"
      ? speed.value
      : (typeof speed === "number" ? speed : null);
  const windUnit =
    speed?.unit || payload.wind?.speedUnit || null;

  return {
    current_time: payload.currentTime || null,
    timezone: payload.timeZone?.id || null,
    is_daytime: typeof payload.isDaytime === "boolean" ? payload.isDaytime : null,
    condition: payload.weatherCondition?.description?.text || null,
    condition_type: payload.weatherCondition?.type || null,
    temperature_c: payload.temperature?.degrees ?? null,
    feels_like_c: payload.feelsLikeTemperature?.degrees ?? null,
    humidity_percent: payload.relativeHumidity ?? null,
    uv_index: payload.uvIndex ?? null,
    precipitation_probability_percent:
      payload.precipitation?.probability?.percent ?? null,
    wind_speed: windSpeed,
    wind_speed_unit: windUnit
  };
}

export async function enrichWithWeatherInfo(tripJson, analysis, env = null) {
  if (analysis.tool_needed !== "weather" && analysis.intent !== "weather") return null;
  if (!env?.GOOGLE_MAPS_KEY) {
    return { type: "weather_error", error: "GOOGLE_MAPS_KEY no configurada" };
  }

  const candidates = buildWeatherCandidates(tripJson, analysis);
  if (!candidates.length) {
    return {
      type: "weather_error",
      error: "No se pudo inferir ubicación para consultar clima",
      attempted_queries: []
    };
  }

  let geocodeInfo = null;
  for (const candidate of candidates) {
    const geocoded = await geocodeDetailed(candidate, { city: analysis.city || null }, env);
    if (geocoded?.result?.lat && geocoded?.result?.lon) {
      geocodeInfo = geocoded;
      break;
    }
  }

  if (!geocodeInfo?.result) {
    return {
      type: "weather_error",
      error: "No se pudo geocodificar ubicación para clima",
      attempted_queries: candidates
    };
  }

  const lat = geocodeInfo.result.lat;
  const lon = geocodeInfo.result.lon;
  const params = new URLSearchParams({
    key: env.GOOGLE_MAPS_KEY,
    "location.latitude": String(lat),
    "location.longitude": String(lon),
    unitsSystem: "METRIC",
    languageCode: "es"
  });

  try {
    const res = await fetch(`https://weather.googleapis.com/v1/currentConditions:lookup?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) {
      return {
        type: "weather_error",
        error: `Weather API error: ${res.status}`,
        details: data?.error?.message || null,
        geocode_location: geocodeInfo.result.display_name || null
      };
    }

    return {
      type: "current_conditions",
      source: "google_weather_api",
      geocode_location: geocodeInfo.result.display_name || null,
      geocode_lat: lat,
      geocode_lon: lon,
      requested_city: analysis.city || null,
      attempted_queries: geocodeInfo.attempted_queries || candidates,
      current: parseWeatherSnapshot(data)
    };
  } catch (error) {
    return {
      type: "weather_error",
      error: "No se pudo consultar Weather API",
      details: String(error),
      geocode_location: geocodeInfo.result.display_name || null
    };
  }
}
