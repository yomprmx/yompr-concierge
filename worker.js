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

  for (const hotel of tripJson.hotelVouchers || []) {
    events.push({
      type: "hotel_checkin",
      title: `Check-in ${hotel.accommodationName || "hotel"}`,
      start: getEventDateTime(hotel.checkInDate),
      end: getEventDateTime(hotel.checkInDate)
    });

    events.push({
      type: "hotel_checkout",
      title: `Check-out ${hotel.accommodationName || "hotel"}`,
      start: getEventDateTime(hotel.checkOutDate),
      end: getEventDateTime(hotel.checkOutDate)
    });
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
    // Caso crítico: un vuelo sale antes del check-out del hotel
if (current.type === "flight" && next.type === "hotel_checkout") {
  conflicts.push({
    severity: "high",
    type: "flight_before_checkout",
    message: `El vuelo "${current.title}" ocurre antes del check-out "${next.title}". Esto requiere revisar el orden del itinerario o hacer check-out antes de salir al aeropuerto.`
  });
  continue;
}

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

  // 🔥 Forzar análisis avanzado (no clasificar como activity)
  if (
    q.includes("tengo tiempo") ||
    q.includes("me da tiempo") ||
    q.includes("conviene") ||
    q.includes("puedo visitar")
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
      thinking: { type: "disabled" },
      temperature: 0,
      max_tokens: 250,
      messages: [
        {
          role: "system",
         content: `
Eres un analista de intención para un concierge de viajes.

Analiza la pregunta del cliente y responde SOLO JSON válido con este formato:

{
  "intent": "hotel | flight | activity | transfer | weather | nearby_places | emergency | itinerary | recommendation | general",
  "scope": "all | city | date | next_event | specific_item | trip_analysis | unknown",
  "city": "nombre de ciudad si aplica, si no null",
  "date_reference": "hoy | mañana | fecha específica | null",
  "confidence": 0-1,
  "needs_clarification": true/false,
  "clarification_question": "pregunta corta si hace falta aclarar"
}

Reglas:
- Si el cliente pregunta por una ciudad específica, usa scope = "city".
- Si pregunta por días, plan, itinerario, estancia o qué hará en una ciudad, usa intent = "itinerary".
- Si menciona una ciudad como París, Roma, Venecia o Barcelona, NO pidas aclaración.
- Si la pregunta puede resolverse revisando el itinerario completo, NO pidas aclaración.
- Solo pide aclaración si realmente hay varias interpretaciones incompatibles.
- Responde SOLO JSON válido.
- Si la pregunta requiere comparar varias ciudades, días, horarios o consecuencias del día siguiente, usa:
  intent = "recommendation"
  scope = "trip_analysis"
  needs_clarification = false
- Si el cliente menciona "hoy", "mañana", "primer día", "último día", usa:
  scope = "date"
  date_reference = "hoy" o "mañana"
  needs_clarification = false
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

let parsed;

try {
  parsed = JSON.parse(content);
} catch (e) {
  parsed = {
    intent: "general",
    confidence: 0,
    needs_clarification: true,
    clarification_question: "¿Podrías aclararme un poco más tu pregunta?"
  };
}

return parsed;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
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

  // 👇 NUEVO: detectar si el viaje aún no empieza
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

  // 👇 fallback si no hay nada ese día
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
        JSON.stringify(s).toLowerCase().includes(city)
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
      <td>${log.question || ""}</td>
      <td>${log.answer || ""}</td>
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
        const { tripId, question, timeZone, localDate } = await request.json();
       
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
    needs_clarification: false,
    clarification_question: null
  };
}

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

const needsThinking =
  intent === "recommendation" ||
  question.toLowerCase().includes("conflicto") ||
  question.toLowerCase().includes("pesado") ||
  question.toLowerCase().includes("conviene") ||
  question.toLowerCase().includes("tengo tiempo") ||
  question.toLowerCase().includes("me da tiempo") ||
  question.toLowerCase().includes("riesgo");
        
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
            max_tokens: 700,
            messages: [
              {
                role: "system",
                content: `
                          Eres Yompr Personal Concierge, un asistente de viaje premium. Responde en español claro, conciso, natural, elegante, contenido, casi como un mayordomo contemporaneo. Usa solo la información del viaje proporcionada. Si no sabes algo con certeza, dilo. No inventes datos.
                          No seas redundante dentro del contexto de la respuesta.
                          IMPORTANTE: No uses createdAt, modifiedAt ni exportedAt como fechas del viaje; son fechas administrativas. 
                          Para determinar inicio, fin o días del viaje, usa fechas de vuelos, check-in/check-out, actividades y servicios. Si detectas una emergencia o problema serio, recomienda contactar a Rigo.
                          Si el viaje aún no ha comenzado, responde de forma clara y útil:
                            - explica que no hay actividades hoy
                            - menciona cuándo inicia el viaje
                            - sugiere ayuda útil (preparación, documentos, recomendaciones)
                            - evita sonar técnico o redundante
                          Si el contexto incluye detected_conflicts, revísalos y menciona solo los relevantes para la pregunta del cliente.
                          Cuando detected_conflicts indique insufficient_buffer antes de un vuelo, trátalo como un riesgo importante. No lo minimices. Explica que además del horario del vuelo hay que considerar traslado al aeropuerto, documentación, seguridad y abordaje.
              `
              },
              {
                role: "user",
                content:
                 "Intención detectada: " + intent +
"\\nZona horaria del cliente: " + (timeZone || "desconocida") +
"\\nFecha local del cliente: " + (localDate || "desconocida") +
"\\n\\nContexto del viaje:\\n" +
JSON.stringify(context) +
"\\n\\nPregunta del cliente:\\n" +
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
  thinking_enabled: needsThinking
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
  <title>${trip.name || "Yompr Concierge"}</title>
</head>
<body style="font-family: Arial; padding: 24px;">
  <h1>${trip.name || "Yompr Concierge"}</h1>
  <p><b>Destino:</b> ${trip.destination || ""}</p>

  <h2>Vuelos</h2>
  <p>${flights.length} reservación(es) de vuelo</p>

  <h2>Hospedaje</h2>
  <p>${hotels.length} voucher(s) de hospedaje</p>

  <h2>Servicios / Actividades</h2>
  <p>${services.length} servicio(s)</p>

  <hr>

  <h2>Pregúntale a tu concierge</h2>
  <input id="question" style="width: 70%;" placeholder="Ej: ¿a qué hora sale mi vuelo?" />
  <button onclick="ask()">Preguntar</button>
  <div id="answer" style="margin-top:20px; white-space:pre-wrap;"></div>

  <script>
    async function ask() {
  const question = document.getElementById("question").value;
  const answerBox = document.getElementById("answer");

  if (!question) {
    answerBox.innerText = "Escribe una pregunta primero.";
    return;
  }

  answerBox.innerText = "Pensando...";

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
        localDate: localDate
      })
    });

    const data = await res.json();

    if (!res.ok) {
      answerBox.innerText = "Error: " + (data.answer || data.message || JSON.stringify(data));
      return;
    }

    answerBox.innerText = data.answer || "No recibí respuesta.";
  } catch (error) {
    answerBox.innerText = "Error de conexión: " + error.message;
  }
}
  </script>

  <hr>
  <p>Yompr Personal Concierge — primera versión funcionando.</p>
</body>
</html>
      `, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
    }

    return new Response("Ruta no encontrada", { status: 404 });
  }
};
