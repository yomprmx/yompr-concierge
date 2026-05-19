import { normalizeText } from "./utils.js";

export function buildCacheKey(prefix, parts = []) {
  const normalized = parts.map(p => normalizeText(String(p ?? "")));
  return `cache:v1:${prefix}:${normalized.join(":")}`;
}

export async function cacheGetJson(env, key) {
  if (!env?.TRIPS || !key) return null;
  try {
    const value = await env.TRIPS.get(key);
    if (!value) return null;
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

export async function cachePutJson(env, key, value, ttlSeconds) {
  if (!env?.TRIPS || !key) return;
  try {
    await env.TRIPS.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds });
  } catch (_) {}
}

