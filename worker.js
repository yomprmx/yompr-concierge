function extractJsonObject(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (_) {}

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch (_) {
    return null;
  }
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function compactText(value, maxLength = 1200) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "...";
}

function inferRouteDirectionFromQuestion(question) {
  const q = normalizeText(question);

  if (
    q.includes("cuando llego") ||
    q.includes("al llegar") ||
    q.includes("llegada") ||
    q.includes("cuando aterrizo") ||
    q.includes("llegamos")
  ) {
    return "airport_to_hotel";
  }

  if (
    q.includes("cuando salgo") ||
    q.includes("para mi vuelo") ||
    q.includes("al aeropuerto") ||
    q.includes("regreso") ||
    q.includes("salida")
  ) {
    return "hotel_to_airport";
  }

  return "unknown";
}

function inferRouteModeFromQuestion(question) {
  const q = normalizeText(question);

  if (
    q.includes("a pie") ||
    q.includes("caminando") ||
    q.includes("caminar") ||
    q.includes("andando")
  ) {
    return "walking";
  }

  if (
    q.includes("taxi") ||
    q.includes("uber") ||
    q.includes("coche") ||
    q.includes("auto") ||
    q.includes("carro")
  ) {
    return "driving";
  }

  if (
    q.includes("transporte publico") ||
    q.includes("transporte público") ||
    q.includes("metro") ||
    q.includes("tren") ||
    q.includes("bus") ||
    q.includes("autobus") ||
    q.includes("autobús")
  ) {
    return "transit";
  }

  return "all";
}

function postProcessAnalysis(question, analysis) {
  const q = normalizeText(question);

  const isRouteQuestion =
    q.includes("aeropuerto") ||
    q.includes("que tan lejos") ||
    q.includes("qué tan lejos") ||
    q.includes("como llego") ||
    q.includes("cómo llego") ||
    q.includes("ruta") ||
    q.includes("traslado") ||
    q.includes("caminando") ||
    q.includes("a pie") ||
    q.includes("taxi") ||
    q.includes("uber") ||
    q.includes("metro") ||
    q.includes("tren") ||
    q.includes("bus") ||
    q.includes("transporte publico") ||
    q.includes("transporte público") ||
    q.includes("cerca") ||
    q.includes("distancia") ||
    q.includes("estacion") ||
    q.includes("estación") ||
    q.includes("terminal");

  if (!analysis || typeof analysis !== "object") {
    analysis = {};
  }

  if (isRouteQuestion) {
    analysis.intent = "route";
    analysis.tool_needed = "route";
    analysis.needs_clarification = false;
    analysis.clarification_question = null;

    if (!analysis.route_mode || analysis.route_mode === "unknown") {
      analysis.route_mode = inferRouteModeFromQuestion(question);
    }

    if (!analysis.route_direction || analysis.route_direction === "unknown") {
      analysis.route_direction = inferRouteDirectionFromQuestion(question);
    }
  }

  analysis.intent = analysis.intent || "general";
  analysis.scope = analysis.scope || "all";
  analysis.city = analysis.city || null;
  analysis.date_reference = analysis.date_reference || null;
  analysis.tool_needed = analysis.tool_needed || "none";
  analysis.route_direction = analysis.route_direction || "unknown";
  analysis.route_mode = analysis.route_mode || "all";
  analysis.airport_code = analysis.airport_code || null;
  analysis.origin_query = analysis.origin_query || null;
  analysis.destination_query = analysis.destination_query || null;
  analysis.place_name = analysis.place_name || null;
  analysis.needs_clarification = Boolean(analysis.needs_clarification);
  analysis.clarification_question = analysis.clarification_question || null;

  return analysis;
}

function getAllHotels(tripJson) {
  return tripJson.hotelVouchers || [];
}

function getAllFlightSegments(tripJson) {
  return (tripJson.flightReservations || []).flatMap(r => r.segments || []);
}

function getHotelAddress(hotel) {
  return hotel?.accommodationAddress || hotel?.address || hotel?.hotelAddress || null;
}

function getHotelName(hotel) {
  return hotel?.accommodationName || hotel?.hotelName || hotel?.name || null;
}

function getHotelSearchText(hotel) {
  return normalizeText([
    getHotelName(hotel),
    getHotelAddress(hotel),
    hotel?.city,
    hotel?.destination,
    hotel?.country,
    JSON.stringify(hotel)
  ].filter(Boolean).join(" "));
}

function getTripSearchText(tripJson) {
  return normalizeText([
    tripJson.trip?.name,
    tripJson.trip?.destination,
    JSON.stringify(tripJson.trip || {}),
    JSON.stringify(tripJson.metadata || {})
  ].filter(Boolean).join(" "));
}

function makeRouteContextForClassifier(tripJson) {
  const hotels = getAllHotels(tripJson).map((h, index) => ({
    index,
    name: getHotelName(h),
    address: getHotelAddress(h),
    city: h.city || h.destination || null,
    raw_hint: compactText(JSON.stringify(h), 700)
  }));

  const flightSegments = getAllFlightSegments(tripJson).map((s, index) => ({
    index,
    airline: [s.airlineCode, s.flightNumber].filter(Boolean).join(""),
    departureAirport: s.departureAirport || null,
    arrivalAirport: s.arrivalAirport || null,
    departureDate: s.departureDate || s.departureDateTime || null,
    arrivalDate: s.arrivalDate || s.arrivalDateTime || null,
    raw_hint: compactText(JSON.stringify(s), 700)
  }));

  const services = (tripJson.serviceBookings || []).slice(0, 30).map((s, index) => ({
    index,
    category: s.category || null,
    name: s.activity?.activityName || s.transfer?.pickupLocation || s.name || s.serviceName || null,
    location: s.location || s.activity?.location || s.transfer?.pickupLocation || s.transfer?.dropoffLocation || null,
    date: s.activity?.date || s.transfer?.date || s.date || null,
    raw_hint: compactText(JSON.stringify(s), 700)
  }));

  return {
    trip: tripJson.trip || {},
    hotels,
    flightSegments,
    services
  };
}

function scoreTextMatch(text, terms) {
  let score = 0;

  for (const term of terms) {
    const normalizedTerm = normalizeText(term);
    if (!normalizedTerm) continue;

    if (text.includes(normalizedTerm)) {
      score += Math.min(10, Math.max(3, normalizedTerm.length / 4));
    }
  }

  return score;
}

function findBestHotel(tripJson, analysis) {
  const hotels = getAllHotels(tripJson);
  if (!hotels.length) return null;
  if (hotels.length === 1) return hotels[0];

  const terms = [
    analysis.city,
    analysis.place_name,
    analysis.origin_query,
    analysis.destination_query
  ].filter(Boolean);

  let bestHotel = hotels[0];
  let bestScore = -1;

  for (const hotel of hotels) {
    const text = getHotelSearchText(hotel);
    const score = scoreTextMatch(text, terms);

    if (score > bestScore) {
      bestScore = score;
      bestHotel = hotel;
    }
  }

  return bestHotel;
}

function findRelevantAirportCode(tripJson, analysis, hotel) {
  const segments = getAllFlightSegments(tripJson);

  if (analysis.airport_code) {
    return String(analysis.airport_code).toUpperCase();
  }

  if (!segments.length) return null;

  const city = normalizeText(analysis.city || "");
  const hotelText = getHotelSearchText(hotel || {});
  const tripText = getTripSearchText(tripJson);
  const direction = analysis.route_direction;

  function segmentScore(segment, airportField) {
    const text = normalizeText(JSON.stringify(segment));
    let score = 0;

    if (city && text.includes(city)) score += 10;
    if (hotelText && text && scoreTextMatch(text, [analysis.city, analysis.place_name]) > 0) score += 3;
    if (tripText && text && scoreTextMatch(text, [analysis.city]) > 0) score += 2;
    if (segment[airportField]) score += 1;

    return score;
  }

  if (direction === "airport_to_hotel") {
    const arrivals = segments.filter(s => s.arrivalAirport);
    if (!arrivals.length) return null;

    const ranked = arrivals
      .map(s => ({ segment: s, score: segmentScore(s, "arrivalAirport") }))
      .sort((a, b) => b.score - a.score);

    return ranked[0]?.segment?.arrivalAirport || null;
  }

  if (direction === "hotel_to_airport") {
    const departures = segments.filter(s => s.departureAirport);
    if (!departures.length) return null;

    const ranked = departures
      .map(s => ({ segment: s, score: segmentScore(s, "departureAirport") }))
      .sort((a, b) => b.score - a.score);

    return ranked[0]?.segment?.departureAirport || null;
  }

  return null;
}

function airportQueryFromCode(code) {
  return code ? `${String(code).toUpperCase()} airport` : null;
}

function buildRouteEndpoints(tripJson, analysis) {
  const hotel = findBestHotel(tripJson, analysis);
  const hotelAddress = getHotelAddress(hotel);
  const airportCode = findRelevantAirportCode(tripJson, analysis, hotel);
  const airportQuery = airportQueryFromCode(airportCode);

  let origin = null;
  let destination = null;

  if (analysis.origin_query && analysis.destination_query) {
    origin = analysis.origin_query;
    destination = analysis.destination_query;
  } else if (analysis.route_direction === "airport_to_hotel") {
    origin = airportQuery;
    destination = hotelAddress;
  } else if (analysis.route_direction === "hotel_to_airport") {
    origin = hotelAddress;
    destination = airportQuery;
  } else if (analysis.route_direction === "place_to_hotel") {
    origin = analysis.place_name || analysis.origin_query;
    destination = hotelAddress;
  } else if (analysis.route_direction === "hotel_to_place") {
    origin = hotelAddress;
    destination = analysis.place_name || analysis.destination_query;
  } else if (analysis.place_name && hotelAddress) {
    origin = analysis.place_name;
    destination = hotelAddress;
  }

  if (!origin || !destination) {
    return null;
  }

  return {
    origin,
    destination,
    hotel,
    airport_code: airportCode || null
  };
}

function buildGeocodeContext(tripJson, hotel, analysis) {
  return [
    analysis.city,
    tripJson.trip?.destination,
    getHotelName(hotel),
    getHotelAddress(hotel)
  ].filter(Boolean).join(", ");
}

async function geocode(address) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Yompr Concierge" }
  });

  const data = await res.json();

  if (!data.length) return null;

  return {
    lat: parseFloat(data[0].lat),
    lon: parseFloat(data[0].lon),
    display_name: data[0].display_name || null
  };
}

async function getRoute(from, to, mode = "driving") {
  const profileMap = {
    driving: "driving",
    walking: "foot"
  };

  const profile = profileMap[mode] || "driving";

  const url =
    `https://router.project-osrm.org/route/v1/${profile}/` +
    `${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;

  const res = await fetch(url);
  const data = await res.json();

  if (!data.routes?.length) return null;

  const route = data.routes[0];

  return {
    mode,
    distance_km: route.distance / 1000,
    duration_min: route.duration / 60
  };
}

function buildGoogleMapsLink(origin, destination, mode = null) {
  let url =
    `https://www.google.com/maps/dir/?api=1` +
    `&origin=${encodeURIComponent(origin)}` +
    `&destination=${encodeURIComponent(destination)}`;

  if (mode) {
    url += `&travelmode=${encodeURIComponent(mode)}`;
  }

  return url;
}

async function enrichWithTransportInfo(tripJson, analysis) {
  if (analysis.tool_needed !== "route" && analysis.intent !== "route") {
    return null;
  }

  const requestedMode = analysis.route_mode || "all";
  const endpoints = buildRouteEndpoints(tripJson, analysis);

  if (!endpoints) {
    return null;
  }

  const { origin, destination, hotel, airport_code } = endpoints;
  const geocodeContext = buildGeocodeContext(tripJson, hotel, analysis);

  const originSearch = geocodeContext ? `${origin}, ${geocodeContext}` : origin;
  const destinationSearch = geocodeContext ? `${destination}, ${geocodeContext}` : destination;

  const originCoords = await geocode(originSearch);
  const destinationCoords = await geocode(destinationSearch);

  if (!originCoords || !destinationCoords) {
    return null;
  }

  const walkingRoute = await getRoute(originCoords, destinationCoords, "walking");
  const drivingRoute = await getRoute(originCoords, destinationCoords, "driving");

  const options = {
    walking: walkingRoute
      ? {
          mode: "walking",
          duration_min: Math.round(walkingRoute.duration_min),
          distance_km: Math.round(walkingRoute.distance_km * 10) / 10,
          maps_link: buildGoogleMapsLink(origin, destination, "walking")
        }
      : null,

    driving: drivingRoute
      ? {
          mode: "driving",
          duration_min: Math.round(drivingRoute.duration_min),
          distance_km: Math.round(drivingRoute.distance_km * 10) / 10,
          maps_link: buildGoogleMapsLink(origin, destination, "driving")
        }
      : null,

    transit: {
      mode: "transit",
      duration_min: null,
      distance_km: null,
      maps_link: buildGoogleMapsLink(origin, destination, "transit"),
      note: "El transporte público depende de horarios y disponibilidad en tiempo real; confirma el tiempo exacto en Google Maps."
    }
  };

  let primary = null;

  if (requestedMode === "walking") {
    primary = options.walking;
  } else if (requestedMode === "driving") {
    primary = options.driving;
  } else if (requestedMode === "transit") {
    primary = options.transit;
  } else {
    primary = options.walking || options.driving || options.transit;
  }

  return {
    route_direction: analysis.route_direction || "unknown",
    route_mode: requestedMode,
    origin,
    destination,
    airport_code: airport_code || null,
    hotel_name: getHotelName(hotel),
    hotel_address: getHotelAddress(hotel),

    geocode_origin_query: originSearch,
    geocode_destination_query: destinationSearch,
    geocode_origin_result: originCoords.display_name || null,
    geocode_destination_result: destinationCoords.display_name || null,

    duration_min: primary?.duration_min || null,
    distance_km: primary?.distance_km || null,
    maps_link: primary?.maps_link || buildGoogleMapsLink(origin, destination),

    options
  };
}

function getEventDateTime(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function collectTripEvents(tripJson) {
  const events = [];

  for (const reservation of tripJson.flightReservations || []) {
    for (const segment of reservation.segments || []) {
      events.push({
        type: "flight",
        title: `Vuelo ${segment.airlineCode || ""}${segment.flightNumber || ""} ${segment.departureAirport || ""} → ${segment.arrivalAirport || ""}`,
        start: getEventDateTime(segment.departureDate || segment.departureDateTime),
        end: getEventDateTime(segment.arrivalDate || segment.arrivalDateTime)
      });
    }
  }

  for (const service of tripJson.serviceBookings || []) {
    if (service.category === "activity" && service.activity) {
      const datePart = service.activity.date;
      const timePart = service.activity.time || "00:00";
      const dateOnly = datePart ? datePart.split("T")[0] : null;
      const start = dateOnly ? getEventDateTime(`${dateOnly}T${timePart}:00`) : null;

      events.push({
        type: "activity",
        title: service.activity.activityName || "Actividad",
        start,
        end: start
      });
    }

    if (service.category === "transfer" && service.transfer) {
      const datePart = service.transfer.date;
      const timePart = service.transfer.pickupTime || "00:00";
      const dateOnly = datePart ? datePart.split("T")[0] : null;
      const start = dateOnly ? getEventDateTime(`${dateOnly}T${timePart}:00`) : null;

      events.push({
        type: "transfer",
        title: `Traslado ${service.transfer.pickupLocation || ""} → ${service.transfer.dropoffLocation || ""}`,
        start,
        end: start
      });
    }
  }

  return events
    .filter(e => e.start)
    .sort((a, b) => a.start - b.start);
}

function requiredBufferMinutes(current, next) {
  if (next.type === "flight") {
    return 180;
  }

  if (current.type === "hotel_checkout" && next.type === "flight") {
    return 180;
  }

  if (next.type === "train") {
    return 60;
  }

  if (next.type === "activity") {
    return 45;
  }

  return 60;
}

function detectBasicConflicts(tripJson) {
  const events = collectTripEvents(tripJson);
  const conflicts = [];

  for (let i = 0; i < events.length - 1; i++) {
    const current = events[i];
    const next = events[i + 1];

    const sameDay =
      current.start.toISOString().split("T")[0] ===
      next.start.toISOString().split("T")[0];

    if (!sameDay) continue;

    const currentEnd = current.end || current.start;
    const minutesBetween = (next.start - currentEnd) / 60000;

    if (minutesBetween < 0) {
      conflicts.push({
        severity: "high",
        type: "overlap",
        message: `Hay eventos encimados: "${current.title}" y "${next.title}".`
      });
    } else {
      const required = requiredBufferMinutes(current, next);

      if (minutesBetween < required) {
        conflicts.push({
          severity: minutesBetween < required / 2 ? "high" : "medium",
          type: "insufficient_buffer",
          message: `Tiempo insuficiente entre "${current.title}" y "${next.title}": hay ${Math.round(minutesBetween)} min disponibles y se recomiendan al menos ${required} min.`
        });
      }
    }
  }

  const byDay = {};
  for (const event of events) {
    const day = event.start.toISOString().split("T")[0];
    byDay[day] = byDay[day] || [];
    byDay[day].push(event);
  }

  for (const [day, dayEvents] of Object.entries(byDay)) {
    if (dayEvents.length >= 4) {
      conflicts.push({
        severity: "low",
        type: "busy_day",
        message: `El día ${day} tiene ${dayEvents.length} eventos. Puede sentirse cargado.`
      });
    }
  }

  return conflicts;
}

async function classifyIntentWithDeepSeek(question, env, tripJson, conversationHistory = []) {
  const routeContext = makeRouteContextForClassifier(tripJson);
  const cleanHistory = Array.isArray(conversationHistory)
    ? conversationHistory
        .filter(m =>
          m &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string"
        )
        .slice(-6)
    : [];

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.DEEPSEEK_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      thinking: { type: "enabled" },
      temperature: 0,
      max_tokens: 700,
      messages: [
        {
          role: "system",
          content: `
Eres un clasificador de intención para un concierge de viajes.

Responde SOLO JSON válido con este formato:

{
  "intent": "hotel | flight | activity | transfer | weather | nearby_places | emergency | itinerary | recommendation | route | general",
  "scope": "all | city | date | next_event | specific_item | trip_analysis | unknown",
  "city": "ciudad si aplica, si no null",
  "date_reference": "hoy | mañana | fecha específica | null",
  "tool_needed": "none | route | places | weather",
  "route_direction": "airport_to_hotel | hotel_to_airport | hotel_to_place | place_to_hotel | place_to_place | unknown",
  "route_mode": "walking | driving | transit | all",
  "airport_code": "código IATA si aparece explícitamente o se puede inferir del contexto, si no null",
  "origin_query": "origen textual si aplica, si no null",
  "destination_query": "destino textual si aplica, si no null",
  "place_name": "lugar mencionado si aplica, si no null",
  "confidence": 0-1,
  "needs_clarification": true/false,
  "clarification_question": "pregunta corta si hace falta aclarar"
}

Reglas:
- Si la pregunta trata sobre distancia, ubicación, ruta, caminar, taxi, Uber, coche, transporte público, metro, tren, bus, aeropuerto o traslado, usa intent="route" y tool_needed="route".
- No clasifiques como hotel solo porque aparece la palabra "hotel"; si la pregunta es sobre llegar, distancia o ubicación, clasifica como route.
- Usa el contexto del viaje para inferir hotel, ciudad y aeropuertos. No inventes datos fuera del contexto.
- Si pregunta "cuando llego", "al llegar", "llegada", usa route_direction="airport_to_hotel".
- Si pregunta "cuando salgo", "para mi vuelo", "al aeropuerto", "regreso", usa route_direction="hotel_to_airport".
- Si pregunta "desde [lugar] al hotel", usa route_direction="place_to_hotel", origin_query="[lugar]" y place_name="[lugar]".
- Si pregunta "del hotel a [lugar]", usa route_direction="hotel_to_place", destination_query="[lugar]" y place_name="[lugar]".
- Si pregunta por transporte público, usa route_mode="transit".
- Si pregunta caminando, a pie o caminar, usa route_mode="walking".
- Si pregunta por taxi, Uber, coche, auto o carro, usa route_mode="driving".
- Si no especifica modo, usa route_mode="all".
- Si hay varios hoteles, usa city, place_name, origin_query o destination_query para identificar el hotel más probable.
- Si la pregunta menciona un lugar que parece contener el nombre de una ciudad, no asumas que es esa ciudad; puede ser un punto de interés, estación o plaza.
- No pidas aclaración si origen/destino se puede resolver usando el itinerario.
- Pide aclaración solo si falta un origen o destino indispensable.
- Responde SOLO JSON válido. Nada antes ni después.
`
        },
        {
          role: "user",
          content:
            "Contexto del viaje para clasificar:\n" +
            JSON.stringify(routeContext) +
            "\n\nHistorial reciente:\n" +
            JSON.stringify(cleanHistory) +
            "\n\nPregunta actual:\n" +
            question
        }
      ]
    })
  });

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "{}";
  const parsed = extractJsonObject(content);

  if (parsed) {
    return parsed;
  }

  return {
    intent: "general",
    scope: "all",
    city: null,
    date_reference: null,
    tool_needed: "none",
    route_direction: "unknown",
    route_mode: "all",
    airport_code: null,
    origin_query: null,
    destination_query: null,
    place_name: null,
    confidence: 0,
    needs_clarification: false,
    clarification_question: null
  };
}

function getTodayInTimezone(timeZone = "UTC") {
  const now = new Date();

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);

  const year = parts.find(p => p.type === "year").value;
  const month = parts.find(p => p.type === "month").value;
  const day = parts.find(p => p.type === "day").value;

  return new Date(`${year}-${month}-${day}T00:00:00`);
}

function resolveDateReference(analysis, tripJson, timeZone) {
  const ref = normalizeText(analysis.date_reference || "");
  const startDate = getTodayInTimezone(timeZone || "UTC");

  if (ref === "hoy") {
    return startDate;
  }

  if (ref === "manana") {
    const d = new Date(startDate);
    d.setDate(d.getDate() + 1);
    return d;
  }

  const possibleDate = getEventDateTime(analysis.date_reference);
  return possibleDate;
}

function getTripStartDate(tripJson) {
  const events = collectTripEvents(tripJson);
  if (events.length) return events[0].start;

  const hotels = getAllHotels(tripJson);
  if (hotels.length > 0 && hotels[0].checkIn) {
    return new Date(hotels[0].checkIn);
  }

  return null;
}

function buildContextByIntent(tripJson, analysis, timeZone) {
  const intent = analysis.intent || "general";
  const scope = analysis.scope || "all";
  const city = normalizeText(analysis.city || "");

  const base = {
    trip: tripJson.trip || {},
    metadata: tripJson.metadata || {}
  };

  const date = resolveDateReference(analysis, tripJson, timeZone);

  if (date) {
    const dateStr = date.toISOString().split("T")[0];

    const filtered = {
      ...base,
      flightReservations: (tripJson.flightReservations || []).filter(f =>
        JSON.stringify(f).includes(dateStr)
      ),
      hotelVouchers: (tripJson.hotelVouchers || []).filter(h =>
        JSON.stringify(h).includes(dateStr)
      ),
      serviceBookings: (tripJson.serviceBookings || []).filter(s =>
        JSON.stringify(s).includes(dateStr)
      )
    };

    const hasResults =
      filtered.flightReservations.length ||
      filtered.hotelVouchers.length ||
      filtered.serviceBookings.length;

    if (hasResults) {
      return filtered;
    }

    const tripStart = getTripStartDate(tripJson);

    if (tripStart && date < tripStart) {
      return {
        ...base,
        note: "El viaje aún no comienza",
        requested_date: dateStr,
        trip_start: tripStart.toISOString(),
        flightReservations: tripJson.flightReservations || [],
        hotelVouchers: tripJson.hotelVouchers || [],
        serviceBookings: tripJson.serviceBookings || []
      };
    }

    return {
      ...base,
      note: "No hay actividades específicas para esta fecha",
      requested_date: dateStr,
      flightReservations: tripJson.flightReservations || [],
      hotelVouchers: tripJson.hotelVouchers || [],
      serviceBookings: tripJson.serviceBookings || []
    };
  }

  if (scope === "city" && city) {
    const matchesCity = text => normalizeText(text).includes(city);

    return {
      ...base,
      flightReservations: tripJson.flightReservations || [],
      hotelVouchers: (tripJson.hotelVouchers || []).filter(h =>
        matchesCity(getHotelAddress(h)) ||
        matchesCity(getHotelName(h)) ||
        matchesCity(JSON.stringify(h))
      ),
      serviceBookings: (tripJson.serviceBookings || []).filter(s =>
        matchesCity(s.location) ||
        matchesCity(JSON.stringify(s))
      )
    };
  }

  if (intent === "hotel") {
    return { ...base, hotelVouchers: tripJson.hotelVouchers || [] };
  }

  if (intent === "flight") {
    return { ...base, flightReservations: tripJson.flightReservations || [] };
  }

  if (intent === "activity") {
    return {
      ...base,
      serviceBookings: (tripJson.serviceBookings || []).filter(s => s.category === "activity")
    };
  }

  if (intent === "transfer") {
    return {
      ...base,
      serviceBookings: (tripJson.serviceBookings || []).filter(s => s.category === "transfer")
    };
  }

  return {
    ...base,
    flightReservations: tripJson.flightReservations || [],
    hotelVouchers: tripJson.hotelVouchers || [],
    serviceBookings: tripJson.serviceBookings || []
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("Yompr Concierge funcionando 🚀");
    }

    if (url.pathname === "/admin/logs") {
      const password = url.searchParams.get("key");

      if (password !== "Rigo090490!") {
        return new Response("No autorizado", { status: 401 });
      }

      const list = await env.CHAT_LOGS.list({ limit: 50 });
      const logs = [];

      for (const key of list.keys) {
        const value = await env.CHAT_LOGS.get(key.name);
        if (value) {
          logs.push(JSON.parse(value));
        }
      }

      logs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      const rows = logs.map(log => `
  <tr>
    <td>${escapeHtml(log.created_at || "")}</td>
    <td>${escapeHtml(log.trip_id || "")}</td>
    <td>${escapeHtml(log.intent || "")}</td>
    <td>${escapeHtml(log.scope || "")}</td>
    <td>${escapeHtml(log.city || "")}</td>
    <td>${log.thinking_enabled ? "🧠 Sí" : "—"}</td>
    <td>${escapeHtml(log.approximate_context_tokens || "")}</td>
    <td>${log.transport_used ? "Sí" : "—"}</td>
    <td>${escapeHtml(log.transport_duration_min || "")}</td>
    <td>${escapeHtml(log.transport_distance_km || "")}</td>
    <td>${escapeHtml(log.transport_error || "")}</td>
    <td>${escapeHtml(log.analysis_route_direction || "")}</td>
    <td>${escapeHtml(log.analysis_route_mode || "")}</td>
    <td>${escapeHtml(log.analysis_origin_query || "")}</td>
    <td>${escapeHtml(log.analysis_destination_query || "")}</td>
    <td>${escapeHtml(log.analysis_place_name || "")}</td>
    <td>${escapeHtml(log.geocode_origin_query || "")}</td>
    <td>${escapeHtml(log.geocode_destination_query || "")}</td>
    <td>${escapeHtml(log.question || "")}</td>
    <td style="max-width: 460px; white-space: pre-wrap;">${escapeHtml(log.answer || "")}</td>
  </tr>
`).join("");

      return new Response(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Yompr Concierge Logs</title>
</head>
<body style="font-family: Arial; padding: 24px;">
  <h1>Yompr Concierge Logs</h1>
  <p>Últimas 50 preguntas registradas.</p>

  <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; font-size: 13px;">
    <thead>
      <tr>
        <th>Fecha</th>
        <th>Trip ID</th>
        <th>Intent</th>
        <th>Scope</th>
        <th>City</th>
        <th>Thinking</th>
        <th>Tokens aprox</th>
        <th>OSM</th>
        <th>Ruta min</th>
        <th>Dist km</th>
        <th>Error OSM</th>
        <th>Route direction</th>
        <th>Route mode</th>
        <th>Origin query</th>
        <th>Destination query</th>
        <th>Place name</th>
        <th>Geocode origin</th>
        <th>Geocode destination</th>
        <th>Pregunta</th>
        <th>Respuesta</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</body>
</html>
`, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
    }

    if (url.pathname === "/admin") {
      const password = url.searchParams.get("key");

      if (password !== "Rigo090490!") {
        return new Response("No autorizado", { status: 401 });
      }

      return new Response(`
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8" /><title>Yompr Concierge Admin</title></head>
<body style="font-family: Arial; padding: 24px;">
  <h1>Yompr Concierge Admin</h1>
  <p>Sube aquí el archivo JSON completo del viaje.</p>
  <input type="file" id="jsonFile" accept=".json,application/json" />
  <br><br>
  <button onclick="uploadTrip()">Guardar viaje</button>
  <div id="result" style="margin-top:20px;"></div>

  <script>
    async function uploadTrip() {
      const fileInput = document.getElementById("jsonFile");
      const result = document.getElementById("result");

      if (!fileInput.files.length) {
        result.innerHTML = "<p style='color:red;'>Selecciona un archivo .json.</p>";
        return;
      }

      const jsonText = await fileInput.files[0].text();

      const res = await fetch("/api/upload-trip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: jsonText
      });

      const data = await res.json();

      result.innerHTML =
        "<p><b>Resultado:</b> " + data.message + "</p>" +
        (data.trip_id ? "<p><b>Trip ID:</b> " + data.trip_id + "</p>" : "") +
        (data.link ? '<p><a href="' + data.link + '" target="_blank">Abrir viaje</a></p>' : "");
    }
  </script>
</body>
</html>
`, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
    }

    if (url.pathname === "/api/upload-trip" && request.method === "POST") {
      try {
        const tripJson = await request.json();

        const tripId =
          tripJson?.trip?.tripIdentifier ||
          tripJson?.trip?.id ||
          tripJson?.flightReservations?.[0]?.tripID ||
          tripJson?.hotelVouchers?.[0]?.tripID ||
          tripJson?.serviceBookings?.[0]?.tripID;

        if (!tripId) {
          return Response.json({
            success: false,
            message: "No encontré tripIdentifier ni tripID en el JSON."
          }, { status: 400 });
        }

        await env.TRIPS.put(tripId, JSON.stringify(tripJson));

        return Response.json({
          success: true,
          message: "Viaje guardado correctamente.",
          trip_id: tripId,
          link: "/v/" + encodeURIComponent(tripId)
        });
      } catch (error) {
        return Response.json({
          success: false,
          message: "El archivo JSON no es válido o hubo un error al guardarlo.",
          error: String(error)
        }, { status: 400 });
      }
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      try {
        const {
          tripId,
          question,
          timeZone,
          localDate,
          conversationHistory = []
        } = await request.json();

        const tripText = await env.TRIPS.get(tripId);

        if (!tripText) {
          return Response.json({ answer: "No encontré el viaje." }, { status: 404 });
        }

        const tripJson = JSON.parse(tripText);

        const cleanHistory = Array.isArray(conversationHistory)
          ? conversationHistory
              .filter(m =>
                m &&
                (m.role === "user" || m.role === "assistant") &&
                typeof m.content === "string"
              )
              .slice(-8)
          : [];

        let analysis = await classifyIntentWithDeepSeek(question, env, tripJson, cleanHistory);
        analysis = postProcessAnalysis(question, analysis);

        if (analysis.needs_clarification) {
          return Response.json({
            answer: analysis.clarification_question || "¿Podrías darme un poco más de detalle para ayudarte mejor?",
            intent: "clarification"
          });
        }

        const context = buildContextByIntent(tripJson, analysis, timeZone);
        const intent = analysis.intent || "general";
        const conflicts = detectBasicConflicts(tripJson);
        context.detected_conflicts = conflicts;
        context.intent_analysis = analysis;

        let transportInfo = null;
        let transportUsed = false;
        let transportError = null;

        try {
          transportInfo = await enrichWithTransportInfo(tripJson, analysis);

          if (transportInfo) {
            context.transport_info = transportInfo;
            transportUsed = true;
          }
        } catch (e) {
          transportUsed = false;
          transportError = String(e);
        }

        const q = normalizeText(question);
        const needsThinking =
          intent === "recommendation" ||
          q.includes("conflicto") ||
          q.includes("pesado") ||
          q.includes("conviene") ||
          q.includes("tengo tiempo") ||
          q.includes("me da tiempo") ||
          q.includes("riesgo");

        const response = await fetch("https://api.deepseek.com/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + env.DEEPSEEK_API_KEY,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "deepseek-v4-flash",
            thinking: { type: needsThinking ? "enabled" : "disabled" },
            temperature: 0.3,
            max_tokens: needsThinking ? 2400 : 800,
            messages: [
              {
                role: "system",
                content: `
Eres Yompr Personal Concierge, un asistente de viaje premium. Responde en español amable, cálido, profesional, claro, natural y elegante, como el mejor asistente personal del mundo.
Usa solo la información del viaje proporcionada. Si no sabes algo con certeza, dilo. No inventes datos.
La respuesta debe ser concisa, lógica y responder lo que el cliente necesita sin hacerla innecesariamente extensa.
No seas condescendiente, sé amable y directo.
Las respuestas deben leerse naturales y como una conversación entre personas, no máquinas.

Puedes usar el historial reciente de esta sesión para entender referencias como:
- "¿y en taxi?"
- "¿y desde ahí?"
- "¿cuánto tarda?"
- "¿y después?"
- "¿qué me recomiendas?"

Fechas:
- No uses createdAt, modifiedAt ni exportedAt como fechas del viaje; son fechas administrativas.
- Para determinar inicio, fin o días del viaje, usa vuelos, check-in/check-out, actividades y servicios.

Riesgos:
- Si el contexto incluye detected_conflicts, menciona solo los relevantes para la pregunta del cliente.
- Prioriza como riesgos reales: vuelos, traslados, trenes, actividades y tiempos insuficientes entre ellos.
- El check-in y check-out del hotel son ventanas o límites administrativos, no eventos fijos.

Estilo:
- No seas redundante.
- No uses lenguaje técnico innecesario; habla como concierge de viaje.
- Si detectas emergencia o problema serio, recomienda contactar a Rigo.

Si se incluye transport_info:
- Usa transport_info como fuente principal para distancias y tiempos.
- No inventes tiempos de ruta.
- Para caminatas, usa solo transport_info.options.walking.
- Para taxi/coche, usa solo transport_info.options.driving.
- Para transporte público, si duration_min es null, NO inventes duración: di que debe confirmarse en el link de Google Maps por horarios en tiempo real.
- Si transport_info.options existe, puedes comparar caminando, taxi/coche y transporte público.
- No digas que algo queda a 5 minutos caminando si transport_info.options.walking indica otro tiempo.
- Si el usuario pregunta “está cerca”, responde con la distancia y duración caminando cuando estén disponibles.
- Si usas transport_info, menciona que es un tiempo estimado calculado.
`
              },
              ...cleanHistory,
              {
                role: "user",
                content:
                  "Intención detectada: " + intent +
                  "\nZona horaria del cliente: " + (timeZone || "desconocida") +
                  "\nFecha local del cliente: " + (localDate || "desconocida") +
                  "\n\nContexto actualizado del viaje:\n" +
                  JSON.stringify(context) +
                  "\n\nPregunta actual del cliente:\n" +
                  question
              }
            ]
          })
        });

        const data = await response.json();

        if (!response.ok) {
          return Response.json({
            answer: "Error de DeepSeek: " + JSON.stringify(data)
          }, { status: 500 });
        }

        const answer = data.choices?.[0]?.message?.content || "No pude responder.";

        const contextText = JSON.stringify(context);
        const approximateTokens = Math.ceil(contextText.length / 4);
        const logId = tripId + "-" + Date.now();

        await env.CHAT_LOGS.put(logId, JSON.stringify({
          created_at: new Date().toISOString(),
          trip_id: tripId,
          question,
          intent,
          scope: analysis.scope || "all",
          city: analysis.city || null,
          answer,
          context_characters: contextText.length,
          approximate_context_tokens: approximateTokens,
          analysis_thinking_enabled: true,
          thinking_enabled: needsThinking,
          session_history_messages: cleanHistory.length,
          transport_used: transportUsed,
          transport_duration_min: transportInfo?.duration_min || null,
          transport_distance_km: transportInfo?.distance_km || null,
          transport_origin: transportInfo?.origin || null,
          transport_destination: transportInfo?.destination || null,
          transport_error: transportError,
          transport_options: transportInfo?.options || null,
          geocode_origin_query: transportInfo?.geocode_origin_query || null,
          geocode_destination_query: transportInfo?.geocode_destination_query || null,
          geocode_origin_result: transportInfo?.geocode_origin_result || null,
          geocode_destination_result: transportInfo?.geocode_destination_result || null,
          analysis_route_direction: analysis.route_direction || null,
          analysis_route_mode: analysis.route_mode || null,
          analysis_origin_query: analysis.origin_query || null,
          analysis_destination_query: analysis.destination_query || null,
          analysis_place_name: analysis.place_name || null,
          used_transport_in_answer: Boolean(transportInfo) && (
            answer.includes(String(transportInfo.duration_min || "__NO_DURATION__")) ||
            answer.includes(String(transportInfo.distance_km || "__NO_DISTANCE__"))
          )
        }));

        return Response.json({ answer, intent });
      } catch (e) {
        return Response.json({
          answer: "Error al procesar la pregunta: " + String(e)
        }, { status: 500 });
      }
    }

    if (url.pathname.startsWith("/v/")) {
      const tripId = decodeURIComponent(url.pathname.replace("/v/", ""));
      const tripText = await env.TRIPS.get(tripId);

      if (!tripText) {
        return new Response("No encontré este viaje.", { status: 404 });
      }

      const tripJson = JSON.parse(tripText);
      const trip = tripJson.trip || {};
      const flights = tripJson.flightReservations || [];
      const hotels = tripJson.hotelVouchers || [];
      const services = tripJson.serviceBookings || [];

      return new Response(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(trip.name || "Yompr Concierge")}</title>

  <style>
    * { box-sizing: border-box; }

    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background: #f4f4f5;
      color: #111827;
      height: 100vh;
      display: flex;
      justify-content: center;
    }

    .app {
      width: 100%;
      max-width: 720px;
      height: 100vh;
      background: #ffffff;
      display: flex;
      flex-direction: column;
      border-left: 1px solid #e5e7eb;
      border-right: 1px solid #e5e7eb;
    }

    .header {
      padding: 18px 20px;
      border-bottom: 1px solid #e5e7eb;
      background: #ffffff;
      flex-shrink: 0;
    }

    .header h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 700;
    }

    .header p {
      margin: 6px 0 0;
      font-size: 13px;
      color: #6b7280;
    }

    .trip-summary {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 10px;
    }

    .chip {
      font-size: 12px;
      background: #f3f4f6;
      color: #374151;
      padding: 6px 9px;
      border-radius: 999px;
    }

    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 18px;
      background: #f9fafb;
    }

    .message-row {
      display: flex;
      margin-bottom: 12px;
    }

    .message-row.user { justify-content: flex-end; }
    .message-row.assistant { justify-content: flex-start; }

    .bubble {
      max-width: 78%;
      padding: 11px 14px;
      border-radius: 18px;
      font-size: 15px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-wrap: break-word;
    }

    .user .bubble {
      background: #111827;
      color: #ffffff;
      border-bottom-right-radius: 5px;
    }

    .assistant .bubble {
      background: #ffffff;
      color: #111827;
      border: 1px solid #e5e7eb;
      border-bottom-left-radius: 5px;
    }

    .composer {
      padding: 12px;
      border-top: 1px solid #e5e7eb;
      background: #ffffff;
      display: flex;
      gap: 8px;
      flex-shrink: 0;
    }

    .composer input {
      flex: 1;
      border: 1px solid #d1d5db;
      border-radius: 999px;
      padding: 12px 15px;
      font-size: 15px;
      outline: none;
    }

    .composer input:focus { border-color: #111827; }

    .composer button {
      border: none;
      background: #111827;
      color: #ffffff;
      border-radius: 999px;
      padding: 0 18px;
      font-size: 15px;
      cursor: pointer;
    }

    .composer button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .typing {
      opacity: 0.7;
      font-style: italic;
    }

    @media (max-width: 600px) {
      .app {
        max-width: none;
        border: none;
      }

      .bubble {
        max-width: 86%;
        font-size: 15px;
      }

      .header { padding: 14px 16px; }
      .messages { padding: 14px; }
    }
  </style>
</head>

<body>
  <div class="app">
    <div class="header">
      <h1>${escapeHtml(trip.name || "Yompr Concierge")}</h1>
      <p>${escapeHtml(trip.destination ? "Destino: " + trip.destination : "Tu concierge personal de viaje")}</p>

      <div class="trip-summary">
        <span class="chip">${flights.length} vuelo(s)</span>
        <span class="chip">${hotels.length} hospedaje(s)</span>
        <span class="chip">${services.length} servicio(s)</span>
      </div>
    </div>

    <div id="messages" class="messages">
      <div class="message-row assistant">
        <div class="bubble">Hola, soy tu concierge personal de Yompr. Puedes preguntarme sobre vuelos, hospedaje, actividades, traslados o recomendaciones de tu viaje.</div>
      </div>
    </div>

    <div class="composer">
      <input
        id="question"
        placeholder="Escribe tu pregunta..."
        autocomplete="off"
        onkeydown="handleKeyDown(event)"
      />
      <button id="sendButton" onclick="ask()">Enviar</button>
    </div>
  </div>

  <script>
    let conversationHistory = [];

    function scrollToBottom() {
      const messages = document.getElementById("messages");
      messages.scrollTop = messages.scrollHeight;
    }

    function addMessage(role, content, extraClass) {
      const messages = document.getElementById("messages");
      const row = document.createElement("div");
      row.className = "message-row " + role;

      const bubble = document.createElement("div");
      bubble.className = "bubble" + (extraClass ? " " + extraClass : "");
      bubble.innerText = content;

      row.appendChild(bubble);
      messages.appendChild(row);
      scrollToBottom();
      return row;
    }

    function handleKeyDown(event) {
      if (event.key === "Enter") ask();
    }

    async function ask() {
      const questionInput = document.getElementById("question");
      const sendButton = document.getElementById("sendButton");
      const question = questionInput.value.trim();

      if (!question) return;

      addMessage("user", question);

      questionInput.value = "";
      questionInput.disabled = true;
      sendButton.disabled = true;

      const thinkingRow = addMessage("assistant", "Pensando...", "typing");
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const localDate = new Date().toLocaleDateString("en-CA", { timeZone });

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tripId: "${tripId}",
            question,
            timeZone,
            localDate,
            conversationHistory
          })
        });

        const data = await res.json();
        thinkingRow.remove();

        if (!res.ok) {
          const errorText = "Error: " + (data.answer || data.message || JSON.stringify(data));
          addMessage("assistant", errorText);
          return;
        }

        const answer = data.answer || "No recibí respuesta.";
        addMessage("assistant", answer);

        conversationHistory.push({ role: "user", content: question });
        conversationHistory.push({ role: "assistant", content: answer });
        conversationHistory = conversationHistory.slice(-8);
      } catch (error) {
        thinkingRow.remove();
        addMessage("assistant", "Error de conexión: " + error.message);
      } finally {
        questionInput.disabled = false;
        sendButton.disabled = false;
        questionInput.focus();
        scrollToBottom();
      }
    }

    scrollToBottom();
  </script>
</body>
</html>
`, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
    }

    return new Response("Ruta no encontrada", { status: 404 });
  }
};
