// Best-effort area geocoding (Phase 6 geo foundation, spec §18).
// Nominatim (OSM) needs no key; usage policy is respected via a short timeout,
// a proper User-Agent, and an in-process cache. Never throws — callers treat
// null as "no coordinates" and keep the text location as the source of truth.

export interface GeoPoint {
  lat: number;
  lon: number;
  display?: string;
}

/** Pure query builder: "Sitabuldi market, Nagpur, India". Tested offline. */
export function buildGeocodeQuery(area?: string | null, landmark?: string | null, city = "Nagpur"): string {
  const bits = [area, landmark].map((s) => (s ?? "").trim()).filter((s) => s && s.toLowerCase() !== "not identified");
  bits.push(city, "India");
  return bits.join(", ");
}

const cache = new Map<string, GeoPoint | null>();

export function clearGeocodeCache(): void {
  cache.clear();
}

async function lookup(query: string): Promise<GeoPoint | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`, {
      signal: ctrl.signal,
      headers: { "User-Agent": "RakshakAI/2.0 (emergency-incident-demo)", Accept: "application/json" },
    });
    if (!res.ok) return null;
    const arr = (await res.json()) as Array<{ lat?: string; lon?: string; display_name?: string }>;
    const first = arr[0];
    const lat = Number(first?.lat);
    const lon = Number(first?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon, display: first?.display_name?.slice(0, 200) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function geocodeArea(area?: string | null, landmark?: string | null, city = "Nagpur"): Promise<GeoPoint | null> {
  const q = buildGeocodeQuery(area, landmark, city);
  if (cache.has(q)) return cache.get(q) ?? null;
  // Over-specific queries ("X crossing, X crossing, ...") often miss while the
  // bare area hits — fall back down the specificity ladder, spaced for the
  // Nominatim usage policy (max 1 req/s).
  const attempts = [
    q,
    buildGeocodeQuery(area, null, city),
    buildGeocodeQuery(landmark, null, city),
  ].filter((s, i, all) => s && all.indexOf(s) === i);
  let result: GeoPoint | null = null;
  for (const [i, attempt] of attempts.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1100));
    result = await lookup(attempt);
    if (result) break;
  }
  // Cache negatives too: an unknown area must not cost requests every time.
  if (cache.size > 500) cache.clear();
  cache.set(q, result);
  return result;
}
