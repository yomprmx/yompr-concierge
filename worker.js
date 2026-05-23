import { escapeHtml, normalizeText } from "./src/utils.js";
import { buildContextByIntent, detectBasicConflicts } from "./src/trip.js";
import { classifyIntentWithDeepSeek } from "./src/classifier.js";
import { enrichWithTransportInfo } from "./src/routing.js";
import { searchPlacesRecommendations } from "./src/recommendations.js";
import { enrichWithWeatherInfo } from "./src/weather.js";
import { saveChatLog } from "./src/logging.js";

function normalizeWrappedUrls(text) {
  if (!text) return text;

  // Une URLs partidas por salto de línea en respuestas del modelo.
  // Ejemplo:
  // https://www.google.com/maps/dir/?
  // api=1&origin=...
  // =>
  // https://www.google.com/maps/dir/?api=1&origin=...
  return String(text).replace(
    /(https?:\/\/[^\s<>\n]+)\n\s*([^\s<>]+)/g,
    (full, first, next) => {
      if (!/[/?#&=%]/.test(next)) return full;
      return first + next;
    }
  );
}

function parseConversationHistory(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-8);
  } catch (_) {
    return [];
  }
}

function parseCookies(request) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const pairs = cookieHeader.split(";").map(p => p.trim()).filter(Boolean);
  const out = {};
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    out[key] = decodeURIComponent(value);
  }
  return out;
}

async function getAuthenticatedAdmin(request, env) {
  const cookies = parseCookies(request);
  const sessionToken = cookies.yompr_admin_session;
  if (!sessionToken || !env?.TRIPS) return null;
  try {
    const raw = await env.TRIPS.get(`admin:sess:${sessionToken}`);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (!session?.username) return null;
    return session;
  } catch (_) {
    return null;
  }
}

async function requireAdminAuth(request, env) {
  const admin = await getAuthenticatedAdmin(request, env);
  if (!admin) {
    return new Response(null, {
      status: 302,
      headers: { Location: "/admin/login" }
    });
  }
  return null;
}

function renderAdminLoginPage(errorText = "") {
  const errorHtml = errorText
    ? `<p style="color:#b91c1c; margin:0 0 12px;">${escapeHtml(errorText)}</p>`
    : "";
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1" />
  <title>Admin Login</title>
</head>
<body style="font-family: Arial, sans-serif; background:#f3f4f6; margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;">
  <form method="POST" action="/admin/login" style="background:#fff; border:1px solid #e5e7eb; border-radius:10px; padding:20px; width:100%; max-width:360px;">
    <div style="text-align:center; margin-bottom:10px;">
      <img src="/logo.png" alt="Yompr" style="width:64px; height:64px; object-fit:contain;" />
    </div>
    <h1 style="margin:0 0 14px; font-size:20px;">Yompr Admin</h1>
    ${errorHtml}
    <label style="font-size:13px; color:#374151;">Usuario</label>
    <input name="username" type="text" required style="width:100%; margin:6px 0 12px; padding:10px; border:1px solid #d1d5db; border-radius:8px;" />
    <label style="font-size:13px; color:#374151;">Contraseña</label>
    <input name="password" type="password" required style="width:100%; margin:6px 0 14px; padding:10px; border:1px solid #d1d5db; border-radius:8px;" />
    <button type="submit" style="width:100%; padding:10px; border:none; border-radius:8px; background:#111827; color:#fff; font-weight:600; cursor:pointer;">Entrar</button>
  </form>
</body>
</html>`;
}

function renderInitialMessages(messages) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  return safeMessages.map(message => `
      <div class="message-row ${message.role === "user" ? "user" : "assistant"}">
        <div class="bubble">${escapeHtml(message.content || "")}</div>
      </div>
  `).join("");
}

function csvValue(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function isSystemTripKey(key) {
  return (
    key.startsWith("geo:v2:") ||
    key.startsWith("cache:v1:") ||
    key.startsWith("admin:sess:") ||
    key.startsWith("access:v1:") ||
    key.startsWith("tripmeta:v1:") ||
    key.startsWith("accesssess:v1:")
  );
}

function normalizeAccessCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
}

function generateAccessCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

async function getTripMeta(env, tripId) {
  try {
    const raw = await env.TRIPS.get(`tripmeta:v1:${tripId}`);
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

async function setTripMeta(env, tripId, meta) {
  await env.TRIPS.put(`tripmeta:v1:${tripId}`, JSON.stringify(meta || {}));
}

async function resolveTripByAccessCode(env, code) {
  const normalized = normalizeAccessCode(code);
  if (!normalized) return null;
  const tripId = await env.TRIPS.get(`access:v1:${normalized}`);
  return tripId || null;
}

async function createClientAccessSession(env, tripId, accessCode) {
  const token = crypto.randomUUID();
  await env.TRIPS.put(`accesssess:v1:${token}`, JSON.stringify({
    trip_id: tripId,
    access_code: normalizeAccessCode(accessCode || ""),
    created_at: new Date().toISOString()
  }), { expirationTtl: 60 * 60 * 24 * 30 });
  return token;
}

async function getClientAccessSession(request, env) {
  const cookies = parseCookies(request);
  const token = cookies.yompr_client_session;
  if (!token || !env?.TRIPS) return null;
  try {
    const raw = await env.TRIPS.get(`accesssess:v1:${token}`);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (!session?.trip_id) return null;
    return session;
  } catch (_) {
    return null;
  }
}

async function requireTripAccess(request, env, tripId) {
  const admin = await getAuthenticatedAdmin(request, env);
  if (admin) return null;
  const session = await getClientAccessSession(request, env);
  if (session?.trip_id === tripId) return null;
  return new Response(null, {
    status: 302,
    headers: { Location: "/portal" }
  });
}

async function assignAccessCode(env, tripId, preferredCode = null) {
  const meta = await getTripMeta(env, tripId);
  const currentCode = normalizeAccessCode(meta.access_code || "");
  const desired = normalizeAccessCode(preferredCode || "");

  if (!desired && currentCode) {
    const mapped = await env.TRIPS.get(`access:v1:${currentCode}`);
    if (mapped === tripId) return currentCode;
  }

  const tryCodes = [];
  if (desired) tryCodes.push(desired);
  for (let i = 0; i < 8; i++) tryCodes.push(generateAccessCode());

  let selected = null;
  for (const candidate of tryCodes) {
    const existingTrip = await env.TRIPS.get(`access:v1:${candidate}`);
    if (!existingTrip || existingTrip === tripId) {
      selected = candidate;
      break;
    }
  }
  if (!selected) throw new Error("No se pudo asignar clave de acceso única.");

  if (currentCode && currentCode !== selected) {
    await env.TRIPS.delete(`access:v1:${currentCode}`).catch(() => {});
  }
  await env.TRIPS.put(`access:v1:${selected}`, tripId);
  await setTripMeta(env, tripId, { ...meta, access_code: selected, updated_at: new Date().toISOString() });
  return selected;
}

function renderClientPortal(errorText = "") {
  const errorHtml = errorText ? `<p style="color:#b91c1c; margin:0 0 12px;">${escapeHtml(errorText)}</p>` : "";
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1" />
  <meta name="theme-color" content="#111827" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="default" />
  <meta name="apple-mobile-web-app-title" content="Yompr" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="apple-touch-icon" href="/appicon.png" />
  <title>Yompr Concierge</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background: #f3f4f6;
      color: #111827;
    }
    .shell {
      min-height: 100vh;
      min-height: 100svh;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding:
        max(18px, calc(env(safe-area-inset-top) + 10px))
        max(16px, env(safe-area-inset-right))
        max(24px, calc(env(safe-area-inset-bottom) + 8px))
        max(16px, env(safe-area-inset-left));
    }
    .card {
      width: min(100%, 560px);
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 20px;
      padding: 22px;
      box-shadow: 0 10px 28px rgba(15, 23, 42, 0.06);
      overflow: hidden;
    }
    .logo-wrap { text-align: center; margin-bottom: 12px; }
    .logo-wrap img { width: 84px; height: 84px; object-fit: contain; }
    h1 {
      margin: 0 0 10px;
      font-size: clamp(42px, 5.6vw, 56px);
      line-height: 1.02;
      letter-spacing: 0;
    }
    .subtitle {
      margin: 0 0 16px;
      color: #6b7280;
      font-size: 17px;
      line-height: 1.35;
    }
    .error {
      color: #b91c1c;
      margin: 0 0 12px;
      font-size: 14px;
    }
    .access-input {
      display: block;
      width: 100%;
      max-width: 100%;
      padding: 15px 16px;
      border: 1px solid #d1d5db;
      border-radius: 14px;
      text-transform: uppercase;
      font-size: 20px;
      line-height: 1.1;
      outline: none;
      margin: 0;
      transition: border-color .14s ease, box-shadow .14s ease;
    }
    .access-input:focus {
      border-color: #0f172a;
      box-shadow: 0 0 0 3px rgba(17, 24, 39, 0.08);
    }
    .btn {
      display: block;
      width: 100%;
      max-width: 100%;
      border: none;
      border-radius: 14px;
      cursor: pointer;
      font-weight: 700;
      margin-left: 0;
      margin-right: 0;
    }
    .btn-primary {
      margin-top: 12px;
      padding: 14px;
      background: #0f172a;
      color: #fff;
      font-size: 22px;
      line-height: 1.05;
    }
    .btn-secondary {
      margin-top: 10px;
      padding: 12px;
      border: 1px solid #d1d5db;
      background: #fff;
      color: #111827;
      font-size: 18px;
      display: none;
    }
    .install-hint {
      font-size: 12px;
      color: #6b7280;
      margin-top: 10px;
      display: none;
    }
    @media (max-width: 640px) {
      .card {
        border-radius: 18px;
        padding: 18px;
      }
      h1 { font-size: 48px; }
      .subtitle { font-size: 16px; margin-bottom: 14px; }
      .access-input { font-size: 18px; padding: 14px; }
      .btn-primary { font-size: 20px; }
    }
    @media (hover: none) and (pointer: coarse) {
      .shell {
        align-items: flex-start;
        padding-top: max(18px, calc(env(safe-area-inset-top) + 10px));
      }
    }
    @media (min-width: 900px) and (hover: hover) and (pointer: fine) {
      .shell {
        align-items: center;
        padding-top: max(22px, calc(env(safe-area-inset-top) + 18px));
      }
    }
  </style>
</head>
<body>
  <main class="shell">
  <form method="POST" action="/portal/access" class="card">
    <div class="logo-wrap">
      <img src="/logo-chat.png" alt="Yompr Chat" />
    </div>
    <h1>Yompr Concierge</h1>
    <p class="subtitle">Ingresa tu clave de acceso para abrir tu viaje.</p>
    ${errorHtml ? `<p class="error">${escapeHtml(errorText)}</p>` : ""}
    <input name="accessCode" class="access-input" placeholder="EJEMPLO: AB12CD" required />
    <button type="submit" class="btn btn-primary">Entrar</button>
    <button id="installAppBtn" type="button" class="btn btn-secondary">Instalar app</button>
    <p id="installHint" class="install-hint">En iPhone: Compartir → “Agregar a pantalla de inicio”.</p>
  </form>
  </main>
  <script>
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
    const installBtn = document.getElementById("installAppBtn");
    const installHint = document.getElementById("installHint");
    let deferredPrompt = null;

    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredPrompt = e;
      if (installBtn && !isStandalone) installBtn.style.display = "block";
    });

    if (installBtn) {
      installBtn.addEventListener("click", async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        await deferredPrompt.userChoice.catch(() => {});
        deferredPrompt = null;
        installBtn.style.display = "none";
      });
    }

    if (isIOS && !isStandalone && installHint) {
      installHint.style.display = "block";
    }
  </script>
</body>
</html>`;
}

function sanitizeUserLocation(raw) {
  if (!raw || typeof raw !== "object") return null;
  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

async function processChatRequest(body, env) {
  const t0 = Date.now();
  let tripId = body.tripId || "unknown";
  let question = body.question || "";

  try {
    const {
      timeZone,
      localDate,
      conversationHistory = []
    } = body;
    const userLocation = sanitizeUserLocation(body.userLocation);

    const tripText = await env.TRIPS.get(tripId);

    if (!tripText) {
      return { status: 404, payload: { answer: "No encontré el viaje." } };
    }

    const tripJson = JSON.parse(tripText);

    const classifierStart = Date.now();
    let analysis = await classifyIntentWithDeepSeek(
      question,
      env,
      tripJson,
      conversationHistory
    );
    const classifierMs = Date.now() - classifierStart;

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

      return {
        status: 200,
        payload: {
          answer: clarificationAnswer,
          intent: "clarification"
        }
      };
    }

    const context = buildContextByIntent(tripJson, analysis, timeZone);
    const intent = analysis.intent || "general";
    const conflicts = detectBasicConflicts(tripJson);
    context.detected_conflicts = conflicts;

    let transportInfo = null;
    let transportUsed = false;
    let transportError = null;
    let routeMs = null;

    try {
      const routeStart = Date.now();
      transportInfo = await enrichWithTransportInfo(
        tripJson,
        { ...analysis, trip_id: tripId, original_question: question, local_date: localDate },
        env
      );
      routeMs = Date.now() - routeStart;

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
    let weatherInfo = null;
    let recommendationsMs = null;
    let weatherMs = null;

    if (intent === "recommendation" && analysis.recommendation_query) {
      try {
        const recStart = Date.now();
        recommendationsInfo = await searchPlacesRecommendations(
          { ...analysis, trip_id: tripId, localDate, original_question: question, user_location: userLocation },
          tripJson,
          env
        );
        recommendationsMs = Date.now() - recStart;
        if (recommendationsInfo?.places?.length) {
          context.recommendations_results = recommendationsInfo.places;
          context.recommendations_operational = recommendationsInfo.operational_validation || null;
          recommendationsUsed = true;
        }
      } catch (e) {
        recommendationsInfo = { places: [], error: String(e) };
      }
    }

    if (intent === "weather" || analysis.tool_needed === "weather" || intent === "recommendation") {
      const weatherStart = Date.now();
      weatherInfo = await enrichWithWeatherInfo(
        tripJson,
        { ...analysis, trip_id: tripId, original_question: question },
        env
      );
      weatherMs = Date.now() - weatherStart;
      if (weatherInfo) context.weather_info = weatherInfo;
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

    const llmStart = Date.now();
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
- Formato obligatorio: usa párrafos cortos, con una línea en blanco entre bloques.
- Cuando des 2 o más opciones (rutas o recomendaciones), enuméralas como "1.", "2.", "3.".
- Cada opción debe ir en su propio bloque; no mezcles dos opciones en el mismo párrafo.
- Después de una URL, inicia una nueva línea o un nuevo párrafo; nunca pegues texto seguido en la misma línea.

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
- Si el lugar trae bloque operational, úsalo para validar recomendación real:
  - Considera open_now, travel_from_hotel_walking_min, travel_from_hotel_driving_min y next_day_risk.
  - Si next_day_risk.level = "unknown", NO menciones riesgo del día siguiente.
  - Si next_day_risk.level = "high", evita recomendar opciones lejanas o de logística pesada.
  - Prioriza opciones con menor tiempo desde hotel cuando el día siguiente sea exigente.
- No menciones todos los campos de cada lugar; sé selectivo y natural.
- Si recommendations_results está vacío o no existe pero el intent es recommendation, di que no encontraste lugares con datos concretos en la zona y recomienda buscar en Google Maps con el tipo de lugar + barrio del hotel.
- NUNCA inventes nombres de restaurantes, bares, museos u otros lugares que no estén en context.recommendations_results.
- Si context.weather_info está disponible, adapta recomendaciones al clima:
  - Si lluvia probable >= 50% o mal clima, prioriza lugares interiores/cubiertos.
  - Si clima agradable, puedes priorizar terrazas o opciones caminables.
  - Explica brevemente por qué la recomendación conviene para ese clima.

Clima:
- Si context.weather_info existe, úsalo como fuente prioritaria para responder clima.
- Si context.weather_info.type = "weather_bundle", úsalo así:
  - Para preguntas de "ahora"/"hoy": usa current.
  - Para preguntas de "mañana": usa forecast_days[1] si existe.
  - Para preguntas de "próximos días"/"esta semana": resume 2 a 3 días de forecast_days de forma compacta.
  - Si forecast_hours existe, úsalo para sugerir ventanas horarias más favorables para salir (lluvia/temperatura), de forma informativa.
  - Incluye temperatura min/max y probabilidad de lluvia cuando esté disponible.
- Tono obligatorio en clima: informativo y flexible, nunca imperativo.
  - Usa frases como: "si quieren salir", "les conviene considerar", "una buena ventana podría ser".
  - Evita frases mandatorias como: "deben", "tienen que", "no salgan".
- Si context.weather_info.type = "weather_error", dilo de forma breve y ofrece volver a intentar con ciudad o zona más específica.
- No inventes pronósticos por hora o por día si no están en context.weather_info.

Rutas:
- Si transport_info.type = “calculated_route”, usa transport_info como fuente ÚNICA para distancias y tiempos. Prohibido usar conocimiento propio sobre distancias, tiempos o rutas.
- Base temporal de rutas:
  - Si transport_info.route_time_basis = "planning_daytime", explica brevemente que la ruta está calculada para planeación (2 días después a las 9:00) para mostrar opciones diurnas más reales.
  - Si transport_info.route_time_basis = "realtime_now", explica que se calculó para salida inmediata.
  - Si el cliente no pidió explícitamente salir ahora, no asumas urgencia.
  - Si transport_info.maps_link_note existe, compártela de forma breve para evitar confusión entre el cálculo planeado y la vista de Google Maps.
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
    const llmMs = Date.now() - llmStart;

    if (!response.ok) {
      return {
        status: 500,
        payload: {
          answer: "Error de DeepSeek: " + JSON.stringify(data)
        }
      };
    }

    const answerRaw = data.choices?.[0]?.message?.content || "No pude responder.";
    const answer = normalizeWrappedUrls(answerRaw);

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
      route_time_basis: transportInfo?.route_time_basis || null,
      route_departure_time: transportInfo?.route_departure_time || null,
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
      recommendations_operational_validated: recommendationsInfo?.places?.filter(p => p?.operational?.validated).length ?? null,
      recommendations_next_day_risk: recommendationsInfo?.operational_validation?.next_day_risk?.level || null,
      weather_used: Boolean(weatherInfo),
      weather_type: weatherInfo?.type || null,
      weather_source: weatherInfo?.source || null,
      weather_location: weatherInfo?.geocode_location || null,
      weather_current_temp_c: weatherInfo?.current?.temperature_c ?? null,
      weather_current_condition: weatherInfo?.current?.condition || null,
      weather_forecast_days: weatherInfo?.forecast_days?.length ?? null,
      weather_forecast_hours: weatherInfo?.forecast_hours?.length ?? null,
      weather_recommendation_windows: weatherInfo?.recommendation_windows?.length ?? null,
      weather_forecast_tomorrow_max_c: weatherInfo?.forecast_days?.[1]?.max_temp_c ?? null,
      weather_forecast_tomorrow_min_c: weatherInfo?.forecast_days?.[1]?.min_temp_c ?? null,
      weather_forecast_tomorrow_rain_prob: weatherInfo?.forecast_days?.[1]?.precipitation_probability_percent ?? null,
      weather_error: weatherInfo?.error || weatherInfo?.details || null,
      latency_total_ms: Date.now() - t0,
      latency_classifier_ms: classifierMs,
      latency_route_ms: routeMs,
      latency_recommendations_ms: recommendationsMs,
      latency_weather_ms: weatherMs,
      latency_llm_ms: llmMs,
      tool_route_status: transportInfo
        ? (transportInfo.type === "calculated_route" ? "ok" : transportInfo.type)
        : (analysis.intent === "route" || analysis.tool_needed === "route" ? "none" : null),
      tool_recommendations_status: recommendationsInfo
        ? (recommendationsUsed ? "ok" : (recommendationsInfo.error ? "error" : "empty"))
        : (intent === "recommendation" ? "none" : null),
      tool_weather_status: weatherInfo
        ? (weatherInfo.type === "weather_error" ? "error" : "ok")
        : ((intent === "weather" || intent === "recommendation") ? "none" : null),
      cache_route_hit: Boolean(transportInfo?.cache_hit),
      cache_recommendations_hit: Boolean(recommendationsInfo?.cache_hit),
      cache_weather_hit: Boolean(weatherInfo?.cache_hit),
      used_transport_in_answer:
        answer.includes("estimado") ||
        answer.includes("Google Maps") ||
        answer.includes("caminando") ||
        answer.includes("taxi") ||
        answer.includes("transporte público")
    });

    return { status: 200, payload: { answer, intent } };
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

    return {
      status: 500,
      payload: {
        answer: errorAnswer
      }
    };
  }
}

const CHAT_CLIENT_JS = String.raw`
(() => {
  const appRoot = document.getElementById("appRoot");
  const tripId = appRoot && appRoot.dataset ? appRoot.dataset.tripId || "" : "";
  const questionInput = document.getElementById("question");
  const sendButton = document.getElementById("sendButton");
  const messages = document.getElementById("messages");

  if (!tripId || !questionInput || !sendButton || !messages) return;

  let conversationHistory = [];
  let isSending = false;

  function syncViewportHeight() {
    const vv = window.visualViewport;
    const h = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty("--vvh", h + "px");
  }

  function userWantsNearbyRecommendations(question) {
    const q = String(question || "").toLowerCase();
    return (
      q.includes("cerca de mi") ||
      q.includes("cerca de mí") ||
      q.includes("near me") ||
      q.includes("a mi alrededor") ||
      q.includes("por aqui") ||
      q.includes("por aquí") ||
      q.includes("alrededor mio") ||
      q.includes("alrededor mío")
    );
  }

  function getCurrentLocation() {
    return new Promise(function(resolve) {
      if (!navigator.geolocation) {
        resolve(null);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        function(position) {
          var coords = position && position.coords ? position.coords : null;
          if (!coords) {
            resolve(null);
            return;
          }
          resolve({
            lat: coords.latitude,
            lon: coords.longitude,
            accuracy: coords.accuracy || null
          });
        },
        function() {
          resolve(null);
        },
        {
          enableHighAccuracy: false,
          timeout: 8000,
          maximumAge: 120000
        }
      );
    });
  }

  function scrollToBottom() {
    messages.scrollTop = messages.scrollHeight;
  }

  function appendStyledText(container, text) {
    var boldRe = /[*][*]([^*]+)[*][*]/g;
    var lines = text.split("\n");
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
    const row = document.createElement("div");
    row.className = "message-row " + role;

    const bubble = document.createElement("div");
    bubble.className = "bubble" + (extraClass ? " " + extraClass : "");

    var urlRe = /https?:\/\/[^\s<>]+|(?:maps|www)[.]google[.]com\/[^\s<>]+|goo[.]gl\/[^\s<>]+/g;
    var trailRe = /[.,;:!?)]+$/;
    var lastIdx = 0;
    var um;
    urlRe.lastIndex = 0;

    while ((um = urlRe.exec(content)) !== null) {
      if (um.index > lastIdx) {
        appendStyledText(bubble, content.slice(lastIdx, um.index));
      }
      var rawUrl = um[0].replace(trailRe, "");
      var hrefUrl = rawUrl.indexOf("http") === 0 ? rawUrl : "https://" + rawUrl;

      var a = document.createElement("a");
      a.href = hrefUrl;
      a.target = "_blank";
      a.rel = "noopener";
      var normalizedHref = hrefUrl.toLowerCase();
      var isMaps =
        normalizedHref.indexOf("maps.google.com") !== -1 ||
        normalizedHref.indexOf("google.com/maps") !== -1 ||
        normalizedHref.indexOf("google.com/travel") !== -1;
      a.textContent = isMaps ? "Ver en Google Maps" : "Abrir enlace";
      a.style.cssText = "color:#3b82f6;text-decoration:underline;font-weight:500;";
      bubble.appendChild(a);

      lastIdx = um.index + um[0].length;
    }

    if (lastIdx < content.length) {
      appendStyledText(bubble, content.slice(lastIdx));
    }

    row.appendChild(bubble);
    messages.appendChild(row);
    scrollToBottom();
    return row;
  }

  function addTypingIndicator() {
    const row = document.createElement("div");
    row.className = "message-row assistant";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    const typing = document.createElement("div");
    typing.className = "typing";
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement("span");
      dot.className = "dot";
      typing.appendChild(dot);
    }
    bubble.appendChild(typing);
    row.appendChild(bubble);
    messages.appendChild(row);
    scrollToBottom();
    return row;
  }

  async function ask(event) {
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    if (event && typeof event.stopPropagation === "function") event.stopPropagation();
    if (isSending || sendButton.disabled) return;

    const question = questionInput.value.trim();
    if (!question) return;

    isSending = true;
    addMessage("user", question);

    questionInput.value = "";
    questionInput.disabled = true;
    sendButton.disabled = true;

    const thinkingRow = addTypingIndicator();

    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const localDate = new Date().toLocaleDateString("en-CA", { timeZone: timeZone });
    const userLocation = userWantsNearbyRecommendations(question)
      ? await getCurrentLocation()
      : null;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tripId: tripId,
          question: question,
          timeZone: timeZone,
          localDate: localDate,
          conversationHistory: conversationHistory,
          userLocation: userLocation
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
      isSending = false;
      questionInput.disabled = false;
      sendButton.disabled = false;
      questionInput.focus();
      scrollToBottom();
    }
  }

  window.YOMPR_CHAT_ASK = ask;
  window.YOMPR_CHAT_KEY = function(event) {
    if (event.key === "Enter") ask(event);
  };

  sendButton.addEventListener("click", ask);
  questionInput.addEventListener("keydown", function(event) {
    if (event.key === "Enter") ask(event);
  });

  syncViewportHeight();
  window.addEventListener("resize", syncViewportHeight);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncViewportHeight);
    window.visualViewport.addEventListener("scroll", syncViewportHeight);
  }
  questionInput.addEventListener("focus", () => setTimeout(syncViewportHeight, 80));
  questionInput.addEventListener("blur", () => setTimeout(syncViewportHeight, 80));

  scrollToBottom();
})();
`;

const CLIENT_SW_JS = String.raw`
const CACHE_NAME = "yompr-client-v1";
const CORE_ASSETS = ["/", "/portal", "/logo-chat.png", "/appicon.png", "/offline.html"];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CORE_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.pathname.startsWith("/admin")) return;
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match("/offline.html"));
    })
  );
});
`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/portal") {
      return new Response(renderClientPortal(), {
        headers: { "Content-Type": "text/html; charset=UTF-8" }
      });
    }

    if (url.pathname === "/portal/access" && request.method === "POST") {
      const form = await request.formData();
      const accessCode = normalizeAccessCode(form.get("accessCode"));
      const tripId = await resolveTripByAccessCode(env, accessCode);
      if (!tripId) {
        return new Response(renderClientPortal("Clave inválida. Verifica tu código."), {
          status: 400,
          headers: { "Content-Type": "text/html; charset=UTF-8" }
        });
      }
      const token = await createClientAccessSession(env, tripId, accessCode);
      return new Response(null, {
        status: 302,
        headers: {
          Location: `/v/${encodeURIComponent(tripId)}`,
          "Set-Cookie": `yompr_client_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`
        }
      });
    }

    if (url.pathname.startsWith("/c/")) {
      const accessCode = normalizeAccessCode(decodeURIComponent(url.pathname.replace("/c/", "")));
      const tripId = await resolveTripByAccessCode(env, accessCode);
      if (!tripId) return new Response("Clave inválida.", { status: 404 });
      const token = await createClientAccessSession(env, tripId, accessCode);
      return new Response(null, {
        status: 302,
        headers: {
          Location: `/v/${encodeURIComponent(tripId)}`,
          "Set-Cookie": `yompr_client_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`
        }
      });
    }

    if (url.pathname === "/admin/login" && request.method === "GET") {
      return new Response(renderAdminLoginPage(), {
        headers: { "Content-Type": "text/html; charset=UTF-8" }
      });
    }

    if (url.pathname === "/admin/login" && request.method === "POST") {
      if (!env?.ADMIN_USERNAME || !env?.ADMIN_PASSWORD) {
        return new Response(renderAdminLoginPage("Falta configurar ADMIN_USERNAME y ADMIN_PASSWORD en el entorno."), {
          status: 500,
          headers: { "Content-Type": "text/html; charset=UTF-8" }
        });
      }

      const form = await request.formData();
      const username = String(form.get("username") || "");
      const password = String(form.get("password") || "");

      if (username !== env.ADMIN_USERNAME || password !== env.ADMIN_PASSWORD) {
        return new Response(renderAdminLoginPage("Credenciales inválidas."), {
          status: 401,
          headers: { "Content-Type": "text/html; charset=UTF-8" }
        });
      }

      const token = crypto.randomUUID();
      await env.TRIPS.put(`admin:sess:${token}`, JSON.stringify({
        username,
        created_at: new Date().toISOString()
      }), { expirationTtl: 60 * 60 * 12 });

      return new Response(null, {
        status: 302,
        headers: {
          Location: "/admin",
          "Set-Cookie": `yompr_admin_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`
        }
      });
    }

    if (url.pathname === "/admin/logout") {
      const cookies = parseCookies(request);
      const token = cookies.yompr_admin_session;
      if (token) {
        await env.TRIPS.delete(`admin:sess:${token}`).catch(() => {});
      }
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/admin/login",
          "Set-Cookie": "yompr_admin_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"
        }
      });
    }

    if (url.pathname === "/api/chat-client.js") {
      return new Response(CHAT_CLIENT_JS, {
        headers: {
          "Content-Type": "application/javascript; charset=UTF-8",
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
          "Pragma": "no-cache",
          "Expires": "0"
        }
      });
    }

    if (url.pathname === "/sw.js") {
      return new Response(CLIENT_SW_JS, {
        headers: {
          "Content-Type": "application/javascript; charset=UTF-8",
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"
        }
      });
    }

    if (url.pathname === "/manifest.webmanifest") {
      return new Response(JSON.stringify({
        name: "Yompr Concierge",
        short_name: "Yompr",
        start_url: "/portal",
        display: "standalone",
        background_color: "#f3f4f6",
        theme_color: "#111827",
        icons: [
          { src: "/appicon.png", sizes: "192x192", type: "image/png" },
          { src: "/appicon.png", sizes: "512x512", type: "image/png" }
        ]
      }), {
        headers: {
          "Content-Type": "application/manifest+json; charset=UTF-8",
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"
        }
      });
    }

    if (url.pathname === "/offline.html") {
      return new Response(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#111827" />
  <title>Sin conexión</title>
</head>
<body style="font-family:Arial,sans-serif;background:#f3f4f6;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:18px;">
  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;max-width:420px;width:100%;padding:20px;text-align:center;">
    <img src="/logo-chat.png" alt="Yompr Chat" style="width:68px;height:68px;object-fit:contain;margin-bottom:10px;" />
    <h1 style="margin:0 0 8px;font-size:22px;color:#111827;">Sin conexión a internet</h1>
    <p style="margin:0;color:#4b5563;line-height:1.5;">
      Esta app necesita conexión para consultar rutas, clima y recomendaciones en tiempo real.
      En cuanto recuperes internet, vuelve a abrir el portal para continuar el chat.
    </p>
  </div>
</body>
</html>`, {
        headers: {
          "Content-Type": "text/html; charset=UTF-8",
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"
        }
      });
    }

    if (url.pathname === "/admin/logs") {
      const blocked = await requireAdminAuth(request, env);
      if (blocked) return blocked;

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
        const weatherStatus = log.weather_used
          ? `✅ ${escapeHtml(log.weather_type || "weather")}<br><small style="color:#555;">${escapeHtml(log.weather_source || "—")}</small><br><small style="color:#0a6;">horas: ${escapeHtml(String(log.weather_forecast_hours ?? "—"))} | ventanas: ${escapeHtml(String(log.weather_recommendation_windows ?? "—"))}</small>`
          : "—";
        const weatherNow = log.weather_current_temp_c != null
          ? `${log.weather_current_temp_c}°C${log.weather_current_condition ? ` • ${escapeHtml(log.weather_current_condition)}` : ""}`
          : "—";
        const weatherTomorrow =
          log.weather_forecast_tomorrow_max_c != null || log.weather_forecast_tomorrow_min_c != null
            ? `${log.weather_forecast_tomorrow_min_c ?? "—"}° / ${log.weather_forecast_tomorrow_max_c ?? "—"}°${log.weather_forecast_tomorrow_rain_prob != null ? ` • lluvia ${log.weather_forecast_tomorrow_rain_prob}%` : ""}`
            : "—";
        const obs = `total ${log.latency_total_ms ?? "—"}ms | cls ${log.latency_classifier_ms ?? "—"} | llm ${log.latency_llm_ms ?? "—"} | route ${log.latency_route_ms ?? "—"} | rec ${log.latency_recommendations_ms ?? "—"} | weather ${log.latency_weather_ms ?? "—"}`;
        const toolStatus = `route:${escapeHtml(log.tool_route_status || "—")} (cache:${log.cache_route_hit ? "hit" : "miss"}, ${escapeHtml(log.route_time_basis || "—")}) | rec:${escapeHtml(log.tool_recommendations_status || "—")} (cache:${log.cache_recommendations_hit ? "hit" : "miss"}) | weather:${escapeHtml(log.tool_weather_status || "—")} (cache:${log.cache_weather_hit ? "hit" : "miss"})`;
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
    <td style="max-width:220px; white-space:pre-wrap; font-size:11px;">${log.recommendations_used ? `✅ ${log.recommendations_count} resultados<br><small style="color:#555;">${escapeHtml(log.recommendations_query || "")}</small>${log.recommendations_bias_used ? "<br><small style='color:#22a;'>📍 bias hotel</small>" : ""}<br><small style="color:#0a6;">ops validadas: ${escapeHtml(String(log.recommendations_operational_validated ?? "—"))}</small><br><small style="color:#555;">riesgo mañana: ${escapeHtml(log.recommendations_next_day_risk || "—")}</small>` : (log.intent === "recommendation" ? `<span style="color:#c00;">Sin resultados<br><small>${escapeHtml(log.recommendations_error || "")}</small></span>` : "—")}</td>
    <td style="max-width:180px; white-space:pre-wrap; font-size:11px;">${weatherStatus}</td>
    <td style="max-width:180px; white-space:pre-wrap; font-size:11px;">${weatherNow}</td>
    <td style="max-width:220px; white-space:pre-wrap; font-size:11px;">${weatherTomorrow}<br><small style="color:#555;">días consultados: ${escapeHtml(String(log.weather_forecast_days ?? "—"))}</small></td>
    <td style="color:#c00; max-width:180px; white-space:pre-wrap; font-size:11px;">${escapeHtml(log.weather_error || "")}</td>
    <td style="max-width:260px; white-space:pre-wrap; font-size:11px;">${escapeHtml(obs)}</td>
    <td style="max-width:240px; white-space:pre-wrap; font-size:11px;">${toolStatus}</td>
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
  <img src="/logo.png" alt="Yompr" style="width:56px; height:56px; object-fit:contain;" />
  <h1>Yompr Concierge Logs</h1>
  <p><a href="/admin">Admin</a> | <a href="/admin/logout">Cerrar sesión</a></p>
  <p>Últimas 200 preguntas registradas.</p>
  <p>
    <a
      href="/admin/logs.txt"
      download="yompr-concierge-logs.txt"
      style="display:inline-block; padding:8px 12px; background:#111827; color:#fff; text-decoration:none; border-radius:6px; font-size:12px;"
    >Descargar TXT</a>
    <a
      href="/admin/logs.csv"
      download="yompr-concierge-logs.csv"
      style="display:inline-block; margin-left:8px; padding:8px 12px; background:#2563eb; color:#fff; text-decoration:none; border-radius:6px; font-size:12px;"
    >Descargar CSV</a>
  </p>
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
        <th>🌤️ Weather</th>
        <th>🌡️ Clima actual</th>
        <th>📅 Mañana</th>
        <th>⚠️ Error clima</th>
        <th>⏱️ Latencias</th>
        <th>🧪 Tools status</th>
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

    if (url.pathname === "/admin/logs.txt") {
      const blocked = await requireAdminAuth(request, env);
      if (blocked) return blocked;

      const list = await env.CHAT_LOGS.list({ limit: 200 });
      const logs = [];
      for (const key of list.keys) {
        const value = await env.CHAT_LOGS.get(key.name);
        if (value) logs.push(JSON.parse(value));
      }
      logs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      const lines = [];
      lines.push("Yompr Concierge Logs");
      lines.push(`Generado: ${new Date().toISOString()}`);
      lines.push(`Total registros: ${logs.length}`);
      lines.push("");

      for (const log of logs) {
        lines.push("------------------------------------------------------------");
        lines.push(`Fecha: ${log.created_at || ""}`);
        lines.push(`Trip ID: ${log.trip_id || ""}`);
        lines.push(`Intent: ${log.intent || ""}`);
        lines.push(`Scope: ${log.scope || ""}`);
        lines.push(`City: ${log.city || ""}`);
        lines.push(`Pregunta: ${log.question || ""}`);
        lines.push(`Respuesta: ${log.answer || ""}`);
        lines.push(`Route status: ${log.tool_route_status || ""}`);
        lines.push(`Route time basis: ${log.route_time_basis || ""}`);
        lines.push(`Route departure time: ${log.route_departure_time || ""}`);
        lines.push(`Recommendations status: ${log.tool_recommendations_status || ""}`);
        lines.push(`Weather status: ${log.tool_weather_status || ""}`);
        lines.push(`Clima ubicación: ${log.weather_location || ""}`);
        lines.push(`Clima actual: ${log.weather_current_temp_c ?? ""}C ${log.weather_current_condition || ""}`);
        lines.push(`Mañana: ${log.weather_forecast_tomorrow_min_c ?? ""}/${log.weather_forecast_tomorrow_max_c ?? ""}C lluvia ${log.weather_forecast_tomorrow_rain_prob ?? ""}%`);
        lines.push(`Error clima: ${log.weather_error || ""}`);
        lines.push(`Latencias(ms): total=${log.latency_total_ms ?? ""}, cls=${log.latency_classifier_ms ?? ""}, llm=${log.latency_llm_ms ?? ""}, route=${log.latency_route_ms ?? ""}, rec=${log.latency_recommendations_ms ?? ""}, weather=${log.latency_weather_ms ?? ""}`);
        lines.push("");
      }

      return new Response(lines.join("\n"), {
        headers: {
          "Content-Type": "text/plain; charset=UTF-8",
          "Content-Disposition": 'attachment; filename="yompr-concierge-logs.txt"'
        }
      });
    }

    if (url.pathname === "/admin/logs.csv") {
      const blocked = await requireAdminAuth(request, env);
      if (blocked) return blocked;

      const list = await env.CHAT_LOGS.list({ limit: 200 });
      const logs = [];
      for (const key of list.keys) {
        const value = await env.CHAT_LOGS.get(key.name);
        if (value) logs.push(JSON.parse(value));
      }
      logs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      const headers = [
        "created_at", "trip_id", "intent", "scope", "city",
        "question", "answer",
        "tool_route_status", "tool_recommendations_status", "tool_weather_status",
        "route_time_basis", "route_departure_time",
        "weather_location", "weather_current_temp_c", "weather_current_condition",
        "weather_forecast_tomorrow_min_c", "weather_forecast_tomorrow_max_c", "weather_forecast_tomorrow_rain_prob",
        "weather_error",
        "latency_total_ms", "latency_classifier_ms", "latency_llm_ms", "latency_route_ms", "latency_recommendations_ms", "latency_weather_ms"
      ];

      const rows = [headers.map(csvValue).join(",")];
      for (const log of logs) {
        const row = [
          log.created_at, log.trip_id, log.intent, log.scope, log.city,
          log.question, log.answer,
          log.tool_route_status, log.tool_recommendations_status, log.tool_weather_status,
          log.route_time_basis, log.route_departure_time,
          log.weather_location, log.weather_current_temp_c, log.weather_current_condition,
          log.weather_forecast_tomorrow_min_c, log.weather_forecast_tomorrow_max_c, log.weather_forecast_tomorrow_rain_prob,
          log.weather_error,
          log.latency_total_ms, log.latency_classifier_ms, log.latency_llm_ms, log.latency_route_ms, log.latency_recommendations_ms, log.latency_weather_ms
        ];
        rows.push(row.map(csvValue).join(","));
      }

      return new Response(rows.join("\n"), {
        headers: {
          "Content-Type": "text/csv; charset=UTF-8",
          "Content-Disposition": 'attachment; filename="yompr-concierge-logs.csv"'
        }
      });
    }

    if (url.pathname === "/admin") {
      const blocked = await requireAdminAuth(request, env);
      if (blocked) return blocked;

      const tripRows = [];
      let cursor;
      let scanned = 0;
      do {
        const page = await env.TRIPS.list({ limit: 1000, cursor });
        for (const key of page.keys || []) {
          scanned++;
          if (isSystemTripKey(key.name)) continue;
          const tripText = await env.TRIPS.get(key.name);
          if (!tripText) continue;
          const meta = await getTripMeta(env, key.name);
          let tripName = "";
          let destination = "";
          let flights = 0;
          let hotels = 0;
          let services = 0;
          try {
            const tripJson = JSON.parse(tripText);
            tripName = tripJson?.trip?.name || "";
            destination = tripJson?.trip?.destination || "";
            flights = (tripJson?.flightReservations || []).length;
            hotels = (tripJson?.hotelVouchers || []).length;
            services = (tripJson?.serviceBookings || []).length;
          } catch (_) {}
          tripRows.push({
            id: key.name,
            accessCode: normalizeAccessCode(meta.access_code || ""),
            tripName,
            destination,
            flights,
            hotels,
            services,
            modified: key.metadata?.modified || ""
          });
        }
        cursor = page.cursor;
      } while (cursor);

      tripRows.sort((a, b) => a.id.localeCompare(b.id));
      const tripsHtml = tripRows.map(t => `
        <tr>
          <td style="padding:8px; border:1px solid #e5e7eb; font-family:monospace;">${escapeHtml(t.id)}</td>
          <td style="padding:8px; border:1px solid #e5e7eb; font-family:monospace;">
            <span id="code-${escapeHtml(t.id)}">${escapeHtml(t.accessCode || "—")}</span>
          </td>
          <td style="padding:8px; border:1px solid #e5e7eb;">${escapeHtml(t.tripName || "—")}</td>
          <td style="padding:8px; border:1px solid #e5e7eb;">${escapeHtml(t.destination || "—")}</td>
          <td style="padding:8px; border:1px solid #e5e7eb; text-align:center;">${t.flights}</td>
          <td style="padding:8px; border:1px solid #e5e7eb; text-align:center;">${t.hotels}</td>
          <td style="padding:8px; border:1px solid #e5e7eb; text-align:center;">${t.services}</td>
          <td style="padding:8px; border:1px solid #e5e7eb; white-space:nowrap;">
            <a href="/v/${encodeURIComponent(t.id)}" target="_blank">Abrir</a>
            &nbsp;|&nbsp;
            <a href="/c/${encodeURIComponent(t.accessCode || "")}" target="_blank">Portal</a>
            &nbsp;|&nbsp;
            <button type="button" onclick="editAccessCode('${escapeHtml(t.id)}','${escapeHtml(t.accessCode || "")}')" style="border:none; background:#1d4ed8; color:#fff; padding:4px 8px; border-radius:6px; cursor:pointer;">Editar clave</button>
            &nbsp;|&nbsp;
            <button type="button" onclick="deleteTrip('${escapeHtml(t.id)}')" style="border:none; background:#b91c1c; color:#fff; padding:4px 8px; border-radius:6px; cursor:pointer;">Eliminar</button>
          </td>
        </tr>
      `).join("");

      return new Response(`
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8" /><title>Yompr Concierge Admin</title></head>
<body style="font-family: Arial; padding: 24px;">
  <img src="/logo.png" alt="Yompr" style="width:56px; height:56px; object-fit:contain;" />
  <h1>Yompr Concierge Admin</h1>
  <p><a href="/admin/logs">Ver logs</a> | <a href="/admin/logout">Cerrar sesión</a></p>
  <p>Sube aquí el archivo JSON completo del viaje.</p>
  <input type="file" id="jsonFile" accept=".json,application/json" />
  <br><br>
  <button onclick="uploadTrip()">Guardar viaje</button>
  <div id="result" style="margin-top:20px;"></div>

  <hr style="margin:22px 0;" />
  <h2>Trips cargados (${tripRows.length})</h2>
  <p style="font-size:12px; color:#6b7280;">Se escanearon ${scanned} claves en KV (se filtran claves internas de cache/sesiones).</p>
  <div style="overflow:auto; border:1px solid #e5e7eb; border-radius:8px;">
    <table style="width:100%; border-collapse:collapse; font-size:13px;">
      <thead>
        <tr style="background:#f3f4f6;">
          <th style="padding:8px; border:1px solid #e5e7eb; text-align:left;">Trip ID</th>
          <th style="padding:8px; border:1px solid #e5e7eb; text-align:left;">Clave acceso</th>
          <th style="padding:8px; border:1px solid #e5e7eb; text-align:left;">Nombre</th>
          <th style="padding:8px; border:1px solid #e5e7eb; text-align:left;">Destino</th>
          <th style="padding:8px; border:1px solid #e5e7eb;">Vuelos</th>
          <th style="padding:8px; border:1px solid #e5e7eb;">Hoteles</th>
          <th style="padding:8px; border:1px solid #e5e7eb;">Servicios</th>
          <th style="padding:8px; border:1px solid #e5e7eb;">Acciones</th>
        </tr>
      </thead>
      <tbody>
        ${tripsHtml || `<tr><td colspan="8" style="padding:12px; text-align:center; color:#6b7280;">No hay trips cargados.</td></tr>`}
      </tbody>
    </table>
  </div>

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
        (data.access_code ? "<p><b>Clave acceso:</b> " + data.access_code + "</p>" : "") +
        (data.link ? '<p><a href="' + data.link + '" target="_blank">Abrir viaje</a></p>' : "") +
        (data.portal_link ? '<p><a href="' + data.portal_link + '" target="_blank">Abrir por portal</a></p>' : "");
    }

    async function deleteTrip(tripId) {
      if (!confirm("¿Eliminar trip " + tripId + "? Esta acción no se puede deshacer.")) return;
      const res = await fetch("/api/admin/delete-trip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tripId })
      });
      const data = await res.json();
      alert(data.message || "Resultado desconocido");
      if (res.ok && data.success) location.reload();
    }

    async function editAccessCode(tripId, currentCode) {
      const next = prompt("Nueva clave de acceso (A-Z y 0-9):", currentCode || "");
      if (next === null) return;
      const res = await fetch("/api/admin/set-access-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tripId, accessCode: next })
      });
      const data = await res.json();
      alert(data.message || "Resultado desconocido");
      if (res.ok && data.success) location.reload();
    }
  </script>
</body>
</html>
`, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
    }

    if (url.pathname === "/api/upload-trip" && request.method === "POST") {
      const blocked = await requireAdminAuth(request, env);
      if (blocked) return blocked;
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
        const accessCode = await assignAccessCode(env, tripId);

        return Response.json({
          success: true,
          message: "Viaje guardado correctamente.",
          trip_id: tripId,
          access_code: accessCode,
          link: "/v/" + encodeURIComponent(tripId),
          portal_link: "/c/" + encodeURIComponent(accessCode)
        });
      } catch (error) {
        return Response.json({
          success: false,
          message: "El archivo JSON no es válido o hubo un error al guardarlo.",
          error: String(error)
        }, { status: 400 });
      }
    }

    if (url.pathname === "/api/admin/delete-trip" && request.method === "POST") {
      const blocked = await requireAdminAuth(request, env);
      if (blocked) return blocked;
      try {
        const body = await request.json();
        const tripId = String(body?.tripId || "").trim();
        if (!tripId || isSystemTripKey(tripId)) {
          return Response.json({ success: false, message: "Trip inválido." }, { status: 400 });
        }
        const meta = await getTripMeta(env, tripId);
        const accessCode = normalizeAccessCode(meta.access_code || "");
        if (accessCode) {
          await env.TRIPS.delete(`access:v1:${accessCode}`).catch(() => {});
        }
        await env.TRIPS.delete(`tripmeta:v1:${tripId}`).catch(() => {});
        await env.TRIPS.delete(tripId);
        return Response.json({ success: true, message: `Trip ${tripId} eliminado.` });
      } catch (e) {
        return Response.json({ success: false, message: "No se pudo eliminar el trip.", error: String(e) }, { status: 400 });
      }
    }

    if (url.pathname === "/api/admin/set-access-code" && request.method === "POST") {
      const blocked = await requireAdminAuth(request, env);
      if (blocked) return blocked;
      try {
        const body = await request.json();
        const tripId = String(body?.tripId || "").trim();
        const requested = normalizeAccessCode(body?.accessCode || "");
        if (!tripId || isSystemTripKey(tripId)) {
          return Response.json({ success: false, message: "Trip inválido." }, { status: 400 });
        }
        if (!requested) {
          return Response.json({ success: false, message: "Clave inválida. Usa solo A-Z y 0-9." }, { status: 400 });
        }
        const tripText = await env.TRIPS.get(tripId);
        if (!tripText) {
          return Response.json({ success: false, message: "Trip no encontrado." }, { status: 404 });
        }
        const code = await assignAccessCode(env, tripId, requested);
        return Response.json({
          success: true,
          message: `Clave actualizada a ${code}.`,
          access_code: code,
          portal_link: `/c/${encodeURIComponent(code)}`
        });
      } catch (e) {
        return Response.json({ success: false, message: "No se pudo actualizar la clave.", error: String(e) }, { status: 400 });
      }
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      const body = await request.json();
      const tripId = String(body?.tripId || "").trim();
      const blocked = await requireTripAccess(request, env, tripId);
      if (blocked) {
        return Response.json({ answer: "Acceso no autorizado. Ingresa por el portal." }, { status: 401 });
      }
      const result = await processChatRequest(body, env);
      return Response.json(result.payload, { status: result.status });
    }

    if (url.pathname.startsWith("/v/")) {
      const tripId = decodeURIComponent(url.pathname.replace("/v/", ""));
      const blocked = await requireTripAccess(request, env, tripId);
      if (blocked) return blocked;
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
  <meta name="theme-color" content="#111827" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="default" />
  <meta name="apple-mobile-web-app-title" content="Yompr Chat" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="apple-touch-icon" href="/appicon.png" />
  <title>${tripName}</title>

  <style>
    html, body {
      height: 100%;
      overflow: hidden;
    }
    :root { --vvh: 100dvh; }
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background: #f4f4f5;
      color: #111827;
      height: var(--vvh);
      display: flex;
      justify-content: center;
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
      padding-left: env(safe-area-inset-left);
      padding-right: env(safe-area-inset-right);
    }

    .app {
      width: 100%;
      max-width: 720px;
      height: var(--vvh);
      max-height: 100%;
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
    .brand {
      display:flex;
      align-items:center;
      gap:10px;
    }
    .brand img {
      width:34px;
      height:34px;
      object-fit:contain;
      border-radius:8px;
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
      overflow-x: hidden;
      -webkit-overflow-scrolling: touch;
      padding: 18px;
      background: #f9fafb;
      scroll-behavior: smooth;
    }

    .message-row {
      display: flex;
      margin-bottom: 12px;
      animation: messageIn 220ms ease-out both;
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
      transition: transform 140ms ease, box-shadow 180ms ease;
    }

    .user .bubble {
      background: #111827;
      color: #ffffff;
      border-bottom-right-radius: 5px;
      box-shadow: 0 6px 14px rgba(17, 24, 39, 0.18);
    }

    .assistant .bubble {
      background: #ffffff;
      color: #111827;
      border: 1px solid #e5e7eb;
      border-bottom-left-radius: 5px;
      box-shadow: 0 5px 12px rgba(15, 23, 42, 0.06);
    }

    .composer {
      position: sticky;
      bottom: 0;
      z-index: 10;
      padding: 12px;
      padding-bottom: calc(22px + env(safe-area-inset-bottom));
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
      font-size: 16px;
      outline: none;
      transition: border-color 140ms ease, box-shadow 140ms ease, background 140ms ease;
    }

    .composer input:focus {
      border-color: #111827;
      box-shadow: 0 0 0 3px rgba(17, 24, 39, 0.08);
      background: #fff;
    }

    .composer button {
      border: none;
      background: #111827;
      color: #ffffff;
      border-radius: 999px;
      padding: 0 18px;
      font-size: 15px;
      cursor: pointer;
      transition: transform 100ms ease, opacity 140ms ease, background 140ms ease;
      will-change: transform;
    }

    .composer button:hover {
      background: #0b1220;
    }

    .composer button:active {
      transform: translateY(1px) scale(0.99);
    }

    .composer button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .typing {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-width: 48px;
    }

    .typing .dot {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: #9ca3af;
      opacity: 0.35;
      animation: dotPulse 1.05s ease-in-out infinite;
    }

    .typing .dot:nth-child(2) {
      animation-delay: 120ms;
    }

    .typing .dot:nth-child(3) {
      animation-delay: 240ms;
    }

    @keyframes dotPulse {
      0%, 80%, 100% { transform: translateY(0); opacity: 0.35; }
      40% { transform: translateY(-3px); opacity: 1; }
    }

    @keyframes messageIn {
      from { opacity: 0; transform: translateY(7px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @media (max-width: 600px) {
      body {
        padding-left: max(8px, env(safe-area-inset-left));
        padding-right: max(8px, env(safe-area-inset-right));
        padding-bottom: max(18px, calc(env(safe-area-inset-bottom) + 16px));
      }
      .app {
        max-width: none;
        border: 1px solid #e5e7eb;
        border-radius: 14px;
        overflow: hidden;
        height: calc(100svh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 18px);
      }

      .bubble {
        max-width: 86%;
        font-size: 16px;
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
  <div class="app" id="appRoot" data-trip-id="${escapeHtml(tripId)}" data-chat-version="v11">
    <div class="header">
      <div class="brand">
        <img src="/logo-chat.png" alt="Yompr Chat" />
        <h1>${tripName}</h1>
      </div>
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

    <div id="composer" class="composer">
      <input
        id="question"
        placeholder="Escribe tu pregunta..."
        autocomplete="off"
        onkeydown="window.YOMPR_CHAT_KEY && window.YOMPR_CHAT_KEY(event)"
      />
      <button id="sendButton" type="button" onclick="window.YOMPR_CHAT_ASK && window.YOMPR_CHAT_ASK(event)">Enviar</button>
    </div>
  </div>
  <script>
${CHAT_CLIENT_JS}
  </script>
  <script>
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  </script>
</body>
</html>
`, {
  headers: {
    "Content-Type": "text/html; charset=UTF-8",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0"
  }
});
    }

    return new Response("Ruta no encontrada", { status: 404 });
  }
};
