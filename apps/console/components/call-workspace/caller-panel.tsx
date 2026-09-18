"use client";

import { useEffect, useState } from "react";
import type { LiveCall } from "@/lib/live";
import { primaryLanguage } from "@/lib/live";
import { formatClock, formatDuration, maskCaller } from "./model";

interface CallerPanelProps {
  call?: LiveCall;
  callId: string;
  callback: string;
  location: string;
  networkQuality: string;
  category: string;
  busyAction: string | null;
  transcriptEmpty: boolean;
  onTransfer: () => void;
  onEscalate: () => void;
  onMarkSafe: () => void;
  onCreateIncident: () => void;
}

function Badge({ label, tone }: { label: string; tone: "ok" | "warn" | "danger" | "info" | "muted" }): React.ReactElement {
  const tones: Record<string, string> = {
    ok: "bg-okbg text-ok border-ok/30",
    warn: "bg-warnbg text-warn border-warn/30",
    danger: "bg-dangerbg text-danger border-danger/30",
    info: "bg-primary-soft text-primary-dark border-primary/30",
    muted: "bg-paper text-muted border-line",
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold ${tones[tone]}`}>
      {label}
    </span>
  );
}

function statusTone(s: LiveCall["status"]): "ok" | "warn" | "danger" | "info" | "muted" {
  if (s === "active") return "ok";
  if (s === "escalated") return "danger";
  if (s === "ended") return "muted";
  return "warn";
}

function priorityTone(p?: string): "ok" | "warn" | "danger" | "info" | "muted" {
  const v = (p ?? "").toUpperCase();
  if (v.includes("P1") || v.includes("CRIT")) return "danger";
  if (v.includes("P2") || v.includes("HIGH")) return "warn";
  if (v.includes("P3") || v.includes("MED")) return "info";
  if (v.includes("P4") || v.includes("LOW")) return "ok";
  return "muted";
}

/** LEFT column: caller + call info. Values come from live events / the linked record only. */
export function CallerPanel({
  call,
  callId,
  callback,
  location,
  networkQuality,
  category,
  busyAction,
  transcriptEmpty,
  onTransfer,
  onEscalate,
  onMarkSafe,
  onCreateIncident,
}: CallerPanelProps): React.ReactElement {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (call?.status === "ended") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [call?.status]);

  const started = call ? Date.parse(call.startedAt) : NaN;
  const endMs = call?.status === "ended" ? Date.parse(call.lastAt) : now;
  const elapsed = call && !Number.isNaN(started) ? Math.max(0, endMs - started) : 0;

  const lang = call ? primaryLanguage(call) : { language: "Unknown", confidence: 0 };
  const masked = maskCaller(call?.from);
  const busy = busyAction !== null;

  return (
    <section aria-label="Caller and call info" className="flex flex-col gap-4 rounded-xl2 bg-card p-4 shadow-card">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Caller</h2>
        <p className="mt-1 font-mono text-lg font-semibold text-ink" aria-label={`Masked caller identity ${masked}`}>
          {masked}
        </p>
        <p className="mt-0.5 text-xs text-muted">Masked for privacy — full CLI stays phone-side.</p>
      </div>

      <dl className="flex flex-col gap-2 text-sm">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted">Status</dt>
          <dd>{call ? <Badge label={call.status.toUpperCase()} tone={statusTone(call.status)} /> : <Badge label="UNKNOWN" tone="muted" />}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted">Duration</dt>
          <dd className="font-mono font-semibold text-ink" aria-live="off">
            {call ? formatDuration(elapsed) : "—"}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted">Detected language</dt>
          <dd className="text-right text-ink">
            {lang.language}
            <span className="ml-1 text-xs text-muted">
              {lang.confidence > 0 ? `${Math.round(lang.confidence * 100)}% of finals` : "no finals yet"}
            </span>
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted">Callback</dt>
          <dd className="font-mono text-ink">{callback}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted">Location</dt>
          <dd className="text-right text-ink">{location}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted">Network quality</dt>
          <dd className="text-ink">{networkQuality}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted">Priority</dt>
          <dd>
            <Badge label={call?.priority ? `Priority ${call.priority}` : "Priority unknown"} tone={priorityTone(call?.priority)} />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted">Category</dt>
          <dd className="text-right text-ink">{category}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted">Utterances</dt>
          <dd className="text-ink">{call ? call.utterances : "—"}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted">Started</dt>
          <dd className="text-ink">{call ? formatClock(call.startedAt) : "—"}</dd>
        </div>
      </dl>

      <div className="rounded-lg border border-line bg-paper p-2.5 text-xs text-muted" aria-label="Recording metadata">
        <p className="font-semibold text-ink">● Recording (metadata only — no console control)</p>
        <p className="mt-1">VoiceLink side: carrier recording active (informational).</p>
        <p>Our side: MixMonitor note attached to the record.</p>
      </div>

      <div className="flex flex-col gap-2" aria-label="Call actions">
        <button
          type="button"
          onClick={onCreateIncident}
          disabled={busy || transcriptEmpty}
          title={transcriptEmpty ? "No transcript yet" : "Create incident from transcript"}
          className="min-h-[48px] rounded-lg bg-primary px-4 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busyAction === "incident" ? "Creating…" : "Create incident"}
        </button>
        <button
          type="button"
          onClick={onTransfer}
          disabled={busy}
          className="min-h-[48px] rounded-lg border border-line px-4 text-sm font-semibold text-ink disabled:opacity-50"
        >
          Transfer to operator
        </button>
        <button
          type="button"
          onClick={onEscalate}
          disabled={busy}
          className="min-h-[48px] rounded-lg border border-danger/40 bg-dangerbg px-4 text-sm font-semibold text-danger disabled:opacity-50"
        >
          {busyAction === "escalate" ? "Escalating…" : "Escalate"}
        </button>
        <button
          type="button"
          onClick={onMarkSafe}
          disabled={busy}
          className="min-h-[48px] rounded-lg border border-ok/30 bg-okbg px-4 text-sm font-semibold text-ok disabled:opacity-50"
        >
          {busyAction === "marksafe" ? "Marking…" : "Mark safe"}
        </button>
      </div>

      <p className="text-xs text-faint">Monitoring call {callId}. No hold / mute / PSTN-end controls exist in this console.</p>
    </section>
  );
}
