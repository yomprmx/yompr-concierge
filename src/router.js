import { normalizeText } from "./utils.js";

function makeTask(overrides = {}) {
  return {
    type: "general",
    priority: 1,
    confidence: 0.6,
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
    clarification_question: null,
    ...overrides
  };
}

function uniqueStrings(values) {
  const result = [];
  for (const value of values || []) {
    const text = String(value || "").trim();
    if (!text) continue;
    if (!result.some(item => normalizeText(item) === normalizeText(text))) {
      result.push(text);
    }
  }
  return result;
}

function extractTripCities(tripJson) {
  return uniqueStrings([
    ...(tripJson?.hotelVouchers || []).flatMap(h => [
      h?.city,
      h?.destination,
      h?.accommodationCity
    ]),
    ...String(tripJson?.trip?.destination || "")
      .split(",")
      .map(part => part.trim())
  ]);
}

function findCityInQuestion(questionNorm, tripJson) {
  const cities = extractTripCities(tripJson);
  for (const city of cities) {
    const cityNorm = normalizeText(city);
    if (cityNorm && questionNorm.includes(cityNorm)) return city;
  }
  return cities[0] || null;
}

function findPrimaryHotel(tripJson, city = null) {
  const hotels = tripJson?.hotelVouchers || [];
  if (!hotels.length) return null;
  const cityNorm = normalizeText(city || "");
  const match = cityNorm
    ? hotels.find(h => normalizeText(h?.city || h?.destination || h?.accommodationCity || "").includes(cityNorm))
    : null;
  const hotel = match || hotels[0];
  if (!hotel) return null;
  return {
    name: hotel.accommodationName || hotel.hotelName || hotel.name || null,
    address: hotel.accommodationAddress || hotel.address || null,
    city: hotel.city || hotel.destination || hotel.accommodationCity || city || null
  };
}

function detectAddressMode(questionNorm) {
  const pluralSignals = [
    "nos ",
    "vamos",
    "queremos",
    "podemos",
    "ayudanos",
    "ayudanos",
    "recomiendanos",
    "dinos",
    "tenemos",
    "nos gustaria",
    "nos gustaria",
    "estamos"
  ];
  return pluralSignals.some(signal => questionNorm.includes(signal)) ? "plural" : "singular";
}

function containsAmbiguousReference(questionNorm) {
  return (
    questionNorm.startsWith("y ") ||
    questionNorm.startsWith("tambien") ||
    questionNorm.startsWith("también") ||
    questionNorm.includes("eso") ||
    questionNorm.includes("esa") ||
    questionNorm.includes("ese") ||
    questionNorm.includes("ahi") ||
    questionNorm.includes("alli") ||
    questionNorm.includes("alli ") ||
    questionNorm.includes("alla") ||
    questionNorm.includes("por ahi") ||
    questionNorm.includes("por alli")
  );
}

function findFirstIndex(questionNorm, terms) {
  let best = -1;
  for (const term of terms) {
    const idx = questionNorm.indexOf(normalizeText(term));
    if (idx >= 0 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

function inferDateReference(questionNorm) {
  if (questionNorm.includes("manana") || questionNorm.includes("mañana")) return "mañana";
  if (questionNorm.includes("hoy") || questionNorm.includes("ahora") || questionNorm.includes("ahorita")) return "hoy";
  return null;
}

function detectWeatherSignal(questionNorm) {
  return findFirstIndex(questionNorm, [
    "clima",
    "pronostico",
    "pronóstico",
    "temperatura",
    "lluvia",
    "va a estar",
    "tiempo"
  ]);
}

function detectRouteSignal(questionNorm) {
  return findFirstIndex(questionNorm, [
    "como llego",
    "cómo llego",
    "como llegar",
    "cómo llegar",
    "indicaciones",
    "ruta",
    "como voy",
    "cómo voy",
    "llegar al",
    "llegar a la",
    "ir al",
    "ir a la"
  ]);
}

function detectWikiSignal(questionNorm) {
  return findFirstIndex(questionNorm, [
    "hablame de",
    "háblame de",
    "que es",
    "qué es",
    "quien fue",
    "quién fue",
    "historia de",
    "arquitectura de",
    "arte de",
    "museo",
    "monumento",
    "barrio",
    "cultura"
  ]);
}

function detectRecommendationSignal(questionNorm) {
  return findFirstIndex(questionNorm, [
    "recomienda",
    "recomendacion",
    "recomendación",
    "donde comer",
    "dónde comer",
    "que puedo comer",
    "qué puedo comer",
    "donde cenar",
    "dónde cenar",
    "bar",
    "cafe",
    "cafeteria",
    "cafetería",
    "restaurante",
    "pizza",
    "ensalada",
    "sushi",
    "carne asada",
    "hamburguesa",
    "museo cerca",
    "algo para comer"
  ]);
}

function detectLookupSignal(questionNorm) {
  const map = [
    { type: "flight_lookup", terms: ["vuelo", "flight", "aterriza", "despega", "terminal"] },
    { type: "hotel_lookup", terms: ["hotel", "check in", "check-in", "check out", "check-out", "hospedaje"] },
    { type: "activity_lookup", terms: ["actividad", "tour", "museo reservado", "entrada", "ticket"] },
    { type: "transfer_lookup", terms: ["traslado", "transfer", "pickup", "chofer"] }
  ];
  for (const item of map) {
    const idx = findFirstIndex(questionNorm, item.terms);
    if (idx >= 0) return { type: item.type, index: idx };
  }
  return null;
}

function detectPlanningSignal(questionNorm) {
  return findFirstIndex(questionNorm, [
    "me conviene",
    "da tiempo",
    "me da tiempo",
    "riesgo",
    "conflicto",
    "pesado",
    "apretado",
    "mejor dia",
    "mejor día",
    "que dia",
    "qué día"
  ]);
}

function hasCurrentLocationSignal(questionNorm) {
  return (
    questionNorm.includes("cerca de mi") ||
    questionNorm.includes("cerca de mí") ||
    questionNorm.includes("aqui cerca") ||
    questionNorm.includes("aquí cerca") ||
    questionNorm.includes("donde estoy") ||
    questionNorm.includes("alrededor de mi") ||
    questionNorm.includes("alrededor de mí") ||
    questionNorm.includes("near me")
  );
}

function inferRecommendationType(questionNorm) {
  if (questionNorm.includes("pizza")) return "restaurante";
  if (questionNorm.includes("ensalada")) return "restaurante";
  if (questionNorm.includes("sushi")) return "restaurante";
  if (questionNorm.includes("carne asada")) return "restaurante";
  if (questionNorm.includes("hamburguesa")) return "restaurante";
  if (questionNorm.includes("bar") || questionNorm.includes("coctel") || questionNorm.includes("copas")) return "bar";
  if (questionNorm.includes("cafe") || questionNorm.includes("cafeter")) return "cafe";
  if (questionNorm.includes("museo")) return "museo";
  return "restaurante";
}

function buildRecommendationQuery(questionNorm, city, locationContext) {
  let base = "restaurant";
  if (questionNorm.includes("pizza")) base = "pizza restaurant";
  else if (questionNorm.includes("ensalada")) base = "salad restaurant";
  else if (questionNorm.includes("sushi")) base = "sushi restaurant";
  else if (questionNorm.includes("carne asada")) base = "steak restaurant";
  else if (questionNorm.includes("hamburguesa")) base = "hamburger restaurant";
  else if (questionNorm.includes("bar") || questionNorm.includes("coctel") || questionNorm.includes("copas")) base = "cocktail bar";
  else if (questionNorm.includes("cafe") || questionNorm.includes("cafeter")) base = "coffee shop";
  else if (questionNorm.includes("museo")) base = "museum";
  else if (questionNorm.includes("desayun")) base = "breakfast restaurant";
  else if (questionNorm.includes("cenar")) base = "dinner restaurant";

  return locationContext === "current_user_area" || !city ? base : `${base} ${city}`.trim();
}

function inferWikiQuery(question) {
  const raw = String(question || "").trim();
  const patterns = [
    /(?:hablame|háblame|dime|cuentame|cuéntame)\s+de\s+(.+?)(?:\?|$)/i,
    /(?:que es|qué es|quien fue|quién fue)\s+(.+?)(?:\?|$)/i,
    /(?:historia|arte|arquitectura|cultura)\s+de\s+(.+?)(?:\?|$)/i
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match?.[1]) return match[1].trim().replace(/[.?!]+$/, "");
  }
  return null;
}

function inferRouteDestination(question, city = null) {
  const raw = String(question || "").trim();
  const patterns = [
    /(?:como|cómo)\s+(?:llego|llegar)\s+(?:a|al|a la)\s+(.+?)(?:\?|$|,|\s+y\s+)/i,
    /(?:indicaciones\s+(?:a|al|a la))\s+(.+?)(?:\?|$|,|\s+y\s+)/i,
    /(?:ruta\s+(?:a|al|a la))\s+(.+?)(?:\?|$|,|\s+y\s+)/i,
    /(?:para\s+ir\s+(?:a|al|a la))\s+(.+?)(?:\?|$|,|\s+y\s+)/i
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match?.[1]) continue;
    const text = match[1].trim().replace(/[.?!]+$/, "");
    if (!text) continue;
    return city ? `${text}, ${city}` : text;
  }
  return null;
}

function inferRouteDirection(questionNorm, destinationText) {
  const destinationNorm = normalizeText(destinationText || "");
  if (destinationNorm.includes("aeropuerto") || destinationNorm.includes("airport") || destinationNorm.includes("terminal")) {
    return "hotel_to_airport";
  }
  return "hotel_to_place";
}

function buildRouteTask(question, questionNorm, tripJson, city) {
  const hotel = findPrimaryHotel(tripJson, city);
  const destination = inferRouteDestination(question, city);
  if (!hotel?.name && !hotel?.address) {
    return { task: null, shouldEscalate: true, reason: "missing_hotel_anchor" };
  }
  if (!destination) {
    return { task: null, shouldEscalate: true, reason: "missing_route_destination" };
  }
  const originQuery = [hotel.name, hotel.address, hotel.city].filter(Boolean).join(", ");
  return {
    task: makeTask({
      type: "route",
      confidence: 0.78,
      scope: "specific_item",
      city,
      date_reference: inferDateReference(questionNorm),
      tool_needed: "route",
      route_direction: inferRouteDirection(questionNorm, destination),
      route_mode: questionNorm.includes("caminando")
        ? "walking"
        : questionNorm.includes("transporte publico") || questionNorm.includes("transporte público")
          ? "transit"
          : questionNorm.includes("taxi") || questionNorm.includes("coche")
            ? "driving"
            : "all",
      place_name: destination.split(",")[0]?.trim() || destination,
      origin_query: originQuery,
      destination_query: destination
    }),
    shouldEscalate: false,
    reason: null
  };
}

function hasAnySpecificTask(tasks) {
  return (tasks || []).some(task => task && task.type !== "general");
}

export function classifyIntentLocally(question, tripJson, conversationHistory = []) {
  const rawQuestion = String(question || "").trim();
  const questionNorm = normalizeText(rawQuestion);
  const city = findCityInQuestion(questionNorm, tripJson);
  const addressMode = detectAddressMode(questionNorm);
  const ambiguousReference = containsAmbiguousReference(questionNorm);
  const hasConversation = Array.isArray(conversationHistory) && conversationHistory.length > 0;
  const taskCandidates = [];
  const escalationReasons = [];

  const weatherIndex = detectWeatherSignal(questionNorm);
  if (weatherIndex >= 0) {
    taskCandidates.push({
      index: weatherIndex,
      task: makeTask({
        type: "weather",
        confidence: 0.86,
        scope: "date",
        city,
        date_reference: inferDateReference(questionNorm),
        tool_needed: "weather"
      })
    });
  }

  const routeIndex = detectRouteSignal(questionNorm);
  if (routeIndex >= 0) {
    const routeResult = buildRouteTask(rawQuestion, questionNorm, tripJson, city);
    if (routeResult.task) {
      taskCandidates.push({ index: routeIndex, task: routeResult.task });
    }
    if (routeResult.shouldEscalate) escalationReasons.push(routeResult.reason);
  }

  const recommendationIndex = detectRecommendationSignal(questionNorm);
  if (recommendationIndex >= 0) {
    const locationContext = hasCurrentLocationSignal(questionNorm) ? "current_user_area" : "trip_context";
    taskCandidates.push({
      index: recommendationIndex,
      task: makeTask({
        type: "recommendation",
        confidence: 0.82,
        scope: "specific_item",
        city,
        tool_needed: "places",
        recommendation_type: inferRecommendationType(questionNorm),
        recommendation_query: buildRecommendationQuery(questionNorm, city, locationContext),
        location_context: locationContext
      })
    });
  }

  const wikiIndex = detectWikiSignal(questionNorm);
  if (wikiIndex >= 0) {
    const wikiQuery = inferWikiQuery(rawQuestion) || city;
    if (wikiQuery) {
      taskCandidates.push({
        index: wikiIndex,
        task: makeTask({
          type: "wiki",
          confidence: 0.78,
          scope: "specific_item",
          city,
          tool_needed: "wiki",
          place_name: wikiQuery,
          wiki_needed: true,
          wiki_query: wikiQuery
        })
      });
    } else {
      escalationReasons.push("missing_wiki_query");
    }
  }

  const lookupSignal = detectLookupSignal(questionNorm);
  if (lookupSignal) {
    taskCandidates.push({
      index: lookupSignal.index,
      task: makeTask({
        type: lookupSignal.type,
        confidence: 0.72,
        scope: city ? "city" : "all",
        city,
        tool_needed: "none"
      })
    });
  }

  const planningIndex = detectPlanningSignal(questionNorm);
  if (planningIndex >= 0) {
    taskCandidates.push({
      index: planningIndex,
      task: makeTask({
        type: "trip_planning",
        confidence: 0.72,
        scope: "trip_analysis",
        city,
        tool_needed: "none"
      })
    });
  }

  const tasks = taskCandidates
    .sort((a, b) => a.index - b.index)
    .map((item, idx) => ({ ...item.task, priority: idx + 1 }))
    .slice(0, 3);

  let shouldEscalate = false;
  if (!hasAnySpecificTask(tasks)) shouldEscalate = true;
  if (ambiguousReference && hasConversation) shouldEscalate = true;
  if (tasks.some(task => task.type === "trip_planning")) shouldEscalate = true;
  if (tasks.some(task => task.type.endsWith("_lookup")) && tasks.length > 1) shouldEscalate = true;
  if (tasks.length > 2) shouldEscalate = true;
  if (rawQuestion.length > 220) shouldEscalate = true;
  if (escalationReasons.length) shouldEscalate = true;

  return {
    tasks: tasks.length ? tasks : [makeTask({ type: "general", confidence: 0.2 })],
    response_style: {
      address_mode: addressMode,
      tone: "premium_warm"
    },
    needs_clarification: false,
    clarification_question: null,
    router_source: "local_rule",
    should_escalate: shouldEscalate,
    escalation_reason: escalationReasons[0] || (shouldEscalate ? "complex_or_ambiguous" : null)
  };
}
