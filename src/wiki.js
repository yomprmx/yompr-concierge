import { buildCacheKey, cacheGetJson, cachePutJson } from "./cache.js";

function pickWikiLanguage(query = "") {
  const q = String(query).toLowerCase();
  if (q.includes(" in ") || q.includes("history of") || q.includes("art in ")) return "en";
  return "es";
}

function cleanWikiText(text = "") {
  return String(text)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "accept": "application/json",
      "user-agent": "YomprConcierge/1.0 (Wikipedia integration)"
    }
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Wiki ${res.status}: ${err}`);
  }
  return await res.json();
}

export async function fetchWikipediaContext(analysis, tripJson, env) {
  const queryBase = analysis?.wiki_query || analysis?.place_name || analysis?.city || "";
  const question = analysis?.original_question || "";
  const query = String(queryBase || question).trim();
  if (!query) return null;

  const lang = pickWikiLanguage(query);
  const tripId = analysis?.trip_id || "unknown";
  const cacheKey = buildCacheKey("wiki", [tripId, lang, query]);
  const cached = await cacheGetJson(env, cacheKey);
  if (cached) return { ...cached, cache_hit: true };

  try {
    const titleSearchUrl = `https://${lang}.wikipedia.org/w/rest.php/v1/search/title?q=${encodeURIComponent(query)}&limit=5`;
    const titleSearch = await fetchJson(titleSearchUrl);
    const pages = Array.isArray(titleSearch?.pages) ? titleSearch.pages : [];
    const best = pages.find(p => p?.title && !String(p?.description || "").toLowerCase().includes("desambiguación")) || pages[0];
    if (!best?.title) {
      const empty = { source: "wikipedia", lang, query, found: false, error: null };
      await cachePutJson(env, cacheKey, empty, 12 * 3600);
      return empty;
    }

    const summaryUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(best.title)}`;
    const summary = await fetchJson(summaryUrl);
    const payload = {
      source: "wikipedia",
      lang,
      query,
      found: true,
      title: summary?.title || best.title,
      description: cleanWikiText(summary?.description || best?.description || ""),
      extract: cleanWikiText(summary?.extract || ""),
      content_urls: {
        desktop: summary?.content_urls?.desktop?.page || null,
        mobile: summary?.content_urls?.mobile?.page || null
      },
      coordinates: summary?.coordinates
        ? { lat: summary.coordinates.lat || null, lon: summary.coordinates.lon || null }
        : null,
      search_candidates: pages.slice(0, 3).map(p => ({
        title: p?.title || null,
        description: cleanWikiText(p?.description || ""),
        excerpt: cleanWikiText(p?.excerpt || "")
      })),
      error: null
    };
    await cachePutJson(env, cacheKey, payload, 12 * 3600);
    return payload;
  } catch (e) {
    return {
      source: "wikipedia",
      lang,
      query,
      found: false,
      error: String(e)
    };
  }
}

