// Incident correlation scoring (spec §18) — pure function, no I/O.
// Embeddings/PostGIS arrive later; this combines the cheap explicit signals
// (text overlap, location, time, entity tokens) so the pipeline shape is real
// and testable today. Individual source reports are always preserved.

export interface Correlian {
  text: string;
  location?: string;
  time?: string | number;
  incidentType?: string;
  weapon?: string | null;
}

export interface CorrelationResult {
  score: number;
  signals: string[];
}

const STOP = new Set(
  "the,a,an,and,or,of,to,in,on,at,for,with,from,by,is,are,was,were,be,been,has,have,had,this,that,these,those,it,its,as,me,ne,ko,ka,ki,ke,se,mein,men,hain,hai,ho,rahi,raha,rahe,madhye,madhe,aahe,la,ne,te,chi,cha,che".split(","),
);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

function normalizeLocation(loc?: string): string {
  return (loc ?? "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").trim();
}

/** Weighted overlap in [0,1]. Threshold guidance: >=0.55 candidate, >=0.75 strong. */
export function correlationScore(a: Correlian, b: Correlian): CorrelationResult {
  const signals: string[] = [];
  let score = 0;

  // 1. Semantic-ish signal: content-word overlap (0.45 weight).
  const wa = words(a.text);
  const wb = words(b.text);
  if (wa.size && wb.size) {
    let overlap = 0;
    for (const w of wa) if (wb.has(w)) overlap += 1;
    const jaccard = overlap / (wa.size + wb.size - overlap);
    if (jaccard > 0) {
      score += jaccard * 0.45;
      signals.push(`text-overlap:${jaccard.toFixed(2)}`);
    }
  }

  // 2. Geographic signal: normalized location match (0.25 weight).
  const la = normalizeLocation(a.location);
  const lb = normalizeLocation(b.location);
  if (la && lb && (la === lb || la.includes(lb) || lb.includes(la))) {
    score += 0.25;
    signals.push("location-match");
  }

  // 3. Temporal signal: decay over 6h (0.15 weight).
  const ta = a.time ? new Date(a.time).getTime() : NaN;
  const tb = b.time ? new Date(b.time).getTime() : NaN;
  if (Number.isFinite(ta) && Number.isFinite(tb)) {
    const hours = Math.abs(ta - tb) / 3_600_000;
    if (hours <= 6) {
      const w = 0.15 * (1 - hours / 6);
      score += w;
      signals.push(`temporal:${hours.toFixed(1)}h`);
    }
  }

  // 4. Entity signal: incident-type / weapon agreement (0.15 weight).
  const typeA = (a.incidentType ?? "").toLowerCase();
  const typeB = (b.incidentType ?? "").toLowerCase();
  if (typeA && typeA !== "unknown" && typeA === typeB) {
    score += 0.1;
    signals.push(`type:${typeA}`);
  }
  const wA = (a.weapon ?? "").toLowerCase();
  const wB = (b.weapon ?? "").toLowerCase();
  if (wA && wA === wB) {
    score += 0.05;
    signals.push(`weapon:${wA}`);
  }

  return { score: Math.round(Math.min(1, score) * 100) / 100, signals };
}

export function isCandidate(result: CorrelationResult): boolean {
  return result.score >= 0.55;
}
