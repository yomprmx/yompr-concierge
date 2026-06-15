import { extractJsonObject } from "./utils.js";
import { buildTripSummaryForClassifier, buildTripTimelineForClassifier } from "./trip.js";

function normalizePriority(value, fallback = 1) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 1) return fallback;
  return Math.round(num);
}

function normalizeConfidence(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

export function mapTaskTypeToIntent(type) {
  switch (type) {
    case "itinerary_lookup":
      return "itinerary";
    case "flight_lookup":
      return "flight";
    case "hotel_lookup":
      return "hotel";
    case "activity_lookup":
      return "activity";
    case "transfer_lookup":
      return "transfer";
    case "recommendation":
      return "recommendation";
    case "route":
      return "route";
    case "weather":
      return "weather";
    case "wiki":
    case "trip_planning":
    default:
      return "general";
  }
}

function defaultTask() {
  return {
    type: "general",
    priority: 1,
    confidence: 0,
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
    wiki_needed: false,
    wiki_query: null,
    needs_clarification: false,
    clarification_question: null
  };
}

function normalizeTask(task, index = 0) {
  const merged = { ...defaultTask(), ...(task && typeof task === "object" ? task : {}) };

  return {
    type: merged.type || "general",
    priority: normalizePriority(merged.priority, index + 1),
    confidence: normalizeConfidence(merged.confidence, 0),
    scope: merged.scope || "all",
    city: merged.city || null,
    date_reference: merged.date_reference || null,
    tool_needed: merged.tool_needed || "none",
    route_direction: merged.route_direction || "unknown",
    route_mode: merged.route_mode || "all",
    airport_code: merged.airport_code || null,
    place_name: merged.place_name || null,
    origin_query: merged.origin_query || null,
    destination_query: merged.destination_query || null,
    recommendation_type: merged.recommendation_type || null,
    recommendation_query: merged.recommendation_query || null,
    price_preference: merged.price_preference || null,
    location_context: merged.location_context || "trip_context",
    wiki_needed: Boolean(merged.wiki_needed),
    wiki_query: merged.wiki_query || null,
    needs_clarification: Boolean(merged.needs_clarification),
    clarification_question: merged.clarification_question || null
  };
}

function buildTaskFromLegacyAnalysis(analysis) {
  const normalized = {
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
    wiki_needed: Boolean(analysis.wiki_needed),
    wiki_query: analysis.wiki_query || null,
    confidence: normalizeConfidence(analysis.confidence, 0),
    needs_clarification: Boolean(analysis.needs_clarification),
    clarification_question: analysis.clarification_question || null
  };

  return normalizeTask({
    type: normalized.tool_needed === "wiki"
      ? "wiki"
      : (
          normalized.intent === "itinerary" ? "itinerary_lookup"
          : normalized.intent === "flight" ? "flight_lookup"
          : normalized.intent === "hotel" ? "hotel_lookup"
          : normalized.intent === "activity" ? "activity_lookup"
          : normalized.intent === "transfer" ? "transfer_lookup"
          : normalized.intent === "weather" ? "weather"
          : normalized.intent === "recommendation" || normalized.intent === "nearby_places" ? "recommendation"
          : normalized.intent === "route" ? "route"
          : "general"
        ),
    priority: 1,
    confidence: normalized.confidence,
    scope: normalized.scope,
    city: normalized.city,
    date_reference: normalized.date_reference,
    tool_needed: normalized.tool_needed,
    route_direction: normalized.route_direction,
    route_mode: normalized.route_mode,
    airport_code: normalized.airport_code,
    place_name: normalized.place_name,
    origin_query: normalized.origin_query,
    destination_query: normalized.destination_query,
    recommendation_type: normalized.recommendation_type,
    recommendation_query: normalized.recommendation_query,
    price_preference: normalized.price_preference,
    location_context: normalized.location_context,
    wiki_needed: normalized.wiki_needed,
    wiki_query: normalized.wiki_query,
    needs_clarification: normalized.needs_clarification,
    clarification_question: normalized.clarification_question
  });
}

function buildPlanEnvelope(raw) {
  if (!raw || typeof raw !== "object") raw = {};

  const rawTasks = Array.isArray(raw.tasks) && raw.tasks.length
    ? raw.tasks
    : [buildTaskFromLegacyAnalysis(raw)];
  const tasks = rawTasks
    .map((task, index) => normalizeTask(task, index))
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 3);

  return {
    tasks,
    response_style: raw.response_style && typeof raw.response_style === "object"
      ? {
          address_mode: raw.response_style.address_mode || "singular",
          tone: raw.response_style.tone || "premium_warm"
        }
      : { address_mode: "singular", tone: "premium_warm" },
    needs_clarification: Boolean(raw.needs_clarification),
    clarification_question: raw.clarification_question || null
  };
}

export function postProcessAnalysis(analysis) {
  const plan = buildPlanEnvelope(analysis);
  const primary = plan.tasks[0] || defaultTask();
  const intent = mapTaskTypeToIntent(primary.type);
  const toolNeeded =
    primary.tool_needed !== "none"
      ? primary.tool_needed
      : (
          primary.type === "route" ? "route"
          : primary.type === "recommendation" ? "places"
          : primary.type === "weather" ? "weather"
          : primary.type === "wiki" ? "wiki"
          : "none"
        );

  return {
    intent,
    scope: primary.scope || "all",
    city: primary.city || null,
    date_reference: primary.date_reference || null,
    tool_needed: toolNeeded,
    route_direction: primary.route_direction || "unknown",
    route_mode: primary.route_mode || "all",
    airport_code: primary.airport_code || null,
    place_name: primary.place_name || null,
    origin_query: primary.origin_query || null,
    destination_query: primary.destination_query || null,
    recommendation_type: primary.recommendation_type || null,
    recommendation_query: primary.recommendation_query || null,
    price_preference: primary.price_preference || null,
    location_context: primary.location_context || "trip_context",
    wiki_needed: Boolean(primary.wiki_needed || primary.type === "wiki"),
    wiki_query: primary.wiki_query || null,
    confidence: primary.confidence,
    needs_clarification: Boolean(plan.needs_clarification || primary.needs_clarification),
    clarification_question: plan.clarification_question || primary.clarification_question || null,
    tasks: plan.tasks,
    response_style: plan.response_style,
    is_multi_intent: plan.tasks.length > 1,
    primary_task_type: primary.type
  };
}

export async function classifyIntentWithDeepSeek(question, env, tripJson, conversationHistory = []) {
  const cleanHistory = Array.isArray(conversationHistory)
    ? conversationHistory
        .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-6)
    : [];

  const tripTimeline = buildTripTimelineForClassifier(tripJson);
  const tripSummary = buildTripSummaryForClassifier(tripJson);
  const normalizedQuestion = String(question || "").toLowerCase();
  const likelyCompound =
    normalizedQuestion.includes(" y ") ||
    normalizedQuestion.includes(" además ") ||
    normalizedQuestion.includes(" tambien ") ||
    normalizedQuestion.includes(" también ") ||
    normalizedQuestion.includes(" aparte ");
  const likelyComplex =
    likelyCompound ||
    normalizedQuestion.includes("como llego") ||
    normalizedQuestion.includes("cómo llego") ||
    normalizedQuestion.includes("me conviene") ||
    normalizedQuestion.includes("historia") ||
    normalizedQuestion.includes("arquitectura") ||
    normalizedQuestion.includes("clima") ||
    normalizedQuestion.includes("mañana");

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.DEEPSEEK_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      thinking: { type: likelyComplex ? "enabled" : "disabled" },
      temperature: 0,
      max_tokens: 1100,
      messages: [
        {
          role: "system",
          content: `
Eres el planner semántico de un concierge de viajes.

Tu trabajo NO es responder al cliente.
Tu trabajo es analizar la pregunta y devolver SOLO JSON válido con un plan de tareas.

Debes usar:
1. El resumen estructurado del viaje.
2. La línea de tiempo cronológica.
3. El historial reciente de la conversación.
4. La pregunta actual.

Devuelve como máximo 3 tareas, ordenadas por prioridad.

Formato exacto:
{
  "tasks": [
    {
      "type": "itinerary_lookup | flight_lookup | hotel_lookup | activity_lookup | transfer_lookup | recommendation | route | weather | wiki | trip_planning | general",
      "priority": 1,
      "confidence": 0-1,
      "scope": "all | city | date | next_event | specific_item | trip_analysis | unknown",
      "city": "ciudad relevante si aplica, si no null",
      "date_reference": "hoy | mañana | fecha específica | null",
      "tool_needed": "none | route | places | weather | wiki",
      "route_direction": "airport_to_hotel | hotel_to_airport | hotel_to_place | place_to_hotel | point_to_point | unknown",
      "route_mode": "walking | driving | transit | all",
      "airport_code": "código IATA si aplica, si no null",
      "place_name": "lugar mencionado por el usuario si aplica, si no null",
      "origin_query": "origen textual completo para calcular ruta si aplica, si no null",
      "destination_query": "destino textual completo para calcular ruta si aplica, si no null",
      "recommendation_type": "restaurante | bar | cafe | museo | parque | tienda | hotel | entretenimiento | otro | null",
      "recommendation_query": "query en inglés listo para Google Places Text Search o null",
      "price_preference": "economico | moderado | caro | null",
      "location_context": "current_user_area | trip_context",
      "wiki_needed": true/false,
      "wiki_query": "consulta breve para Wikipedia o null",
      "needs_clarification": true/false,
      "clarification_question": "pregunta corta si falta un dato indispensable"
    }
  ],
  "response_style": {
    "address_mode": "singular | plural",
    "tone": "premium_warm"
  },
  "needs_clarification": true/false,
  "clarification_question": "pregunta corta si falta un dato indispensable"
}

Reglas:
- No respondas al usuario.
- No inventes datos.
- Si la pregunta mezcla varias necesidades, sepárala en múltiples tareas.
- Usa por defecto address_mode="singular". Solo usa plural si el cliente se expresa claramente en plural.
- Si la pregunta es de historia, arte, arquitectura, barrios, monumentos, museos o cultura local, crea una tarea wiki.
- Si la pregunta es de clima, crea una tarea weather.
- Si la pregunta es de recomendaciones, crea una tarea recommendation.
- Si pide recomendaciones cerca de su ubicación actual, usa location_context="current_user_area".
- Si pide recomendaciones por ciudad, hotel o itinerario, usa location_context="trip_context".
- Si la pregunta es sobre vuelos, hoteles, actividades, traslados o agenda, usa tareas lookup.
- Si la pregunta es sobre logística de tiempo, conveniencia o conflictos del viaje, usa trip_planning.
- Si el usuario pregunta cómo ir a un sitio, crea una tarea route y llena origin_query y destination_query cuando se puedan inferir.
- Si el usuario dice "cuando vaya a X", "para ir a X", "cuando me vaya a X" o "cuando salga hacia X", interpreta que pregunta por la salida desde la etapa anterior del itinerario hacia X.
- Para rutas, usa la línea de tiempo para encontrar el hotel correcto de salida y no asumas el hotel de destino.
- Solo pide aclaración si falta un dato indispensable.
- Responde SOLO JSON válido.
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
    tasks: [defaultTask()],
    response_style: { address_mode: "singular", tone: "premium_warm" },
    needs_clarification: false,
    clarification_question: null
  });
}
