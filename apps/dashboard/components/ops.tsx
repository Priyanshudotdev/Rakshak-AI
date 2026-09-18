"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  audioUrl,
  clearRecords,
  deleteRecord,
  getAnalytics,
  getDispatchLog,
  getHealth,
  getProfile,
  getRecordCount,
  getTranslation,
  listRecords,
  login,
  logout,
  operatorName,
  postDispatch,
  processAudioFile,
  processCall,
  putProfile,
  register,
  setOperatorName,
  setTranslation,
  signedInOperator,
  synthesize,
  translate,
  type ListenVoice,
} from "../lib/api";
import type { LiveEvent } from "../lib/live";
import { activeLiveCallId, translationSuggestionForCall, translationToggleHistory, useLiveEvents } from "../lib/live";
import { summarizeVerification } from "../lib/verification";
import type { DispatchEntry, IncidentRecord } from "../lib/types";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHead,
  EmptyState,
  Field,
  KV,
  PriorityBadge,
  SelectInput,
  Spinner,
  TextArea,
  TextInput,
} from "./ui";
import { LivePanel } from "./live";

const invalidateAll = (qc: ReturnType<typeof useQueryClient>) =>
  Promise.all([
    qc.invalidateQueries({ queryKey: ["records"] }),
    qc.invalidateQueries({ queryKey: ["count"] }),
    qc.invalidateQueries({ queryKey: ["analytics"] }),
    qc.invalidateQueries({ queryKey: ["dispatch"] }),
  ]);

/* ---------------- Header ---------------- */

function Header({ count }: { count?: number }) {
  const health = useQuery({ queryKey: ["health"], queryFn: getHealth, refetchInterval: 10_000 });
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-ink/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-3 px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg2 bg-accent font-mono text-lg font-bold text-white">
            R
          </span>
          <div>
            <h1 className="text-base font-semibold leading-tight text-white">Rakshak AI — Operator Console</h1>
            <p className="text-xs text-muted">AI assists · Human operator decides · No autonomous dispatch</p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Badge tone={health.data?.status === "ok" ? "ok" : "bad"}>
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${health.data?.status === "ok" ? "bg-priolow" : "bg-priohigh"}`} />
            API {health.data?.status ?? "…"}
          </Badge>
          <Badge tone="neutral">STT {health.data?.sarvam ? "on" : "off"}</Badge>
          <Badge tone="neutral">LLM {health.data?.gemini ? "on" : "rules"}</Badge>
          <Badge tone="info">records {count ?? "…"}</Badge>
        </div>
      </div>
    </header>
  );
}

/* ---------------- Intake (new incident) ---------------- */

function IntakePanel({ onDone }: { onDone: (id: string) => void }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"text" | "audio">("text");
  const [transcript, setTranscript] = useState("");
  const [language, setLanguage] = useState("");
  const [error, setError] = useState<string | null>(null);

  const call = useMutation({
    mutationFn: () => processCall(transcript.trim(), language || undefined),
    onSuccess: async (res) => {
      setError(null);
      setTranscript("");
      await invalidateAll(qc);
      onDone(res.data.id);
    },
    onError: (e: Error) => setError(e.message),
  });

  const audio = useMutation({
    mutationFn: (file: File) => processAudioFile(file),
    onSuccess: async (res) => {
      setError(null);
      await invalidateAll(qc);
      onDone(res.data.id);
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Card>
      <CardHead title="New incident" sub="Manual transcript or voice recording → extraction + priority" />
      <CardBody>
        <div className="mb-3 grid grid-cols-2 gap-1 rounded-md2 border border-line bg-ink p-1">
          {(["text", "audio"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-md2 px-3 py-1.5 text-sm font-medium ${tab === t ? "bg-surface3 text-white" : "text-muted hover:text-cream"}`}
            >
              {t === "text" ? "Transcript" : "Audio file"}
            </button>
          ))}
        </div>
        {error ? (
          <div className="mb-3">
            <Alert kind="error">{error}</Alert>
          </div>
        ) : null}
        {tab === "text" ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (transcript.trim()) call.mutate();
            }}
          >
            <Field label="Caller transcript (original language, code-mixed OK)">
              <TextArea
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                placeholder="e.g. Manish Nagar me aag lagi hai, do log andar fase hain…"
              />
            </Field>
            <Field label="Language hint (optional)">
              <TextInput value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="Hindi / Marathi / English…" />
            </Field>
            <Button type="submit" disabled={call.isPending || !transcript.trim()} className="w-full">
              {call.isPending ? <Spinner /> : null} Analyze incident
            </Button>
          </form>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              const input = document.getElementById("rakshak-audio") as HTMLInputElement | null;
              const file = input?.files?.[0];
              if (file) audio.mutate(file);
            }}
          >
            <Field label="Voice recording (webm / wav / mp3, ≤10MB)">
              <TextInput id="rakshak-audio" type="file" accept="audio/*,.webm,.wav,.mp3,.m4a,.ogg" />
            </Field>
            <Button type="submit" disabled={audio.isPending} className="w-full">
              {audio.isPending ? <Spinner /> : null} Transcribe + analyze
            </Button>
            <p className="text-xs text-muted">Runs STT → translation → extraction → priority → Marathi voice preview.</p>
          </form>
        )}
      </CardBody>
    </Card>
  );
}

/* ---------------- Analytics strip ---------------- */

function AnalyticsStrip() {
  const { data, isPending } = useQuery({
    queryKey: ["analytics"],
    queryFn: async () => (await getAnalytics()).data,
    refetchInterval: 5000,
  });
  const stats: Array<[string, string]> = data
    ? [
        ["Incidents", String(data.total_records)],
        ["HIGH priority", String(data.priority_breakdown?.HIGH ?? 0)],
        ["Immediate danger", String(data.immediate_danger_count)],
        ["Dispatched", String(data.dispatched_count)],
        ["Avg total", `${data.average_latencies?.total_ms ?? 0} ms`],
        ["Avg STT", `${data.average_latencies?.speech_ms ?? 0} ms`],
      ]
    : [];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      {isPending
        ? Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-[68px] animate-pulse rounded-lg2 border border-line bg-surface" />
          ))
        : stats.map(([k, v]) => (
            <div key={k} className="rounded-lg2 border border-line bg-surface px-4 py-3">
              <p className="font-mono text-xl font-semibold text-white">{v}</p>
              <p className="mt-0.5 text-xs uppercase tracking-wider text-muted">{k}</p>
            </div>
          ))}
    </div>
  );
}

/* ---------------- Records ---------------- */

export function RecordsPanel({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [prio, setPrio] = useState("ALL");
  const [lang, setLang] = useState("");
  const [confirmingClear, setConfirmingClear] = useState(false);
  const session = useSignedInOperator();
  const isAdmin = session?.role === "admin";
  const records = useQuery({
    queryKey: ["records", q, prio, lang],
    queryFn: async () =>
      (
        await listRecords({
          q: q || undefined,
          priority: prio,
          language: lang || undefined,
          limit: 50,
        })
      ).data,
    refetchInterval: 4000,
  });

  const clearAll = useMutation({
    mutationFn: () => clearRecords(),
    onSuccess: async () => {
      await invalidateAll(qc);
      setConfirmingClear(false);
    },
  });

  return (
    <Card className="flex min-h-[420px] flex-col">
      <CardHead
        title="Incident records"
        sub="Live list · audio streams on demand, never inline"
        right={<Badge tone="info">{records.data?.length ?? "…"} shown</Badge>}
      />
      <CardBody>
        <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_130px]">
          <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search id, transcript, location, type…" />
          <SelectInput value={prio} onChange={(e) => setPrio(e.target.value)} aria-label="Priority filter">
            {["ALL", "HIGH", "MEDIUM", "LOW", "CRITICAL"].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </SelectInput>
        </div>
        {records.isPending ? (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> Loading records…
          </div>
        ) : !records.data?.length ? (
          <EmptyState title="No incidents yet" sub="Analyze a transcript or upload audio to create the first record." />
        ) : (
          <ul className="max-h-[560px] space-y-2 overflow-y-auto pr-1">
            {records.data.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => onSelect(r.id)}
                  className={`w-full rounded-md2 border p-3 text-left transition-colors ${
                    selectedId === r.id ? "border-accent bg-accent/10" : "border-line bg-surface2 hover:border-muted"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-muted">{r.id}</span>
                    <PriorityBadge level={r.priority?.level} />
                  </div>
                  <p className="mt-1 truncate text-sm font-medium text-cream">
                    {r.extraction?.incident_type ?? "Unknown"} · {r.extraction?.location ?? "Not identified"}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted">
                    {r.extraction?.summary || r.transcript_original || "—"}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Badge tone="neutral">{r.original_language ?? "?"}</Badge>
                    <Badge tone="neutral">{r.source ?? "text"}</Badge>
                    {r.dispatched ? <Badge tone="ok">dispatched</Badge> : null}
                    {r.has_original_audio ? <Badge tone="info">audio</Badge> : null}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
        {isAdmin ? (
          <div className="mt-3">
            {!confirmingClear ? (
              <Button variant="danger" onClick={() => setConfirmingClear(true)}>
                Clear all records
              </Button>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-sm text-cream">Clear all incidents?</span>
                <Button variant="danger" disabled={clearAll.isPending} onClick={() => clearAll.mutate()}>
                  Confirm
                </Button>
                <Button variant="ghost" onClick={() => setConfirmingClear(false)}>
                  Cancel
                </Button>
              </div>
            )}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

/* ---------------- TTS box ---------------- */

function TtsBox({ recordId }: { recordId: string }) {
  const [text, setText] = useState("");
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tts = useMutation({
    mutationFn: () => synthesize(text.trim(), { language_code: "mr-IN", record_id: recordId }),
    onSuccess: (res) => {
      setError(null);
      setSrc(res.data.audio_base64);
    },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <div className="rounded-md2 border border-line bg-ink p-3">
      <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">Operator voice reply (Marathi TTS)</p>
      {error ? (
        <div className="mb-2">
          <Alert kind="error">{error}</Alert>
        </div>
      ) : null}
      <div className="flex gap-2">
        <TextInput value={text} onChange={(e) => setText(e.target.value)} placeholder="Madat pohoch rahi hai, ghabrayein mat…" />
        <Button disabled={tts.isPending || !text.trim()} onClick={() => tts.mutate()}>
          {tts.isPending ? <Spinner /> : "Speak"}
        </Button>
      </div>
      {src ? <audio className="mt-2" controls preload="none" src={src} /> : null}
    </div>
  );
}

/* ---------------- Record detail ---------------- */

export function TranslationHistory({ events, callId }: { events: LiveEvent[]; callId?: string | null }) {
  const history = translationToggleHistory(events, callId ?? null);
  return (
    <div>
      <p className="mb-2 text-xs text-muted">Live-only — no backfill; history clears on refresh.</p>
      {!history.length ? (
        <p className="text-sm text-muted">No translation toggles for this call yet.</p>
      ) : (
        <ul className="max-h-[180px] space-y-1.5 overflow-y-auto pr-1">
          {history.map((h, i) => (
            <li
              key={`${h.at}-${i}`}
              className="flex items-center gap-2 rounded-md2 border border-line/70 bg-ink px-2 py-1.5 text-xs"
            >
              <Badge tone={h.enabled ? "ok" : "neutral"}>{h.enabled ? "on" : "off"}</Badge>
              <span className="truncate font-mono text-muted">{h.callId}</span>
              {h.by ? <span className="truncate text-muted">by {h.by}</span> : null}
              <span className="ml-auto shrink-0 font-mono text-muted">{h.at.slice(11, 19)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RecordDetail({ record, events }: { record: IncidentRecord | null; events: LiveEvent[] }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const session = useSignedInOperator();
  const isAdmin = session?.role === "admin";
  const del = useMutation({
    mutationFn: (id: string) => deleteRecord(id),
    onSuccess: async () => {
      await invalidateAll(qc);
      setConfirming(false);
    },
  });
  const dispatch = useMutation({
    mutationFn: (entry: { call_id?: string; location?: string; incident_type?: string; priority?: string; units?: string }) =>
      postDispatch(entry),
    onSuccess: async () => {
      await invalidateAll(qc);
    },
  });

  if (!record) return <EmptyState title="No incident selected" sub="Pick a record from the list to inspect evidence, audio and actions." />;

  const verification = summarizeVerification(events, record.call_id);
  const verificationTone =
    verification.status === "corroborated" || verification.status === "officially_confirmed"
      ? ("ok" as const)
      : verification.status === "multiple_reports"
        ? ("warn" as const)
        : ("neutral" as const);

  const ext = record.extraction ?? {};
  const prio = record.priority ?? {};
  const osm = `https://www.openstreetmap.org/search?query=${encodeURIComponent(`${ext.location ?? ""} ${ext.landmark ?? ""}`.trim() || "Nagpur")}`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <PriorityBadge level={prio.level} />
        <Badge tone="neutral">{record.original_language ?? "?"}</Badge>
        <Badge tone="neutral">{record.llm_used ?? "rules"}</Badge>
        {record.dispatched ? <Badge tone="ok">dispatched</Badge> : <Badge tone="warn">awaiting decision</Badge>}
        <span className="ml-auto font-mono text-xs text-muted">{record.id}</span>
      </div>

      <p className="text-sm text-cream">{ext.summary || "No summary available."}</p>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card>
          <CardHead title="Caller said (original)" sub={record.original_language ?? ""} />
          <CardBody>
            <p className="whitespace-pre-wrap text-sm text-cream">{record.transcript_original || "—"}</p>
            {record.transcript_marathi ? (
              <>
                <p className="mb-1 mt-3 text-xs font-medium uppercase tracking-wider text-muted">Marathi</p>
                <p className="whitespace-pre-wrap text-sm text-cream">{record.transcript_marathi}</p>
              </>
            ) : null}
            {record.transcript_english ? (
              <>
                <p className="mb-1 mt-3 text-xs font-medium uppercase tracking-wider text-muted">English (operator)</p>
                <p className="whitespace-pre-wrap text-sm text-cream">{record.transcript_english}</p>
              </>
            ) : null}
          </CardBody>
        </Card>
        <Card>
          <CardHead title="Extracted entities" sub="Unverified AI output — confirm before acting" />
          <CardBody>
            <dl>
              <KV k="Type" v={`${ext.incident_type ?? "Unknown"}${ext.incident_secondary ? ` · ${ext.incident_secondary}` : ""}`} />
              <KV k="Location" v={ext.location} />
              <KV k="Landmark" v={ext.landmark || "—"} />
              <KV k="People" v={ext.people_involved} />
              <KV k="Weapon" v={ext.weapon_mentioned ? (ext.weapon_type ?? "yes") : "none mentioned"} />
              <KV k="Danger" v={ext.immediate_danger ? `yes · risk ${ext.risk_level ?? "?"}` : "no"} />
              <KV k="Caller" v={`${ext.caller_state ?? "unknown"} · ${ext.caller_gender ?? "?"}`} />
            </dl>
            {ext.geo && Number.isFinite(ext.geo.lat) && Number.isFinite(ext.geo.lon) ? (
              <div className="mt-2 overflow-hidden rounded-md2 border border-line">
                <iframe
                  title={`Map of ${ext.location ?? "incident"}`}
                  src={`https://www.openstreetmap.org/export/embed.html?bbox=${ext.geo.lon - 0.02}%2C${ext.geo.lat - 0.015}%2C${ext.geo.lon + 0.02}%2C${ext.geo.lat + 0.015}&layer=mapnik&marker=${ext.geo.lat}%2C${ext.geo.lon}`}
                  className="h-44 w-full border-0"
                  loading="lazy"
                />
              </div>
            ) : null}
            <a href={osm} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-accentlight hover:underline">
              Open location in OpenStreetMap ↗
            </a>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHead title="Priority recommendation" sub="Explainable · operator makes the final call" />
        <CardBody>
          <p className="text-sm text-cream">{prio.reasoning || "—"}</p>
          {(prio.decision_factors?.length ?? 0) > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {prio.decision_factors!.map((f) => (
                <Badge key={f} tone="neutral">
                  {f}
                </Badge>
              ))}
            </div>
          ) : null}
          <dl className="mt-2">
            <KV k="Recommended" v={prio.recommended_response} />
            <KV k="Notes" v={prio.dispatcher_notes || "—"} />
            <KV k="Confidence" v={prio.confidence != null ? `${Math.round(prio.confidence * 100)}% · floor ${prio.rule_floor ?? "?"}` : "—"} mono />
          </dl>
        </CardBody>
      </Card>
      <Card><CardHead title="Verification and corroboration" sub="Reported is not confirmed — extra sources attach here, never as new incidents" right={<Badge tone={verificationTone}>{verification.status.replace("_", " ")}</Badge>} /><CardBody>{verification.evidence.length === 0 ? (<p className="text-sm text-muted">Single source so far. Correlating reports from calls, news and official feeds will attach here with scores and signals.</p>) : (<><p className="mb-2 text-sm text-cream">{verification.reports} corroborating report{verification.reports === 1 ? "" : "s"}</p><ul className="space-y-2">{verification.evidence.map((ev, i) => (<li key={ev.report_id ?? i} className="rounded-md2 border border-line bg-ink p-2.5 text-xs"><div className="flex items-center justify-between gap-2"><span className="font-medium text-cream">{ev.report_title ?? ev.report_id ?? "Report"}</span>{ev.correlation_score != null ? (<Badge tone="info">{Math.round(ev.correlation_score * 100)}%</Badge>) : null}</div><p className="mt-0.5 text-muted">{ev.report_source ?? "unknown source"}{ev.signals?.length ? ` · ${ev.signals.join(" · ")}` : ""}</p></li>))}</ul></>)}</CardBody></Card>

      <Card>
        <CardHead title="Translation history" sub="Live-only — no backfill" />
        <CardBody>
          <TranslationHistory events={events} callId={record.call_id} />
        </CardBody>
      </Card>

      {(record.has_original_audio || record.has_translated_audio) && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {record.has_original_audio ? (
            <div className="rounded-md2 border border-line bg-ink p-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">Original caller audio</p>
              <audio controls preload="none" src={audioUrl(record.id, "original")} />
            </div>
          ) : null}
          {record.has_translated_audio ? (
            <div className="rounded-md2 border border-line bg-ink p-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">Marathi voice broadcast</p>
              <audio controls preload="none" src={audioUrl(record.id, "translated")} />
            </div>
          ) : null}
        </div>
      )}

      <TtsBox recordId={record.id} />

      <Card>
        <CardHead title="Operational decision" sub="Human-in-the-loop — AI never dispatches on its own" />
        <CardBody>
          <form
            className="grid grid-cols-1 gap-2 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              dispatch.mutate({
                call_id: record.call_id,
                location: String(fd.get("location") || ext.location || "Not identified"),
                incident_type: String(fd.get("incident_type") || ext.incident_type || "Unknown"),
                priority: String(fd.get("priority") || prio.level || "MEDIUM"),
                units: String(fd.get("units") || "Patrol unit assigned"),
              });
            }}
          >
            <Field label="Location">
              <TextInput name="location" defaultValue={ext.location ?? ""} />
            </Field>
            <Field label="Units">
              <TextInput name="units" defaultValue="Patrol unit assigned" />
            </Field>
            <Field label="Incident type">
              <TextInput name="incident_type" defaultValue={ext.incident_type ?? ""} />
            </Field>
            <Field label="Priority">
              <SelectInput name="priority" defaultValue={prio.level ?? "MEDIUM"}>
                {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </SelectInput>
            </Field>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={dispatch.isPending} className="w-full">
                {dispatch.isPending ? <Spinner /> : null} Log dispatch decision
              </Button>
            </div>
          </form>
          {record.timings && Object.keys(record.timings).length > 0 ? (
            <p className="mt-3 font-mono text-[11px] text-muted">
              {Object.entries(record.timings)
                .map(([k, v]) => `${k}=${v}ms`)
                .join(" · ")}
            </p>
          ) : null}
          <div className="mt-3">
            {!isAdmin ? null : !confirming ? (
              <Button variant="danger" onClick={() => setConfirming(true)}>
                Delete record
              </Button>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-sm text-cream">Delete this incident?</span>
                <Button variant="danger" disabled={del.isPending} onClick={() => del.mutate(record.id)}>
                  Confirm
                </Button>
                <Button variant="ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            )}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

/* ---------------- Operator listen ---------------- */

const LISTEN_KEY = "rakshak.listen-lang";
const LISTEN_VOICES: Array<{ code: ListenVoice; label: string }> = [
  { code: "en-IN", label: "English" },
  { code: "hi-IN", label: "Hindi" },
  { code: "mr-IN", label: "Marathi" },
];

function listenVoice(): ListenVoice {
  try {
    const v = localStorage.getItem(LISTEN_KEY);
    if (v === "hi-IN" || v === "mr-IN" || v === "en-IN") return v;
  } catch {
    /* ignore */
  }
  return "en-IN";
}

/** Operator-only translated listening: latest live utterance rendered in the
 *  operator's chosen language. Caller hears nothing of this — it plays in the
 *  operator's browser only. Language is auto-detected per utterance. */
function OperatorListen({ feed }: { feed: { events: LiveEvent[] } }) {
  const [voice, setVoice] = useState<ListenVoice>(listenVoice);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const activeCallId = activeLiveCallId(feed.events);
  const latest = feed.events.find((e) => e.name === "transcript.final" && e.callId === activeCallId)
    ?? feed.events.find((e) => e.name === "transcript.final");
  const payload = (latest?.payload ?? {}) as { original_text?: string; language?: string };
  const text = payload.original_text ?? "";
  return (
    <Card>
      <CardHead
        title="Operator listen"
        sub="Private translation — caller never hears this"
        right={payload.language ? <Badge tone="info">{payload.language}</Badge> : null}
      />
      <CardBody>
        {!text ? (
          <EmptyState title="No live speech yet" sub="Latest caller utterance with auto-detected language appears here." />
        ) : (
          <>
            <p className="text-sm text-cream">{text}</p>
            <p className="mt-1 font-mono text-xs text-muted">{latest?.callId ?? ""}</p>
          </>
        )}
        <div className="mt-2 flex items-center gap-2">
          <div className="flex overflow-hidden rounded-md2 border border-line text-xs">
            {LISTEN_VOICES.map((v) => (
              <button
                key={v.code}
                onClick={() => {
                  setVoice(v.code);
                  try {
                    localStorage.setItem(LISTEN_KEY, v.code);
                  } catch {
                    /* ignore */
                  }
                }}
                className={`px-2.5 py-1 ${voice === v.code ? "bg-accent text-white" : "text-muted hover:text-cream"}`}
              >
                {v.label}
              </button>
            ))}
          </div>
          <Button
            disabled={busy || !text}
            onClick={() => {
              setBusy(true);
              setError(null);
              translate(text, voice, payload.language)
                .then((t) => synthesize(t.data.translated_text, { language_code: voice }))
                .then((s) => {
                  setSrc(s.data.audio_base64);
                  setBusy(false);
                  audioRef.current?.play().catch(() => undefined);
                })
                .catch((e: Error) => {
                  setError(e.message || "Translation failed");
                  setBusy(false);
                });
            }}
          >
            {busy ? <Spinner /> : "▶ Listen"}
          </Button>
        </div>
        {error ? (
          <p className="mt-1 text-xs text-red-400">{error}</p>
        ) : null}
        {src ? <audio ref={audioRef} className="mt-2 w-full" controls preload="none" src={src} /> : null}
      </CardBody>
    </Card>
  );
}

/* ---------------- Operator profile ---------------- */

export const PROFILE_LANGUAGES = [
  "mr-IN",
  "hi-IN",
  "en-IN",
  "gu-IN",
  "ta-IN",
  "te-IN",
  "kn-IN",
  "ml-IN",
  "bn-IN",
] as const;

/** Re-reads the signed-in operator so the profile card appears/disappears as
 *  the DispatchPanel signs in/out in the same tab (storage events don't fire
 *  same-tab, so also sync on focus + a light poll). */
function useSignedInOperator() {
  const [session, setSession] = useState(signedInOperator);
  useEffect(() => {
    const sync = () => setSession(signedInOperator());
    sync();
    window.addEventListener("storage", sync);
    window.addEventListener("focus", sync);
    const t = setInterval(sync, 2000);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("focus", sync);
      clearInterval(t);
    };
  }, []);
  return session;
}

export function OperatorProfile() {
  const session = useSignedInOperator();
  const qc = useQueryClient();
  const profile = useQuery({
    queryKey: ["profile"],
    queryFn: getProfile,
    enabled: !!session,
    refetchOnWindowFocus: false,
  });
  const [known, setKnown] = useState<string[]>([]);
  const [defaultLang, setDefaultLang] = useState<string>("mr-IN");
  const [mobile, setMobile] = useState("");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (profile.data && !hydrated) {
      setKnown(profile.data.known_languages ?? []);
      setDefaultLang(profile.data.default_language ?? "mr-IN");
      setMobile(profile.data.mobile_e164 ?? "");
      setHydrated(true);
    }
  }, [profile.data, hydrated]);

  useEffect(() => {
    if (!session) setHydrated(false);
  }, [session]);

  const save = useMutation({
    mutationFn: () => putProfile({ known_languages: known, default_language: defaultLang, mobile_e164: mobile }),
    onSuccess: async (updated) => {
      setKnown(updated.known_languages ?? []);
      setDefaultLang(updated.default_language ?? defaultLang);
      setMobile(updated.mobile_e164 ?? "");
      await qc.invalidateQueries({ queryKey: ["profile"] });
    },
  });

  if (!session) return null;

  const toggleLang = (code: string) =>
    setKnown((prev) => (prev.includes(code) ? prev.filter((l) => l !== code) : [...prev, code]));

  return (
    <Card>
      <CardHead
        title="Operator profile"
        sub={session ? `Signed in as ${session.name}` : "Languages + contact for translation"}
        right={profile.data?.active === false ? <Badge tone="warn">inactive</Badge> : null}
      />
      <CardBody>
        {profile.isPending ? (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> Loading profile…
          </div>
        ) : profile.isError ? (
          <Alert kind="error">Couldn&apos;t load profile — check the API and retry.</Alert>
        ) : (
          <div className="space-y-3">
            <Field label="Known languages">
              <div className="flex flex-wrap gap-1.5">
                {PROFILE_LANGUAGES.map((code) => {
                  const on = known.includes(code);
                  return (
                    <button
                      key={code}
                      type="button"
                      data-testid={`lang-chip-${code}`}
                      aria-pressed={on}
                      onClick={() => toggleLang(code)}
                      className={`rounded-full border px-2.5 py-1 font-mono text-xs transition-colors ${
                        on
                          ? "border-accent bg-accent text-white"
                          : "border-line bg-ink text-muted hover:text-cream"
                      }`}
                    >
                      {code}
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field label="Default language">
              <SelectInput value={defaultLang} onChange={(e) => setDefaultLang(e.target.value)} aria-label="Default language">
                {PROFILE_LANGUAGES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Mobile (E164)">
              <TextInput
                value={mobile}
                onChange={(e) => setMobile(e.target.value)}
                placeholder="+911234567890"
                inputMode="tel"
                aria-label="Mobile (E164)"
              />
            </Field>
            {save.isError ? (
              <Alert kind="error">{save.error instanceof Error ? save.error.message : "Save failed."}</Alert>
            ) : null}
            {save.isSuccess ? <Alert kind="ok">Profile saved.</Alert> : null}
            <Button disabled={save.isPending} onClick={() => save.mutate()} className="w-full">
              {save.isPending ? <Spinner /> : null} Save profile
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/* ---------------- Live translation (toggle + nudge) ---------------- */

export function TranslationToggle({
  enabled,
  pending,
  disabled,
  onToggle,
}: {
  enabled: boolean;
  pending?: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <Button onClick={onToggle} disabled={disabled || pending} variant={enabled ? "primary" : "ghost"} aria-pressed={enabled}>
      {pending ? <Spinner /> : null} Translation: {enabled ? "ON" : "OFF"}
    </Button>
  );
}

export function NudgeBanner({
  callerLanguage,
  pending,
  onEnable,
}: {
  callerLanguage: string;
  pending?: boolean;
  onEnable: () => void;
}) {
  return (
    <div role="alert" className="mt-3 rounded-md2 border border-priomed/40 bg-priomed/10 p-2.5">
      <p className="text-sm text-cream">Caller speaks {callerLanguage} — enable translation?</p>
      <div className="mt-2">
        <Button onClick={onEnable} disabled={pending}>
          {pending ? <Spinner /> : null} Enable
        </Button>
      </div>
    </div>
  );
}

export function LiveTranslationPanel({ feed }: { feed: { events: LiveEvent[] } }) {
  const callId = activeLiveCallId(feed.events);
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: ["translation", callId],
    queryFn: () => getTranslation(callId as string),
    enabled: !!callId,
    refetchInterval: 5000,
    refetchOnWindowFocus: false,
  });
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOptimistic(null);
    setError(null);
    setPending(false);
  }, [callId]);

  const enabled = optimistic ?? state.data?.enabled ?? false;
  const suggestion = translationSuggestionForCall(feed.events, callId);
  const showNudge = !!callId && !!suggestion && !enabled;

  const flip = async (next?: boolean) => {
    if (!callId || pending) return;
    const target = next ?? !enabled;
    const prev = enabled;
    setOptimistic(target);
    setPending(true);
    setError(null);
    try {
      const res = await setTranslation(callId, target);
      qc.setQueryData(["translation", callId], res);
      setOptimistic(null);
    } catch (e) {
      setOptimistic(prev);
      setError(e instanceof Error ? e.message : "Translation update failed");
    } finally {
      setPending(false);
    }
  };

  return (
    <Card>
      <CardHead
        title="Live translation"
        sub={callId ? `Per-call toggle · ${callId}` : "Waiting for a live call"}
        right={<Badge tone={enabled ? "ok" : "neutral"}>{enabled ? "on" : "off"}</Badge>}
      />
      <CardBody>
        {!callId ? (
          <EmptyState title="No live call" sub="Latest transcript.final sets the active call for translation." />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <TranslationToggle enabled={enabled} pending={pending || state.isPending} onToggle={() => void flip()} />
              <span className="font-mono text-xs text-muted">{callId}</span>
            </div>
            {error ? (
              <div className="mt-2">
                <Alert kind="error">{error}</Alert>
              </div>
            ) : null}
            {showNudge && suggestion ? (
              <NudgeBanner callerLanguage={suggestion.callerLanguage} pending={pending} onEnable={() => void flip(true)} />
            ) : null}
          </>
        )}
      </CardBody>
    </Card>
  );
}

/* ---------------- Dispatch log ---------------- */

function DispatchPanel() {
  const { data, isPending } = useQuery({ queryKey: ["dispatch"], queryFn: getDispatchLog, refetchInterval: 5000 });
  const log: DispatchEntry[] = Array.isArray(data) ? data : [];
  const [callsign, setCallsign] = useState(operatorName());
  const [session, setSession] = useState(signedInOperator());
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  return (
    <Card>
      <CardHead title="Dispatch log" sub="Operator decisions — auditable" right={<Badge tone="info">{log.length}</Badge>} />
      <CardBody>
        {session ? (
          <p className="mb-2 flex items-center justify-between gap-2 text-xs text-muted">
            <span>
              Signed in as <span className="text-cream">{session.name}</span> ({session.role})
            </span>
            <button
              className="text-accentlight hover:underline"
              onClick={() => {
                void logout().then(() => {
                  setSession(null);
                });
              }}
            >
              Sign out
            </button>
          </p>
        ) : (
          <div className="mb-2 space-y-1.5">
            <div className="flex items-center gap-2 text-xs text-muted">
              <span className="w-14 shrink-0">Callsign</span>
              <input
                value={callsign}
                onChange={(e) => {
                  setCallsign(e.target.value);
                  setOperatorName(e.target.value);
                }}
                placeholder="operator"
                maxLength={100}
                className="w-full rounded-md2 border border-line bg-ink px-2 py-1 text-xs text-cream outline-none placeholder:text-muted"
              />
            </div>
            <div className="flex items-center gap-2 text-xs text-muted">
              <span className="w-14 shrink-0">Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="first sign-in registers"
                maxLength={200}
                className="w-full rounded-md2 border border-line bg-ink px-2 py-1 text-xs text-cream outline-none placeholder:text-muted"
              />
              <button
                className="shrink-0 text-accentlight hover:underline"
                onClick={() => {
                  setAuthError(null);
                  const name = callsign.trim() || "operator";
                  const done = (op: { name: string; role: string }) => {
                    setSession(op);
                    setOperatorName(op.name);
                    setPassword("");
                  };
                  // First operator bootstraps via register; afterwards login.
                  login(name, password)
                    .then(done)
                    .catch(() =>
                      register(name, password)
                        .then(() => login(name, password))
                        .then(done)
                        .catch(() => setAuthError("Sign-in failed — check name/password.")),
                    );
                }}
              >
                Sign in
              </button>
            </div>
            {authError ? <p className="text-xs text-red-400">{authError}</p> : null}
          </div>
        )}
        {isPending ? (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> Loading…
          </div>
        ) : !log.length ? (
          <EmptyState title="No dispatches logged" sub="Decisions from the record panel appear here." />
        ) : (
          <ul className="max-h-[300px] space-y-2 overflow-y-auto pr-1">
            {log.slice(0, 20).map((d, i) => (
              <li key={d.id ?? i} className="rounded-md2 border border-line bg-ink p-2.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-muted">{d.id ?? "—"} · {d.time ?? ""}</span>
                  <PriorityBadge level={d.priority} />
                </div>
                <p className="mt-1 text-sm text-cream">
                  {d.incident_type ?? "Unknown"} — {d.location ?? "Not identified"}
                </p>
                <p className="text-muted">
                  {d.call_id ?? ""} · {d.units ?? ""}{d.operator ? ` · ${d.operator}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/* ---------------- Console ---------------- */

export function OpsConsole() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const feed = useLiveEvents();
  const count = useQuery({ queryKey: ["count"], queryFn: getRecordCount, refetchInterval: 4000 });
  const records = useQuery({
    queryKey: ["records", "", "ALL", ""],
    queryFn: async () => (await listRecords({ priority: "ALL", limit: 50 })).data,
    refetchInterval: 4000,
  });
  const selected: IncidentRecord | null = selectedId
    ? (records.data?.find((r) => r.id === selectedId) ?? null)
    : null;

  return (
    <div className="min-h-dvh">
      <Header count={count.data} />
      <main className="mx-auto max-w-[1400px] space-y-4 px-4 py-4">
        <AnalyticsStrip />
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[340px_minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="space-y-4">
            <IntakePanel onDone={(id) => setSelectedId(id)} />
            <LivePanel feed={feed} />
            <LiveTranslationPanel feed={feed} />
            <OperatorListen feed={feed} />
            <OperatorProfile />
            <DispatchPanel />
          </div>
          <RecordsPanel selectedId={selectedId} onSelect={(id) => setSelectedId(id)} />
          <Card className="min-h-[420px]">
            <CardHead title="Incident workspace" sub="Evidence · reasoning · actions" />
            <CardBody>
              <RecordDetail record={selected} events={feed.events} />
            </CardBody>
          </Card>
        </div>
        <footer className="pb-6 pt-2 text-center text-xs text-muted">
          Rakshak AI V2 · COMMUNICATE → UNDERSTAND → CORRELATE · Verification stays explicit: reported ≠ confirmed.
        </footer>
      </main>
    </div>
  );
}
