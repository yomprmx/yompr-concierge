import { normalizeText } from "./utils.js";
import { geocode } from "./geocode.js";

const PRICE_LEVEL_MAP = {
  "PRICE_LEVEL_FREE": "gratuito",
  "PRICE_LEVEL_INEXPENSIVE": "económico ($)",
  "PRICE_LEVEL_MODERATE": "precio moderado ($$)",
  "PRICE_LEVEL_EXPENSIVE": "caro ($$$)",
  "PRICE_LEVEL_VERY_EXPENSIVE": "muy caro ($$$$)"
};

export async function searchPlacesRecommendations(analysis, tripJson, env) {
  if (!env?.GOOGLE_MAPS_KEY) return null;
  const query = analysis.recommendation_query;
  if (!query) return null;

  let locationBias = null;
  const city = analysis.city ? normalizeText(analysis.city) : null;

  if (city) {
    const hotels = tripJson.hotelVouchers || [];
    const cityHotel = hotels.find(h =>
      normalizeText(h.accommodationAddress || "").includes(city) ||
      normalizeText(h.accommodationName || "").includes(city) ||
      normalizeText(JSON.stringify(h)).includes(city)
    );

    if (cityHotel) {
      const hotelQuery = [cityHotel.accommodationName, cityHotel.accommodationAddress].filter(Boolean).join(", ");
      if (hotelQuery) {
        try {
          const hotelGeo = await geocode(hotelQuery, { city: analysis.city }, env);
          if (hotelGeo?.lat && hotelGeo?.lon) {
            locationBias = { circle: { center: { latitude: hotelGeo.lat, longitude: hotelGeo.lon }, radius: 2000 } };
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
    const places = data.places.slice(0, 6).map(p => ({
      name: p.displayName?.text || null,
      address: p.formattedAddress || null,
      rating: p.rating ? Math.round(p.rating * 10) / 10 : null,
      review_count: p.userRatingCount || null,
      price_level: PRICE_LEVEL_MAP[p.priceLevel] || null,
      description: p.editorialSummary?.text || null,
      type: p.primaryType || null,
      opening_hours: p.regularOpeningHours?.weekdayDescriptions || null,
      maps_link: p.googleMapsUri || null
    }));
    return { places, query, bias_used: Boolean(locationBias), error: null };
  } catch (e) {
    return { places: [], query, bias_used: Boolean(locationBias), error: String(e) };
  }
}
