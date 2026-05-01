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

function inferCityFromQuestion(question) {
  const q = normalizeText(question);

  if (q.includes("paris")) return "París";
  if (q.includes("roma")) return "Roma";
  if (q.includes("venecia")) return "Venecia";
  if (q.includes("barcelona")) return "Barcelona";

  return null;
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

function airportCodeForCity(city) {
  const c = normalizeText(city || "");

  const map = {
    paris: "CDG",
    roma: "FCO",
    venecia: "VCE",
    barcelona: "BCN"
  };

  return map[c] || null;
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
    q.includes("traslado");

  if (!analysis || typeof analysis !== "object") {
    analysis = {};
  }

  if (isRouteQuestion) {
    analysis.intent = "route";
    analysis.tool_needed = "route";
    analysis.needs_clarification = false;
    analysis.clarification_question = null;

    if (!analysis.city) {
      analysis.city = inferCityFromQuestion(question);
    }

    if (!analysis.scope || analysis.scope === "unknown") {
      analysis.scope = analysis.city ? "city" : "all";
    }

    if (!analysis.route_direction || analysis.route_direction === "unknown") {
      analysis.route_direction = inferRouteDirectionFromQuestion(question);
    }

    if (!analysis.airport_code && analysis.city) {
      analysis.airport_code = airportCodeForCity(analysis.city);
    }
  }

  return analysis;
}

function airportLabelForCode(code) {
  const map = {
    CDG: "Charles de Gaulle Airport",
    FCO: "Rome Fiumicino Airport",
    VCE: "Venice Marco Polo Airport",
    BCN: "Barcelona El Prat Airport"
  };

  return map[code] || `${code} airport`;
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
    lon: parseFloat(data[0].lon)
  };
}

async function getRoute(from, to) {
  const url = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;

  const res = await fetch(url);
  const data = await res.json();

  if (!data.routes?.length) return null;

  const route = data.routes[0];

  return {
    distance_km: route.distance / 1000,
    duration_min: route.duration / 60
  };
}

function buildGoogleMapsLink(origin, destination) {
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}`;
}

async function enrichWithTransportInfo(tripJson, analysis) {
  if (analysis.tool_needed !== "route" && analysis.intent !== "route") {
    return null;
  }

  const city = normalizeText(analysis.city || "");
  const routeDirection = analysis.route_direction || "unknown";

  if (!city) return null;

  const hotels = tripJson.hotelVouchers || [];
  const allSegments = (tripJson.flightReservations || []).flatMap(r => r.segments || []);

  const hotel = hotels.find(h =>
    normalizeText(JSON.stringify(h)).includes(city)
  );

  if (!hotel?.accommodationAddress) return null;

  let airportCode = analysis.airport_code || airportCodeForCity(analysis.city);

  if (!airportCode) return null;

  let segment = null;

  if (routeDirection === "airport_to_hotel") {
    segment = allSegments.find(s => s.arrivalAirport === airportCode);
    airportCode = segment?.arrivalAirport || airportCode;
  } else if (routeDirection === "hotel_to_airport") {
    segment = allSegments.find(s => s.departureAirport === airportCode);
    airportCode = segment?.departureAirport || airportCode;
  } else {
    segment = allSegments.find(s =>
      s.arrivalAirport === airportCode || s.departureAirport === airportCode
    );
  }

  const hotelAddress = hotel.accommodationAddress;
  const airportAddress = airportLabelForCode(airportCode);

  let origin = hotelAddress;
  let destination = airportAddress;

  if (routeDirection === "airport_to_hotel") {
    origin = airportAddress;
    destination = hotelAddress;
  } else if (routeDirection === "hotel_to_airport") {
    origin = hotelAddress;
    destination = airportAddress;
  } else {
    return null;
  }

  const originCoords = await geocode(origin);
  const destinationCoords = await geocode(destination);

  if (!originCoords || !destinationCoords) return null;

  const route = await getRoute(originCoords, destinationCoords);

  if (!route) return null;

  return {
    city: analysis.city || null,
    route_direction: routeDirection,
    origin,
    destination,
    airport_code: airportCode,
    duration_min: Math.round(route.duration_min),
    distance_km: Math.round(route.distance_km),
    maps_link: buildGoogleMapsLink(origin, destination)
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
        start: getEventDateTime(segment.departureDate),
        end: getEventDateTime(segment.arrivalDate)
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

function detectIntentLocal(question) {
  const q = question.toLowerCase();

  if (
    q.includes("aeropuerto") ||
    q.includes("qué tan lejos") ||
    q.includes("que tan lejos") ||
    q.includes("cómo llego") ||
    q.includes("como llego") ||
    q.includes("ruta") ||
    q.includes("traslado")
  ) {
    return "unknown";
  }

  const intents = {
    hotel: ["hotel", "hospedaje", "alojamiento", "quedo", "quedar", "dormir", "habitación", "habitacion", "check in", "check-in", "pernoctar"],
    flight: ["llegamos", "llega", "llegar", "salimos", "salir", "hora llegamos", "hora llega", "vuelo", "avión", "avion", "aeropuerto", "aerolínea", "aerolinea", "despega", "sale mi vuelo", "maleta", "equipaje", "terminal"],
    activity: ["actividad", "tour", "excursión", "excursion", "boleto", "entrada", "evento"],
    transfer: ["traslado", "chofer", "pickup", "recogida", "transporte"],
    emergency: ["emergencia", "cancelaron", "perdí", "perdi", "no aparece", "ayuda urgente", "pasaporte", "accidente"],
    weather: ["clima", "llover", "lluvia", "temperatura", "frío", "frio", "calor"],
    nearby_places: ["cerca", "restaurante", "farmacia", "cajero", "supermercado", "comer"]
  };

  for (const [intent, words] of Object.entries(intents)) {
    if (words.some(word => q.includes(word))) return intent;
  }

  return "unknown";
}

async function classifyIntentWithDeepSeek(question, env) {
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
      max_tokens: 500,
      messages: [
        {
          role: "system",
          content: `
Eres un analista de intención para un concierge de viajes.

Responde SOLO JSON válido con este formato:

{
  "intent": "hotel | flight | activity | transfer | weather | nearby_places | emergency | itinerary | recommendation | route | general",
  "scope": "all | city | date | next_event | specific_item | trip_analysis | unknown",
  "city": "nombre de ciudad si aplica, si no null",
  "date_reference": "hoy | mañana | fecha específica | null",
  "tool_needed": "none | route | places | weather",
  "route_direction": "airport_to_hotel | hotel_to_airport | hotel_to_place | unknown",
  "airport_code": "código IATA si aplica, si no null",
  "confidence": 0-1,
  "needs_clarification": true/false,
  "clarification_question": "pregunta corta si hace falta aclarar"
}

Reglas:
- Si pregunta por distancia, ruta, aeropuerto, cómo llegar o traslado, usa intent="route" y tool_needed="route".
- Si dice "cuando llego", "al llegar", "llegada", usa route_direction="airport_to_hotel".
- Si dice "cuando salgo", "para mi vuelo", "al aeropuerto", "regreso", usa route_direction="hotel_to_airport".
- Si menciona París, Roma, Venecia o Barcelona, usa scope="city" y city correspondiente.
- Si puedes inferir el aeropuerto por ciudad o vuelo, llena airport_code.
- No pidas aclaración si se puede resolver revisando el itinerario.
- Solo pide aclaración si realmente faltan datos indispensables.
- Responde SOLO JSON válido.
- Para preguntas sobre aeropuerto, distancia, ruta o cómo llegar, NO pidas aclaración si aparece una ciudad del itinerario.
- Si el usuario dice "cuando llego", interpreta que quiere la ruta desde el aeropuerto de llegada hacia el hotel.
- Si el usuario dice "cuando salgo", "regreso" o "para mi vuelo", interpreta que quiere la ruta desde el hotel hacia el aeropuerto de salida.
- Si no estás seguro pero la ciudad está clara, usa intent="route", tool_needed="route" y route_direction según la mejor inferencia.
`
        },
        {
          role: "user",
          content: question
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
    airport_code: null,
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
  const ref = (analysis.date_reference || "").toLowerCase();

  const startDate = getTodayInTimezone(timeZone || "UTC");

  if (ref === "hoy") {
    return startDate;
  }

  if (ref === "mañana") {
    const d = new Date(startDate);
    d.setDate(d.getDate() + 1);
    return d;
  }

  return null;
}

function getTripStartDate(tripJson) {
  const flights = tripJson.flightReservations || [];

  if (flights.length > 0) {
    const firstFlight = flights[0];
    const date = firstFlight.departureDate || firstFlight.departureDateTime;
    if (date) return new Date(date);
  }

  const hotels = tripJson.hotelVouchers || [];
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
    const matchesCity = (text) => normalizeText(text).includes(city);

    return {
      ...base,
      flightReservations: tripJson.flightReservations || [],
      hotelVouchers: (tripJson.hotelVouchers || []).filter(h =>
        matchesCity(h.accommodationAddress) ||
        matchesCity(h.accommodationName)
      ),
      serviceBookings: (tripJson.serviceBookings || []).filter(s =>
        matchesCity(s.location) ||
        normalizeText(JSON.stringify(s)).includes(city)
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
    <td>${log.created_at || ""}</td>
    <td>${log.trip_id || ""}</td>
    <td>${log.intent || ""}</td>
    <td>${log.scope || ""}</td>
    <td>${log.city || ""}</td>
    <td>${log.thinking_enabled ? "🧠 Sí" : "—"}</td>
    <td>${log.approximate_context_tokens || ""}</td>
    <td>${log.transport_used ? "Sí" : "—"}</td>
    <td>${log.transport_duration_min || ""}</td>
    <td>${log.transport_distance_km || ""}</td>
    <td>${log.transport_error || ""}</td>
    <td>${log.question || ""}</td>
    <td style="max-width: 400px; white-space: pre-wrap;">${log.answer || ""}</td>
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

        let localIntent = detectIntentLocal(question);
        let analysis;

        if (localIntent === "unknown") {
          analysis = await classifyIntentWithDeepSeek(question, env);
        } else {
          analysis = {
            intent: localIntent,
            scope: "all",
            city: null,
            date_reference: null,
            tool_needed: "none",
            route_direction: "unknown",
            airport_code: null,
            needs_clarification: false,
            clarification_question: null
          };
        }

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

        const needsThinking =
          intent === "recommendation" ||
          question.toLowerCase().includes("conflicto") ||
          question.toLowerCase().includes("pesado") ||
          question.toLowerCase().includes("conviene") ||
          question.toLowerCase().includes("tengo tiempo") ||
          question.toLowerCase().includes("me da tiempo") ||
          question.toLowerCase().includes("riesgo");

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
            max_tokens: needsThinking ? 2400 : 700,
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

Antes del viaje:
- Si el viaje aún no ha comenzado, explica que todavía no inicia.
- Menciona cuándo inicia y cuál es el primer evento relevante.
- Ofrece ayuda útil: documentos, equipaje, recomendaciones o preparación.

Riesgos:
- Si el contexto incluye detected_conflicts, menciona solo los relevantes para la pregunta del cliente.
- Prioriza como riesgos reales: vuelos, traslados, trenes, actividades y tiempos insuficientes entre ellos.
- Si hay insufficient_buffer antes de un vuelo, trátalo como riesgo importante. Considera traslado al aeropuerto, documentación, seguridad y abordaje.
- El check-in y check-out del hotel son ventanas o límites administrativos, no eventos fijos.
- No trates un vuelo antes del check-out estándar como conflicto crítico. Solo recomienda check-out anticipado y preparar equipaje con tiempo.
- No recomiendes late check-out para resolver salidas tempranas.

Estilo:
- No seas redundante.
- No uses lenguaje técnico, tus conversaciones son viajeros que buscan una experiencia de viaje.
- Si haces una lista, termínala completa y cierra con una conclusión breve.
- Si detectas emergencia o problema serio, recomienda contactar a Rigo.

Si se incluye transport_info:
- Úsalo para calcular tiempos reales.
- Menciona duración estimada del traslado.
- Sugiere hora de salida considerando el vuelo.
- Incluye el link de Google Maps si es útil.
- Si utilizas información de transport_info, menciona explícitamente que es un tiempo estimado calculado.
`
              },
              ...cleanHistory,
              {
                role: "user",
                content:
                  "Intención detectada: " + intent +
                  "\\nZona horaria del cliente: " + (timeZone || "desconocida") +
                  "\\nFecha local del cliente: " + (localDate || "desconocida") +
                  "\\n\\nContexto actualizado del viaje:\\n" +
                  JSON.stringify(context) +
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

        const logId = tripId + "-" + Date.now();

        await env.CHAT_LOGS.put(logId, JSON.stringify({
          created_at: new Date().toISOString(),
          trip_id: tripId,
          question: question,
          intent: intent,
          scope: analysis.scope || "all",
          city: analysis.city || null,
          answer: answer,
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
          used_transport_in_answer: answer.includes("traslado estimado")
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
  <title>${trip.name || "Yompr Concierge"}</title>

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
      <h1>${trip.name || "Yompr Concierge"}</h1>
      <p>${trip.destination ? "Destino: " + trip.destination : "Tu concierge personal de viaje"}</p>

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
