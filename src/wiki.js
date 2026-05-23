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

function buildQueryVariants(query = "") {
  const q = String(query).trim();
  if (!q) return [];
  const variants = [q];
  const cleaned = q
    .replace(/\b(historia|historico|histórico|arte|arquitectura|urbano|cultura|museo|pintura)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned && cleaned !== q) variants.push(cleaned);
  const short = cleaned.split(" ").slice(0, 4).join(" ").trim();
  if (short && !variants.includes(short)) variants.push(short);
  return variants.slice(0, 3);
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

async function searchTitles(lang, query) {
  const restUrl = `https://${lang}.wikipedia.org/w/rest.php/v1/search/title?q=${encodeURIComponent(query)}&limit=5`;
  const rest = await fetchJson(restUrl).catch(() => null);
  const restPages = Array.isArray(rest?.pages) ? rest.pages : [];
  if (restPages.length) {
    return restPages.map(p => ({
      title: p?.title || null,
      description: cleanWikiText(p?.description || ""),
      excerpt: cleanWikiText(p?.excerpt || "")
    })).filter(p => p.title);
  }

  const mwUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=5&format=json&utf8=1`;
  const mw = await fetchJson(mwUrl).catch(() => null);
  const items = Array.isArray(mw?.query?.search) ? mw.query.search : [];
  return items.map(i => ({
    title: i?.title || null,
    description: "",
    excerpt: cleanWikiText(i?.snippet || "")
  })).filter(i => i.title);
}

export async function fetchWikipediaContext(analysis, tripJson, env) {
  const queryBase = analysis?.wiki_query || analysis?.place_name || analysis?.city || "";
  const question = analysis?.original_question || "";
  const query = String(queryBase || question).trim();
  if (!query) return null;

  const lang = pickWikiLanguage(query);
  const queryVariants = buildQueryVariants(query);
  const tripId = analysis?.trip_id || "unknown";
  const cacheKey = buildCacheKey("wiki", [tripId, lang, queryVariants.join("|")]);
  const cached = await cacheGetJson(env, cacheKey);
  if (cached) return { ...cached, cache_hit: true };

  try {
    const langs = lang === "es" ? ["es", "en"] : [lang, "es"];
    let pages = [];
    let usedLang = lang;

    for (const candidateLang of langs) {
      for (const variant of queryVariants) {
        const found = await searchTitles(candidateLang, variant);
        if (found.length) {
          pages = found;
          usedLang = candidateLang;
          break;
        }
      }
      if (pages.length) break;
    }

    const best = pages.find(p => p?.title && !String(p?.description || "").toLowerCase().includes("desambiguación")) || pages[0];
    if (!best?.title) {
      const empty = { source: "wikipedia", lang, query, found: false, error: null };
      await cachePutJson(env, cacheKey, empty, 12 * 3600);
      return empty;
    }

    const summaryUrl = `https://${usedLang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(best.title)}`;
    const summary = await fetchJson(summaryUrl);
    const extract = cleanWikiText(summary?.extract || "");
    if (!extract) {
      const empty = {
        source: "wikipedia",
        lang: usedLang,
        query,
        found: false,
        error: "summary_empty",
        search_candidates: pages.slice(0, 3)
      };
      await cachePutJson(env, cacheKey, empty, 2 * 3600);
      return empty;
    }
    const payload = {
      source: "wikipedia",
      lang: usedLang,
      query,
      found: true,
      title: summary?.title || best.title,
      description: cleanWikiText(summary?.description || best?.description || ""),
      extract,
      content_urls: {
        desktop: summary?.content_urls?.desktop?.page || null,
        mobile: summary?.content_urls?.mobile?.page || null
      },
      coordinates: summary?.coordinates
        ? { lat: summary.coordinates.lat || null, lon: summary.coordinates.lon || null }
        : null,
      search_candidates: pages.slice(0, 3),
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
