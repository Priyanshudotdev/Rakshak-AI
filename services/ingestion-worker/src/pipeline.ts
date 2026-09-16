import { correlationScore, fallbackExtract, isCandidate } from "@rakshak/ai-engine";
import { onQueue } from "./queue.js";
import type { SourceReport } from "./sources.js";
import { seedIncident, verificationFor } from "./verify.js";

const API_URL = process.env.API_URL ?? "http://localhost:3001";
const INGEST_KEY = process.env.EVENT_INGEST_KEY ?? "";

async function publish(name: string, callId: string, payload: unknown): Promise<void> {
  try {
    await fetch(`${API_URL}/api/events/publish`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(INGEST_KEY ? { "x-ingest-key": INGEST_KEY } : {}),
      },
      body: JSON.stringify({ name, callId, payload }),
    });
  } catch {
    /* event bus is best-effort; the report itself is already logged */
  }
}

interface IncidentSnapshot {
  id: string;
  callId: string;
  text: string;
  location?: string;
  time?: string;
  incidentType?: string;
  weapon?: string | null;
}

async function recentIncidents(): Promise<IncidentSnapshot[]> {
  try {
    const res = await fetch(`${API_URL}/api/records?limit=50`);
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: any[] };
    return (body.data ?? []).map((r) => ({
      id: String(r.id ?? r.call_id ?? ""),
      callId: String(r.call_id ?? r.id ?? ""),
      text: `${r.transcript_original ?? ""}\n${r.transcript_english ?? ""}\n${r.extraction?.summary ?? ""}`,
      location: r.extraction?.location,
      time: r.created_at,
      incidentType: r.extraction?.incident_type,
      weapon: r.extraction?.weapon_type ?? null,
    }));
  } catch {
    return [];
  }
}

export function registerPipeline(): void {
  onQueue("extraction", async ({ data }) => {
    const report = data.report as SourceReport;
    const extraction = fallbackExtract(report.title, `${report.title}\n${report.body}`);
    const { enqueue } = await import("./queue.js");
    await enqueue("classification", "report", { report, extraction });
  });

  onQueue("classification", async ({ data }) => {
    const { enqueue } = await import("./queue.js");
    await enqueue("location-resolution", "report", data);
  });

  onQueue("location-resolution", async ({ data }) => {
    const { enqueue } = await import("./queue.js");
    await enqueue("incident-correlation", "report", data);
  });

  onQueue("incident-correlation", async ({ data }) => {
    const { report, extraction } = data as { report: SourceReport; extraction: any };
    const incidents = await recentIncidents();
    const mine = {
      text: `${report.title}\n${report.body}`,
      location: extraction?.location?.area,
      time: report.publishedAt,
      incidentType: extraction?.incident_type?.primary,
      weapon: extraction?.weapon_mentioned?.weapon_type ?? null,
    };
    const matches = incidents
      .map((inc) => ({ inc, result: correlationScore(mine, inc) }))
      .filter((m) => isCandidate(m.result))
      .sort((x, y) => y.result.score - x.result.score)
      .slice(0, 3)
      .map((m) => ({
        incident_id: m.inc.id,
        call_id: m.inc.callId,
        score: m.result.score,
        signals: m.result.signals,
      }));
    const { enqueue } = await import("./queue.js");
    await enqueue("enrichment", "report", { report, extraction, matches });
  });

  onQueue("enrichment", async ({ data }) => {
    const { enqueue } = await import("./queue.js");
    await enqueue("notification", "report", data);
  });

  // Notification NEVER creates incidents. It annotates matched ones with
  // evidence + verification, and logs unmatched reports as candidates.
  onQueue("notification", async ({ data }) => {
    const { report, matches } = data as {
      report: SourceReport;
      matches: Array<{ incident_id: string; call_id: string; score: number; signals: string[] }>;
    };
    if (!matches.length) {
      console.log(JSON.stringify({ level: "info", msg: "unmatched source report", report: report.id, source: report.source }));
      return;
    }
    for (const match of matches) {
      seedIncident(match.incident_id);
      const verification = verificationFor(match.incident_id, 1);
      await publish("ai.explanation.updated", match.call_id, {
        report_id: report.id,
        report_source: report.source,
        report_title: report.title,
        correlation_score: match.score,
        signals: match.signals,
        verification: verification.status,
        corroborating_reports: verification.reports,
      });
      await publish("incident.updated", match.call_id, {
        verification: verification.status,
        corroborating_reports: verification.reports,
        matched_report: report.id,
      });
    }
  });
}
