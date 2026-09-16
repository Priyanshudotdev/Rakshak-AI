// Multi-source report intake (spec §17). Phase 5 starts with RSS + fixtures;
// social/citizen connectors arrive when technically and legally appropriate.
// Reports are EVIDENCE, never incidents — verification stays explicit (§19).

export type ReportSource = "rss" | "official" | "citizen" | "fixture";

export interface SourceReport {
  id: string;
  source: ReportSource;
  title: string;
  body: string;
  url?: string;
  publishedAt?: string;
  region?: string;
}

function attr(text: string, tag: string): string {
  const m = text.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return (m?.[1] ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39);/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Minimal RSS 2.0 + Atom parsing without dependencies. Throws nothing. */
export function parseFeed(xml: string, source: ReportSource = "rss"): SourceReport[] {
  const reports: SourceReport[] = [];
  try {
    const blocks: string[] = [
      ...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi),
      ...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi),
    ].map((m) => m[0]);
    blocks.slice(0, 50).forEach((block, i) => {
      const title = stripHtml(attr(block, "title")).slice(0, 300);
      const body = stripHtml(attr(block, "description") || attr(block, "summary") || attr(block, "content")).slice(0, 2000);
      if (!title && !body) return;
      const link = attr(block, "link").match(/href="([^"]+)"/)?.[1] ?? stripHtml(attr(block, "link")).slice(0, 500);
      reports.push({
        id: `SRC-${Date.now().toString(36).toUpperCase()}-${i}`,
        source,
        title: title || body.slice(0, 120),
        body: body || title,
        url: link || undefined,
        publishedAt: stripHtml(attr(block, "pubDate") || attr(block, "published") || attr(block, "updated")) || undefined,
      });
    });
  } catch {
    /* malformed feed -> zero reports, never a crash */
  }
  return reports;
}

async function fetchWithTimeout(url: string, ms = 15_000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "RakshakAI-ingest/2.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Poll configured feeds. RSS_FIXTURE (raw XML) overrides the network for tests/demos. */
export async function collectReports(): Promise<SourceReport[]> {
  const fixture = process.env.RSS_FIXTURE;
  if (fixture) return parseFeed(fixture, "fixture");

  const feeds = (process.env.RSS_FEEDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out: SourceReport[] = [];
  for (const url of feeds.slice(0, 10)) {
    try {
      out.push(...parseFeed(await fetchWithTimeout(url)));
    } catch {
      /* per-feed isolation: one bad feed never stops the poll */
    }
  }
  return out.slice(0, 100);
}
