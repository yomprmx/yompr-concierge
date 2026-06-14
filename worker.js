import { escapeHtml, normalizeText } from "./src/utils.js";
import { buildContextByIntent, detectBasicConflicts } from "./src/trip.js";
import { classifyIntentWithDeepSeek } from "./src/classifier.js";
import { enrichWithTransportInfo } from "./src/routing.js";
import { searchPlacesRecommendations } from "./src/recommendations.js";
import { enrichWithWeatherInfo } from "./src/weather.js";
import { saveChatLog } from "./src/logging.js";
import { fetchWikipediaContext } from "./src/wiki.js";

const CLIENT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const CLIENT_SESSION_IDLE_MS = 36 * 60 * 60 * 1000;
const PRIVACY_CONSENT_TTL_SECONDS = 60 * 60 * 24 * 60;
const PRIVACY_REASK_BASE_MS = 24 * 60 * 60 * 1000;
const PRIVACY_REASK_CONTINUOUS_MS = 48 * 60 * 60 * 1000;
const PRIVACY_CONTINUOUS_GAP_MS = 6 * 60 * 60 * 1000;
const PRIVACY_POLICY_VERSION = "2026-05-v1";
const CHAT_WELCOME_MESSAGE = "Bienvenido. Soy Tho, tu concierge privado de Yompr. Estoy aquí para acompañarte en cada etapa del viaje con una atención cálida, precisa y cuidadosamente personalizada.\n\nPuedo ayudarte con logística de vuelos, hoteles y traslados, recomendaciones de restaurantes y experiencias, rutas optimizadas, contexto cultural e histórico de lugares, y sugerencias adaptadas al clima y al ritmo real de tu itinerario.\n\nSi lo prefieres, también puedo priorizar opciones cerca de tu ubicación actual para resolver planes en el momento. ¿Con qué te gustaría empezar hoy?";
const PRECISE_GPS_MAX_ACCURACY_M = 120;

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

function hasAnyUrl(text) {
  return /https?:\/\/[^\s<>()]+/i.test(String(text || ""));
}

function appendRecommendationLinks(answer, recommendations) {
  const base = String(answer || "").trim();
  const places = Array.isArray(recommendations) ? recommendations : [];
  if (!places.length) return base;
  if (hasAnyUrl(base)) return base;

  const linked = places
    .filter(place => place && place.name && place.maps_link)
    .slice(0, 3);

  if (!linked.length) return base;

  const lines = linked.map((place, index) => `${index + 1}. ${place.name}\n${place.maps_link}`);
  return `${base}\n\nEnlaces de Google Maps:\n\n${lines.join("\n\n")}`;
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
    key.startsWith("accesssess:v1:") ||
    key.startsWith("privacy:v1:")
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
  const nowIso = new Date().toISOString();
  await env.TRIPS.put(`accesssess:v1:${token}`, JSON.stringify({
    trip_id: tripId,
    access_code: normalizeAccessCode(accessCode || ""),
    created_at: nowIso,
    last_activity_at: nowIso
  }), { expirationTtl: CLIENT_SESSION_TTL_SECONDS });
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
    const lastActivityMs = Date.parse(session.last_activity_at || session.created_at || "");
    if (!Number.isFinite(lastActivityMs)) {
      await env.TRIPS.delete(`accesssess:v1:${token}`).catch(() => {});
      return null;
    }
    if (Date.now() - lastActivityMs > CLIENT_SESSION_IDLE_MS) {
      await env.TRIPS.delete(`accesssess:v1:${token}`).catch(() => {});
      return null;
    }
    return { ...session, token };
  } catch (_) {
    return null;
  }
}

async function touchClientAccessSession(env, session) {
  if (!env?.TRIPS || !session?.token || !session?.trip_id) return;
  const updated = {
    ...session,
    last_activity_at: new Date().toISOString()
  };
  delete updated.token;
  await env.TRIPS.put(`accesssess:v1:${session.token}`, JSON.stringify(updated), {
    expirationTtl: CLIENT_SESSION_TTL_SECONDS
  });
}

async function clearClientAccessSession(request, env) {
  const cookies = parseCookies(request);
  const token = cookies.yompr_client_session;
  if (!token || !env?.TRIPS) return;
  await env.TRIPS.delete(`accesssess:v1:${token}`).catch(() => {});
}

async function getPrivacyConsent(request, env) {
  const cookies = parseCookies(request);
  const token = cookies.yompr_privacy_token;
  if (!token || !env?.TRIPS) return null;
  try {
    const raw = await env.TRIPS.get(`privacy:v1:${token}`);
    if (!raw) return null;
    const payload = JSON.parse(raw);
    if (!payload?.trip_id || !payload?.accepted_at) return null;
    return { ...payload, token };
  } catch (_) {
    return null;
  }
}

function getPrivacyReaskWindowMs(consent) {
  const acceptedMs = Date.parse(consent?.accepted_at || "");
  const lastSeenMs = Date.parse(consent?.last_seen_at || consent?.accepted_at || "");
  if (!Number.isFinite(acceptedMs)) return 0;
  const nowMs = Date.now();
  const isContinuous = Number.isFinite(lastSeenMs) && (nowMs - lastSeenMs) <= PRIVACY_CONTINUOUS_GAP_MS;
  return isContinuous ? PRIVACY_REASK_CONTINUOUS_MS : PRIVACY_REASK_BASE_MS;
}

function isPrivacyConsentValid(consent, tripId) {
  if (!consent || !tripId) return false;
  if (consent.trip_id !== tripId) return false;
  if (consent.policy_version !== PRIVACY_POLICY_VERSION) return false;
  const acceptedMs = Date.parse(consent.accepted_at || "");
  if (!Number.isFinite(acceptedMs)) return false;
  return (Date.now() - acceptedMs) <= getPrivacyReaskWindowMs(consent);
}

async function touchPrivacyConsent(env, consent) {
  if (!env?.TRIPS || !consent?.token) return;
  const updated = {
    ...consent,
    last_seen_at: new Date().toISOString()
  };
  delete updated.token;
  await env.TRIPS.put(`privacy:v1:${consent.token}`, JSON.stringify(updated), {
    expirationTtl: PRIVACY_CONSENT_TTL_SECONDS
  });
}

async function createPrivacyConsent(env, tripId) {
  const token = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  await env.TRIPS.put(`privacy:v1:${token}`, JSON.stringify({
    trip_id: tripId,
    policy_version: PRIVACY_POLICY_VERSION,
    accepted_at: nowIso,
    last_seen_at: nowIso
  }), { expirationTtl: PRIVACY_CONSENT_TTL_SECONDS });
  return token;
}

async function clearPrivacyConsent(env, request) {
  const current = await getPrivacyConsent(request, env);
  if (current?.token) {
    await env.TRIPS.delete(`privacy:v1:${current.token}`).catch(() => {});
  }
}

async function requireTripAccess(request, env, tripId) {
  const admin = await getAuthenticatedAdmin(request, env);
  if (admin) return null;
  const session = await getClientAccessSession(request, env);
  if (session?.trip_id === tripId) {
    await touchClientAccessSession(env, session).catch(() => {});
    return null;
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/portal",
      "Set-Cookie": "yompr_client_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"
    }
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
  const accuracy = Number(raw.accuracy);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return {
    lat,
    lon,
    accuracy: Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null
  };
}

function isPreciseUserLocation(userLocation) {
  if (!userLocation) return false;
  if (!Number.isFinite(userLocation.lat) || !Number.isFinite(userLocation.lon)) return false;
  if (!Number.isFinite(userLocation.accuracy)) return false;
  return userLocation.accuracy <= PRECISE_GPS_MAX_ACCURACY_M;
}

function roundCoord(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 10000) / 10000;
}

function shouldRequestGpsForRecommendation(analysis, question) {
  const intent = analysis?.intent || "";
  if (intent !== "recommendation" && intent !== "nearby_places") return false;
  if ((analysis?.location_context || "") === "current_user_area") return true;
  const q = normalizeText(question || "");
  return (
    q.includes("cerca de mi") ||
    q.includes("cerca de mí") ||
    q.includes("near me") ||
    q.includes("aqui") ||
    q.includes("aquí") ||
    q.includes("alrededor") ||
    q.includes("donde estoy") ||
    q.includes("around me")
  );
}

function shouldUseWikipedia(analysis, question) {
  if (analysis?.wiki_needed) return true;
  if (analysis?.tool_needed === "wiki") return true;
  if (analysis?.wiki_query) return true;
  const q = normalizeText(question || "");
  return (
    q.includes("hablame de") ||
    q.includes("háblame de") ||
    q.includes("que es") ||
    q.includes("qué es") ||
    q.includes("quien fue") ||
    q.includes("quién fue") ||
    q.includes("historia") ||
    q.includes("historico") ||
    q.includes("histórico") ||
    q.includes("arquitectura") ||
    q.includes("arte") ||
    q.includes("museo") ||
    q.includes("monumento") ||
    q.includes("barrio") ||
    q.includes("urbano") ||
    q.includes("cultura")
  );
}

function getLastConversationMessage(conversationHistory, role) {
  if (!Array.isArray(conversationHistory)) return null;
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    const item = conversationHistory[i];
    if (item && item.role === role && typeof item.content === "string" && item.content.trim()) {
      return item.content.trim();
    }
  }
  return null;
}

function looksLikeRecommendationAnswer(text) {
  const q = normalizeText(text || "");
  return (
    q.includes("resenas") ||
    q.includes("reseñas") ||
    q.includes("estrellas") ||
    q.includes("google maps") ||
    q.includes("minutos caminando") ||
    q.includes("minutos a pie") ||
    q.includes("abre hasta") ||
    /\b1\./.test(String(text || ""))
  );
}

function isRecommendationFollowupQuestion(question) {
  const q = normalizeText(question || "").trim();
  if (!q) return false;
  return (
    q.startsWith("y ") ||
    q.startsWith("y algo") ||
    q.startsWith("y para") ||
    q.includes("mas tarde") ||
    q.includes("más tarde") ||
    q.includes("caminando") ||
    q.includes("a pie") ||
    q.includes("mas barato") ||
    q.includes("más barato") ||
    q.includes("mas cerca") ||
    q.includes("más cerca") ||
    q.includes("algo para cenar") ||
    q.includes("un lugar para cenar")
  );
}

function shouldCarryRecommendationContext(question, conversationHistory) {
  if (!isRecommendationFollowupQuestion(question)) return false;
  const lastAssistant = getLastConversationMessage(conversationHistory, "assistant");
  return looksLikeRecommendationAnswer(lastAssistant);
}

function buildClassifierQuestion(question, conversationHistory) {
  if (!shouldCarryRecommendationContext(question, conversationHistory)) return question;
  const lastUser = getLastConversationMessage(conversationHistory, "user");
  const lastAssistant = getLastConversationMessage(conversationHistory, "assistant");
  const parts = [
    "Pregunta anterior del cliente:",
    lastUser || "N/A",
    "",
    "Respuesta anterior del concierge:",
    lastAssistant || "N/A",
    "",
    "Seguimiento actual del cliente:",
    question
  ];
  return parts.join("\n");
}

function inferFollowupRecommendationType(question, previousUserQuestion) {
  const q = normalizeText(`${previousUserQuestion || ""} ${question || ""}`);
  if (q.includes("cenar") || q.includes("dinner") || q.includes("comer") || q.includes("restaurant") || q.includes("restaurante")) {
    return "restaurante";
  }
  if (q.includes("cafe") || q.includes("cafeter") || q.includes("coffee")) return "cafe";
  if (q.includes("bar") || q.includes("copas") || q.includes("tragos")) return "bar";
  return "restaurante";
}

function buildFallbackRecommendationQuery(type, city, question, previousUserQuestion) {
  const q = normalizeText(`${previousUserQuestion || ""} ${question || ""}`);
  const cityText = city || "";
  if (type === "bar") return `bar ${cityText}`.trim();
  if (type === "cafe") return `coffee shop ${cityText}`.trim();
  if (q.includes("cenar") || q.includes("dinner")) return `family dinner restaurant ${cityText}`.trim();
  if (q.includes("desayun") || q.includes("breakfast")) return `breakfast restaurant ${cityText}`.trim();
  if (q.includes("comer") || q.includes("lunch") || q.includes("food")) return `restaurant ${cityText}`.trim();
  return `${type === "restaurante" ? "restaurant" : type} ${cityText}`.trim();
}

function buildChatSystemPrompt(options = {}) {
  const {
    includePlanningRules = false,
    includeRecommendationRules = false,
    includeWeatherRules = false,
    includeWikiRules = false,
    includeRouteRules = false
  } = options;

  const sections = [];

  sections.push(`
Eres Tho, concierge privado de Yompr.

Identidad y tono:
- Sofisticado, observador y resolutivo.
- Combina lujo contemporáneo, hospitalidad refinada, inteligencia tranquila y atención al detalle.
- Comunícate en español con calidez humana, estilo natural y elegante, sin rigidez ni tono robótico.
- Dirígete por defecto en segunda persona singular (tú/te/tu), con trato cercano y premium.
- Evita "Familia + apellido", "señor/señora + apellido" o nombres propios del expediente, salvo que el cliente pida explícitamente ese tratamiento.
- No uses plural ("ustedes/les/su viaje de ustedes") a menos que el cliente se exprese explícitamente en plural y quieras reflejar su mismo tono.

Reglas base:
- Usa solo información del viaje y de herramientas inyectadas en contexto.
- Si falta certeza, dilo claramente. No inventes datos ni supuestos.
- Responde en texto plano, sin Markdown, tablas ni asteriscos.
- Sé claro, breve y útil; evita redundancia.
- Usa párrafos cortos con una línea en blanco entre bloques.
- Si das 2+ opciones, enumera como "1.", "2.", "3.".
- Después de cualquier URL, inicia nueva línea o párrafo.
`);

  sections.push(`
URLs (regla estricta):
- Copia URLs completas EXACTAS desde los datos, incluyendo "https://".
- No acortes, no cambies dominio, no uses placeholders como [link] o (enlace).
`);

  if (includePlanningRules) {
    sections.push(`
Planeación, fechas y riesgos:
- Ignora createdAt/modifiedAt/exportedAt para lógica de viaje.
- Usa vuelos, check-in/check-out, actividades y servicios para secuencia real.
- Si el viaje no inicia, dilo y menciona primer evento relevante.
- Si hay conflictos en detected_conflicts, menciona solo los relevantes.
- Check-in/check-out son ventanas administrativas, no eventos fijos.
- Para decidir mejor día o salida nocturna, evalúa siempre impacto del día siguiente.
- Penaliza noches previas a vuelos/traslados/tours tempranos.
`);
  }

  if (includeRecommendationRules) {
    sections.push(`
Recomendaciones:
- Si context.recommendations_results tiene elementos, es tu única fuente de lugares.
- No inventes lugares fuera de esa lista.
- Prioriza rating + reseñas + cercanía + ajuste al pedido (tipo/precio/horario).
- Si location_source = "user_location", habla de ubicación actual y evita referencias al hotel.
- Si location_source = "user_location", nunca digas ni insinúes "estás en el hotel", "desde tu hotel", "donde te hospedas" o equivalente, salvo que el cliente mencione explícitamente el hotel.
- Si el cliente pide algo "a pie" o "caminando", solo menciona opciones realmente caminables desde la ubicación actual.
- Si next_day_risk = "unknown", no menciones riesgo del día siguiente.
- Si no hay resultados, dilo y ofrece búsqueda alternativa prudente.
`);
  }

  if (includeWeatherRules) {
    sections.push(`
Clima:
- Si context.weather_info existe, úsalo como fuente prioritaria.
- "hoy/ahora": current. "mañana": forecast_days[1]. Semana: resumen compacto.
- Si hay forecast_hours, sugiere ventanas horarias favorables de forma informativa.
- Tono no imperativo: sugiere, no ordenes.
- Si weather_error, dilo breve y propone reintento con zona más específica.
`);
  }

  if (includeWikiRules) {
    sections.push(`
Wikipedia (guía cultural/urbana/histórica/artística):
- Si context.wikipedia_info.found=true, úsalo como fuente principal.
- Resume lo más relevante en 4-7 líneas, con 1 dato memorable si aparece en extract.
- Si existe wikipedia_info.content_urls.desktop, compártelo para ampliar.
- Si no hay resultado o error, dilo breve y evita afirmaciones específicas no verificadas.
`);
  }

  if (includeRouteRules) {
    sections.push(`
Rutas:
- Si transport_info.type="calculated_route", usa SOLO transport_info para tiempos/distancias.
- No inventes tiempos ni distancias fuera de transport_info.
- Explica route_time_basis: planning_daytime vs realtime_now cuando aplique.
- Compara opciones disponibles (walking/driving/transit) solo si existen.
- Si transit.steps existe, úsalo para guía paso a paso.
- Si falta origen/destino o hay geocoding/route error, dilo y pide precisión o comparte maps_link.
- Respeta origin_query/destination_query del análisis y la secuencia del itinerario.
`);
  }

  sections.push(`
Límites del rol (obligatorio):
- Eres exclusivamente informativo.
- No puedes reservar, contratar, cancelar, cobrar, cotizar en tiempo real ni gestionar pagos.
- Si piden acciones transaccionales, redirige de forma cálida a su agente de Yompr.
`);

  return sections.join("\n");
}

async function processChatRequest(body, env) {
  const t0 = Date.now();
  let tripId = body.tripId || "unknown";
  let question = body.question || "";

  try {
    const {
      timeZone,
      localDate,
      conversationHistory = [],
      locationRequestTriggered = false,
      locationPermissionState = null,
      locationRetry = false
    } = body;
    const userLocation = sanitizeUserLocation(body.userLocation);
    const userLocationIsPrecise = isPreciseUserLocation(userLocation);

    const tripText = await env.TRIPS.get(tripId);

    if (!tripText) {
      return { status: 404, payload: { answer: "No encontré el viaje." } };
    }

    const tripJson = JSON.parse(tripText);

    const classifierStart = Date.now();
    const classifierQuestion = buildClassifierQuestion(question, conversationHistory);
    let analysis = await classifyIntentWithDeepSeek(
      classifierQuestion,
      env,
      tripJson,
      conversationHistory
    );
    const classifierMs = Date.now() - classifierStart;
    const carryRecommendationContext = shouldCarryRecommendationContext(question, conversationHistory);
    const previousUserQuestion = getLastConversationMessage(conversationHistory, "user");

    if (carryRecommendationContext) {
      if (
        analysis.intent === "clarification" ||
        analysis.intent === "general" ||
        analysis.needs_clarification
      ) {
        analysis.intent = "recommendation";
        analysis.scope = analysis.scope === "unknown" ? "specific_item" : (analysis.scope || "specific_item");
        analysis.tool_needed = "places";
        analysis.needs_clarification = false;
        analysis.clarification_question = null;
      }

      if (userLocationIsPrecise) {
        analysis.location_context = "current_user_area";
      }

      if (!analysis.recommendation_type) {
        analysis.recommendation_type = inferFollowupRecommendationType(question, previousUserQuestion);
      }

      if (!analysis.recommendation_query) {
        analysis.recommendation_query = buildFallbackRecommendationQuery(
          analysis.recommendation_type,
          analysis.city,
          question,
          previousUserQuestion
        );
      }
    }

    const gpsRecommendedByAi = shouldRequestGpsForRecommendation(analysis, question);

    if (gpsRecommendedByAi && !userLocationIsPrecise && !locationRequestTriggered && !locationRetry) {
      await saveChatLog(env, {
        trip_id: tripId,
        question,
        intent: analysis.intent || "recommendation",
        scope: analysis.scope || "all",
        city: analysis.city || null,
        answer: "Solicitud de ubicación enviada al cliente.",
        location_context: analysis.location_context || null,
        gps_requested: true,
        gps_permission_state: "not_requested_yet",
        gps_coords_sent: false,
        gps_accuracy_m: userLocation?.accuracy ?? null,
        tool_recommendations_status: "needs_location"
      });
      return {
        status: 200,
        payload: {
          requires_location: true,
          requires_precise_location: true,
          location_reason: "nearby_recommendation",
          answer: "Para darte recomendaciones realmente cerca de ti, necesito tu ubicación actual con precisión alta."
        }
      };
    }

    if (gpsRecommendedByAi && !userLocationIsPrecise && locationRetry) {
      const noGpsAnswer = userLocation
        ? "Recibí tu ubicación, pero no con precisión suficiente. Activa la ubicación precisa en tu iPhone (Ajustes > Safari > Ubicación > Precisa) y vuelve a compartir ubicación."
        : "No pude acceder a tu ubicación actual. Revisa permisos de ubicación del navegador y vuelve a tocar Compartir ubicación para darte opciones cerca de ti.";
      await saveChatLog(env, {
        trip_id: tripId,
        question,
        intent: analysis.intent || "recommendation",
        scope: analysis.scope || "all",
        city: analysis.city || null,
        answer: noGpsAnswer,
        location_context: analysis.location_context || null,
        gps_requested: true,
        gps_permission_state: locationPermissionState || "unknown",
        gps_coords_sent: false,
        gps_accuracy_m: userLocation?.accuracy ?? null,
        tool_recommendations_status: "location_unavailable"
      });
      return {
        status: 200,
        payload: {
          answer: noGpsAnswer,
          intent: analysis.intent || "recommendation",
          requires_location: true,
          requires_precise_location: true,
          location_source: null
        }
      };
    }

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
    let wikiInfo = null;
    let recommendationsMs = null;
    let weatherMs = null;
    let wikiMs = null;
    const wikiRequested = shouldUseWikipedia(analysis, question);

    const isRecommendationIntent = intent === "recommendation" || intent === "nearby_places";

    if (isRecommendationIntent && analysis.recommendation_query) {
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

    if (intent === "weather" || analysis.tool_needed === "weather" || isRecommendationIntent) {
      const weatherStart = Date.now();
      weatherInfo = await enrichWithWeatherInfo(
        tripJson,
        { ...analysis, trip_id: tripId, original_question: question },
        env
      );
      weatherMs = Date.now() - weatherStart;
      if (weatherInfo) context.weather_info = weatherInfo;
    }

    if (wikiRequested) {
      try {
        const wikiStart = Date.now();
        wikiInfo = await fetchWikipediaContext(
          { ...analysis, trip_id: tripId, original_question: question },
          tripJson,
          env
        );
        wikiMs = Date.now() - wikiStart;
        if (wikiInfo && (wikiInfo.found || wikiInfo.error)) {
          context.wikipedia_info = wikiInfo;
        }
      } catch (e) {
        wikiInfo = { source: "wikipedia", found: false, error: String(e) };
      }
    }

    const questionNorm = normalizeText(question);

    const planningSignals = [
      "conflicto",
      "pesado",
      "conviene",
      "mejor dia",
      "mejor día",
      "que dia",
      "qué día",
      "en que ciudad",
      "en qué ciudad",
      "salir",
      "noche",
      "bar",
      "cena",
      "cenar",
      "tengo tiempo",
      "me da tiempo",
      "riesgo"
    ];
    const hasPlanningSignal =
      analysis.scope === "trip_analysis" ||
      planningSignals.some(signal => questionNorm.includes(signal));

    const needsThinking = isRecommendationIntent || wikiRequested || hasPlanningSignal;
    const includeRouteRules = analysis.tool_needed === "route" || intent === "route" || Boolean(transportInfo);
    const includeRecommendationRules = isRecommendationIntent;
    const includeWeatherRules = intent === "weather" || analysis.tool_needed === "weather" || isRecommendationIntent;
    const includeWikiRules = wikiRequested;
    const includePlanningRules = hasPlanningSignal || isRecommendationIntent;
    const systemPrompt = buildChatSystemPrompt({
      includePlanningRules,
      includeRecommendationRules,
      includeWeatherRules,
      includeWikiRules,
      includeRouteRules
    });

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
            content: systemPrompt
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
    const answer = normalizeWrappedUrls(
      appendRecommendationLinks(answerRaw, recommendationsInfo?.places)
    );

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
      recommendations_location_source: recommendationsInfo?.operational_validation?.location_source || null,
      location_context: analysis.location_context || null,
      wiki_used: Boolean(wikiInfo?.found),
      wiki_query: analysis.wiki_query || null,
      wiki_title: wikiInfo?.title || null,
      wiki_url: wikiInfo?.content_urls?.desktop || null,
      wiki_error: wikiInfo?.error || null,
      gps_requested: Boolean(locationRequestTriggered),
      gps_permission_state: locationPermissionState || null,
      gps_coords_sent: Boolean(userLocation),
      gps_accuracy_m: userLocation?.accuracy ?? null,
      gps_precision_ok: userLocationIsPrecise,
      gps_lat: roundCoord(userLocation?.lat),
      gps_lon: roundCoord(userLocation?.lon),
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
      latency_wiki_ms: wikiMs,
      latency_llm_ms: llmMs,
      tool_route_status: transportInfo
        ? (transportInfo.type === "calculated_route" ? "ok" : transportInfo.type)
        : (analysis.intent === "route" || analysis.tool_needed === "route" ? "none" : null),
      tool_recommendations_status: recommendationsInfo
        ? (recommendationsUsed ? "ok" : (recommendationsInfo.error ? "error" : "empty"))
        : (isRecommendationIntent ? "none" : null),
      tool_weather_status: weatherInfo
        ? (weatherInfo.type === "weather_error" ? "error" : "ok")
        : ((intent === "weather" || isRecommendationIntent) ? "none" : null),
      tool_wiki_status: wikiInfo
        ? (wikiInfo.found ? "ok" : (wikiInfo.error ? "error" : "empty"))
        : (wikiRequested ? "none" : null),
      cache_route_hit: Boolean(transportInfo?.cache_hit),
      cache_recommendations_hit: Boolean(recommendationsInfo?.cache_hit),
      cache_weather_hit: Boolean(weatherInfo?.cache_hit),
      cache_wiki_hit: Boolean(wikiInfo?.cache_hit),
      used_transport_in_answer:
        answer.includes("estimado") ||
        answer.includes("Google Maps") ||
        answer.includes("caminando") ||
        answer.includes("taxi") ||
        answer.includes("transporte público")
    });

    return {
      status: 200,
      payload: {
        answer,
        intent,
        location_source: recommendationsInfo?.operational_validation?.location_source || null
      }
    };
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
  const privacyOverlay = document.getElementById("privacyOverlay");
  const privacyAccept = document.getElementById("privacyAccept");
  const privacyDecline = document.getElementById("privacyDecline");
  const privacyRequired = appRoot && appRoot.dataset ? appRoot.dataset.privacyRequired === "1" : false;
  const welcomeMessage = typeof window.YOMPR_WELCOME_MESSAGE === "string" ? window.YOMPR_WELCOME_MESSAGE : "Bienvenidos. Soy Tho, su concierge privado de Yompr.";

  if (!tripId || !questionInput || !sendButton || !messages) return;

  let conversationHistory = [];
  let isSending = false;
  const GPS_CONSENT_KEY = "yompr_gps_consent_until";
  const GPS_CONSENT_TTL_MS = 24 * 60 * 60 * 1000;
  const PRECISE_LOCATION_MAX_ACCURACY_M = 120;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent || "");

  function syncViewportHeight() {
    const vv = window.visualViewport;
    const keyboardOpen = vv ? (window.innerHeight - vv.height) > 120 : false;
    const h = vv ? Math.round(vv.height + (vv.offsetTop || 0)) : window.innerHeight;
    document.body.classList.toggle("keyboard-open", keyboardOpen);
    document.documentElement.style.setProperty("--vvh", h + "px");
  }

  async function getLocationPermissionState() {
    try {
      if (!navigator.permissions || !navigator.permissions.query) return "unknown";
      const p = await navigator.permissions.query({ name: "geolocation" });
      return p && p.state ? p.state : "unknown";
    } catch (_) {
      return "unknown";
    }
  }

  function getCurrentLocation(requirePrecise) {
    return new Promise(function(resolve) {
      if (!navigator.geolocation) {
        resolve({ coords: null, permissionState: "unavailable" });
        return;
      }

      getLocationPermissionState().then(function(preState) {
        if (preState === "denied") {
          resolve({ coords: null, permissionState: "denied_precheck" });
          return;
        }

        const promptLike = preState === "prompt" || preState === "unknown";
        const attemptTimeoutMs = promptLike ? 30000 : 15000;

        function runAttempt(attemptNumber) {
          var resolved = false;
          var timeoutId = setTimeout(function() {
            if (resolved) return;
            resolved = true;
            resolve({ coords: null, permissionState: "timeout" });
          }, attemptTimeoutMs + 1500);

          navigator.geolocation.getCurrentPosition(
            async function(position) {
              if (resolved) return;
              resolved = true;
              clearTimeout(timeoutId);
              var coords = position && position.coords ? position.coords : null;
              if (!coords) {
                resolve({ coords: null, permissionState: "error_no_coords" });
                return;
              }
              const locationPayload = {
                coords: {
                  lat: coords.latitude,
                  lon: coords.longitude,
                  accuracy: coords.accuracy || null
                },
                permissionState: "granted"
              };
              if (
                requirePrecise &&
                Number.isFinite(locationPayload.coords.accuracy) &&
                locationPayload.coords.accuracy > PRECISE_LOCATION_MAX_ACCURACY_M
              ) {
                const perm = await getLocationPermissionState();
                locationPayload.permissionState = perm === "granted" ? "granted_approximate" : perm;
              }
              resolve(locationPayload);
            },
            function(err) {
              if (resolved) return;
              resolved = true;
              clearTimeout(timeoutId);

              var code = err && typeof err.code === "number" ? err.code : 0;
              var denied = code === 1;
              var unavailable = code === 2;
              var timeout = code === 3;

              // En la primera autorización algunos navegadores móviles reportan
              // un error transitorio justo después del prompt. Reintentamos una vez
              // antes de concluir que realmente falló.
              if (!denied && attemptNumber === 1 && promptLike) {
                setTimeout(function() {
                  runAttempt(2);
                }, 350);
                return;
              }

              resolve({
                coords: null,
                permissionState: denied
                  ? "denied"
                  : (timeout ? "timeout" : (unavailable ? "unavailable_position" : "error"))
              });
            },
            {
              enableHighAccuracy: true,
              timeout: attemptTimeoutMs,
              maximumAge: 0
            }
          );
        }

        runAttempt(1);
      });
    });
  }

  function hasActiveGpsConsent() {
    try {
      const raw = localStorage.getItem(GPS_CONSENT_KEY);
      const expiresAt = raw ? Number(raw) : 0;
      return Number.isFinite(expiresAt) && Date.now() < expiresAt;
    } catch (_) {
      return false;
    }
  }

  function setGpsConsentActive() {
    try {
      localStorage.setItem(GPS_CONSENT_KEY, String(Date.now() + GPS_CONSENT_TTL_MS));
    } catch (_) {}
  }

  function clearGpsConsent() {
    try {
      localStorage.removeItem(GPS_CONSENT_KEY);
    } catch (_) {}
  }

  function addLocationBadge() {
    const row = document.createElement("div");
    row.className = "message-row assistant";
    const badge = document.createElement("div");
    badge.className = "bubble";
    badge.style.cssText = "display:inline-flex;align-items:center;gap:6px;padding:6px 10px;font-size:12px;background:#ecfeff;border:1px solid #67e8f9;color:#0f766e;";
    badge.textContent = "Ubicacion actual utilizada para estas recomendaciones";
    row.appendChild(badge);
    messages.appendChild(row);
    scrollToBottom();
  }

  function addLocationRequestCard(onShareLocation) {
    const row = document.createElement("div");
    row.className = "message-row assistant";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.style.cssText = "max-width:520px;";

    const text = document.createElement("div");
    text.textContent = "Para buscar opciones realmente cerca de ti, comparte tu ubicación precisa.";
    text.style.marginBottom = "8px";
    bubble.appendChild(text);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Compartir ubicación precisa";
    btn.style.cssText = "background:#0f172a;color:#fff;border:none;border-radius:10px;padding:8px 12px;font-size:13px;cursor:pointer;";
    btn.addEventListener("click", async function() {
      btn.disabled = true;
      btn.textContent = "Solicitando permiso...";
      try {
        await onShareLocation();
      } finally {
        if (document.body.contains(btn)) {
          btn.disabled = false;
          btn.textContent = "Compartir ubicación precisa";
        }
      }
    });
    bubble.appendChild(btn);

    row.appendChild(bubble);
    messages.appendChild(row);
    scrollToBottom();
    return row;
  }

  function addLocationHelpMessage(permissionState, accuracy) {
    const bits = [];
    if (permissionState === "denied" || permissionState === "denied_precheck") {
      bits.push("El permiso de ubicación está bloqueado en el navegador.");
    } else if (permissionState === "granted_approximate") {
      bits.push("Recibí tu ubicación, pero con precisión aproximada.");
    } else {
      bits.push("No pude obtener una ubicación precisa en este intento.");
    }
    if (Number.isFinite(accuracy)) {
      bits.push("Precisión recibida: " + Math.round(accuracy) + " m.");
    }
    if (isIOS) {
      bits.push("En iPhone: Ajustes > Safari > Ubicación > Precisa, luego vuelve a intentar.");
    } else {
      bits.push("Revisa permisos de ubicación del navegador y vuelve a intentar.");
    }
    addMessage("assistant", bits.join(" "));
  }

  function lockComposer(locked) {
    questionInput.disabled = locked;
    sendButton.disabled = locked;
  }

  function showPrivacyOverlay() {
    if (!privacyOverlay) return;
    privacyOverlay.classList.add("visible");
    privacyOverlay.setAttribute("aria-hidden", "false");
    lockComposer(true);
  }

  function hidePrivacyOverlay() {
    if (!privacyOverlay) return;
    privacyOverlay.classList.remove("visible");
    privacyOverlay.setAttribute("aria-hidden", "true");
    lockComposer(false);
  }

  async function acceptPrivacyPolicy() {
    const res = await fetch("/api/privacy/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tripId: tripId })
    });
    if (!res.ok) {
      throw new Error("No se pudo guardar tu consentimiento.");
    }
  }

  async function rejectPrivacyPolicy() {
    await fetch("/api/privacy/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tripId: tripId })
    }).catch(() => {});
    window.location.href = "/portal";
  }

  function scrollToBottom() {
    messages.scrollTop = messages.scrollHeight;
  }

  function scrollToMessageStart(row) {
    messages.scrollTop = Math.max(0, row.offsetTop - 8);
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

  function renderBubbleRichContent(bubble, content) {
    bubble.textContent = "";
    var urlRe = /https?:\/\/[^\s<>]+|(?:maps|www)[.]google[.]com\/[^\s<>]+|goo[.]gl\/[^\s<>]+/g;

    function countChar(text, ch) {
      var total = 0;
      for (var i = 0; i < text.length; i++) if (text[i] === ch) total++;
      return total;
    }

    function splitUrlToken(token) {
      var end = token.length;
      var trailing = "";
      while (end > 0) {
        var ch = token[end - 1];
        if (/[.,;:!?]/.test(ch)) {
          trailing = ch + trailing;
          end--;
          continue;
        }
        if (ch === ")" || ch === "]" || ch === "}") {
          var head = token.slice(0, end);
          var opens = ch === ")" ? countChar(head, "(") : (ch === "]" ? countChar(head, "[") : countChar(head, "{"));
          var closes = ch === ")" ? countChar(head, ")") : (ch === "]" ? countChar(head, "]") : countChar(head, "}"));
          if (closes > opens) {
            trailing = ch + trailing;
            end--;
            continue;
          }
        }
        break;
      }
      return { url: token.slice(0, end), trailing: trailing };
    }

    var lastIdx = 0;
    var um;
    urlRe.lastIndex = 0;

    while ((um = urlRe.exec(content)) !== null) {
      if (um.index > lastIdx) {
        appendStyledText(bubble, content.slice(lastIdx, um.index));
      }
      var split = splitUrlToken(um[0]);
      var rawUrl = split.url;
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
      if (split.trailing) {
        appendStyledText(bubble, split.trailing);
      }

      lastIdx = um.index + um[0].length;
    }

    if (lastIdx < content.length) {
      appendStyledText(bubble, content.slice(lastIdx));
    }
  }

  function addMessage(role, content, extraClass, options) {
    const opts = options || {};
    const row = document.createElement("div");
    row.className = "message-row " + role;

    const bubble = document.createElement("div");
    bubble.className = "bubble" + (extraClass ? " " + extraClass : "") + (opts.fadeIn ? " reveal-fade" : "");

    row.appendChild(bubble);
    messages.appendChild(row);
    renderBubbleRichContent(bubble, content);
    if (opts.scrollToStart) scrollToMessageStart(row);
    else scrollToBottom();
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

    async function sendChat(userLocation, locationRequestTriggered, locationPermissionState, locationRetry) {
      return fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tripId: tripId,
          question: question,
          timeZone: timeZone,
          localDate: localDate,
          conversationHistory: conversationHistory,
          userLocation: userLocation,
          locationRequestTriggered: locationRequestTriggered,
          locationPermissionState: locationPermissionState,
          locationRetry: locationRetry
        })
      });
    }

    try {
      // Política de privacidad: no enviar ubicación por defecto.
      // Primero consultamos sin GPS y solo si el backend lo pide, hacemos retry con ubicación.
      let res = await sendChat(null, false, "not_requested", false);
      let data = await res.json();

      if (data && data.requires_privacy_consent) {
        thinkingRow.remove();
        showPrivacyOverlay();
        return;
      }

      if (res.ok && data && data.requires_location) {
        const canAutoRetry = hasActiveGpsConsent();
        if (canAutoRetry) {
          const locationResult = await getCurrentLocation(true);
          const retryRes = await sendChat(locationResult.coords, true, locationResult.permissionState, true);
          const retryData = await retryRes.json();
          thinkingRow.remove();
          if (!retryRes.ok) {
            const errorText = "Error: " + (retryData.answer || retryData.message || JSON.stringify(retryData));
            addMessage("assistant", errorText);
            return;
          }
          const answer2 = retryData.answer || "No recibí respuesta.";
          addMessage("assistant", answer2, "", { fadeIn: true, scrollToStart: true });
          if (locationResult.permissionState === "granted" && locationResult.coords) {
            setGpsConsentActive();
          } else {
            clearGpsConsent();
            addLocationHelpMessage(locationResult.permissionState, locationResult.coords?.accuracy);
          }
          if (retryData.location_source === "user_location") {
            addLocationBadge();
          }
          conversationHistory.push({ role: "user", content: question });
          conversationHistory.push({ role: "assistant", content: answer2 });
          conversationHistory = conversationHistory.slice(-8);
          return;
        } else {
          thinkingRow.remove();
          let requestRow = null;
          requestRow = addLocationRequestCard(async function() {
            const locationResult = await getCurrentLocation(true);
            const retryRes = await sendChat(locationResult.coords, true, locationResult.permissionState, true);
            const retryData = await retryRes.json();
            if (requestRow) requestRow.remove();

            if (!retryRes.ok) {
              const errorText = "Error: " + (retryData.answer || retryData.message || JSON.stringify(retryData));
              addMessage("assistant", errorText);
              return;
            }
            const answer2 = retryData.answer || "No recibí respuesta.";
            addMessage("assistant", answer2);
            if (locationResult.permissionState === "granted" && locationResult.coords) {
              setGpsConsentActive();
            } else {
              clearGpsConsent();
              addLocationHelpMessage(locationResult.permissionState, locationResult.coords?.accuracy);
            }
            if (retryData.location_source === "user_location") {
              addLocationBadge();
            }
            conversationHistory.push({ role: "user", content: question });
            conversationHistory.push({ role: "assistant", content: answer2 });
            conversationHistory = conversationHistory.slice(-8);
          });
          return;
        }
      }

      thinkingRow.remove();

      if (!res.ok) {
        const errorText = "Error: " + (data.answer || data.message || JSON.stringify(data));
        addMessage("assistant", errorText);
        return;
      }

      const answer = data.answer || "No recibí respuesta.";
      addMessage("assistant", answer, "", { fadeIn: true, scrollToStart: true });
      if (data.location_source === "user_location") {
        addLocationBadge();
      }
      conversationHistory.push({ role: "user", content: question });
      conversationHistory.push({ role: "assistant", content: answer });
      conversationHistory = conversationHistory.slice(-8);
    } catch (error) {
      thinkingRow.remove();
      addMessage("assistant", "Error de conexión: " + error.message);
    } finally {
      isSending = false;
      if (!privacyOverlay || !privacyOverlay.classList.contains("visible")) {
        questionInput.disabled = false;
        sendButton.disabled = false;
        questionInput.focus();
      }
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
  questionInput.addEventListener("focus", () => setTimeout(syncViewportHeight, 30));
  questionInput.addEventListener("blur", () => setTimeout(syncViewportHeight, 30));

  if (privacyAccept) {
    privacyAccept.addEventListener("click", async function() {
      privacyAccept.disabled = true;
      privacyDecline.disabled = true;
      privacyAccept.textContent = "Guardando...";
      try {
        await acceptPrivacyPolicy();
        hidePrivacyOverlay();
        if (!messages.querySelector(".message-row")) {
          addMessage("assistant", welcomeMessage, "", { fadeIn: true, scrollToStart: true });
        }
        questionInput.focus();
      } catch (err) {
        addMessage("assistant", "No pude registrar tu consentimiento. Intenta nuevamente.");
      } finally {
        privacyAccept.disabled = false;
        privacyDecline.disabled = false;
        privacyAccept.textContent = "Acepto y continuar";
      }
    });
  }

  if (privacyDecline) {
    privacyDecline.addEventListener("click", rejectPrivacyPolicy);
  }

  if (privacyRequired) {
    showPrivacyOverlay();
  }

  scrollToBottom();
})();
`;

const CLIENT_SW_JS = String.raw`
const CACHE_NAME = "yompr-client-v2";
const CORE_ASSETS = ["/portal", "/logo-chat.png", "/appicon.png", "/offline.html"];

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

  const isDynamicRoute =
    url.pathname.startsWith("/v/") ||
    url.pathname.startsWith("/api/") ||
    url.pathname === "/" ||
    url.pathname === "/portal";

  if (isDynamicRoute) {
    event.respondWith(
      fetch(req).catch(() => caches.match("/offline.html"))
    );
    return;
  }

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
      const headers = new Headers();
      headers.set("Location", `/v/${encodeURIComponent(tripId)}`);
      headers.append("Set-Cookie", `yompr_client_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${CLIENT_SESSION_TTL_SECONDS}`);
      headers.append("Set-Cookie", "yompr_privacy_token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
      return new Response(null, {
        status: 302,
        headers
      });
    }

    if (url.pathname.startsWith("/c/")) {
      const accessCode = normalizeAccessCode(decodeURIComponent(url.pathname.replace("/c/", "")));
      const tripId = await resolveTripByAccessCode(env, accessCode);
      if (!tripId) return new Response("Clave inválida.", { status: 404 });
      const token = await createClientAccessSession(env, tripId, accessCode);
      const headers = new Headers();
      headers.set("Location", `/v/${encodeURIComponent(tripId)}`);
      headers.append("Set-Cookie", `yompr_client_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${CLIENT_SESSION_TTL_SECONDS}`);
      headers.append("Set-Cookie", "yompr_privacy_token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
      return new Response(null, {
        status: 302,
        headers
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

      const list = await env.CHAT_LOGS.list({ limit: 500 });
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
        const obs = `total ${log.latency_total_ms ?? "—"}ms | cls ${log.latency_classifier_ms ?? "—"} | llm ${log.latency_llm_ms ?? "—"} | route ${log.latency_route_ms ?? "—"} | rec ${log.latency_recommendations_ms ?? "—"} | weather ${log.latency_weather_ms ?? "—"} | wiki ${log.latency_wiki_ms ?? "—"}`;
        const toolStatus = `route:${escapeHtml(log.tool_route_status || "—")} (cache:${log.cache_route_hit ? "hit" : "miss"}, ${escapeHtml(log.route_time_basis || "—")}) | rec:${escapeHtml(log.tool_recommendations_status || "—")} (cache:${log.cache_recommendations_hit ? "hit" : "miss"}) | weather:${escapeHtml(log.tool_weather_status || "—")} (cache:${log.cache_weather_hit ? "hit" : "miss"}) | wiki:${escapeHtml(log.tool_wiki_status || "—")} (cache:${log.cache_wiki_hit ? "hit" : "miss"})`;
        const wikiStatus = log.wiki_used
          ? `✅ ${escapeHtml(log.wiki_title || "Artículo")}<br><small style="color:#555;">${escapeHtml(log.wiki_query || "")}</small><br><small style="color:#0a6;">${escapeHtml(log.wiki_url || "")}</small>`
          : (log.tool_wiki_status ? `<small style="color:#555;">${escapeHtml(log.tool_wiki_status)}</small>${log.wiki_error ? `<br><small style="color:#c00;">${escapeHtml(log.wiki_error)}</small>` : ""}` : "—");
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
    <td style="max-width:220px; white-space:pre-wrap; font-size:11px;">${log.recommendations_used ? `✅ ${log.recommendations_count} resultados<br><small style="color:#555;">${escapeHtml(log.recommendations_query || "")}</small>${log.recommendations_bias_used ? `<br><small style='color:#22a;'>📍 source: ${escapeHtml(log.recommendations_location_source || "hotel")}</small>` : ""}<br><small style="color:#0a6;">ops validadas: ${escapeHtml(String(log.recommendations_operational_validated ?? "—"))}</small><br><small style="color:#555;">riesgo mañana: ${escapeHtml(log.recommendations_next_day_risk || "—")}</small>` : ((log.intent === "recommendation" || log.intent === "nearby_places") ? `<span style="color:#c00;">Sin resultados<br><small>${escapeHtml(log.recommendations_error || "")}</small></span>` : "—")}</td>
    <td style="max-width:180px; white-space:pre-wrap; font-size:11px;">${log.gps_requested ? `solicitado<br><small style="color:#555;">permiso: ${escapeHtml(log.gps_permission_state || "—")}</small><br><small style="color:#0a6;">coords: ${log.gps_coords_sent ? "sí" : "no"}${log.gps_precision_ok === true ? " • precisa" : (log.gps_precision_ok === false ? " • aprox" : "")}</small><br><small style="color:#666;">acc: ${log.gps_accuracy_m ?? "—"}m</small><br><small style="color:#666;">${log.gps_lat ?? "—"}, ${log.gps_lon ?? "—"}</small>` : "—"}</td>
    <td style="max-width:180px; white-space:pre-wrap; font-size:11px;">${weatherStatus}</td>
    <td style="max-width:240px; white-space:pre-wrap; font-size:11px;">${wikiStatus}</td>
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
  <p>Últimas 500 preguntas registradas.</p>
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
        <th>📍 GPS</th>
        <th>🌤️ Weather</th>
        <th>📚 Wikipedia</th>
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

      const list = await env.CHAT_LOGS.list({ limit: 500 });
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
        lines.push(`Recommendations location source: ${log.recommendations_location_source || ""}`);
        lines.push(`Wikipedia status: ${log.tool_wiki_status || ""}`);
        lines.push(`Wikipedia query: ${log.wiki_query || ""}`);
        lines.push(`Wikipedia title: ${log.wiki_title || ""}`);
        lines.push(`Wikipedia url: ${log.wiki_url || ""}`);
        lines.push(`Wikipedia error: ${log.wiki_error || ""}`);
        lines.push(`GPS requested: ${log.gps_requested ? "yes" : "no"}`);
        lines.push(`GPS permission: ${log.gps_permission_state || ""}`);
        lines.push(`GPS coords sent: ${log.gps_coords_sent ? "yes" : "no"} (${log.gps_lat ?? ""}, ${log.gps_lon ?? ""})`);
        lines.push(`GPS accuracy(m): ${log.gps_accuracy_m ?? ""}`);
        lines.push(`GPS precise: ${log.gps_precision_ok === true ? "yes" : (log.gps_precision_ok === false ? "no" : "")}`);
        lines.push(`Weather status: ${log.tool_weather_status || ""}`);
        lines.push(`Clima ubicación: ${log.weather_location || ""}`);
        lines.push(`Clima actual: ${log.weather_current_temp_c ?? ""}C ${log.weather_current_condition || ""}`);
        lines.push(`Mañana: ${log.weather_forecast_tomorrow_min_c ?? ""}/${log.weather_forecast_tomorrow_max_c ?? ""}C lluvia ${log.weather_forecast_tomorrow_rain_prob ?? ""}%`);
        lines.push(`Error clima: ${log.weather_error || ""}`);
        lines.push(`Latencias(ms): total=${log.latency_total_ms ?? ""}, cls=${log.latency_classifier_ms ?? ""}, llm=${log.latency_llm_ms ?? ""}, route=${log.latency_route_ms ?? ""}, rec=${log.latency_recommendations_ms ?? ""}, weather=${log.latency_weather_ms ?? ""}, wiki=${log.latency_wiki_ms ?? ""}`);
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

      const list = await env.CHAT_LOGS.list({ limit: 500 });
      const logs = [];
      for (const key of list.keys) {
        const value = await env.CHAT_LOGS.get(key.name);
        if (value) logs.push(JSON.parse(value));
      }
      logs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      const headers = [
        "created_at", "trip_id", "intent", "scope", "city",
        "question", "answer",
        "tool_route_status", "tool_recommendations_status", "tool_weather_status", "tool_wiki_status",
        "wiki_used", "wiki_query", "wiki_title", "wiki_url", "wiki_error",
        "gps_requested", "gps_permission_state", "gps_coords_sent", "gps_accuracy_m", "gps_precision_ok", "gps_lat", "gps_lon",
        "recommendations_location_source", "location_context",
        "route_time_basis", "route_departure_time",
        "weather_location", "weather_current_temp_c", "weather_current_condition",
        "weather_forecast_tomorrow_min_c", "weather_forecast_tomorrow_max_c", "weather_forecast_tomorrow_rain_prob",
        "weather_error",
        "latency_total_ms", "latency_classifier_ms", "latency_llm_ms", "latency_route_ms", "latency_recommendations_ms", "latency_weather_ms", "latency_wiki_ms"
      ];

      const rows = [headers.map(csvValue).join(",")];
      for (const log of logs) {
        const row = [
          log.created_at, log.trip_id, log.intent, log.scope, log.city,
          log.question, log.answer,
          log.tool_route_status, log.tool_recommendations_status, log.tool_weather_status, log.tool_wiki_status,
          log.wiki_used, log.wiki_query, log.wiki_title, log.wiki_url, log.wiki_error,
          log.gps_requested, log.gps_permission_state, log.gps_coords_sent, log.gps_accuracy_m, log.gps_precision_ok, log.gps_lat, log.gps_lon,
          log.recommendations_location_source, log.location_context,
          log.route_time_basis, log.route_departure_time,
          log.weather_location, log.weather_current_temp_c, log.weather_current_condition,
          log.weather_forecast_tomorrow_min_c, log.weather_forecast_tomorrow_max_c, log.weather_forecast_tomorrow_rain_prob,
          log.weather_error,
          log.latency_total_ms, log.latency_classifier_ms, log.latency_llm_ms, log.latency_route_ms, log.latency_recommendations_ms, log.latency_weather_ms, log.latency_wiki_ms
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
            <button type="button" onclick="replaceTripJson('${escapeHtml(t.id)}')" style="border:none; background:#0f766e; color:#fff; padding:4px 8px; border-radius:6px; cursor:pointer;">Reemplazar JSON</button>
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
  <input type="file" id="replaceJsonFile" accept=".json,application/json" style="display:none;" />
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
    let replaceTargetTripId = "";

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

    function replaceTripJson(tripId) {
      replaceTargetTripId = tripId;
      const input = document.getElementById("replaceJsonFile");
      input.value = "";
      input.click();
    }

    document.getElementById("replaceJsonFile").addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      if (!file || !replaceTargetTripId) return;
      const result = document.getElementById("result");
      const ok = confirm("¿Reemplazar el JSON del trip " + replaceTargetTripId + "?");
      if (!ok) return;

      try {
        const jsonText = await file.text();
        const res = await fetch("/api/admin/replace-trip-json", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tripId: replaceTargetTripId,
            jsonText
          })
        });
        const data = await res.json();
        result.innerHTML =
          "<p><b>Resultado:</b> " + (data.message || "Resultado desconocido") + "</p>" +
          (data.trip_id ? "<p><b>Trip ID:</b> " + data.trip_id + "</p>" : "") +
          (data.portal_link ? '<p><a href="' + data.portal_link + '" target="_blank">Abrir por portal</a></p>' : "");
        alert(data.message || "Resultado desconocido");
        if (res.ok && data.success) location.reload();
      } catch (error) {
        alert("No se pudo reemplazar el JSON: " + String(error));
      }
    });

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

    if (url.pathname === "/api/admin/replace-trip-json" && request.method === "POST") {
      const blocked = await requireAdminAuth(request, env);
      if (blocked) return blocked;
      try {
        const body = await request.json();
        const tripId = String(body?.tripId || "").trim();
        const jsonText = String(body?.jsonText || "");

        if (!tripId || isSystemTripKey(tripId)) {
          return Response.json({ success: false, message: "Trip inválido." }, { status: 400 });
        }
        if (!jsonText) {
          return Response.json({ success: false, message: "No se recibió contenido JSON." }, { status: 400 });
        }

        const currentTrip = await env.TRIPS.get(tripId);
        if (!currentTrip) {
          return Response.json({ success: false, message: "Trip no encontrado." }, { status: 404 });
        }

        const tripJson = JSON.parse(jsonText);
        const detectedTripId =
          tripJson?.trip?.tripIdentifier ||
          tripJson?.trip?.id ||
          tripJson?.flightReservations?.[0]?.tripID ||
          tripJson?.hotelVouchers?.[0]?.tripID ||
          tripJson?.serviceBookings?.[0]?.tripID ||
          "";

        if (detectedTripId && String(detectedTripId).trim() !== tripId) {
          return Response.json({
            success: false,
            message: `El JSON parece pertenecer a otro trip (${detectedTripId}). Debe coincidir con ${tripId}.`
          }, { status: 400 });
        }

        await env.TRIPS.put(tripId, JSON.stringify(tripJson));
        const meta = await getTripMeta(env, tripId);
        const accessCode = normalizeAccessCode(meta.access_code || "");
        return Response.json({
          success: true,
          message: `JSON reemplazado correctamente para ${tripId}.`,
          trip_id: tripId,
          portal_link: accessCode ? `/c/${encodeURIComponent(accessCode)}` : null
        });
      } catch (e) {
        return Response.json({
          success: false,
          message: "No se pudo reemplazar el JSON del trip.",
          error: String(e)
        }, { status: 400 });
      }
    }

    if (url.pathname === "/api/privacy/accept" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const tripId = String(body?.tripId || "").trim();
      const blocked = await requireTripAccess(request, env, tripId);
      if (blocked) {
        return Response.json({ success: false, message: "Acceso no autorizado." }, { status: 401 });
      }
      const token = await createPrivacyConsent(env, tripId);
      return new Response(JSON.stringify({
        success: true,
        message: "Aviso de privacidad aceptado.",
        policy_version: PRIVACY_POLICY_VERSION
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "Set-Cookie": `yompr_privacy_token=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${PRIVACY_CONSENT_TTL_SECONDS}`
        }
      });
    }

    if (url.pathname === "/api/privacy/reject" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const tripId = String(body?.tripId || "").trim();
      const blocked = await requireTripAccess(request, env, tripId);
      if (blocked) {
        return Response.json({ success: false, message: "Acceso no autorizado." }, { status: 401 });
      }
      await clearPrivacyConsent(env, request).catch(() => {});
      await clearClientAccessSession(request, env).catch(() => {});
      const headers = new Headers();
      headers.set("Content-Type", "application/json; charset=UTF-8");
      headers.append("Set-Cookie", "yompr_privacy_token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
      headers.append("Set-Cookie", "yompr_client_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
      return new Response(JSON.stringify({
        success: true,
        redirect_to: "/portal"
      }), {
        status: 200,
        headers
      });
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      const body = await request.json();
      const tripId = String(body?.tripId || "").trim();
      const blocked = await requireTripAccess(request, env, tripId);
      if (blocked) {
        return Response.json({ answer: "Acceso no autorizado. Ingresa por el portal." }, { status: 401 });
      }
      const privacyConsent = await getPrivacyConsent(request, env);
      if (!isPrivacyConsentValid(privacyConsent, tripId)) {
        return Response.json({
          answer: "Para continuar, necesito que aceptes el aviso de privacidad.",
          requires_privacy_consent: true
        }, { status: 451 });
      }
      await touchPrivacyConsent(env, privacyConsent).catch(() => {});
      const result = await processChatRequest(body, env);
      return Response.json(result.payload, { status: result.status });
    }

    if (url.pathname.startsWith("/v/")) {
      const tripId = decodeURIComponent(url.pathname.replace("/v/", ""));
      const blocked = await requireTripAccess(request, env, tripId);
      if (blocked) return blocked;
      const privacyConsent = await getPrivacyConsent(request, env);
      const needsPrivacyConsent = !isPrivacyConsentValid(privacyConsent, tripId);
      if (!needsPrivacyConsent) {
        await touchPrivacyConsent(env, privacyConsent).catch(() => {});
      }
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
      position: relative;
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

    .bubble.reveal-fade {
      animation: bubbleFadeIn 260ms ease both;
    }

    .composer {
      position: relative;
      z-index: 10;
      padding: 12px;
      padding-bottom: calc(14px + env(safe-area-inset-bottom));
      border-top: 1px solid #e5e7eb;
      background: #ffffff;
      display: flex;
      gap: 8px;
      flex-shrink: 0;
    }

    body.keyboard-open .composer {
      padding-bottom: max(8px, env(safe-area-inset-bottom));
    }

    .composer input {
      flex: 1;
      min-width: 0;
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
      flex: 0 0 auto;
      min-width: 96px;
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

    .privacy-overlay {
      position: absolute;
      inset: 0;
      background: rgba(255, 255, 255, 0.96);
      backdrop-filter: blur(2px);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 18px;
      z-index: 50;
    }

    .privacy-overlay.visible {
      display: flex;
    }

    .privacy-card {
      width: 100%;
      max-width: 560px;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 16px;
      padding: 18px;
      box-shadow: 0 18px 44px rgba(15, 23, 42, 0.22);
    }

    .privacy-card h2 {
      margin: 0 0 8px;
      font-size: 20px;
      color: #111827;
    }

    .privacy-card p {
      margin: 0 0 10px;
      color: #374151;
      line-height: 1.5;
      font-size: 14px;
    }

    .privacy-actions {
      display: flex;
      gap: 10px;
      justify-content: flex-end;
      margin-top: 12px;
      flex-wrap: wrap;
    }

    .privacy-btn {
      border: none;
      border-radius: 10px;
      padding: 10px 14px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }

    .privacy-btn.primary {
      background: #111827;
      color: #fff;
    }

    .privacy-btn.secondary {
      background: #e5e7eb;
      color: #111827;
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

    @keyframes bubbleFadeIn {
      from { opacity: 0; transform: translateY(5px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @media (max-width: 600px) {
      body {
        padding-top: max(8px, env(safe-area-inset-top));
        padding-left: max(12px, env(safe-area-inset-left));
        padding-right: max(12px, env(safe-area-inset-right));
        padding-bottom: max(16px, env(safe-area-inset-bottom));
      }
      .app {
        max-width: none;
        border: 1px solid #e5e7eb;
        border-radius: 30px;
        overflow: hidden;
        height: calc(var(--vvh) - max(8px, env(safe-area-inset-top)) - max(16px, env(safe-area-inset-bottom)));
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

      .composer {
        padding: 10px;
        padding-bottom: calc(20px + env(safe-area-inset-bottom));
      }

      .composer button {
        min-width: 90px;
        padding: 0 14px;
      }

      .privacy-card {
        border-radius: 14px;
        padding: 14px;
      }

      .privacy-actions {
        flex-direction: column-reverse;
      }

      .privacy-btn {
        width: 100%;
      }
    }
  </style>
</head>

<body>
  <div class="app" id="appRoot" data-trip-id="${escapeHtml(tripId)}" data-chat-version="v12" data-privacy-required="${needsPrivacyConsent ? "1" : "0"}">
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
      ${needsPrivacyConsent ? "" : `
      <div class="message-row assistant">
        <div class="bubble">${escapeHtml(CHAT_WELCOME_MESSAGE)}</div>
      </div>
      `}
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

    <div id="privacyOverlay" class="privacy-overlay" aria-hidden="true">
      <div class="privacy-card">
        <h2>Aviso de privacidad</h2>
        <p>Para habilitar tu concierge digital, necesitamos tu autorización para el tratamiento de datos personales y de uso del servicio.</p>
        <p>Durante la experiencia podemos procesar información del viaje, mensajes del chat, ubicación (solo cuando la compartes) y contenido obtenido desde Google, Wikipedia y datos proporcionados por nuestra agencia.</p>
        <p>Si no aceptas este aviso, no podremos activar el chat y te regresaremos al portal principal.</p>
        <div class="privacy-actions">
          <button id="privacyDecline" type="button" class="privacy-btn secondary">No acepto</button>
          <button id="privacyAccept" type="button" class="privacy-btn primary">Acepto y continuar</button>
        </div>
      </div>
    </div>
  </div>
  <script>
    window.YOMPR_WELCOME_MESSAGE = ${JSON.stringify(CHAT_WELCOME_MESSAGE)};
  </script>
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
