import { escapeHtml, normalizeText } from "./src/utils.js";
import { buildContextByIntent, detectBasicConflicts } from "./src/trip.js";
import { classifyIntentWithDeepSeek } from "./src/classifier.js";
import { enrichWithTransportInfo } from "./src/routing.js";
import { searchPlacesRecommendations } from "./src/recommendations.js";
import { saveChatLog } from "./src/logging.js";

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

      const rows = logs.map(log => {
        const hasRouteError = log.transport_error || log.geocode_origin_error || log.geocode_destination_error;
        const rowStyle = hasRouteError ? ' style="background:#fff3cd;"' : (log.intent === "error" ? ' style="background:#fde8e8;"' : "");
        const coordOrigin = (log.geocode_origin_lat && log.geocode_origin_lon)
          ? `${(+log.geocode_origin_lat).toFixed(4)}, ${(+log.geocode_origin_lon).toFixed(4)}`
          : "—";
        const coordDest = (log.geocode_destination_lat && log.geocode_destination_lon)
          ? `${(+log.geocode_destination_lat).toFixed(4)}, ${(+log.geocode_destination_lon).toFixed(4)}`
          : "—";
        const walking = log.walking_duration_min != null ? `${log.walking_duration_min}min / ${log.walking_distance_km}km` : "—";
        const driving = log.driving_duration_min != null ? `${log.driving_duration_min}min / ${log.driving_distance_km}km` : "—";
        const transit = log.transit_duration_min != null ? `${log.transit_duration_min}min / ${log.transit_distance_km}km` : "—";
        return `
  <tr${rowStyle}>
    <td>${escapeHtml(log.created_at || "")}</td>
    <td>${escapeHtml(log.trip_id || "")}</td>
    <td>${escapeHtml(log.intent || "")}</td>
    <td>${escapeHtml(log.scope || "")}</td>
    <td>${escapeHtml(log.city || "")}</td>
    <td>${log.thinking_enabled ? "Sí" : "—"}</td>
    <td>${escapeHtml(String(log.approximate_context_tokens || ""))}</td>
    <td>${log.transport_used ? "Sí" : "—"}</td>
    <td>${escapeHtml(log.transport_type || "")}</td>
    <td>${escapeHtml(log.route_direction || "")}</td>
    <td>${escapeHtml(log.route_mode || "")}</td>
    <td>${walking}</td>
    <td>${driving}</td>
    <td>${transit}</td>
    <td style="color:${log.transport_error ? '#c00' : 'inherit'};">${escapeHtml(log.transport_error || "—")}</td>
    <td style="max-width: 220px; white-space: pre-wrap;">${escapeHtml(log.transport_origin || "")}</td>
    <td style="max-width: 220px; white-space: pre-wrap;">${escapeHtml(log.transport_destination || "")}</td>
    <td style="max-width: 240px; white-space: pre-wrap;">${escapeHtml(log.geocode_origin || "")}<br><small style="color:#666;">${coordOrigin}</small></td>
    <td style="max-width: 240px; white-space: pre-wrap;">${escapeHtml(log.geocode_destination || "")}<br><small style="color:#666;">${coordDest}</small></td>
    <td style="max-width: 260px; white-space: pre-wrap; font-size:11px; color:#555;">${escapeHtml(log.geocode_origin_attempted_query || "")}</td>
    <td style="max-width: 260px; white-space: pre-wrap; font-size:11px; color:#555;">${escapeHtml(log.geocode_destination_attempted_query || "")}</td>
    <td style="color:#c00; max-width:160px; white-space:pre-wrap;">${escapeHtml(log.geocode_origin_error || "")}</td>
    <td style="color:#c00; max-width:160px; white-space:pre-wrap;">${escapeHtml(log.geocode_destination_error || "")}</td>
    <td style="max-width:200px; white-space:pre-wrap; font-size:11px;">${log.recommendations_used ? `✅ ${log.recommendations_count} resultados<br><small style="color:#555;">${escapeHtml(log.recommendations_query || "")}</small>${log.recommendations_bias_used ? "<br><small style='color:#22a;'>📍 bias hotel</small>" : ""}` : (log.intent === "recommendation" ? `<span style="color:#c00;">Sin resultados<br><small>${escapeHtml(log.recommendations_error || "")}</small></span>` : "—")}</td>
    <td style="max-width: 260px; white-space: pre-wrap;">${escapeHtml(log.question || "")}</td>
    <td style="max-width: 480px; white-space: pre-wrap;">${escapeHtml(log.answer || "")}</td>
  </tr>`;
      }).join("");

      return new Response(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Yompr Concierge Logs</title>
  <style>
    body { font-family: Arial; padding: 24px; }
    table { border-collapse: collapse; font-size: 12px; }
    th { background: #1f2937; color: #fff; padding: 8px; position: sticky; top: 0; }
    td { padding: 7px 8px; border: 1px solid #e5e7eb; vertical-align: top; }
    tr:hover td { background: #f0f9ff; }
    .legend { margin-bottom: 12px; font-size: 12px; }
    .legend span { display: inline-block; width: 14px; height: 14px; margin-right: 4px; vertical-align: middle; border-radius: 2px; }
  </style>
</head>
<body>
  <h1>Yompr Concierge Logs</h1>
  <p>Últimas 200 preguntas registradas.</p>
  <div class="legend">
    <span style="background:#fff3cd;"></span> Advertencia (error de geocoding/ruta) &nbsp;
    <span style="background:#fde8e8;"></span> Error crítico
  </div>

  <table border="1" cellpadding="8" cellspacing="0">
    <thead>
      <tr>
        <th>Fecha</th>
        <th>Trip ID</th>
        <th>Intent</th>
        <th>Scope</th>
        <th>City</th>
        <th>Thinking</th>
        <th>Tokens</th>
        <th>Ruta calc.</th>
        <th>Transport type</th>
        <th>Direction</th>
        <th>Mode</th>
        <th>🚶 Walking</th>
        <th>🚗 Driving</th>
        <th>🚇 Transit</th>
        <th>Error ruta</th>
        <th>Origin query</th>
        <th>Destination query</th>
        <th>Geocode origen (+ coords)</th>
        <th>Geocode destino (+ coords)</th>
        <th>Queries origen intentadas</th>
        <th>Queries destino intentadas</th>
        <th>Error geocode origen</th>
        <th>Error geocode destino</th>
        <th>🏪 Recomendaciones</th>
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

        let recommendationsInfo = null;
        let recommendationsUsed = false;

        if (intent === "recommendation" && analysis.recommendation_query) {
          try {
            recommendationsInfo = await searchPlacesRecommendations(analysis, tripJson, env);
            if (recommendationsInfo?.places?.length) {
              context.recommendations_results = recommendationsInfo.places;
              recommendationsUsed = true;
            }
          } catch (e) {
            recommendationsInfo = { places: [], error: String(e) };
          }
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

URLs y enlaces (REGLA ABSOLUTA):
- Cuando incluyas cualquier URL (Google Maps, links de lugares, maps_link, googleMapsUri, etc.), escríbela SIEMPRE COMPLETA, EXACTAMENTE como aparece en los datos, empezando por "https://".
- PROHIBIDO abreviar URLs, quitar el "https://", quitar "www.", o reemplazar parte de la URL con texto descriptivo.
- PROHIBIDO escribir "maps.google.com/..." sin el "https://" delante. Siempre debe ser "https://maps.google.com/..." o "https://www.google.com/maps/..." según venga en los datos.
- PROHIBIDO escribir placeholders como "[link]", "[enlace]", "(ver enlace)", "(enlace aquí)" — copia la URL real del campo.
- Antes de cada URL, deja un espacio para que sea clickeable. Ejemplo correcto: "Aquí está el enlace: https://maps.google.com/?cid=12345"

Recomendaciones:
- Si context.recommendations_results existe y tiene elementos, úsalo como tu ÚNICA fuente para recomendar lugares. Prohibido inventar o añadir lugares que no estén en esa lista.
- Elige 2 o 3 opciones de la lista. Prioriza las que tengan mejor rating y más reseñas. Si el usuario pidió precio bajo, filtra por price_level económico primero.
- Para cada lugar recomendado incluye: nombre, descripción breve (usa el campo description si existe, si no describe el tipo brevemente), rating (ej: 4.5 ⭐ con X reseñas), precio si está disponible, horario relevante si aplica, y el maps_link como enlace clickeable.
- Si opening_hours está disponible y la pregunta es para esta noche o hoy, menciona si está abierto.
- No menciones todos los campos de cada lugar; sé selectivo y natural.
- Si recommendations_results está vacío o no existe pero el intent es recommendation, di que no encontraste lugares con datos concretos en la zona y recomienda buscar en Google Maps con el tipo de lugar + barrio del hotel.
- NUNCA inventes nombres de restaurantes, bares, museos u otros lugares que no estén en context.recommendations_results.

Rutas:
- Si transport_info.type = “calculated_route”, usa transport_info como fuente ÚNICA para distancias y tiempos. Prohibido usar conocimiento propio sobre distancias, tiempos o rutas.
- Si transport_info.options existe, compara las opciones disponibles: caminando, taxi/coche y transporte público.
- Para caminatas: usa ÚNICAMENTE transport_info.options.walking.duration_min y distance_km. Si walking es null, no menciones caminado como opción.
- Para taxi/coche: usa ÚNICAMENTE transport_info.options.driving.duration_min y distance_km. Si driving es null, no menciones esta opción.
- Para transporte público: usa ÚNICAMENTE transport_info.options.transit.duration_min y distance_km.
  - Si transit.duration_min tiene un valor numérico, úsalo tal cual. No lo cuestiones ni lo ajustes.
  - Si transit.steps existe, úsalo para explicar la ruta paso a paso: qué línea tomar, desde qué parada, cuántas paradas, dónde transbordar. Esto es lo más valioso que puedes dar al cliente.
  - Si transit.duration_min es null, escribe: "Para el transporte público no tengo el tiempo calculado en este momento; puedes ver las opciones exactas aquí: " seguido del valor exacto y completo del campo transport_info.options.transit.maps_link (la URL completa empezando por https://). NO escribas el texto literal "[transit.maps_link]" ni "(enlace de transporte público)" ni nada similar — copia el contenido del campo. NUNCA estimes ni supongas un tiempo de tránsito.
- REGLA ABSOLUTA: Cualquier tiempo o distancia que menciones debe estar en transport_info. Si no está ahí, no lo digas.
- No inventes tiempos de ruta bajo ninguna circunstancia, aunque creas conocer la ciudad.
- Si el usuario pregunta “está cerca”, responde con distancia y duración caminando cuando estén disponibles.
- Si transport_info.type = “route_without_destination”, NO des tiempos ni alternativas. Explica que falta el destino exacto y pide el aeropuerto, estación o punto al que quiere ir.
- Si transport_info.type = “geocoding_failed”, no inventes distancia ni duración. Ofrece el enlace de Google Maps y pide una dirección más precisa.
- Si transport_info.type = “route_calculation_failed”, di que no se pudo calcular la ruta y ofrece el enlace de Google Maps.
- Si el análisis estructurado incluye origin_query y destination_query, respétalos como la interpretación principal de la ruta.
- No cambies la ciudad o el hotel de origen si origin_query ya fue resuelto por el clasificador.
- Si el usuario habla de “ir a”, “salir hacia”, “cuando vaya a” otra ciudad, revisa el JSON completo para ubicar la etapa previa del viaje.
- Antes de responder rutas entre ciudades o cambios de destino, verifica la secuencia real del viaje en el JSON completo.

ROL Y LÍMITES — LEE ESTO ANTES DE RESPONDER:
Eres un asistente EXCLUSIVAMENTE informativo. Tu único rol es consultar el itinerario, responder preguntas y orientar al cliente.
NUNCA puedes realizar ninguna acción transaccional. Esto incluye, sin excepción:
- Reservar, contratar, gestionar, modificar o cancelar cualquier servicio (vuelos, hoteles, traslados, tours, restaurantes u otros).
- Generar, enviar o mencionar links de pago, cobros, facturas, transferencias o cualquier forma de transacción económica.
- Confirmar disponibilidad en tiempo real ni hacer cotizaciones de precios actuales.
- Coordinar proveedores, contactar terceros o actuar en nombre del cliente.
Si el cliente pide cualquiera de estas cosas, responde siempre de forma cálida pero clara: “Eso lo gestiona directamente tu agente de Yompr. Para reservas, cambios o pagos, ponte en contacto con Rigo y con gusto lo coordinarán contigo.”
PROHIBIDO usar frases como: “puedo ayudarte a reservar”, “te genero el link de pago”, “podemos gestionar eso”, “te coordino la reserva”, “puedo hacer ese cambio por ti” o cualquier variante que sugiera capacidad de acción transaccional.
No ofrezcas capacidades que no tienes, ni insinúes que podrías hacerlo más adelante. Redirige siempre al agente.
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

  walking_duration_min: transportInfo?.options?.walking?.duration_min ?? null,
  walking_distance_km: transportInfo?.options?.walking?.distance_km ?? null,
  driving_duration_min: transportInfo?.options?.driving?.duration_min ?? null,
  driving_distance_km: transportInfo?.options?.driving?.distance_km ?? null,
  transit_duration_min: transportInfo?.options?.transit?.duration_min ?? null,
  transit_distance_km: transportInfo?.options?.transit?.distance_km ?? null,

  route_direction: analysis.route_direction || null,
  route_mode: analysis.route_mode || null,
  place_name: analysis.place_name || null,
  geocode_origin: transportInfo?.geocode_origin_display_name || null,
  geocode_destination: transportInfo?.geocode_destination_display_name || null,
  geocode_origin_lat: transportInfo?.geocode_origin_lat || null,
  geocode_origin_lon: transportInfo?.geocode_origin_lon || null,
  geocode_destination_lat: transportInfo?.geocode_destination_lat || null,
  geocode_destination_lon: transportInfo?.geocode_destination_lon || null,
  geocode_origin_attempted_query: transportInfo?.geocode_origin_attempted_query || null,
  geocode_destination_attempted_query: transportInfo?.geocode_destination_attempted_query || null,
  geocode_origin_error: transportInfo?.geocode_origin_error || null,
  geocode_destination_error: transportInfo?.geocode_destination_error || null,

  recommendations_used: recommendationsUsed,
  recommendations_query: analysis.recommendation_query || null,
  recommendations_count: recommendationsInfo?.places?.length ?? null,
  recommendations_bias_used: recommendationsInfo?.bias_used || false,
  recommendations_error: recommendationsInfo?.error || null,

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

    // Renderiza texto con negritas (**texto**) y saltos de linea en nodos DOM.
    // Usa [*][*] como char-class para evitar cualquier escape en template literal.
    // "\\n" en template produce "\n" en el browser = caracter de salto de linea real.
    function appendStyledText(container, text) {
      var boldRe = new RegExp("[*][*]([^*]+)[*][*]", "g");
      var lines = text.split("\\n");
      for (var li = 0; li < lines.length; li++) {
        if (li > 0) container.appendChild(document.createElement("br"));
        var line = lines[li];
        var lastBold = 0;
        var bm;
        boldRe.lastIndex = 0;
        while ((bm = boldRe.exec(line)) !== null) {
          if (bm.index > lastBold) {
            container.appendChild(document.createTextNode(line.slice(lastBold, bm.index)));
          }
          var strong = document.createElement("strong");
          strong.textContent = bm[1];
          container.appendChild(strong);
          lastBold = bm.index + bm[0].length;
        }
        if (lastBold < line.length) {
          container.appendChild(document.createTextNode(line.slice(lastBold)));
        }
      }
    }

    function addMessage(role, content, extraClass) {
      const messages = document.getElementById("messages");

      const row = document.createElement("div");
      row.className = "message-row " + role;

      const bubble = document.createElement("div");
      bubble.className = "bubble" + (extraClass ? " " + extraClass : "");

      // Detecta URLs con exec() en loop (evita ambiguedades de split+capturing group).
      // Regex sin secuencias de escape: [^ <>] para "no espacio/chevron", [.] para punto literal.
      var urlRe = new RegExp("https?://[^ <>]+|(?:maps|www)[.]google[.]com/[^ <>]+|goo[.]gl/[^ <>]+", "g");
      var trailRe = new RegExp("[.,;:!?)]+$");
      var lastIdx = 0;
      var um;
      urlRe.lastIndex = 0;

      while ((um = urlRe.exec(content)) !== null) {
        // Texto antes de la URL
        if (um.index > lastIdx) {
          appendStyledText(bubble, content.slice(lastIdx, um.index));
        }
        // Limpiar puntuacion final que romperia el href
        var rawUrl = um[0].replace(trailRe, "");
        // Añadir protocolo si falta
        var hrefUrl = rawUrl.indexOf("http") === 0 ? rawUrl : "https://" + rawUrl;

        var a = document.createElement("a");
        a.href = hrefUrl;
        a.target = "_blank";
        a.rel = "noopener";
        var isMaps = hrefUrl.indexOf("maps.google.com") !== -1 || hrefUrl.indexOf("google.com/maps") !== -1;
        a.textContent = isMaps ? "Ver en Google Maps" : hrefUrl;
        a.style.cssText = "color:#3b82f6;text-decoration:underline;font-weight:500;";
        bubble.appendChild(a);

        lastIdx = um.index + um[0].length;
      }

      // Texto restante despues de la ultima URL
      if (lastIdx < content.length) {
        appendStyledText(bubble, content.slice(lastIdx));
      }

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
