function detectIntentLocal(question) {
  const q = question.toLowerCase();

  const intents = {
    hotel: ["hotel", "hospedaje", "alojamiento", "quedo", "quedar", "dormir", "habitación", "check in", "check-in"],
    flight: ["vuelo", "avión", "aeropuerto", "aerolínea", "despega", "sale mi vuelo", "maleta", "equipaje", "terminal"],
    activity: ["actividad", "tour", "excursión", "boleto", "entrada", "visitar", "evento"],
    transfer: ["traslado", "chofer", "pickup", "recogida", "transporte"],
    emergency: ["emergencia", "cancelaron", "perdí", "no aparece", "ayuda urgente", "pasaporte", "accidente"],
    weather: ["clima", "llover", "lluvia", "temperatura", "frío", "calor"],
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
      max_tokens: 20,
      messages: [
        {
          role: "system",
          content: "Clasifica la intención de la pregunta de un viajero. Responde SOLO una palabra de esta lista: hotel, flight, activity, transfer, weather, nearby_places, emergency, itinerary, general."
        },
        {
          role: "user",
          content: question
        }
      ]
    })
  });

  const data = await response.json();
  return (data.choices?.[0]?.message?.content || "general").trim().toLowerCase();
}

function buildContextByIntent(tripJson, intent) {
  const base = {
    trip: tripJson.trip || {},
    metadata: tripJson.metadata || {}
  };

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

  if (intent === "itinerary") {
    return {
      ...base,
      flightReservations: tripJson.flightReservations || [],
      hotelVouchers: tripJson.hotelVouchers || [],
      serviceBookings: tripJson.serviceBookings || []
    };
  }

  if (intent === "emergency") {
    return {
      ...base,
      flightReservations: tripJson.flightReservations || [],
      hotelVouchers: tripJson.hotelVouchers || [],
      serviceBookings: tripJson.serviceBookings || []
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

    let intent = detectIntentLocal(question);

    if (intent === "unknown") {
      intent = await classifyIntentWithDeepSeek(question, env);
    }

    const context = buildContextByIntent(tripJson, intent);

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

    return Response.json({
      answer,
      intent
    });
  } catch (e) {
    return Response.json({
      answer: "Error al procesar la pregunta: " + String(e)
    }, { status: 500 });
  }
});

        const data = await response.json();

        if (!response.ok) {
          return Response.json({
            answer: "Error de DeepSeek: " + JSON.stringify(data)
          }, { status: 500 });
        }

        const answer = data.choices?.[0]?.message?.content || "No pude responder.";

        return Response.json({ answer });
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
