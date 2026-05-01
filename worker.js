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

function buildContextByIntent(tripJson, analysis) {
  const intent = analysis.intent || "general";
  const scope = analysis.scope || "all";
  const city = normalizeText(analysis.city || "");

  const base = {
    trip: tripJson.trip || {},
    metadata: tripJson.metadata || {}
  };

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
        const { tripId, question } = await request.json();

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

const context = buildContextByIntent(tripJson, analysis);
const intent = analysis.intent || "general";

        const response = await fetch("https://api.deepseek.com/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + env.DEEPSEEK_API_KEY,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "deepseek-v4-flash",
            thinking: { type: "disabled" },
            temperature: 0.3,
            max_tokens: 700,
            messages: [
              {
                role: "system",
                content: "Eres Yompr Personal Concierge, un asistente de viaje premium. Responde en español claro, breve y útil. Usa solo la información del viaje proporcionada. Si no sabes algo con certeza, dilo. No inventes datos. Si detectas una emergencia o problema serio, recomienda contactar a Rigo."
              },
              {
                role: "user",
                content:
                  "Intención detectada: " + intent +
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
  approximate_context_tokens: approximateTokens
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

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tripId: "${tripId}",
            question: question
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
