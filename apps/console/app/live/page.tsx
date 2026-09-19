"use client";

/**
 * Live Calls queue.
 *
 * HONESTY CONTRACT (backend has NO call-assignment endpoint and NO browser telephony):
 * - There is no server "calls list". The queue is derived SOLELY from
 *   deriveCalls(useLiveEvents().events) — a client-side fold over the WS event
 *   stream. The page says so in the UI ("derived from N live events").
 * - "Answer" = claim the call: record assignment in localStorage keyed by
 *   callId, then POST /api/dispatch {call_id, decision:"claimed", operator}
 *   (best-effort audit trail, NOT a server assignment), then route to the
 *   /live/[callId] workspace. The browser NEVER takes call audio — a notice
 *   states audio stays on the operator's phone (dial the DID to join audio).
 * - "Assign" = same claim flow with an operator-name input.
 * - "Open call" = plain link to the workspace. Durations tick client-side from
 *   startedAt every second and freeze at ended (lastAt - startedAt).
 *
 * ESCALATION RULE (client-side derivation — the backend exposes no escalated
 * flag; LiveCall.escalated is always false from deriveCalls today):
 *   escalated = priority is exactly CRITICAL (case-insensitive)
 *           OR endedReason contains "escalat" (case-insensitive)
 *           OR the live `escalated` bit is set (forward-compat).
 * NOTE: HIGH priority alone does NOT escalate. An escalated call stays in the
 * Escalated group even after it ends (that is the only place an endedReason
 * escalation can surface); Recently ended lists ended NON-escalated calls.
 *
 * GROUPING (clean partition of derived calls):
 * - Escalated: isEscalated(call), any status.
 * - Recently ended: status ended AND not escalated (last 10 by lastAt desc).
 * - Incoming: status incoming, not escalated.
 * - Active: status active/waiting, not escalated, AND (claimed OR operatorJoined).
 * - Waiting: status active/waiting, not escalated, unclaimed AND no operator
 *   joined. The waitingOperators ids from deriveCalls render as chips above
 *   this group (operators waiting to join, from operator.waiting events).
 */

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowSquareOut,
  ArrowClockwise,
  CheckCircle,
  Clock,
  MagnifyingGlass,
  MapPin,
  Phone,
  PhoneCall,
  PhoneDisconnect,
  PhoneIncoming,
  Siren,
  Translate,
  UserCheck,
  UserPlus,
  Warning,
  WarningCircle,
} from "@phosphor-icons/react";
import { Shell } from "@/components/shell";
import { operatorName, postDispatch } from "@/lib/api";
import { deriveCalls, primaryLanguage, useLiveEvents, type LiveCall } from "@/lib/live";

export const dynamic = "force-dynamic";

/* ---------------- assignment storage (local-only claim ledger) ---------------- */

/**
 * ASSIGNMENT STORAGE: the backend has no assignment endpoint, so claims live in
 * localStorage under CLAIMS_KEY: { [callId]: { operator, at, decision } }.
 * "claimed-by-me" = entry.operator === current operator name;
 * "claimed-by-X" = entry exists with another name; else "unassigned".
 * The POST /api/dispatch {decision:"claimed"} is a best-effort shared audit
 * trail, not the source of truth for assignment.
 */
const CLAIMS_KEY = "rakshak.console.claims.v1";

interface Claim {
  operator: string;
  at: string;
  decision: string;
}

function loadClaims(): Record<string, Claim> {
  try {
    const raw = localStorage.getItem(CLAIMS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Claim>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeClaim(callId: string, claim: Claim): void {
  try {
    const all = loadClaims();
    all[callId] = claim;
    localStorage.setItem(CLAIMS_KEY, JSON.stringify(all));
  } catch {
    /* private mode — claim stays in memory only */
  }
}

/* ---------------- derivation + formatting helpers ---------------- */

/** Caller privacy: never render a full number — last 4 digits only. */
function maskCaller(from: string | undefined | null): string {
  if (!from || /unknown/i.test(from)) return "Unknown caller";
  const digits = from.replace(/\D/g, "");
  if (!digits) return "Unknown caller";
  return `\u2022\u2022\u2022 \u2022\u2022\u2022 ${digits.slice(-4)}`;
}

function isEscalated(call: LiveCall): boolean {
  if (call.escalated) return true;
  if ((call.priority ?? "").toUpperCase() === "CRITICAL") return true;
  if ((call.endedReason ?? "").toLowerCase().includes("escalat")) return true;
  return false;
}

function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "0:00";
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

/** Seconds since startedAt; frozen at ended (lastAt - startedAt). Null clock
 *  (pre-hydration) renders as zero so server and client agree exactly. */
function elapsedSeconds(call: LiveCall, nowMs: number | null): number {
  const start = new Date(call.startedAt).getTime();
  if (!Number.isFinite(start)) return 0;
  if (call.status === "ended") {
    const end = new Date(call.lastAt).getTime();
    return Number.isFinite(end) ? Math.max(0, (end - start) / 1000) : 0;
  }
  if (nowMs === null) return 0;
  return Math.max(0, (nowMs - start) / 1000);
}

function formatTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/* ---------------- badges (icon + text, never color alone) ---------------- */

function PriorityBadge({ level }: { level: string | undefined }) {
  const p = (level ?? "").toUpperCase();
  if (p === "CRITICAL")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-dangerbg px-2 py-0.5 text-xs font-medium text-danger">
        <Siren size={14} aria-hidden /> Critical
      </span>
    );
  if (p === "HIGH")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-warnbg px-2 py-0.5 text-xs font-medium text-warn">
        <Warning size={14} aria-hidden /> High
      </span>
    );
  if (p === "MEDIUM")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-2 py-0.5 text-xs font-medium text-primary-dark">
        <WarningCircle size={14} aria-hidden /> Medium
      </span>
    );
  if (p === "LOW")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-paper px-2 py-0.5 text-xs font-medium text-muted">
        <WarningCircle size={14} aria-hidden /> Low
      </span>
    );
  return <span className="inline-flex items-center gap-1 text-xs text-faint">No priority yet</span>;
}

function StatusBadge({ status }: { status: LiveCall["status"] }) {
  if (status === "incoming")
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-primary-dark">
        <PhoneIncoming size={14} aria-hidden /> Incoming
      </span>
    );
  if (status === "active")
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-ok">
        <PhoneCall size={14} aria-hidden /> Active
      </span>
    );
  if (status === "waiting")
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-warn">
        <Clock size={14} aria-hidden /> Waiting
      </span>
    );
  if (status === "escalated")
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-danger">
        <Siren size={14} aria-hidden /> Escalated
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-muted">
      <PhoneDisconnect size={14} aria-hidden /> Ended
    </span>
  );
}

function ClaimBadge({ claim, me }: { claim: Claim | undefined; me: string }) {
  if (!claim)
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs font-medium text-warn">
        <Clock size={14} aria-hidden /> Unassigned
      </span>
    );
  if (claim.operator === me)
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-2 py-0.5 text-xs font-medium text-primary-dark">
        <UserCheck size={14} aria-hidden /> Claimed by you
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-paper px-2 py-0.5 text-xs font-medium text-muted">
      <UserCheck size={14} aria-hidden /> Claimed by {claim.operator}
    </span>
  );
}

/* ---------------- single call card ---------------- */

function CallCard({
  call,
  nowMs,
  claim,
  me,
  busy,
  assignOpen,
  assignName,
  onAssignNameChange,
  onAnswer,
  onAssignOpen,
  onAssignConfirm,
  onAssignCancel,
}: {
  call: LiveCall;
  nowMs: number | null;
  claim: Claim | undefined;
  me: string;
  busy: boolean;
  assignOpen: boolean;
  assignName: string;
  onAssignNameChange: (v: string) => void;
  onAnswer: () => void;
  onAssignOpen: () => void;
  onAssignConfirm: () => void;
  onAssignCancel: () => void;
}) {
  const { language, confidence } = primaryLanguage(call);
  const claimed = Boolean(claim);
  return (
    <li className="rounded-xl2 border border-line bg-card p-4 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-semibold text-ink" title={`Call ${call.callId}`}>
              {call.callId}
            </span>
            <StatusBadge status={call.status} />
            <PriorityBadge level={call.priority} />
            {isEscalated(call) && (
              <span className="inline-flex items-center gap-1 rounded-full bg-dangerbg px-2 py-0.5 text-xs font-medium text-danger">
                <Siren size={14} aria-hidden /> Escalated
              </span>
            )}
          </div>
          <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <div className="flex items-center gap-2 text-ink">
              <dt className="sr-only">Caller</dt>
              <dd>
                <Phone size={14} className="mr-1 inline text-muted" aria-hidden />
                {maskCaller(call.from)}
              </dd>
            </div>
            <div className="flex items-center gap-2 text-ink">
              <dt className="sr-only">Duration</dt>
              <dd>
                <Clock size={14} className="mr-1 inline text-muted" aria-hidden />
                <span aria-label={`Call duration ${formatDuration(elapsedSeconds(call, nowMs))}`}>
                  {formatDuration(elapsedSeconds(call, nowMs))}
                </span>
                {call.status === "ended" && <span className="ml-1 text-xs text-faint">(final)</span>}
              </dd>
            </div>
            <div className="flex items-center gap-2 text-ink">
              <dt className="sr-only">Language</dt>
              <dd>
                <Translate size={14} className="mr-1 inline text-muted" aria-hidden />
                {language}
                {confidence > 0 && <span className="ml-1 text-xs text-muted">{Math.round(confidence * 100)}%</span>}
              </dd>
            </div>
            <div className="flex items-center gap-2 text-ink">
              <dt className="sr-only">Location</dt>
              <dd>
                <MapPin size={14} className="mr-1 inline text-muted" aria-hidden />
                {call.location || "Unknown"}
              </dd>
            </div>
          </dl>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <ClaimBadge claim={claim} me={me} />
            <span className="text-xs text-faint">
              {nowMs === null ? "Started —" : `Started ${formatTime(call.startedAt)}`}
              {call.incidentType ? ` · ${call.incidentType}` : ""}
              {call.utterances > 0 ? ` · ${call.utterances} utterance${call.utterances === 1 ? "" : "s"}` : ""}
            </span>
          </div>
        </div>
        <div className="flex flex-col items-stretch gap-2 sm:items-end">
          {!claimed ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={onAnswer}
                className="inline-flex items-center gap-1.5 rounded-xl2 bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
              >
                <PhoneCall size={16} aria-hidden /> {busy ? "Claiming…" : "Answer"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={onAssignOpen}
                className="inline-flex items-center gap-1.5 rounded-xl2 border border-line bg-card px-3 py-2 text-sm font-medium text-ink hover:bg-paper disabled:opacity-50"
              >
                <UserPlus size={16} aria-hidden /> Assign
              </button>
            </div>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-ok">
              <CheckCircle size={14} aria-hidden /> Claimed{claim?.operator === me ? " by you" : ` by ${claim?.operator}`}
            </span>
          )}
          <Link
            href={`/live/${encodeURIComponent(call.callId)}`}
            className="inline-flex items-center gap-1.5 rounded-xl2 border border-line bg-card px-3 py-2 text-sm font-medium text-primary-dark hover:bg-primary-soft"
          >
            <ArrowSquareOut size={16} aria-hidden /> Open call
          </Link>
        </div>
      </div>
      {assignOpen && !claimed && (
        <form
          className="mt-3 flex flex-wrap items-center gap-2 rounded-xl2 bg-paper p-3"
          onSubmit={(e) => {
            e.preventDefault();
            onAssignConfirm();
          }}
        >
          <label htmlFor={`assign-${call.callId}`} className="text-sm font-medium text-ink">
            Assign to operator
          </label>
          <input
            id={`assign-${call.callId}`}
            value={assignName}
            onChange={(e) => onAssignNameChange(e.target.value)}
            placeholder={me}
            autoFocus
            className="min-w-40 flex-1 rounded-xl2 border border-line bg-card px-3 py-2 text-sm text-ink"
          />
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-xl2 bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
          >
            <UserCheck size={16} aria-hidden /> Confirm claim
          </button>
          <button
            type="button"
            onClick={onAssignCancel}
            className="rounded-xl2 border border-line bg-card px-3 py-2 text-sm text-ink hover:bg-paper"
          >
            Cancel
          </button>
          <p className="w-full text-xs text-muted">
            Claiming records assignment locally and posts a claimed entry to the dispatch log. Audio stays on the
            operator&apos;s phone — dial the DID to join audio.
          </p>
        </form>
      )}
    </li>
  );
}

/* ---------------- group section ---------------- */

function GroupSection({
  title,
  icon,
  count,
  emptyText,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  count: number;
  emptyText: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="space-y-3">
      <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
        <span className="text-muted" aria-hidden>
          {icon}
        </span>
        {title}
        <span className="rounded-full bg-paper px-2 py-0.5 text-xs font-medium text-muted">{count}</span>
      </h2>
      {count === 0 ? (
        <div className="rounded-xl2 border border-dashed border-line bg-card p-6 text-center">
          <p className="text-sm text-muted">{emptyText}</p>
        </div>
      ) : (
        <ul className="space-y-3">{children}</ul>
      )}
    </section>
  );
}

/* ---------------- page ---------------- */

function LiveQueue() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { status, events, retryCount, nextRetryMs } = useLiveEvents();

  // nowMs starts null so server and first client render agree ("—");
  // the interval sets real time client-side only. Rendering Date.now()
  // directly would hydrate-mismatch on every load.
  const [nowMs, setNowMs] = useState<number | null>(null);
  const [me, setMe] = useState("operator");
  const [claims, setClaims] = useState<Record<string, Claim>>({});
  const [busyCallId, setBusyCallId] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [assignOpenFor, setAssignOpenFor] = useState<string | null>(null);
  const [assignName, setAssignName] = useState("");

  useEffect(() => {
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    setMe(operatorName());
    setClaims(loadClaims());
  }, []);

  const { calls, waitingOperators } = useMemo(() => deriveCalls(events), [events]);

  /* URL-backed filters (shareable): q, priority, language, status, assigned */
  const q = (searchParams.get("q") ?? "").trim();
  const fPriority = searchParams.get("priority") ?? "ALL";
  const fLanguage = searchParams.get("language") ?? "ALL";
  const fStatus = searchParams.get("status") ?? "ALL";
  const fAssigned = searchParams.get("assigned") ?? "ALL";

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams.toString());
    if (!value || value === "ALL") next.delete(key);
    else next.set(key, value);
    router.replace(`?${next.toString()}`, { scroll: false });
  };

  const languages = useMemo(() => {
    const set = new Set<string>();
    for (const c of calls) {
      const { language } = primaryLanguage(c);
      if (language && language !== "Unknown") set.add(language);
    }
    return [...set].sort();
  }, [calls]);

  const filtered = useMemo(() => {
    const needle = q.toLowerCase();
    return calls.filter((c) => {
      if (fPriority !== "ALL" && (c.priority ?? "").toUpperCase() !== fPriority) return false;
      if (fLanguage !== "ALL" && primaryLanguage(c).language !== fLanguage) return false;
      if (fAssigned === "MINE") {
        const cl = claims[c.callId];
        if (!cl || cl.operator !== me) return false;
      }
      if (fStatus !== "ALL") {
        const s = fStatus.toLowerCase();
        if (s === "escalated") {
          if (!isEscalated(c)) return false;
        } else if (c.status !== s) {
          return false;
        }
      }
      if (needle) {
        const hay = `${c.callId} ${c.from} ${c.location ?? ""} ${c.incidentType ?? ""} ${primaryLanguage(c).language}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [calls, q, fPriority, fLanguage, fStatus, fAssigned, claims, me]);

  const groups = useMemo(() => {
    const escalated: LiveCall[] = [];
    const incoming: LiveCall[] = [];
    const waiting: LiveCall[] = [];
    const active: LiveCall[] = [];
    const ended: LiveCall[] = [];
    for (const c of filtered) {
      if (isEscalated(c)) {
        escalated.push(c);
        continue;
      }
      if (c.status === "ended") {
        ended.push(c);
        continue;
      }
      if (c.status === "incoming") {
        incoming.push(c);
        continue;
      }
      const claimed = Boolean(claims[c.callId]);
      if (claimed || c.operatorJoined) active.push(c);
      else waiting.push(c);
    }
    ended.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
    return { escalated, incoming, waiting, active, ended: ended.slice(0, 10) };
  }, [filtered, claims]);

  const claimCall = async (call: LiveCall, assignee?: string) => {
    const target = (assignee ?? me).trim() || me;
    setBusyCallId(call.callId);
    setClaimError(null);
    const claim: Claim = { operator: target, at: new Date().toISOString(), decision: "claimed" };
    writeClaim(call.callId, claim);
    setClaims(loadClaims());
    try {
      /* Best-effort shared audit trail — NOT a server assignment (no such endpoint). */
      await postDispatch({
        call_id: call.callId,
        decision: "claimed",
        operator: target,
        location: call.location ?? "Not identified",
        incident_type: call.incidentType ?? "Unknown",
        priority: call.priority ?? "MEDIUM",
      });
    } catch (err) {
      setClaimError(
        `Claim saved locally for ${target}, but the dispatch-log entry failed: ${err instanceof Error ? err.message : "network error"}.`,
      );
    } finally {
      setBusyCallId(null);
    }
    setAssignOpenFor(null);
    setAssignName("");
    setNotice(
      `Call ${call.callId} claimed by ${target}. Audio stays on the operator's phone — dial the DID to join audio, then continue in the call workspace.`,
    );
    router.push(`/live/${encodeURIComponent(call.callId)}?claimed=1`);
  };

  const cardProps = (call: LiveCall) => ({
    call,
    nowMs,
    claim: claims[call.callId],
    me,
    busy: busyCallId === call.callId,
    assignOpen: assignOpenFor === call.callId,
    assignName,
    onAssignNameChange: setAssignName,
    onAnswer: () => void claimCall(call),
    onAssignOpen: () => {
      setAssignName(me);
      setAssignOpenFor(call.callId);
    },
    onAssignConfirm: () => void claimCall(call, assignName),
    onAssignCancel: () => {
      setAssignOpenFor(null);
      setAssignName("");
    },
  });

  return (
    <Shell section="live" title="Live Calls">
      {/* Reconnecting / connecting banner */}
      {status !== "live" && (
        <div
          role="status"
          className="mb-4 flex items-start gap-2 rounded-xl2 border border-line bg-warnbg p-3 text-sm text-warn"
        >
          <ArrowClockwise size={18} className="mt-0.5 shrink-0 animate-spin" aria-hidden />
          <div>
            <p className="font-medium">
              {status === "connecting" ? "Connecting to the live feed…" : "Reconnecting to the live feed…"}
            </p>
            <p className="text-xs">
              Showing the last known queue below — it may be stale.
              {retryCount > 0 && ` Retry #${retryCount}`}
              {nextRetryMs != null && ` in ~${Math.round(nextRetryMs / 1000)}s`}.
            </p>
          </div>
        </div>
      )}
      {notice && (
        <div role="status" className="mb-4 flex items-start justify-between gap-2 rounded-xl2 border border-line bg-primary-soft p-3 text-sm text-primary-dark">
          <p>{notice}</p>
          <button type="button" onClick={() => setNotice(null)} className="shrink-0 underline">
            Dismiss
          </button>
        </div>
      )}
      {claimError && (
        <div role="alert" className="mb-4 rounded-xl2 border border-line bg-dangerbg p-3 text-sm text-danger">
          {claimError}
        </div>
      )}

      {/* Source honesty note */}
      <p className="mb-4 text-xs text-muted">
        Queue derived client-side from {events.length} live event{events.length === 1 ? "" : "s"} — there is no server
        calls list. Your browser never carries call audio; answer claims the call, then you join audio from your
        phone.
      </p>

      {/* Search + filters (URL-backed, shareable) */}
      <div className="mb-6 rounded-xl2 border border-line bg-card p-4 shadow-card">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="flex items-center gap-2 rounded-xl2 border border-line bg-card px-3 py-2 lg:col-span-1">
            <MagnifyingGlass size={16} className="shrink-0 text-muted" aria-hidden />
            <span className="sr-only">Search calls</span>
            <input
              value={searchParams.get("q") ?? ""}
              onChange={(e) => setParam("q", e.target.value)}
              placeholder="Search id, caller, place…"
              className="w-full bg-transparent text-sm text-ink placeholder:text-faint focus:outline-none"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-muted">Priority</span>
            <select
              value={fPriority}
              onChange={(e) => setParam("priority", e.target.value)}
              className="w-full rounded-xl2 border border-line bg-card px-3 py-2 text-sm text-ink"
            >
              {["ALL", "CRITICAL", "HIGH", "MEDIUM", "LOW"].map((p) => (
                <option key={p} value={p}>
                  {p === "ALL" ? "All priorities" : p.charAt(0) + p.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-muted">Language</span>
            <select
              value={fLanguage}
              onChange={(e) => setParam("language", e.target.value)}
              className="w-full rounded-xl2 border border-line bg-card px-3 py-2 text-sm text-ink"
            >
              <option value="ALL">All languages</option>
              {languages.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-muted">Status</span>
            <select
              value={fStatus}
              onChange={(e) => setParam("status", e.target.value)}
              className="w-full rounded-xl2 border border-line bg-card px-3 py-2 text-sm text-ink"
            >
              {["ALL", "incoming", "waiting", "active", "escalated", "ended"].map((s) => (
                <option key={s} value={s}>
                  {s === "ALL" ? "All statuses" : s.charAt(0).toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-muted">Assignment</span>
            <select
              value={fAssigned}
              onChange={(e) => setParam("assigned", e.target.value)}
              className="w-full rounded-xl2 border border-line bg-card px-3 py-2 text-sm text-ink"
            >
              <option value="ALL">All calls</option>
              <option value="MINE">Assigned to me</option>
            </select>
          </label>
        </div>
      </div>

      {status === "connecting" && events.length === 0 ? (
        /* Initial loading skeleton */
        <div className="space-y-3" aria-label="Loading live calls">
          {[0, 1, 2].map((i) => (
            <div key={i} className="animate-pulse rounded-xl2 border border-line bg-card p-4">
              <div className="h-4 w-1/3 rounded bg-paper" />
              <div className="mt-2 h-3 w-2/3 rounded bg-paper" />
              <div className="mt-2 h-3 w-1/2 rounded bg-paper" />
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-8">
          <GroupSection
            title="Incoming"
            icon={<PhoneIncoming size={18} />}
            count={groups.incoming.length}
            emptyText="No incoming calls right now."
          >
            {groups.incoming.map((c) => (
              <CallCard key={c.callId} {...cardProps(c)} />
            ))}
          </GroupSection>

          <GroupSection
            title="Waiting"
            icon={<Clock size={18} />}
            count={groups.waiting.length}
            emptyText="Nothing waiting — every answered call has an operator."
          >
            {waitingOperators.length > 0 && (
              <li className="rounded-xl2 border border-dashed border-line bg-paper p-3 text-xs text-muted">
                Operators waiting to join (from live events): {waitingOperators.join(", ")}
              </li>
            )}
            {groups.waiting.map((c) => (
              <CallCard key={c.callId} {...cardProps(c)} />
            ))}
          </GroupSection>

          <GroupSection
            title="Active"
            icon={<PhoneCall size={18} />}
            count={groups.active.length}
            emptyText="No active operator-joined calls."
          >
            {groups.active.map((c) => (
              <CallCard key={c.callId} {...cardProps(c)} />
            ))}
          </GroupSection>

          <GroupSection
            title="Escalated"
            icon={<Siren size={18} />}
            count={groups.escalated.length}
            emptyText="No escalated calls. Escalation = CRITICAL priority or an escalated end reason."
          >
            {groups.escalated.map((c) => (
              <CallCard key={c.callId} {...cardProps(c)} />
            ))}
          </GroupSection>

          <GroupSection
            title="Recently ended"
            icon={<PhoneDisconnect size={18} />}
            count={groups.ended.length}
            emptyText="No recently ended calls."
          >
            {groups.ended.map((c) => (
              <CallCard key={c.callId} {...cardProps(c)} />
            ))}
          </GroupSection>
        </div>
      )}

      <p className="mt-6 text-xs text-muted">
        Answer claims the call for you; Assign claims it for a named operator. Either way, open the call workspace and
        join audio from your phone — this page never handles call audio.
      </p>
    </Shell>
  );
}

export default function LivePage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-3 p-6" aria-label="Loading live calls">
          {[0, 1, 2].map((i) => (
            <div key={i} className="animate-pulse rounded-xl2 border border-line bg-card p-4">
              <div className="h-4 w-1/3 rounded bg-paper" />
              <div className="mt-2 h-3 w-2/3 rounded bg-paper" />
            </div>
          ))}
        </div>
      }
    >
      <LiveQueue />
    </Suspense>
  );
}
