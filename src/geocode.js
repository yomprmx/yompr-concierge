import { normalizeText } from "./utils.js";

const GEOCODE_CACHE_TTL = 86400;
const COUNTRY_ALIASES = [
  [/\bfrancia\b/gi, "France"], [/\bespana\b/gi, "Spain"], [/\bespaña\b/gi, "Spain"], [/\bitalia\b/gi, "Italy"],
  [/\balemania\b/gi, "Germany"], [/\breino unido\b/gi, "United Kingdom"], [/\bestados unidos\b/gi, "United States"],
  [/\bpaises bajos\b/gi, "Netherlands"], [/\bpaíses bajos\b/gi, "Netherlands"], [/\bsuiza\b/gi, "Switzerland"],
  [/\baustria\b/gi, "Austria"], [/\bportugal\b/gi, "Portugal"], [/\bgrecia\b/gi, "Greece"]
];

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean).map(v => String(v).trim()).filter(Boolean))];
}
function replaceCountryAliases(query) {
  let result = String(query || "");
  for (const [pattern, replacement] of COUNTRY_ALIASES) result = result.replace(pattern, replacement);
  return result;
}
function simplifyPlaceQuery(query) {
  return String(query || "").replace(/\([^)]*\)/g, " ").replace(/[“”"']/g, " ").replace(/\s+/g, " ").trim();
}
function removeGenericPlaceWords(query) {
  return String(query || "")
    .replace(/\b(aeropuerto|airport|aéroport|flughafen|aeroporto)\b/gi, " ")
    .replace(/\b(estacion|estación|station|gare|stazione|terminal|termini)\b/gi, " ")
    .replace(/\b(hotel|hostal|hostel|resort|apartment|apartamento)\b/gi, " ")
    .replace(/\b(de|del|la|el|le|les|the|di|da|do|du)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function extractIataCode(query) {
  const match = String(query || "").match(/\(([A-Z]{3})\)|\b([A-Z]{3})\b/);
  return match ? (match[1] || match[2]) : null;
}
function getGeocodeCacheKey(query, options = {}) {
  return [normalizeText(query), normalizeText(options.city || ""), normalizeText(options.country || "")].join("|");
}
async function rememberGeocodeResult(env, cacheKey, value) {
  if (!cacheKey || !env?.TRIPS) return;
  try {
    await env.TRIPS.put("geo:v2:" + cacheKey, JSON.stringify(value), { expirationTtl: GEOCODE_CACHE_TTL });
  } catch (_) {}
}
async function geocodePlacesSearch(query, env, placeType = null) {
  if (!query || !env?.GOOGLE_MAPS_KEY) return null;
  try {
    const body = { textQuery: query };
    if (placeType) body.includedType = placeType;
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": env.GOOGLE_MAPS_KEY,
        "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location"
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.places?.length) return null;
    const place = data.places[0];
    const lat = place.location?.latitude;
    const lon = place.location?.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { display_name: place.formattedAddress || place.displayName?.text || null, lat, lon };
  } catch (_) {
    return null;
  }
}
async function geocodeAddressSearch(query, env) {
  if (!query || !env?.GOOGLE_MAPS_KEY) return null;
  try {
    const params = new URLSearchParams({ address: query, key: env.GOOGLE_MAPS_KEY });
    const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status === "REQUEST_DENIED") return { error: "REQUEST_DENIED" };
    if (data.status !== "OK" || !data.results?.length) return null;
    const loc = data.results[0].geometry.location;
    if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return null;
    return { display_name: data.results[0].formatted_address || null, lat: loc.lat, lon: loc.lng };
  } catch (_) {
    return null;
  }
}

export async function geocodeDetailed(query, options = {}, env = null) {
  if (!query) {
    return { query: null, result: null, attempted_queries: [], attempted_query: null, status: "missing_query", error: "missing_query" };
  }

  const cacheKey = getGeocodeCacheKey(query, options);
  if (env?.TRIPS) {
    try {
      const cached = await env.TRIPS.get("geo:v2:" + cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (_) {}
  }

  const base = String(query).trim();
  const cityText = options.city ? String(options.city).trim() : "";
  const iataCode = extractIataCode(base);
  const isAirportLike = iataCode || /\b(aeropuerto|airport|aéroport|flughafen|aeroporto)\b/i.test(base);
  const candidateList = [];
  if (iataCode) {
    candidateList.push(`${iataCode} airport`);
    if (cityText) candidateList.push(`${iataCode} airport ${cityText}`);
  }

  candidateList.push(base);
  if (cityText && !normalizeText(base).includes(normalizeText(cityText))) candidateList.push(`${base}, ${cityText}`);
  const simplified = replaceCountryAliases(simplifyPlaceQuery(base));
  if (simplified !== base) candidateList.push(simplified);
  if (isAirportLike && !iataCode) candidateList.push(removeGenericPlaceWords(simplified));
  const candidates = uniqueValues(candidateList);

  const attemptedQueries = [];
  let lastError = null;

  for (const candidate of candidates) {
    attemptedQueries.push(candidate);
    const placeType = isAirportLike ? "airport" : null;
    const placesResult = await geocodePlacesSearch(candidate, env, placeType);
    if (placesResult?.lat) {
      const value = { query, result: { query, attempted_query: candidate, ...placesResult }, attempted_queries: attemptedQueries, attempted_query: candidate, status: "found", error: null };
      await rememberGeocodeResult(env, cacheKey, value);
      return value;
    }

    const geocodeResult = await geocodeAddressSearch(candidate, env);
    if (geocodeResult?.error === "REQUEST_DENIED") {
      lastError = "REQUEST_DENIED: API key inválida";
      break;
    }
    if (geocodeResult?.lat) {
      const value = { query, result: { query, attempted_query: candidate, ...geocodeResult }, attempted_queries: attemptedQueries, attempted_query: candidate, status: "found", error: null };
      await rememberGeocodeResult(env, cacheKey, value);
      return value;
    }
    lastError = "not_found";
  }

  const value = {
    query,
    result: null,
    attempted_queries: attemptedQueries,
    attempted_query: attemptedQueries[attemptedQueries.length - 1] || null,
    status: lastError ? "error" : "not_found",
    error: lastError
  };
  await rememberGeocodeResult(env, cacheKey, value);
  return value;
}

export async function geocode(query, options = {}, env = null) {
  const detailed = await geocodeDetailed(query, options, env);
  return detailed.result;
}
