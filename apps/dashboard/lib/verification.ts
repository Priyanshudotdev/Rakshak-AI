import type { LiveEvent } from "./live";

// Pure mapping from live bus events to a verification summary (spec §19).
// corroborated is the ceiling here — officially_confirmed is operator-only
// and arrives through the dispatch workflow, never the event bus.

export interface Evidence {
  report_id?: string;
  report_source?: string;
  report_title?: string;
  correlation_score?: number;
  signals?: string[];
}

export interface VerificationSummary {
  status: string;
  reports: number;
  evidence: Evidence[];
}

export function summarizeVerification(events: LiveEvent[], callId?: string): VerificationSummary {
  const relevant = callId ? events.filter((e) => e.callId === callId) : events;
  const seen = new Map<string, Evidence>();
  let status = "unverified";
  let reports = 0;

  for (const e of relevant) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (e.name === "ai.explanation.updated") {
      const id = String(p.report_id ?? `${String(p.report_source ?? "?")}:${String(p.report_title ?? "")}`);
      const score = Number(p.correlation_score ?? 0);
      const prev = seen.get(id);
      if (!prev || score > Number(prev.correlation_score ?? 0)) {
        seen.set(id, {
          report_id: typeof p.report_id === "string" ? p.report_id : undefined,
          report_source: typeof p.report_source === "string" ? p.report_source : undefined,
          report_title: typeof p.report_title === "string" ? p.report_title : undefined,
          correlation_score: Number.isFinite(score) ? score : undefined,
          signals: Array.isArray(p.signals) ? (p.signals as string[]) : undefined,
        });
      }
      if (typeof p.verification === "string") status = p.verification;
      if (typeof p.corroborating_reports === "number") reports = Math.max(reports, p.corroborating_reports);
    } else if (e.name === "incident.updated") {
      if (typeof p.verification === "string") status = p.verification;
      if (typeof p.corroborating_reports === "number") reports = Math.max(reports, p.corroborating_reports);
    }
  }

  const evidence = [...seen.values()].sort(
    (a, b) => Number(b.correlation_score ?? 0) - Number(a.correlation_score ?? 0),
  );
  return { status, reports, evidence };
}
