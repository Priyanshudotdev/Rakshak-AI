// Verification ladder (spec §19). Reports corroborate; only operators confirm.
//
// Primary ledger is the API (`POST /api/incidents/:key/sources`, backed by
// `incident_sources` on Postgres / file store) so counts survive restarts.
// The in-memory map below is the offline fallback when the API is unreachable.

export type Verification = "unverified" | "multiple_reports" | "corroborated" | "officially_confirmed";

const API_URL = process.env.API_URL ?? "http://localhost:3001";
const INGEST_KEY = process.env.EVENT_INGEST_KEY ?? "";

const counts = new Map<string, number>();

export function verificationFor(incidentId: string, newMatches: number): { status: Verification; reports: number } {
  const total = (counts.get(incidentId) ?? 1) + Math.max(0, newMatches);
  counts.set(incidentId, total);
  if (total >= 4) return { status: "corroborated", reports: total };
  if (total >= 2) return { status: "multiple_reports", reports: total };
  return { status: "unverified", reports: total };
}

export function seedIncident(incidentId: string): void {
  if (!counts.has(incidentId)) counts.set(incidentId, 1);
}

export function resetVerification(): void {
  counts.clear();
}

export interface SourceReportLike {
  id: string;
  source: string;
  title: string;
}

/** Record one corroborating source against the durable ledger. Falls back to
 *  the in-memory ladder when the API is unreachable (same status shape). */
export async function recordSource(
  incidentKey: string,
  report: SourceReportLike,
  score: number,
  signals: string[],
): Promise<{ status: Verification; reports: number }> {
  try {
    const res = await fetch(`${API_URL}/api/incidents/${encodeURIComponent(incidentKey)}/sources`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(INGEST_KEY ? { "x-ingest-key": INGEST_KEY } : {}),
      },
      body: JSON.stringify({
        report_id: report.id,
        source: report.source,
        title: report.title,
        correlation_score: score,
        signals,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: { verification?: Verification; reports?: number } };
    if (!body.data || typeof body.data.reports !== "number") throw new Error("bad verification payload");
    return { status: body.data.verification ?? "multiple_reports", reports: body.data.reports };
  } catch {
    seedIncident(incidentKey);
    return verificationFor(incidentKey, 1);
  }
}
