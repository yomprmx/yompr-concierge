import { geocodeDetailed } from "./geocode.js";
import { normalizeText } from "./utils.js";
import { buildCacheKey, cacheGetJson, cachePutJson } from "./cache.js";

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

function parseForecastDay(day) {
  if (!day || typeof day !== "object") return null;
  const daytime = day.daytimeForecast || day.daytime || {};
  const nighttime = day.nighttimeForecast || day.nighttime || {};

  const daytimePop = daytime.precipitation?.probability?.percent ?? null;
  const nighttimePop = nighttime.precipitation?.probability?.percent ?? null;
  const maxPop = [daytimePop, nighttimePop].filter(v => typeof v === "number").reduce((m, v) => Math.max(m, v), null);

  return {
    display_date: day.displayDate || null,
    interval_start: day.interval?.startTime || null,
    interval_end: day.interval?.endTime || null,
    max_temp_c: day.maxTemperature?.degrees ?? null,
    min_temp_c: day.minTemperature?.degrees ?? null,
    daytime_condition: daytime.weatherCondition?.description?.text || daytime.weatherCondition?.type || null,
    nighttime_condition: nighttime.weatherCondition?.description?.text || nighttime.weatherCondition?.type || null,
    precipitation_probability_percent: maxPop
  };
}

function resolveForecastDaysByQuestion(analysis) {
  const q = normalizeText(analysis.original_question || "");
  const dateRef = normalizeText(analysis.date_reference || "");
  if (q.includes("mañana") || q.includes("manana") || dateRef === "mañana" || dateRef === "manana") return 2;
  if (q.includes("esta semana") || q.includes("próximos") || q.includes("proximos")) return 5;
  return 3;
}

function resolveForecastHoursByQuestion(analysis) {
  const q = normalizeText(analysis.original_question || "");
  if (q.includes("hora") || q.includes("horario") || q.includes("tarde") || q.includes("noche") || q.includes("salir")) return 18;
  return 12;
}

function parseHourItem(item) {
  if (!item || typeof item !== "object") return null;
  return {
    time: item.interval?.startTime || item.time || null,
    temperature_c: item.temperature?.degrees ?? null,
    feels_like_c: item.feelsLikeTemperature?.degrees ?? null,
    precipitation_probability_percent: item.precipitation?.probability?.percent ?? null,
    condition: item.weatherCondition?.description?.text || item.weatherCondition?.type || null
  };
}

function buildSoftRecommendationWindows(hourly) {
  if (!Array.isArray(hourly) || !hourly.length) return [];
  const candidates = hourly
    .filter(h => h && typeof h.precipitation_probability_percent === "number")
    .sort((a, b) => (a.precipitation_probability_percent - b.precipitation_probability_percent) || ((a.temperature_c ?? 99) - (b.temperature_c ?? 99)))
    .slice(0, 3)
    .map(h => ({
      time: h.time,
      reason: `menor probabilidad de lluvia (${h.precipitation_probability_percent}%)`,
      temperature_c: h.temperature_c ?? null,
      condition: h.condition || null
    }));
  return candidates;
}

export async function enrichWithWeatherInfo(tripJson, analysis, env = null) {
  if (analysis.tool_needed !== "weather" && analysis.intent !== "weather") return null;
  if (!env?.GOOGLE_MAPS_KEY) {
    return { type: "weather_error", error: "GOOGLE_MAPS_KEY no configurada" };
  }
  const tripId = analysis.trip_id || "unknown";

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
  const utcHourBucket = new Date().toISOString().slice(0, 13);
  const params = new URLSearchParams({
    key: env.GOOGLE_MAPS_KEY,
    "location.latitude": String(lat),
    "location.longitude": String(lon),
    unitsSystem: "METRIC",
    languageCode: "es"
  });
  const forecastDaysRequested = resolveForecastDaysByQuestion(analysis);
  const forecastHoursRequested = resolveForecastHoursByQuestion(analysis);
  const cacheKey = buildCacheKey("weather", [
    tripId,
    lat,
    lon,
    analysis.city || "",
    analysis.date_reference || "",
    forecastDaysRequested,
    forecastHoursRequested,
    utcHourBucket
  ]);
  const cached = await cacheGetJson(env, cacheKey);
  if (cached) return { ...cached, cache_hit: true };

  try {
    const [currentRes, forecastRes, hourlyRes] = await Promise.all([
      fetch(`https://weather.googleapis.com/v1/currentConditions:lookup?${params.toString()}`),
      fetch(`https://weather.googleapis.com/v1/forecast/days:lookup?${params.toString()}&days=${forecastDaysRequested}`),
      fetch(`https://weather.googleapis.com/v1/forecast/hours:lookup?${params.toString()}&hours=${forecastHoursRequested}`)
    ]);

    const currentData = await currentRes.json();
    const forecastData = await forecastRes.json();
    const hourlyData = await hourlyRes.json();

    if (!currentRes.ok && !forecastRes.ok && !hourlyRes.ok) {
      return {
        type: "weather_error",
        error: `Weather API error: current=${currentRes.status}, forecast=${forecastRes.status}, hourly=${hourlyRes.status}`,
        details: currentData?.error?.message || forecastData?.error?.message || hourlyData?.error?.message || null,
        geocode_location: geocodeInfo.result.display_name || null
      };
    }

    const forecastDays = Array.isArray(forecastData?.forecastDays)
      ? forecastData.forecastDays.map(parseForecastDay).filter(Boolean)
      : [];
    const forecastHours = Array.isArray(hourlyData?.forecastHours)
      ? hourlyData.forecastHours.map(parseHourItem).filter(Boolean)
      : [];
    const recommendationWindows = buildSoftRecommendationWindows(forecastHours);

    const payload = {
      type: "weather_bundle",
      source: "google_weather_api",
      geocode_location: geocodeInfo.result.display_name || null,
      geocode_lat: lat,
      geocode_lon: lon,
      requested_city: analysis.city || null,
      attempted_queries: geocodeInfo.attempted_queries || candidates,
      current: currentRes.ok ? parseWeatherSnapshot(currentData) : null,
      forecast_days_requested: forecastDaysRequested,
      forecast_days: forecastDays,
      forecast_hours_requested: forecastHoursRequested,
      forecast_hours: forecastHours,
      recommendation_windows: recommendationWindows,
      cache_hit: false
    };
    await cachePutJson(env, cacheKey, payload, 45 * 60);
    return payload;
  } catch (error) {
    return {
      type: "weather_error",
      error: "No se pudo consultar Weather API",
      details: String(error),
      geocode_location: geocodeInfo.result.display_name || null
    };
  }
}
