import { extractJsonObject } from "./utils.js";
import { buildTripSummaryForClassifier, buildTripTimelineForClassifier } from "./trip.js";

export function postProcessAnalysis(analysis) {
  if (!analysis || typeof analysis !== "object") analysis = {};

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
    recommendation_type: analysis.recommendation_type || null,
    recommendation_query: analysis.recommendation_query || null,
    price_preference: analysis.price_preference || null,
    location_context: analysis.location_context || "trip_context",
    confidence: typeof analysis.confidence === "number" ? analysis.confidence : 0,
    needs_clarification: Boolean(analysis.needs_clarification),
    clarification_question: analysis.clarification_question || null
  };
}

export async function classifyIntentWithDeepSeek(question, env, tripJson, conversationHistory = []) {
  const cleanHistory = Array.isArray(conversationHistory)
    ? conversationHistory
        .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
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
  "recommendation_type": "restaurante | bar | cafe | museo | parque | tienda | hotel | entretenimiento | otro | null — solo si intent=recommendation",
  "recommendation_query": "query en inglés listo para Google Places Text Search, ej: 'cheap french restaurant Montmartre Paris' — solo si intent=recommendation, si no null",
  "price_preference": "economico | moderado | caro | null — solo si intent=recommendation",
  "location_context": "current_user_area | trip_context — current_user_area solo si el usuario pide explícita o implícitamente recomendaciones cerca de su ubicación actual",
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
- Si intent="recommendation": llena siempre recommendation_type, recommendation_query y price_preference.
  - recommendation_query debe estar en inglés, ser específico, incluir tipo de lugar + precio si aplica + barrio/ciudad. Ejemplos: "cheap french bistro Montmartre Paris", "rooftop bar Venice", "family museum Rome near Colosseum".
  - Si el usuario no menciona precio, usa price_preference=null y omite precio en el query.
  - Si el usuario pide algo cerca del hotel, incluye el barrio o zona del hotel en el query.
  - Si el usuario pide recomendaciones "cerca de mí", "aquí", "alrededor", "donde estoy" o equivalente, usa location_context="current_user_area".
  - Si pide recomendaciones por ciudad, hotel o itinerario, usa location_context="trip_context".
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

  if (parsed) return postProcessAnalysis(parsed);

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
    recommendation_type: null,
    recommendation_query: null,
    price_preference: null,
    location_context: "trip_context",
    confidence: 0,
    needs_clarification: false,
    clarification_question: null
  });
}
