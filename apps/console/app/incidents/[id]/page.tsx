"use client";

/**
 * Incident detail (case file).
 *
 * READ-FIRST contracts (verified against apps/api/src/app.ts — not modified):
 * - GET /api/records/:id            -> { status:"success", data: <full record> }
 * - GET /api/records/:id/audio      -> raw audio bytes (?which=translated);
 *                                      404 when the record has no audio.
 * - GET /api/incidents/:key/verification -> { status, data:{ verification, reports, evidence } }
 * - GET /api/audit?limit=N          -> { status, data:[{ id, created_at, actor,
 *                                      action, entity, entity_id, detail }] }
 * - GET /api/dispatch               -> { status, data:[dispatch entries] }
 * - POST /api/dispatch { call_id, location, incident_type, priority, units }
 *   -> { status, data: entry, log, audit }. The server keeps ONLY those
 *   fields, stamps id/time/operator, flips the record's dispatched flag and
 *   writes an audit row. Extra body fields (decision/note) are sent for
 *   forward-compatibility but are NOT persisted server-side today.
 *
 * Honesty gaps (no backend exists — device-local, always labeled):
 * - operator notes, internal comments, workflow status (anything beyond the
 *   canonical dispatched boolean) -> localStorage, labeled "on this device".
 * - no operator-notes / attachments / incident-status / team endpoints.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowClockwise,
  ArrowLeft,
  Broadcast,
  ChatText,
  ChatsCircle,
  Clock,
  Copy,
  Check,
  Download,
  Ear,
  Eye,
  FileAudio,
  FileText,
  Info,
  ListChecks,
  MapPin,
  NotePencil,
  SealCheck,
  Siren,
  UserCircle,
  Waveform,
  XCircle,
} from "@phosphor-icons/react";
import { Shell } from "@/components/shell";
import {
  audioUrl,
  getAuditLog,
  getDispatchLog,
  getRecord,
  getVerification,
  operatorName,
  postDispatch,
} from "@/lib/api";
import { deriveCalls, useLiveEvents } from "@/lib/live";
import type { AuditEntry, DispatchEntry, IncidentRecord } from "@/lib/types";

/* ---------------- local shapes (server rows carry more than lib/types) ---------------- */

interface RecordDetail extends IncidentRecord {
  has_original_audio?: boolean;
  has_translated_audio?: boolean;
  original_audio_base64?: string;
  translated_audio_base64?: string;
  dispatch_info?: { id?: string; operator?: string; units?: string } | null;
}

interface AuditRow extends AuditEntry {
  created_at?: string;
  at?: string;
}

interface DispatchRow extends DispatchEntry {
  time?: string;
  location?: string;
  incident_type?: string;
  priority?: string;
  created_at?: string;
}

type Workflow = "Open" | "Investigating" | "Dispatched" | "Resolved" | "Closed";
const WORKFLOWS: Workflow[] = ["Open", "Investigating", "Dispatched", "Resolved", "Closed"];

interface LocalComment {
  author: string;
  text: string;
  at: string;
}

/* ---------------- small helpers ---------------- */

function deviceKey(id: string, suffix: string): string {
  return `rakshak.incident.${id}.${suffix}`;
}

/** localStorage-backed state; always labeled device-local at the call site. */
function useDeviceState<T>(key: string | null, initial: T): [T, (next: T | ((p: T) => T)) => void] {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) setValue(JSON.parse(raw) as T);
    } catch {
      /* keep default */
    }
  }, [key]);
  const set = useCallback(
    (next: T | ((p: T) => T)) => {
      setValue((prev) => {
        const v = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        try {
          if (key) localStorage.setItem(key, JSON.stringify(v));
        } catch {
          /* private mode */
        }
        return v;
      });
    },
    [key],
  );
  return [value, set];
}

function maskName(name?: string): string {
  if (!name || !name.trim()) return "Withheld";
  return name
    .trim()
    .split(/\s+/)
    .map((w) => `${w.charAt(0)}•••`)
    .join(" ");
}

function fmtWhen(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function priorityOf(rec: RecordDetail): string {
  return String(rec.priority?.level ?? "UNKNOWN").toUpperCase();
}

function levelTone(level: string): "red" | "amber" | "green" | "neutral" {
  if (level === "HIGH" || level === "CRITICAL") return "red";
  if (level === "MEDIUM") return "amber";
  if (level === "LOW") return "green";
  return "neutral";
}

function toneClass(tone: "red" | "amber" | "green" | "blue" | "neutral"): string {
  switch (tone) {
    case "red":
      return "bg-dangerbg text-danger";
    case "amber":
      return "bg-warnbg text-warn";
    case "green":
      return "bg-okbg text-ok";
    case "blue":
      return "bg-primary-soft text-primary-dark";
    default:
      return "bg-paper text-muted";
  }
}

/* ---------------- presentational bits ---------------- */

function Card({
  id,
  title,
  icon,
  label,
  children,
}: {
  id?: string;
  title: string;
  icon: React.ReactNode;
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-label={title}
      className="scroll-mt-24 rounded-xl2 border border-line bg-card p-5 shadow-card"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-primary" aria-hidden="true">
          {icon}
        </span>
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {label ? (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-paper px-2.5 py-1 text-xs text-muted">
            <Info size={14} aria-hidden="true" />
            {label}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Badge({
  tone,
  icon,
  text,
}: {
  tone: "red" | "amber" | "green" | "blue" | "neutral";
  icon: React.ReactNode;
  text: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${toneClass(tone)}`}
    >
      <span aria-hidden="true">{icon}</span>
      {text}
    </span>
  );
}

function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div aria-hidden="true" className="space-y-2">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="h-4 animate-pulse rounded bg-line" style={{ width: `${92 - i * 12}%` }} />
      ))}
    </div>
  );
}

function AiTag() {
  return (
    <span className="ml-2 inline-flex items-center rounded-full bg-primary-soft px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-primary-dark">
      AI-generated
    </span>
  );
}

/* ---------------- page ---------------- */

export default function IncidentDetailPage() {
  const params = useParams();
  const rawId = params?.id;
  const id = decodeURIComponent(Array.isArray(rawId) ? (rawId[0] ?? "") : (rawId ?? ""));
  const short = id.length > 12 ? `${id.slice(0, 12)}…` : id;
  const queryClient = useQueryClient();

  const recordQuery = useQuery({
    queryKey: ["record", id],
    queryFn: async () => (await getRecord(id)).data as RecordDetail,
    enabled: id.length > 0,
    retry: 1,
  });
  const rec = recordQuery.data ?? null;
  const callKey = rec?.call_id?.trim() ? rec.call_id : id;

  /* Live-call presence (shared WS feed): the "open live call" link renders
   * only while this incident's call is actually live. Unknown => skipped. */
  const { events: liveEvents } = useLiveEvents();
  const liveCall = useMemo(() => {
    if (!rec) return null;
    const keys = new Set([callKey, id, rec.call_id ?? ""].filter((k) => k !== ""));
    return (
      deriveCalls(liveEvents).calls.find((c) => keys.has(c.callId) && c.status !== "ended") ?? null
    );
  }, [liveEvents, callKey, id, rec]);

  const verificationQuery = useQuery({
    queryKey: ["verification", id],
    queryFn: async () => (await getVerification(id)).data,
    enabled: Boolean(rec),
    retry: 1,
  });

  const dispatchQuery = useQuery({
    queryKey: ["dispatch-log"],
    queryFn: getDispatchLog,
    enabled: Boolean(rec),
    retry: 1,
  });

  const auditQuery = useQuery({
    queryKey: ["audit-log"],
    queryFn: async () => (await getAuditLog(200)).data as AuditRow[],
    enabled: Boolean(rec),
    retry: 1,
  });

  /* device-local workflow / notes / comments */
  const [workflow, setWorkflow] = useDeviceState<Workflow>(id ? deviceKey(id, "workflow") : null, "Open");
  const [notes, setNotes] = useDeviceState<string>(id ? deviceKey(id, "notes") : null, "");
  const [draftNote, setDraftNote] = useState<string | null>(null);
  const [comments, setComments] = useDeviceState<LocalComment[]>(
    id ? deviceKey(id, "comments") : null,
    [],
  );
  const [commentText, setCommentText] = useState("");
  const [units, setUnits] = useState("");
  const [dispatchMsg, setDispatchMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (draftNote === null) setDraftNote(notes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes]);

  const myDispatches = useMemo(() => {
    const rows = ((dispatchQuery.data ?? []) as DispatchRow[]).filter(
      (e) => e.call_id === callKey || e.call_id === id || e.call_id === rec?.call_id,
    );
    return [...rows].sort((a, b) => {
      const na = Number(String(a.id ?? "").replace(/^DSP-0*/, "") || "0");
      const nb = Number(String(b.id ?? "").replace(/^DSP-0*/, "") || "0");
      return nb - na;
    });
  }, [dispatchQuery.data, callKey, id, rec?.call_id]);

  const myAudit = useMemo(() => {
    const rows = (auditQuery.data ?? []).filter(
      (a) => a.entity_id === id || (rec?.call_id && a.entity_id === rec.call_id),
    );
    return [...rows].sort((a, b) =>
      String(b.created_at ?? b.at ?? "") < String(a.created_at ?? a.at ?? "") ? -1 : 1,
    );
  }, [auditQuery.data, id, rec?.call_id]);

  const timeline = useMemo(() => {
    type Item = { key: string; sort: number; when: string; kind: string; title: string; sub?: string };
    const items: Item[] = [];
    for (const a of myAudit) {
      const when = String(a.created_at ?? a.at ?? "");
      items.push({
        key: `a-${a.id ?? `${a.action}-${when}`}`,
        sort: Date.parse(when) || 0,
        when: when ? fmtWhen(when) : "time not recorded",
        kind: "audit",
        title: `${a.action ?? "event"} · ${a.entity ?? "record"}`,
        sub: `by ${a.actor ?? "unknown"}${
          a.detail && typeof a.detail === "object" ? ` — ${JSON.stringify(a.detail).slice(0, 160)}` : ""
        }`,
      });
    }
    for (const d of myDispatches) {
      const m = String(d.time ?? "").match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
      let sort = 0;
      if (m) {
        const t = new Date();
        t.setHours(Number(m[1]), Number(m[2]), Number(m[3] ?? "0"), 0);
        sort = t.getTime();
      } else if (d.created_at) {
        sort = Date.parse(d.created_at) || 0;
      }
      if (!sort) {
        const n = Number(String(d.id ?? "").replace(/^DSP-0*/, "") || "0");
        sort = n; // monotonic fallback — sorts below dated audit rows
      }
      items.push({
        key: `d-${d.id ?? `${d.units}-${d.time}`}`,
        sort,
        when: d.time ? `${d.time} (server log time, no date recorded)` : fmtWhen(d.created_at),
        kind: "dispatch",
        title: `Dispatch ${d.id ?? ""} — ${d.units ?? "units assigned"}`.trim(),
        sub: `by ${d.operator ?? "unknown"}`,
      });
    }
    return items.sort((a, b) => b.sort - a.sort);
  }, [myAudit, myDispatches]);

  const responders = useMemo(() => {
    const out: { operator?: string; units?: string }[] = [];
    if (rec?.dispatch_info && (rec.dispatch_info.operator || rec.dispatch_info.units)) {
      out.push({ operator: rec.dispatch_info.operator, units: rec.dispatch_info.units });
    }
    for (const d of myDispatches) out.push({ operator: d.operator, units: d.units });
    return out.filter((r) => r.operator || r.units);
  }, [rec?.dispatch_info, myDispatches]);

  const level = rec ? priorityOf(rec) : "UNKNOWN";
  const dispatched = Boolean(rec?.dispatched);
  const verification = verificationQuery.data ?? null;

  const hasOriginalAudio = rec
    ? (rec.has_original_audio ?? Boolean(rec.original_audio_base64))
    : false;
  const hasTranslatedAudio = rec
    ? (rec.has_translated_audio ?? Boolean(rec.translated_audio_base64))
    : false;

  async function copyId() {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  async function logDispatch(decision?: Workflow) {
    if (!rec) return;
    setDispatchBusy(true);
    setDispatchMsg(null);
    try {
      await postDispatch({
        call_id: callKey,
        location: rec.extraction?.location ?? "Not identified",
        incident_type: rec.extraction?.incident_type ?? "Unknown",
        priority: level,
        units: units.trim() || "Patrol unit assigned",
        ...(decision ? { decision, note: `Workflow set to ${decision} by ${operatorName()}` } : {}),
      });
      setDispatchMsg({ ok: true, text: "Dispatch logged to the server (audited)." });
      setUnits("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["record", id] }),
        queryClient.invalidateQueries({ queryKey: ["dispatch-log"] }),
        queryClient.invalidateQueries({ queryKey: ["audit-log"] }),
      ]);
    } catch (e) {
      setDispatchMsg({
        ok: false,
        text: e instanceof Error ? e.message : "Dispatch failed. Sign in may be required.",
      });
    } finally {
      setDispatchBusy(false);
    }
  }

  /** Only "Dispatched" writes to the server: any POST /api/dispatch flips the
   *  record's canonical dispatched flag, so other workflow states must stay
   *  device-local or every click would falsely mark the case dispatched. */
  async function setStatus(next: Workflow) {
    setStatusMsg(null);
    if (next === "Dispatched") {
      setStatusBusy(true);
      try {
        await postDispatch({
          call_id: callKey,
          location: rec?.extraction?.location ?? "Not identified",
          incident_type: rec?.extraction?.incident_type ?? "Unknown",
          priority: level,
          units: units.trim() || "Dispatch logged from incident detail (units unspecified)",
          decision: next,
          note: `Workflow set to ${next} by ${operatorName()}`,
        });
        setWorkflow(next);
        setUnits("");
        setStatusMsg({ ok: true, text: "Dispatched: server log + audit updated, workflow saved on this device." });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["record", id] }),
          queryClient.invalidateQueries({ queryKey: ["dispatch-log"] }),
          queryClient.invalidateQueries({ queryKey: ["audit-log"] }),
        ]);
      } catch (e) {
        setStatusMsg({
          ok: false,
          text: e instanceof Error ? e.message : "Dispatch failed. Workflow was not changed.",
        });
      } finally {
        setStatusBusy(false);
      }
      return;
    }
    setWorkflow(next);
    setStatusMsg({ ok: true, text: `${next} saved on this device. Server status is unchanged.` });
  }

  function addComment() {
    const text = commentText.trim().slice(0, 2000);
    if (!text) return;
    setComments((prev) => [
      { author: operatorName(), text, at: new Date().toISOString() },
      ...prev,
    ]);
    setCommentText("");
  }

  function exportReport() {
    if (!rec) return;
    const L: string[] = [];
    L.push(`# Incident report — ${id}`);
    L.push("");
    L.push(`- Exported: ${new Date().toISOString()} (generated client-side in the console)`);
    L.push(`- Canonical server status: ${dispatched ? "dispatched=true" : "dispatched=false"}`);
    L.push(`- Workflow state (this device only): ${workflow}`);
    L.push(`- Priority: ${level}${rec.priority?.reasoning ? ` — ${rec.priority.reasoning}` : ""}`);
    L.push(`- Language: ${rec.original_language ?? "unknown"} · Source: ${rec.source ?? "unknown"}`);
    L.push(`- Created: ${rec.created_at ?? "unknown"}`);
    if (verification) L.push(`- Verification: ${verification.verification} (${verification.reports} reports)`);
    L.push("");
    L.push(`## Caller (identity masked)`);
    L.push(maskName(rec.extraction?.caller_name));
    L.push(`Location: ${rec.extraction?.location ?? "Not identified"}${rec.extraction?.landmark ? ` (near ${rec.extraction.landmark})` : ""}`);
    L.push("");
    L.push(`## Transcripts`);
    L.push(`### Original (${rec.original_language ?? "unknown language"})`);
    L.push(rec.transcript_original?.trim() || "_No original transcript on this record._");
    L.push(`### Marathi`);
    L.push(rec.transcript_marathi?.trim() || "_No Marathi transcript on this record._");
    L.push(`### English`);
    L.push(rec.transcript_english?.trim() || "_No English transcript on this record._");
    L.push("");
    L.push(`## AI summary (AI-generated, verify before acting)`);
    const ex = rec.extraction ?? {};
    for (const [k, v] of Object.entries(ex)) {
      if (v === undefined || v === null || v === "") continue;
      L.push(`- ${k}: ${String(v)}`);
    }
    L.push("");
    L.push(`## Recording`);
    L.push(hasOriginalAudio ? `Original audio on file: ${audioUrl(id)}` : "No recording on file.");
    if (hasTranslatedAudio) L.push(`Translated audio on file: ${audioUrl(id, "translated")}`);
    L.push("");
    L.push(`## Dispatch log (server)`);
    if (!myDispatches.length) L.push("_No dispatch entries for this incident._");
    for (const d of myDispatches) {
      L.push(`- ${d.id ?? "entry"} · ${d.time ?? "?"} · ${d.units ?? ""} · by ${d.operator ?? "unknown"}`);
    }
    L.push("");
    L.push(`## Operator notes (stored on this device only)`);
    L.push(notes.trim() || "_No notes._");
    L.push("");
    L.push(`## Internal comments (stored on this device only)`);
    if (!comments.length) L.push("_No comments._");
    for (const c of comments) L.push(`- ${c.author} · ${c.at}: ${c.text}`);
    L.push("");
    L.push(`## Audit history (server)`);
    if (!myAudit.length) L.push("_No audit rows reference this incident._");
    for (const a of myAudit) {
      L.push(`- ${a.created_at ?? a.at ?? "?"} · ${a.actor ?? "?"} · ${a.action ?? "?"} · ${JSON.stringify(a.detail ?? {})}`);
    }
    const blob = new Blob([L.join("\n")], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `incident-${id.replace(/[^a-zA-Z0-9-_]+/g, "_")}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const extractionRows: { label: string; value: string }[] = rec
    ? [
        { label: "Incident type", value: rec.extraction?.incident_type ?? "" },
        { label: "Summary", value: rec.extraction?.summary ?? "" },
        { label: "Location", value: rec.extraction?.location ?? "" },
        { label: "Landmark", value: rec.extraction?.landmark ?? "" },
        { label: "Caller (masked)", value: maskName(rec.extraction?.caller_name) },
        {
          label: "People involved",
          value: rec.extraction?.people_involved != null ? String(rec.extraction.people_involved) : "",
        },
        { label: "Injuries", value: rec.extraction?.injuries ?? "" },
        { label: "Weapons", value: rec.extraction?.weapons ?? "" },
        { label: "Suspect", value: rec.extraction?.suspect ?? "" },
        { label: "Vehicle", value: rec.extraction?.vehicle ?? "" },
        { label: "Priority reasoning", value: rec.priority?.reasoning ?? "" },
      ]
    : [];

  return (
    <Shell
      section="incidents"
      title={`Incident ${short}`}
      crumbs={[{ label: "Incidents", href: "/incidents" }]}
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6 sm:px-6">
        <a
          href="/incidents"
          className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-primary-dark hover:underline"
        >
          <ArrowLeft size={16} aria-hidden="true" /> Back to incidents
        </a>

        {recordQuery.isPending ? (
          <div className="rounded-xl2 border border-line bg-card p-5 shadow-card" aria-busy="true" aria-label="Loading incident">
            <Skeleton lines={5} />
          </div>
        ) : recordQuery.isError || !rec ? (
          <div
            role="alert"
            className="flex flex-col items-start gap-3 rounded-xl2 border border-line bg-card p-5 shadow-card"
          >
            <Badge
              tone="red"
              icon={<XCircle size={14} aria-hidden="true" />}
              text={recordQuery.isError ? "Could not load this incident" : "Record not found"}
            />
            <p className="text-sm text-muted">
              {recordQuery.error instanceof Error
                ? recordQuery.error.message
                : "No record exists for this ID."}
            </p>
            <button
              type="button"
              onClick={() => recordQuery.refetch()}
              className="inline-flex items-center gap-1.5 rounded-xl2 bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary-dark"
            >
              <ArrowClockwise size={16} aria-hidden="true" /> Retry
            </button>
          </div>
        ) : (
          <>
            {/* ---------- header ---------- */}
            <div className="rounded-xl2 border border-line bg-card p-5 shadow-card">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="flex min-w-0 items-center gap-2 text-lg font-semibold text-ink">
                  <span className="truncate font-mono text-base" title={id}>
                    {id}
                  </span>
                  <button
                    type="button"
                    onClick={copyId}
                    aria-label="Copy incident ID"
                    title="Copy incident ID"
                    className="rounded p-1 text-muted hover:bg-paper hover:text-ink"
                  >
                    {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                  </button>
                </h1>
                <div className="ml-auto flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => recordQuery.refetch()}
                    className="inline-flex items-center gap-1.5 rounded-xl2 border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-paper"
                  >
                    <ArrowClockwise size={16} aria-hidden="true" /> Refresh
                  </button>
                  <button
                    type="button"
                    onClick={exportReport}
                    className="inline-flex items-center gap-1.5 rounded-xl2 bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-dark"
                  >
                    <Download size={16} aria-hidden="true" /> Export report
                  </button>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Badge
                  tone={dispatched ? "blue" : "neutral"}
                  icon={
                    dispatched ? (
                      <Broadcast size={14} aria-hidden="true" />
                    ) : (
                      <Info size={14} aria-hidden="true" />
                    )
                  }
                  text={dispatched ? "Server: dispatched" : "Server: not dispatched"}
                />
                <Badge
                  tone={
                    workflow === "Resolved"
                      ? "green"
                      : workflow === "Investigating"
                        ? "amber"
                        : workflow === "Dispatched"
                          ? "blue"
                          : "neutral"
                  }
                  icon={<Eye size={14} aria-hidden="true" />}
                  text={`Workflow: ${workflow} (this device)`}
                />
                <Badge
                  tone={levelTone(level)}
                  icon={<Siren size={14} aria-hidden="true" />}
                  text={`Priority: ${level}`}
                />
                {verificationQuery.isPending ? (
                  <Badge tone="neutral" icon={<Clock size={14} aria-hidden="true" />} text="Checking verification…" />
                ) : verification ? (
                  <Badge
                    tone={
                      verification.verification === "corroborated"
                        ? "green"
                        : verification.verification === "multiple_reports"
                          ? "amber"
                          : "neutral"
                    }
                    icon={<SealCheck size={14} aria-hidden="true" />}
                    text={`${verification.verification.replace(/_/g, " ")} · ${verification.reports} report${verification.reports === 1 ? "" : "s"}`}
                  />
                ) : (
                  <Badge tone="neutral" icon={<Info size={14} aria-hidden="true" />} text="Verification unavailable" />
                )}
              </div>
              <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
                <div className="flex gap-2">
                  <dt className="w-32 shrink-0 text-muted">Assigned</dt>
                  <dd className="text-ink">
                    {responders.length
                      ? responders.map((r, i) => (
                          <div key={i}>
                            {r.units ?? "Units assigned"}
                            {r.operator ? <span className="text-muted"> · {r.operator}</span> : null}
                          </div>
                        ))
                      : "Unassigned"}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-32 shrink-0 text-muted">Created</dt>
                  <dd className="text-ink">{fmtWhen(rec.created_at)}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-32 shrink-0 text-muted">Call</dt>
                  <dd className="flex flex-wrap items-center gap-2 font-mono text-ink">
                    {rec.call_id ?? "—"}
                    {liveCall ? (
                      <a
                        href={`/live/${encodeURIComponent(liveCall.callId)}`}
                        className="inline-flex items-center gap-1 font-sans text-sm font-medium text-primary-dark hover:underline"
                      >
                        <Waveform size={16} aria-hidden="true" /> Open live call (active now)
                      </a>
                    ) : null}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-32 shrink-0 text-muted">Source</dt>
                  <dd className="text-ink">{rec.source ?? "—"}</dd>
                </div>
              </dl>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              {/* ---------- caller ---------- */}
              <Card title="Caller" icon={<UserCircle size={20} aria-hidden="true" />}>
                <dl className="space-y-2 text-sm">
                  <div className="flex gap-2">
                    <dt className="w-28 shrink-0 text-muted">Identity</dt>
                    <dd className="text-ink">
                      {maskName(rec.extraction?.caller_name)}{" "}
                      <span className="text-xs text-muted">(masked for privacy)</span>
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-28 shrink-0 text-muted">Language</dt>
                    <dd className="text-ink">{rec.original_language ?? "Unknown"}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-28 shrink-0 text-muted">Location</dt>
                    <dd className="text-ink">
                      {rec.extraction?.location?.trim() || "Not identified"}
                      {rec.extraction?.landmark ? ` · near ${rec.extraction.landmark}` : null}
                    </dd>
                  </div>
                </dl>
                <div
                  aria-label="Map preview placeholder"
                  className="mt-3 flex min-h-28 flex-col items-center justify-center gap-1 rounded-xl2 border border-dashed border-line bg-paper p-4 text-center"
                >
                  <MapPin size={22} className="text-faint" aria-hidden="true" />
                  <p className="text-sm font-medium text-ink">Map preview placeholder</p>
                  <p className="text-xs text-muted">No geodata provider is wired in this build.</p>
                </div>
              </Card>

              {/* ---------- recording ---------- */}
              <Card
                id="recording"
                title="Recording"
                icon={<FileAudio size={20} aria-hidden="true" />}
              >
                {hasOriginalAudio || hasTranslatedAudio ? (
                  <div className="space-y-4">
                    {hasOriginalAudio ? (
                      <div>
                        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
                          Original audio
                        </p>
                        <audio controls preload="none" src={audioUrl(id)} aria-label="Original call recording" />
                      </div>
                    ) : null}
                    {hasTranslatedAudio ? (
                      <div>
                        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
                          Translated audio
                        </p>
                        <audio
                          controls
                          preload="none"
                          src={audioUrl(id, "translated")}
                          aria-label="Translated call recording"
                        />
                      </div>
                    ) : null}
                    <p className="text-xs text-muted">
                      Source: {rec.source ?? "unknown"} · Recorded: {fmtWhen(rec.created_at)} · Language:{" "}
                      {rec.original_language ?? "unknown"}
                    </p>
                  </div>
                ) : (
                  <p className="flex items-center gap-2 text-sm text-muted">
                    <Waveform size={18} aria-hidden="true" /> No recording available for this incident.
                  </p>
                )}
              </Card>
            </div>

            {/* ---------- transcript ---------- */}
            <Card
              id="transcripts"
              title="Transcript"
              icon={<ChatText size={20} aria-hidden="true" />}
            >
              <div className="grid gap-4 md:grid-cols-3">
                {[
                  { label: `Original · ${rec.original_language ?? "unknown language"}`, text: rec.transcript_original },
                  { label: "Marathi", text: rec.transcript_marathi },
                  { label: "English", text: rec.transcript_english },
                ].map((b) => (
                  <div key={b.label} className="rounded-xl2 border border-line bg-paper p-3">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{b.label}</p>
                    <p className="whitespace-pre-wrap text-sm text-ink">
                      {b.text?.trim() || <span className="text-muted">No transcript in this language.</span>}
                    </p>
                  </div>
                ))}
              </div>
            </Card>

            {/* ---------- AI summary ---------- */}
            <Card
              title="AI summary"
              icon={<ListChecks size={20} aria-hidden="true" />}
              label="Verify before acting"
            >
              <dl className="divide-y divide-line text-sm">
                {extractionRows
                  .filter((r) => r.value.trim() !== "")
                  .map((r) => (
                    <div key={r.label} className="flex gap-2 py-2">
                      <dt className="w-36 shrink-0 text-muted">
                        {r.label}
                        <AiTag />
                      </dt>
                      <dd className="whitespace-pre-wrap text-ink">{r.value}</dd>
                    </div>
                  ))}
                {!extractionRows.some((r) => r.value.trim() !== "") ? (
                  <p className="py-2 text-sm text-muted">No AI extraction on this record.</p>
                ) : null}
              </dl>
            </Card>

            {/* ---------- timeline ---------- */}
            <Card title="Event timeline" icon={<Clock size={20} aria-hidden="true" />} label="Newest first">
              {auditQuery.isPending || dispatchQuery.isPending ? (
                <Skeleton lines={4} />
              ) : timeline.length === 0 ? (
                <p className="text-sm text-muted">
                  No audit rows or dispatch entries reference this incident yet.
                </p>
              ) : (
                <ol className="space-y-3">
                  {timeline.map((t) => (
                    <li key={t.key} className="flex gap-3 text-sm">
                      <span
                        aria-hidden="true"
                        className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${
                          t.kind === "dispatch" ? "bg-primary" : "bg-faint"
                        }`}
                      />
                      <div className="min-w-0">
                        <p className="font-medium text-ink">{t.title}</p>
                        <p className="text-xs text-muted">
                          {t.when}
                          {t.sub ? ` · ${t.sub}` : null}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              {/* ---------- operator notes (device-local) ---------- */}
              <Card
                title="Operator notes"
                icon={<NotePencil size={20} aria-hidden="true" />}
                label="Stored on this device — not synced"
              >
                <label htmlFor="op-notes" className="sr-only">
                  Operator notes (stored on this device only)
                </label>
                <textarea
                  id="op-notes"
                  rows={5}
                  value={draftNote ?? ""}
                  onChange={(e) => setDraftNote(e.target.value)}
                  placeholder="Shift handover, follow-ups, context for the next operator…"
                  className="w-full rounded-xl2 border border-line bg-paper p-3 text-sm text-ink placeholder:text-faint"
                />
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setNotes(draftNote ?? "")}
                    className="rounded-xl2 bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-dark"
                  >
                    Save notes
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDraftNote("");
                      setNotes("");
                    }}
                    className="rounded-xl2 border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-paper"
                  >
                    Clear
                  </button>
                </div>
              </Card>

              {/* ---------- evidence ---------- */}
              <Card title="Evidence" icon={<FileText size={20} aria-hidden="true" />}>
                <ul className="space-y-2 text-sm">
                  <li className="flex items-center gap-2">
                    <FileAudio size={16} className="text-muted" aria-hidden="true" />
                    {hasOriginalAudio ? (
                      <a href="#recording" className="font-medium text-primary-dark hover:underline">
                        Call recording (on file)
                      </a>
                    ) : (
                      <span className="text-muted">Call recording — none on file</span>
                    )}
                  </li>
                  <li className="flex items-center gap-2">
                    <ChatText size={16} className="text-muted" aria-hidden="true" />
                    <a href="#transcripts" className="font-medium text-primary-dark hover:underline">
                      Call transcripts (original / Marathi / English)
                    </a>
                  </li>
                </ul>
                <p className="mt-3 text-xs text-muted">
                  Evidence is limited to the recording and transcripts stored on this record. There is
                  no attachment upload endpoint in this build.
                </p>
              </Card>
            </div>

            {/* ---------- dispatch ---------- */}
            <Card
              title="Dispatch"
              icon={<Broadcast size={20} aria-hidden="true" />}
              label="Writes to the server log (audited)"
            >
              <p className="mb-3 text-sm text-muted">
                {rec.extraction?.incident_type ?? "Unknown"} ·{" "}
                {rec.extraction?.location ?? "Not identified"} · Priority {level}
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <label htmlFor="dispatch-units" className="sr-only">
                  Responding units
                </label>
                <input
                  id="dispatch-units"
                  value={units}
                  onChange={(e) => setUnits(e.target.value)}
                  placeholder="e.g. PCR-4, Ambulance-2"
                  maxLength={200}
                  className="flex-1 rounded-xl2 border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-faint"
                />
                <button
                  type="button"
                  onClick={() => logDispatch()}
                  disabled={dispatchBusy || !units.trim()}
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl2 bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Broadcast size={16} aria-hidden="true" />
                  {dispatchBusy ? "Logging…" : "Log dispatch"}
                </button>
              </div>
              {dispatchMsg ? (
                <p role="status" className={`mt-2 text-sm ${dispatchMsg.ok ? "text-ok" : "text-danger"}`}>
                  {dispatchMsg.text}
                </p>
              ) : null}
              <div className="mt-4">
                <h3 className="mb-2 text-sm font-semibold text-ink">Entries for this incident</h3>
                {dispatchQuery.isPending ? (
                  <Skeleton lines={2} />
                ) : dispatchQuery.isError ? (
                  <p className="text-sm text-danger">Could not load the dispatch log.</p>
                ) : myDispatches.length === 0 ? (
                  <p className="text-sm text-muted">No units dispatched yet.</p>
                ) : (
                  <ul className="space-y-2 text-sm">
                    {myDispatches.map((d) => (
                      <li key={d.id ?? `${d.units}-${d.time}`} className="rounded-xl2 border border-line bg-paper p-3">
                        <p className="font-medium text-ink">
                          {d.id ? <span className="mr-2 font-mono text-xs text-muted">{d.id}</span> : null}
                          {d.units ?? "Units assigned"}
                        </p>
                        <p className="text-xs text-muted">
                          {d.time ?? "?"} · by {d.operator ?? "unknown"}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>

            {/* ---------- comments (device-local) ---------- */}
            <Card
              title="Internal comments"
              icon={<ChatsCircle size={20} aria-hidden="true" />}
              label="Stored on this device — not synced"
            >
              <div className="flex flex-col gap-2 sm:flex-row">
                <label htmlFor="new-comment" className="sr-only">
                  Add an internal comment (stored on this device only)
                </label>
                <input
                  id="new-comment"
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addComment();
                  }}
                  placeholder="Comment for other operators on this device…"
                  maxLength={2000}
                  className="flex-1 rounded-xl2 border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-faint"
                />
                <button
                  type="button"
                  onClick={addComment}
                  disabled={!commentText.trim()}
                  className="rounded-xl2 bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Comment
                </button>
              </div>
              {comments.length === 0 ? (
                <p className="mt-3 text-sm text-muted">No comments yet.</p>
              ) : (
                <ul className="mt-3 space-y-2 text-sm">
                  {comments.map((c, i) => (
                    <li key={`${c.at}-${i}`} className="rounded-xl2 border border-line bg-paper p-3">
                      <p className="text-ink">{c.text}</p>
                      <p className="mt-1 text-xs text-muted">
                        {c.author} · {fmtWhen(c.at)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* ---------- audit ---------- */}
            <Card
              title="Audit history"
              icon={<SealCheck size={20} aria-hidden="true" />}
              label="Server audit trail (read-only)"
            >
              {auditQuery.isPending ? (
                <Skeleton lines={3} />
              ) : auditQuery.isError ? (
                <p className="text-sm text-danger">Could not load the audit log.</p>
              ) : myAudit.length === 0 ? (
                <p className="text-sm text-muted">No audit rows reference this incident.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {myAudit.map((a) => (
                    <li key={a.id ?? `${a.action}-${a.created_at}`} className="rounded-xl2 border border-line bg-paper p-3">
                      <p className="font-medium text-ink">
                        {a.action ?? "event"}{" "}
                        <span className="font-normal text-muted">· {a.entity ?? "record"}</span>
                      </p>
                      <p className="text-xs text-muted">
                        {fmtWhen(a.created_at ?? a.at)} · by {a.actor ?? "unknown"}
                      </p>
                      {a.detail !== undefined ? (
                        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-muted">
                          {typeof a.detail === "string" ? a.detail : JSON.stringify(a.detail)}
                        </pre>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* ---------- status controls ---------- */}
            <Card
              title="Status"
              icon={<Ear size={20} aria-hidden="true" />}
              label="Only “Dispatched” writes to the server"
            >
              <div className="flex flex-wrap gap-2" role="group" aria-label="Workflow status">
                {WORKFLOWS.map((w) => {
                  const active = workflow === w || (w === "Dispatched" && dispatched);
                  return (
                    <button
                      key={w}
                      type="button"
                      onClick={() => setStatus(w)}
                      disabled={statusBusy}
                      aria-pressed={workflow === w}
                      className={`rounded-xl2 border px-3 py-1.5 text-sm font-medium ${
                        active
                          ? "border-primary bg-primary-soft text-primary-dark"
                          : "border-line bg-paper text-ink hover:bg-line/40"
                      } disabled:cursor-not-allowed disabled:opacity-50`}
                    >
                      {w}
                    </button>
                  );
                })}
              </div>
              {statusMsg ? (
                <p role="status" className={`mt-2 text-sm ${statusMsg.ok ? "text-ok" : "text-danger"}`}>
                  {statusMsg.text}
                </p>
              ) : null}
              <p className="mt-2 text-xs text-muted">
                The canonical backend status is the dispatched flag (set by any unit dispatch and
                shown in the header). The other workflow states are kept on this device only, so
                changing them never falsely marks the case dispatched on the server.
              </p>
            </Card>
          </>
        )}
      </div>
    </Shell>
  );
}
