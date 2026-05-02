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
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const GEOCODE_CACHE_TTL = 86400; // 24 horas

const COUNTRY_ALIASES = [
  [/\bfrancia\b/gi, "France"],
  [/\bespana\b/gi, "Spain"],
  [/\bespaña\b/gi, "Spain"],
  [/\bitalia\b/gi, "Italy"],
  [/\balemania\b/gi, "Germany"],
  [/\breino unido\b/gi, "United Kingdom"],
  [/\bestados unidos\b/gi, "United States"],
  [/\bpaises bajos\b/gi, "Netherlands"],
  [/\bpaíses bajos\b/gi, "Netherlands"],
  [/\bsuiza\b/gi, "Switzerland"],
  [/\baustria\b/gi, "Austria"],
  [/\bportugal\b/gi, "Portugal"],
  [/\bgrecia\b/gi, "Greece"]
];

function getEventDateTime(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function getTodayInTimezone(timeZone = "UTC") {
  const now = new Date();

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);

  const year = parts.find(p => p.type === "year")?.value;
  const month = parts.find(p => p.type === "month")?.value;
  const day = parts.find(p => p.type === "day")?.value;

  return new Date(`${year}-${month}-${day}T00:00:00`);
}

function resolveDateReference(analysis, timeZone) {
  const ref = normalizeText(analysis.date_reference || "");
  const startDate = getTodayInTimezone(timeZone || "UTC");

  if (ref === "hoy") {
    return startDate;
  }

  if (ref === "manana" || ref === "mañana") {
    const d = new Date(startDate);
    d.setDate(d.getDate() + 1);
    return d;
  }

  const parsed = getEventDateTime(analysis.date_reference);
  if (parsed) return parsed;

  return null;
}

function getTripStartDate(tripJson) {
  const flights = tripJson.flightReservations || [];

  for (const reservation of flights) {
    for (const segment of reservation.segments || []) {
      const date = segment.departureDate || segment.departureDateTime;
      if (date) return new Date(date);
    }
  }

  const hotels = tripJson.hotelVouchers || [];
  if (hotels.length > 0 && hotels[0].checkIn) {
    return new Date(hotels[0].checkIn);
  }

  return null;
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
      const dateOnly = datePart ? String(datePart).split("T")[0] : null;
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
      const dateOnly = datePart ? String(datePart).split("T")[0] : null;
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
  if (next.type === "flight") return 180;
  if (current.type === "hotel_checkout" && next.type === "flight") return 180;
  if (next.type === "train") return 60;
  if (next.type === "activity") return 45;
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

function buildTripSummaryForClassifier(tripJson) {
  return {
    trip: tripJson.trip || {},
    hotels: (tripJson.hotelVouchers || []).map(h => ({
      name:
        h.accommodationName ||
        h.hotelName ||
        h.name ||
        null,
      address:
        h.accommodationAddress ||
        h.address ||
        null,
      checkIn: h.checkIn || null,
      checkOut: h.checkOut || null,
      city:
        h.city ||
        h.destination ||
        null
    })),
    flights: (tripJson.flightReservations || []).flatMap(r =>
      (r.segments || []).map(s => ({
        departureAirport: s.departureAirport || null,
        arrivalAirport: s.arrivalAirport || null,
        departureDate: s.departureDate || s.departureDateTime || null,
        arrivalDate: s.arrivalDate || s.arrivalDateTime || null,
        airlineCode: s.airlineCode || null,
        flightNumber: s.flightNumber || null
      }))
    ),
    services: (tripJson.serviceBookings || []).map(s => ({
      category: s.category || null,
      name:
        s.activity?.activityName ||
        s.transfer?.pickupLocation ||
        s.serviceName ||
        null,
      location:
        s.location ||
        s.activity?.location ||
        s.transfer?.pickupLocation ||
        s.transfer?.dropoffLocation ||
        null,
      date:
        s.activity?.date ||
        s.transfer?.date ||
        null
    }))
  };
}

function buildTripTimelineForClassifier(tripJson) {
  const items = [];

  for (const hotel of tripJson.hotelVouchers || []) {
    items.push({
      type: "hotel",
      name:
        hotel.accommodationName ||
        hotel.hotelName ||
        hotel.name ||
        null,
      address:
        hotel.accommodationAddress ||
        hotel.address ||
        null,
      city:
        hotel.city ||
        hotel.destination ||
        hotel.accommodationCity ||
        null,
      checkIn: hotel.checkIn || null,
      checkOut: hotel.checkOut || null,
      raw: hotel
    });
  }

  for (const reservation of tripJson.flightReservations || []) {
    for (const segment of reservation.segments || []) {
      items.push({
        type: "flight",
        title: `Vuelo ${segment.airlineCode || ""}${segment.flightNumber || ""}`,
        departureAirport: segment.departureAirport || null,
        arrivalAirport: segment.arrivalAirport || null,
        departureDate: segment.departureDate || segment.departureDateTime || null,
        arrivalDate: segment.arrivalDate || segment.arrivalDateTime || null,
        raw: segment
      });
    }
  }

  for (const service of tripJson.serviceBookings || []) {
    if (service.category === "transfer" && service.transfer) {
      items.push({
        type: "transfer",
        pickupLocation: service.transfer.pickupLocation || null,
        dropoffLocation: service.transfer.dropoffLocation || null,
        date: service.transfer.date || null,
        pickupTime: service.transfer.pickupTime || null,
        raw: service
      });
    }

    if (service.category === "activity" && service.activity) {
      items.push({
        type: "activity",
        name: service.activity.activityName || null,
        location: service.activity.location || service.location || null,
        date: service.activity.date || null,
        time: service.activity.time || null,
        raw: service
      });
    }
  }

  return items.sort((a, b) => {
    const aDate =
      a.departureDate ||
      a.arrivalDate ||
      a.checkIn ||
      a.checkOut ||
      a.date ||
      "";

    const bDate =
      b.departureDate ||
      b.arrivalDate ||
      b.checkIn ||
      b.checkOut ||
      b.date ||
      "";

    return String(aDate).localeCompare(String(bDate));
  });
}

function postProcessAnalysis(analysis) {
  if (!analysis || typeof analysis !== "object") {
    analysis = {};
  }

  return {
    intent: analysis.intent || "general",
    scope: analysis.scope || "all",
    city: analysis.city || null,
    date_reference: analysis.date_reference || null,
    tool_needed: analysis.tool_needed || "none",
    route_direction: analysis.route_direction || "unknown",
    route_mode: analysis.route_mode || "all",
    airport_code: analysis.airport_code || null,
    place_name: analysis.place_name || null,
    origin_query: analysis.origin_query || null,
    destination_query: analysis.destination_query || null,
    confidence: typeof analysis.confidence === "number" ? analysis.confidence : 0,
    needs_clarification: Boolean(analysis.needs_clarification),
    clarification_question: analysis.clarification_question || null
  };
}

async function classifyIntentWithDeepSeek(question, env, tripJson, conversationHistory = []) {
  const cleanHistory = Array.isArray(conversationHistory)
    ? conversationHistory
        .filter(m =>
          m &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string"
        )
        .slice(-8)
    : [];

const tripTimeline = buildTripTimelineForClassifier(tripJson);
const tripSummary = buildTripSummaryForClassifier(tripJson);
  
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
      max_tokens: 1600,
      messages: [
        {
          role: "system",
          content: `
Eres un clasificador avanzado para un concierge de viajes.

Tu trabajo NO es responder al cliente.
Tu trabajo es analizar la pregunta y el viaje completo para devolver SOLO JSON válido.

Debes usar:
1. El JSON completo del viaje.
2. El historial reciente de la conversación.
3. La pregunta actual.

Formato exacto de respuesta:

{
  "intent": "hotel | flight | activity | transfer | weather | nearby_places | emergency | itinerary | recommendation | route | general",
  "scope": "all | city | date | next_event | specific_item | trip_analysis | unknown",
  "city": "ciudad relevante si aplica, si no null",
  "date_reference": "hoy | mañana | fecha específica | null",
  "tool_needed": "none | route | places | weather",
  "route_direction": "airport_to_hotel | hotel_to_airport | hotel_to_place | place_to_hotel | point_to_point | unknown",
  "route_mode": "walking | driving | transit | all",
  "airport_code": "código IATA si aplica, si no null",
  "place_name": "lugar mencionado por el usuario si aplica, si no null",
  "origin_query": "origen textual completo para calcular ruta si aplica, si no null",
  "destination_query": "destino textual completo para calcular ruta si aplica, si no null",
  "confidence": 0-1,
  "needs_clarification": true/false,
  "clarification_question": "pregunta corta si falta un dato indispensable"
}

Principios:
- No respondas al usuario.
- No inventes datos.
- Usa el JSON completo del viaje para entender el orden real del itinerario.
- Usa vuelos, hoteles, check-in, check-out, fechas y ciudades para inferir desde dónde sale el viajero y hacia dónde va.
- Si el usuario dice algo como "cuando salga de mi hotel para ir a X", identifica el hotel correcto según la etapa previa del itinerario, no necesariamente el hotel de X.
- Si el usuario dice "cuando llegue a X", normalmente quiere ruta desde aeropuerto/estación/lugar de llegada hacia su hotel en X.
- Si hay una ruta calculable, llena origin_query y destination_query con textos completos y geocodificables.
- Para hoteles, usa nombre + dirección + ciudad si están disponibles.
- Para aeropuertos, usa código IATA + nombre o ciudad si está disponible.
- Para estaciones, terminales o puntos de interés, usa el nombre del lugar más ciudad.
- Solo pide aclaración si de verdad falta un dato indispensable y no puede inferirse del viaje.
- Si es una pregunta general de movilidad sin destino concreto, puedes usar intent="route" pero origin_query o destination_query pueden ser null.
- Responde SOLO JSON válido.

- Si el usuario dice "cuando vaya a X", "para ir a X", "cuando me vaya a X", "cuando salga hacia X" o algo equivalente, interpreta que pregunta por la salida desde la etapa anterior del itinerario hacia X.
- Para resolverlo, usa la línea de tiempo cronológica:
  1. Identifica la ciudad o destino X.
  2. Encuentra el tramo de transporte que lleva hacia X, si existe.
  3. Encuentra el hotel inmediatamente anterior a ese tramo.
  4. Usa ese hotel como origin_query.
  5. Usa como destination_query el aeropuerto, estación, terminal o punto de salida de ese tramo.
- No uses el hotel de X como origen cuando la pregunta sea sobre "ir a X", salvo que el usuario diga claramente que ya está en X.
- Si no puedes identificar una estación, aeropuerto o terminal exacta de salida, pero sí sabes que el usuario pregunta por salir del hotel anterior hacia otro destino, devuelve:
  route_direction="hotel_to_place",
  origin_query con el hotel anterior,
  destination_query=null,
  needs_clarification=true,
  clarification_question preguntando desde qué aeropuerto, estación o punto saldrá hacia ese destino.

`
        },
        ...cleanHistory,
        {
          role: "user",
          content:
  "Resumen estructurado del viaje:\n" +
  JSON.stringify(tripSummary) +
  "\n\nLínea de tiempo cronológica del viaje:\n" +
  JSON.stringify(tripTimeline) +
  "\n\nJSON completo del viaje, por si necesitas validar algún dato:\n" +
  JSON.stringify(tripJson) +
  "\n\nPregunta actual del usuario:\n" +
  question
        }
      ]
    })
  });

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "{}";
  const parsed = extractJsonObject(content);

  if (parsed) {
    return postProcessAnalysis(parsed);
  }

  return postProcessAnalysis({
    intent: "general",
    scope: "all",
    city: null,
    date_reference: null,
    tool_needed: "none",
    route_direction: "unknown",
    route_mode: "all",
    airport_code: null,
    place_name: null,
    origin_query: null,
    destination_query: null,
    confidence: 0,
    needs_clarification: false,
    clarification_question: null
  });
}

function buildContextByIntent(tripJson, analysis, timeZone) {
  const intent = analysis.intent || "general";
  const scope = analysis.scope || "all";
  const city = normalizeText(analysis.city || "");

  const base = {
    trip: tripJson.trip || {},
    metadata: tripJson.metadata || {}
  };

  const date = resolveDateReference(analysis, timeZone);

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
        matchesCity(h.accommodationAddress) ||
        matchesCity(h.accommodationName) ||
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

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean).map(v => String(v).trim()).filter(Boolean))];
}

function replaceCountryAliases(query) {
  let result = String(query || "");

  for (const [pattern, replacement] of COUNTRY_ALIASES) {
    result = result.replace(pattern, replacement);
  }

  return result;
}

function simplifyPlaceQuery(query) {
  return String(query || "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[“”"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  return [
    normalizeText(query),
    normalizeText(options.city || ""),
    normalizeText(options.country || "")
  ].join("|");
}

async function rememberGeocodeResult(env, cacheKey, value) {
  if (!cacheKey || !env?.TRIPS) return;
  try {
    await env.TRIPS.put("geo:" + cacheKey, JSON.stringify(value), { expirationTtl: GEOCODE_CACHE_TTL });
  } catch (_) {}
}

function buildGeocodeQueries(query, city = null, country = null) {
  const original = String(query || "").trim();
  if (!original) return [];

  const simplified = simplifyPlaceQuery(original);
  const withoutGenericWords = removeGenericPlaceWords(simplified);
  const countryAdjustedOriginal = replaceCountryAliases(original);
  const countryAdjustedSimplified = replaceCountryAliases(simplified);
  const commaParts = simplified.split(",").map(part => part.trim()).filter(Boolean);
  const addressWithoutPlaceName = commaParts.length > 1 ? commaParts.slice(1).join(", ") : "";
  const iataCode = extractIataCode(original);
  const airportLike =
    /\b(aeropuerto|airport|aéroport|aeroport|flughafen|aeroporto)\b/i.test(original) ||
    Boolean(iataCode);

  const cityText = city ? String(city).trim() : "";
  const countryText = country ? String(country).trim() : "";

  const baseQueries = [
    original,
    countryAdjustedOriginal,
    simplified,
    countryAdjustedSimplified,
    withoutGenericWords,
    addressWithoutPlaceName,
    replaceCountryAliases(addressWithoutPlaceName)
  ];

  if (airportLike && iataCode) {
    baseQueries.unshift(
      `${iataCode} airport`,
      cityText ? `${cityText} ${iataCode} airport` : null
    );
  }

  if (airportLike) {
    const airportName = simplified
      .replace(/\([^)]*\)/g, " ")
      .replace(/\b(aeropuerto|airport|aéroport|aeroport|flughafen|aeroporto)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^(de|del|la|el|le|les|the|di|da|do|du)\s+/i, "")
      .trim();

    if (airportName) {
      baseQueries.push(`${airportName} Airport`);
    }
  }

  const expandedQueries = [];

  for (const q of baseQueries) {
    if (!q) continue;

    expandedQueries.push(q);

    if (cityText && !normalizeText(q).includes(normalizeText(cityText))) {
      expandedQueries.push(`${q}, ${cityText}`);
    }

    if (countryText && !normalizeText(q).includes(normalizeText(countryText))) {
      expandedQueries.push(`${q}, ${countryText}`);
    }

    if (
      cityText &&
      countryText &&
      !normalizeText(q).includes(normalizeText(cityText))
    ) {
      expandedQueries.push(`${q}, ${cityText}, ${countryText}`);
    }
  }

  return uniqueValues(expandedQueries);
}

async function geocodeDetailed(query, options = {}, env = null) {
  if (!query) {
    return {
      query: null,
      result: null,
      attempted_queries: [],
      attempted_query: null,
      status: "missing_query",
      error: "missing_query"
    };
  }

  const cacheKey = getGeocodeCacheKey(query, options);

  if (env?.TRIPS) {
    try {
      const cached = await env.TRIPS.get("geo:" + cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (_) {}
  }

  const queries = buildGeocodeQueries(
    query,
    options.city || null,
    options.country || null
  );
  const attemptedQueries = [];
  let lastError = null;

  for (const candidate of queries) {
    attemptedQueries.push(candidate);

    try {
      const params = new URLSearchParams({
        q: candidate,
        format: "jsonv2",
        limit: "1",
        addressdetails: "1",
        namedetails: "1",
        "accept-language": "es,en"
      });

      const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "Yompr Concierge travel assistant"
        }
      });

      if (!res.ok) {
        lastError = `HTTP ${res.status}${res.statusText ? " " + res.statusText : ""}`;
        continue;
      }

      const data = await res.json();

      if (Array.isArray(data) && data.length) {
        const lat = parseFloat(data[0].lat);
        const lon = parseFloat(data[0].lon);

        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          const value = {
            query,
            result: {
              query,
              attempted_query: candidate,
              display_name: data[0].display_name || null,
              lat,
              lon
            },
            attempted_queries: attemptedQueries,
            attempted_query: candidate,
            status: "found",
            error: null
          };

          await rememberGeocodeResult(env, cacheKey, value);
          return value;
        }
      }
    } catch (error) {
      lastError = String(error);
    }
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

async function geocode(query, options = {}, env = null) {
  const detailed = await geocodeDetailed(query, options, env);
  return detailed.result;
}

async function getRoute(from, to, mode = "driving") {
  try {
    const profileMap = {
      driving: "driving",
      walking: "foot"
    };

    const profile = profileMap[mode] || "driving";

    const url =
      `https://router.project-osrm.org/route/v1/${profile}/` +
      `${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;

    const res = await fetch(url);

    if (!res.ok) return null;

    const data = await res.json();

    if (!data.routes?.length) return null;

    const route = data.routes[0];

    return {
      mode,
      distance_km: route.distance / 1000,
      duration_min: route.duration / 60
    };
  } catch (_) {
    return null;
  }
}

function buildGoogleMapsLink(origin, destination, mode = null) {
  if (!destination) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(origin || "")}`;
  }

  let url =
    `https://www.google.com/maps/dir/?api=1` +
    `&origin=${encodeURIComponent(origin || "")}` +
    `&destination=${encodeURIComponent(destination || "")}`;

  if (mode) {
    url += `&travelmode=${encodeURIComponent(mode)}`;
  }

  return url;
}

async function enrichWithTransportInfo(tripJson, analysis, env = null) {
  if (analysis.tool_needed !== "route" && analysis.intent !== "route") {
    return null;
  }

  const origin = analysis.origin_query || null;
  const destination = analysis.destination_query || null;
  const requestedMode = analysis.route_mode || "all";

  if (!origin && !destination) {
    return {
      type: "route_missing_origin_destination",
      route_direction: analysis.route_direction || "unknown",
      route_mode: requestedMode,
      origin: null,
      destination: null,
      place_name: analysis.place_name || null,
      city: analysis.city || null,
      note: "No se recibieron origen y destino suficientes para calcular una ruta."
    };
  }

  if (origin && !destination) {
    return {
      type: "route_without_destination",
      route_direction: analysis.route_direction || "unknown",
      route_mode: requestedMode,
      origin,
      destination: null,
      place_name: analysis.place_name || null,
      city: analysis.city || null,
      note: "El usuario pidió movilidad o alternativas de transporte, pero no indicó un destino concreto. No se puede calcular distancia o duración exacta sin destino.",
      maps_link: buildGoogleMapsLink(origin, null)
    };
  }

  if (!origin && destination) {
    return {
      type: "route_without_origin",
      route_direction: analysis.route_direction || "unknown",
      route_mode: requestedMode,
      origin: null,
      destination,
      place_name: analysis.place_name || null,
      city: analysis.city || null,
      note: "Hay destino, pero falta origen para calcular la ruta.",
      maps_link: buildGoogleMapsLink(destination, null)
    };
  }

const originGeo = await geocodeDetailed(origin, {
  city: analysis.city || null,
  country: null
}, env);

const destinationGeo = await geocodeDetailed(destination, {
  city: analysis.city || null,
  country: null
}, env);

const originCoords = originGeo.result;
const destinationCoords = destinationGeo.result;

  if (!originCoords || !destinationCoords) {
    const geocodeError = [
      !originCoords ? `origin: ${originGeo.error || originGeo.status}` : null,
      !destinationCoords ? `destination: ${destinationGeo.error || destinationGeo.status}` : null
    ].filter(Boolean).join(" | ");

    return {
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
      maps_link: buildGoogleMapsLink(origin, destination)
    };
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
      note: "El transporte público requiere horarios y rutas en tiempo real; confirma el tiempo exacto en Google Maps."
    }
  };

  let routeError = null;

  if (requestedMode === "walking" && !options.walking) {
    routeError = "walking_route_not_found";
  } else if (requestedMode === "driving" && !options.driving) {
    routeError = "driving_route_not_found";
  } else if (requestedMode === "all" && !options.walking && !options.driving) {
    routeError = "osrm_route_not_found";
  }

  if (routeError) {
    return {
      type: "route_calculation_failed",
      route_direction: analysis.route_direction || "unknown",
      route_mode: requestedMode,
      origin,
      destination,
      place_name: analysis.place_name || null,
      city: analysis.city || null,
      duration_min: null,
      distance_km: null,
      maps_link: buildGoogleMapsLink(origin, destination),
      geocode_origin_display_name: originCoords.display_name || null,
      geocode_destination_display_name: destinationCoords.display_name || null,
      geocode_origin_attempted_query: originGeo.attempted_queries.join(" | ") || originCoords.attempted_query || null,
      geocode_destination_attempted_query: destinationGeo.attempted_queries.join(" | ") || destinationCoords.attempted_query || null,
      geocode_origin_error: null,
      geocode_destination_error: null,
      geocode_error: null,
      route_error: routeError,
      options
    };
  }

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
    type: "calculated_route",
    route_direction: analysis.route_direction || "unknown",
    route_mode: requestedMode,
    origin,
    destination,
    place_name: analysis.place_name || null,
    city: analysis.city || null,
    duration_min: primary?.duration_min || null,
    distance_km: primary?.distance_km || null,
    maps_link: primary?.maps_link || buildGoogleMapsLink(origin, destination),
    geocode_origin_display_name: originCoords.display_name || null,
    geocode_destination_display_name: destinationCoords.display_name || null,
    options,
    geocode_origin_attempted_query: originGeo.attempted_queries.join(" | ") || originCoords.attempted_query || null,
    geocode_destination_attempted_query: destinationGeo.attempted_queries.join(" | ") || destinationCoords.attempted_query || null,
    geocode_origin_error: null,
    geocode_destination_error: null,
    geocode_error: null
  };
}

async function saveChatLog(env, log) {
  try {
    const tripId = log.trip_id || "unknown";
    const logId = tripId + "-" + Date.now() + "-" + Math.random().toString(36).slice(2);

    await env.CHAT_LOGS.put(logId, JSON.stringify({
      created_at: new Date().toISOString(),
      trip_id: tripId,
      question: log.question || "",
      intent: log.intent || "",
      scope: log.scope || "",
      city: log.city || "",
      answer: log.answer || "",
      context_characters: log.context_characters || 0,
      approximate_context_tokens: log.approximate_context_tokens || 0,
      analysis_thinking_enabled: log.analysis_thinking_enabled || false,
      thinking_enabled: log.thinking_enabled || false,
      session_history_messages: log.session_history_messages || 0,

      transport_used: log.transport_used || false,
      transport_type: log.transport_type || null,
      transport_duration_min: log.transport_duration_min || null,
      transport_distance_km: log.transport_distance_km || null,
      transport_origin: log.transport_origin || null,
      transport_destination: log.transport_destination || null,
      transport_error: log.transport_error || null,

      route_direction: log.route_direction || null,
      route_mode: log.route_mode || null,
      place_name: log.place_name || null,
      geocode_origin: log.geocode_origin || null,
      geocode_destination: log.geocode_destination || null,

      error_stage: log.error_stage || null,
      raw_error: log.raw_error || null,

      used_transport_in_answer: log.used_transport_in_answer || false,

      geocode_origin_attempted_query: log.geocode_origin_attempted_query || null,
      geocode_destination_attempted_query: log.geocode_destination_attempted_query || null,
      geocode_origin_error: log.geocode_origin_error || null,
      geocode_destination_error: log.geocode_destination_error || null
    }));
  } catch (e) {
    console.log("Error saving chat log:", String(e));
  }
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

      const list = await env.CHAT_LOGS.list({ limit: 200 });
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
    <td>${escapeHtml(log.transport_type || "")}</td>
    <td>${escapeHtml(log.transport_duration_min || "")}</td>
    <td>${escapeHtml(log.transport_distance_km || "")}</td>
    <td>${escapeHtml(log.transport_error || "")}</td>
    <td>${escapeHtml(log.route_direction || "")}</td>
    <td>${escapeHtml(log.route_mode || "")}</td>
    <td style="max-width: 220px; white-space: pre-wrap;">${escapeHtml(log.transport_origin || "")}</td>
    <td style="max-width: 220px; white-space: pre-wrap;">${escapeHtml(log.transport_destination || "")}</td>
    <td style="max-width: 180px; white-space: pre-wrap;">${escapeHtml(log.place_name || "")}</td>
    <td>${escapeHtml(log.geocode_origin || "")}</td>
    <td>${escapeHtml(log.geocode_destination || "")}</td>
    <td style="max-width: 280px; white-space: pre-wrap;">${escapeHtml(log.geocode_origin_attempted_query || "")}</td>
    <td style="max-width: 280px; white-space: pre-wrap;">${escapeHtml(log.geocode_destination_attempted_query || "")}</td>
    <td style="max-width: 180px; white-space: pre-wrap;">${escapeHtml(log.geocode_origin_error || "")}</td>
    <td style="max-width: 180px; white-space: pre-wrap;">${escapeHtml(log.geocode_destination_error || "")}</td>
    <td style="max-width: 260px; white-space: pre-wrap;">${escapeHtml(log.question || "")}</td>
    <td style="max-width: 480px; white-space: pre-wrap;">${escapeHtml(log.answer || "")}</td>
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
  <p>Últimas 200 preguntas registradas.</p>

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
        <th>Transport type</th>
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
        <th>Origin attempted</th>
        <th>Destination attempted</th>
        <th>Origin error</th>
        <th>Destination error</th>
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
  let tripId = "unknown";
  let question = "";

  try {
    const body = await request.json();

    tripId = body.tripId || "unknown";
    question = body.question || "";

    const {
      timeZone,
      localDate,
      conversationHistory = []
    } = body;

        const tripText = await env.TRIPS.get(tripId);

        if (!tripText) {
          return Response.json({ answer: "No encontré el viaje." }, { status: 404 });
        }

        const tripJson = JSON.parse(tripText);

let analysis = await classifyIntentWithDeepSeek(
  question,
  env,
  tripJson,
  conversationHistory
);
        if (analysis.needs_clarification) {
  const clarificationAnswer =
    analysis.clarification_question ||
    "¿Podrías darme un poco más de detalle para ayudarte mejor?";

  await saveChatLog(env, {
    trip_id: tripId,
    question,
    intent: "clarification",
    scope: analysis.scope || "unknown",
    city: analysis.city || null,
    answer: clarificationAnswer,
    analysis_thinking_enabled: true,
    thinking_enabled: false,
    session_history_messages: Array.isArray(conversationHistory) ? conversationHistory.length : 0,
    route_direction: analysis.route_direction || null,
    route_mode: analysis.route_mode || null,
    place_name: analysis.place_name || null
  });

  return Response.json({
    answer: clarificationAnswer,
    intent: "clarification"
  });
}

        const context = buildContextByIntent(tripJson, analysis, timeZone);
        const intent = analysis.intent || "general";
        const conflicts = detectBasicConflicts(tripJson);
        context.detected_conflicts = conflicts;

        let transportInfo = null;
        let transportUsed = false;
        let transportError = null;

        try {
          transportInfo = await enrichWithTransportInfo(tripJson, analysis, env);

          if (transportInfo) {
            context.transport_info = transportInfo;
            transportUsed = transportInfo.type === "calculated_route";
          }
        } catch (e) {
          transportUsed = false;
          transportError = String(e);
        }

        const questionNorm = normalizeText(question);

        const needsThinking =
  intent === "recommendation" ||
  analysis.scope === "trip_analysis" ||
  questionNorm.includes("conflicto") ||
  questionNorm.includes("pesado") ||
  questionNorm.includes("conviene") ||
  questionNorm.includes("mejor dia") ||
  questionNorm.includes("mejor día") ||
  questionNorm.includes("que dia") ||
  questionNorm.includes("qué día") ||
  questionNorm.includes("en que ciudad") ||
  questionNorm.includes("en qué ciudad") ||
  questionNorm.includes("salir") ||
  questionNorm.includes("noche") ||
  questionNorm.includes("bar") ||
  questionNorm.includes("cena") ||
  questionNorm.includes("cenar") ||
  questionNorm.includes("tengo tiempo") ||
  questionNorm.includes("me da tiempo") ||
  questionNorm.includes("riesgo");

        const cleanHistory = Array.isArray(conversationHistory)
          ? conversationHistory
              .filter(m =>
                m &&
                (m.role === "user" || m.role === "assistant") &&
                typeof m.content === "string"
              )
              .slice(-8)
          : [];

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
            max_tokens: needsThinking ? 3000 : 1200,
            messages: [
              {
                role: "system",
                content: `
Eres Yompr Personal Concierge, un asistente de viaje premium. Responde en español amable, cálido, profesional, claro, natural y elegante, como el mejor asistente personal del mundo.

Usa solo la información del viaje proporcionada y los datos calculados en transport_info. Si no sabes algo con certeza, dilo. No inventes datos.

La respuesta debe ser concisa, lógica y responder lo que el cliente necesita sin hacerla innecesariamente extensa.
No seas condescendiente, sé amable y directo.
Las respuestas deben leerse naturales y como una conversación entre personas, no máquinas.
Responde en texto plano. No uses Markdown, encabezados con ###, tablas ni asteriscos para negritas.

Puedes usar el historial reciente de esta sesión para entender referencias como:
- "¿y en taxi?"
- "¿y desde ahí?"
- "¿cuánto tarda?"
- "¿y después?"
- "¿qué me recomiendas?"

Fechas:
- No uses createdAt, modifiedAt ni exportedAt como fechas del viaje; son fechas administrativas.
- Para determinar inicio, fin o días del viaje, usa vuelos, check-in/check-out, actividades y servicios.

Antes del viaje:
- Si el viaje aún no ha comenzado, explica que todavía no inicia.
- Menciona cuándo inicia y cuál es el primer evento relevante.
- Ofrece ayuda útil: documentos, equipaje, recomendaciones o preparación.

Riesgos:
- Si el contexto incluye detected_conflicts, menciona solo los relevantes para la pregunta del cliente.
- Prioriza como riesgos reales: vuelos, traslados, trenes, actividades y tiempos insuficientes entre ellos.
- Si hay insufficient_buffer antes de un vuelo, trátalo como riesgo importante.
- El check-in y check-out del hotel son ventanas o límites administrativos, no eventos fijos.
- No trates un vuelo antes del check-out estándar como conflicto crítico. Solo recomienda check-out anticipado y preparar equipaje con tiempo.
- No recomiendes late check-out para resolver salidas tempranas.

Recomendaciones de días / planes:
- Cuando el usuario pida "mejor día", "qué día conviene", "en qué ciudad", "salir de noche", "cenar", "tomar algo" o planes que impliquen cansancio, evalúa SIEMPRE el día siguiente.
- Penaliza fuertemente cualquier noche previa a vuelo temprano, traslado temprano, cambio de ciudad, check-out temprano, tour o actividad importante por la mañana.
- No recomiendes como mejor opción una noche si al día siguiente hay que madrugar, aunque esa ciudad sea atractiva.
- Compara explícitamente 2 o 3 opciones y elige la que tenga menor impacto logístico.
- Si una opción es atractiva pero logísticamente mala, dilo claramente.
- La mejor recomendación debe balancear experiencia, descanso y riesgo operativo del día siguiente.
- Si recomiendas entre varios días, baja prioridad a noches antes de vuelos o traslados tempranos, prefiere noches donde el día siguiente sea libre, ligero o sin cambio de ciudad.

Estilo:
- No seas redundante.
- No uses lenguaje técnico.
- Si haces una lista, termínala completa y cierra con una conclusión breve.
- Si detectas emergencia o problema serio, recomienda contactar a Rigo.

Rutas:
- Si transport_info.type = "calculated_route", usa transport_info como fuente principal para distancias y tiempos.
- Si transport_info.options existe, puedes comparar caminando, taxi/coche y transporte público.
- Para caminatas, usa solo transport_info.options.walking.
- Para taxi/coche, usa solo transport_info.options.driving.
- Para transporte público, si duration_min es null, NO inventes duración: di que debe confirmarse en el link de Google Maps por horarios en tiempo real.
- No inventes tiempos de ruta.
- No digas que algo queda a pocos minutos caminando si transport_info.options.walking indica otro tiempo.
- Si el usuario pregunta “está cerca”, responde con distancia y duración caminando cuando estén disponibles.
- Si transport_info.type = "route_without_destination", NO des tiempos ni alternativas como si fueran definitivas. Explica que falta el destino exacto para calcular la ruta y pide el aeropuerto, estación, terminal o punto al que quiere ir.
- Si transport_info.type = "geocoding_failed", no inventes distancia, duración ni rangos aproximados por conocimiento general. Di que no se pudo calcular la ruta con precisión, ofrece el enlace de Google Maps si existe y pide una dirección más precisa si hace falta.
- Si transport_info.type = "route_calculation_failed", no inventes tiempos ni distancias. Di que sí se ubicaron origen/destino, pero no se pudo calcular la ruta por OSRM; ofrece el enlace de Google Maps.
- Si el análisis estructurado incluye origin_query y destination_query, respétalos como la interpretación principal de la ruta.
- No cambies la ciudad o el hotel de origen si origin_query ya fue resuelto por el clasificador.
- Si el usuario habla de "ir a", "salir hacia", "cuando vaya a" otra ciudad, revisa el JSON completo para ubicar la etapa previa del viaje.
- Antes de responder rutas entre ciudades o cambios de destino, verifica la secuencia real del viaje en el JSON completo.
`
              },
              ...cleanHistory,
              {
                role: "user",
                content:
                  "Análisis estructurado:\n" +
                  JSON.stringify(analysis) +
                  "\n\nZona horaria del cliente: " + (timeZone || "desconocida") +
                  "\nFecha local del cliente: " + (localDate || "desconocida") +
                 "\\n\\nContexto filtrado del viaje:\\n" +
JSON.stringify(context) +
"\\n\\nJSON completo del viaje para verificar secuencia, fechas y traslados:\\n" +
JSON.stringify(tripJson) +
"\\n\\nPregunta actual del cliente:\\n" +
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

      await saveChatLog(env, {
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
  transport_type: transportInfo?.type || null,
  transport_duration_min: transportInfo?.duration_min || null,
  transport_distance_km: transportInfo?.distance_km || null,
  transport_origin: transportInfo?.origin || null,
  transport_destination: transportInfo?.destination || null,
  transport_error: transportError || transportInfo?.geocode_error || transportInfo?.route_error || null,

  route_direction: analysis.route_direction || null,
  route_mode: analysis.route_mode || null,
  place_name: analysis.place_name || null,
  geocode_origin: transportInfo?.geocode_origin_display_name || null,
  geocode_destination: transportInfo?.geocode_destination_display_name || null,
  geocode_origin_attempted_query: transportInfo?.geocode_origin_attempted_query || null,
  geocode_destination_attempted_query: transportInfo?.geocode_destination_attempted_query || null,
  geocode_origin_error: transportInfo?.geocode_origin_error || null,
  geocode_destination_error: transportInfo?.geocode_destination_error || null,

  used_transport_in_answer:
    answer.includes("estimado") ||
    answer.includes("Google Maps") ||
    answer.includes("caminando") ||
    answer.includes("taxi") ||
    answer.includes("transporte público")
});

        return Response.json({ answer, intent });
           } catch (e) {
        const errorAnswer = "Error al procesar la pregunta: " + String(e);

        await saveChatLog(env, {
          trip_id: tripId,
          question,
          intent: "error",
          scope: "unknown",
          city: null,
          answer: errorAnswer,
          error_stage: "api_chat_catch",
          raw_error: String(e)
        });

        return Response.json({
          answer: errorAnswer
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

      const tripName = escapeHtml(trip.name || "Yompr Concierge");
      const destinationText = trip.destination
        ? "Destino: " + escapeHtml(trip.destination)
        : "Tu concierge personal de viaje";

      return new Response(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${tripName}</title>

  <style>
    * {
      box-sizing: border-box;
    }

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

    .message-row.user {
      justify-content: flex-end;
    }

    .message-row.assistant {
      justify-content: flex-start;
    }

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

    .composer input:focus {
      border-color: #111827;
    }

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

      .header {
        padding: 14px 16px;
      }

      .messages {
        padding: 14px;
      }
    }
  </style>
</head>

<body>
  <div class="app">
    <div class="header">
      <h1>${tripName}</h1>
      <p>${destinationText}</p>

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
      if (event.key === "Enter") {
        ask();
      }
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

      const localDate = new Date().toLocaleDateString("en-CA", {
        timeZone: timeZone
      });

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tripId: "${tripId}",
            question: question,
            timeZone: timeZone,
            localDate: localDate,
            conversationHistory: conversationHistory
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

        conversationHistory.push({
          role: "user",
          content: question
        });

        conversationHistory.push({
          role: "assistant",
          content: answer
        });

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
