"use client";

/**
 * Live emergency call workspace — app/live/[callId]/page.tsx
 *
 * Three columns (stack to one on tablet/mobile; controls sticky at bottom):
 *   LEFT   CallerPanel      — masked identity, status + duration, language,
 *                             location/callback/network (or Unknown/—, never
 *                             invented), priority, category, recording note,
 *                             real actions only.
 *   CENTER TimelinePanel    — bilingual finals timeline w/ playback, search,
 *                             copy, auto-scroll, degraded banners.
 *   RIGHT  BriefPanel       — AI emergency brief, editable, badged, sourced
 *                             from the linked record + process-call results.
 *   BOTTOM ControlBar       — playback audio, languages, translation toggle,
 *                             response actions, direction indicator.
 *
 * HONESTY: no Hold / PSTN-mute / End-PSTN / push-to-talk / hardware-transfer
 * controls exist anywhere here — there is no backend for them. "End
 * monitoring" only stops console monitoring (phone audio unaffected).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Translate, X } from "@phosphor-icons/react";
import { Shell } from "@/components/shell";
import { deriveCalls, primaryLanguage, useLiveEvents } from "@/lib/live";
import {
  getProfile,
  getTranslation,
  postDispatch,
  processCall,
  putProfile,
  setTranslation,
} from "@/lib/api";
import type { IncidentRecord, OperatorProfile } from "@/lib/types";
import { enumerateAudioDevices, loadPrefs, savePrefs, type AudioDevice } from "@/lib/prefs";
import { BriefPanel, type IncidentSignal } from "@/components/call-workspace/brief-panel";
import { CallerPanel } from "@/components/call-workspace/caller-panel";
import { TimelinePanel } from "@/components/call-workspace/timeline-panel";
import { ControlBar, CALLER_AUTO } from "@/components/call-workspace/control-bar";
import { AssignDialog, ConfirmDialog } from "@/components/call-workspace/dialogs";
import {
  buildTimeline,
  buildTranscriptText,
  CALLBACK_KEYS,
  firstPayloadString,
  latestTranslationSuggestion,
  LOCATION_EVENT_KEYS,
  maskCaller,
  NETWORK_KEYS,
} from "@/components/call-workspace/model";
import { setPlaybackSink, setPlaybackVolume } from "@/components/call-workspace/playback";

type DialogKind = "transfer" | "escalate" | "marksafe" | "endmonitor" | null;

function SkeletonCol(): React.ReactElement {
  return (
    <div className="flex flex-col gap-2 rounded-xl2 bg-card p-4 shadow-card" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="h-10 animate-pulse rounded-lg bg-paper motion-reduce:animate-none" />
      ))}
    </div>
  );
}

export default function LiveCallPage({ params }: { params: { callId: string } }): React.ReactElement {
  const callId = decodeURIComponent(params.callId);
  const router = useRouter();
  const feed = useLiveEvents();

  // null = unknown / not yet loaded. Backend default is OFF — never assume ON.
  // Treat null as OFF for safety-critical gating, display as loading.
  const [translationOn, setTranslationOn] = useState<boolean | null>(null);
  const [translationLoading, setTranslationLoading] = useState(true);
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);

  const [profile, setProfile] = useState<OperatorProfile | null>(null);
  const [profilePending, setProfilePending] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [callerLang, setCallerLang] = useState<string>(CALLER_AUTO);
  const [volume, setVolume] = useState(1);
  const [outputs, setOutputs] = useState<AudioDevice[]>([{ deviceId: "default", label: "Default speaker" }]);
  const [outputId, setOutputId] = useState("default");

  const [dialog, setDialog] = useState<DialogKind>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [incidentSignal, setIncidentSignal] = useState<IncidentSignal | null>(null);
  const [record, setRecord] = useState<IncidentRecord | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 5000);
  }, []);

  // ---- derived live state ----
  const { calls, waitingOperators } = useMemo(() => deriveCalls(feed.events), [feed.events]);
  const call = useMemo(() => calls.find((c) => c.callId === callId), [calls, callId]);
  const entries = useMemo(() => buildTimeline(feed.events, callId, call), [feed.events, callId, call]);
  const utterances = useMemo(() => entries.filter((e) => e.kind === "utterance"), [entries]);
  const ended = call?.status === "ended";

  const callerTongue = call ? primaryLanguage(call).language : "Unknown";
  const operatorTongue = profile?.default_language || loadPrefsSafe();

  const callback = firstPayloadString(feed.events, callId, CALLBACK_KEYS) ?? call?.from ?? "Unknown";
  const location = call?.location ?? record?.extraction?.location ?? firstPayloadString(feed.events, callId, LOCATION_EVENT_KEYS) ?? "Unknown";
  const networkQuality = firstPayloadString(feed.events, callId, NETWORK_KEYS) ?? "—";
  const category = call?.incidentType ?? record?.extraction?.incident_type ?? "Unknown — pending AI brief";

  // Mismatch nudge: latest translation.suggested for this call (reuses model helper).
  const suggestion = useMemo(() => latestTranslationSuggestion(feed.events, callId), [feed.events, callId]);
  // Show only while the toggle is OFF/unknown — never when ON is confirmed.
  const showSuggestion = !!suggestion && translationOn !== true && !suggestionDismissed;

  // Re-arm the nudge when the call or the suggested tongue changes.
  useEffect(() => {
    setSuggestionDismissed(false);
  }, [callId, suggestion?.language]);

  // ---- effects: translation toggle / profile / devices ----
  useEffect(() => {
    let cancelled = false;
    setTranslationLoading(true);
    getTranslation(callId)
      .then((t) => {
        if (!cancelled) {
          setTranslationOn(t.enabled);
          setTranslationError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setTranslationError(err instanceof Error ? err.message : "Failed to load translation state.");
      })
      .finally(() => {
        if (!cancelled) setTranslationLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [callId]);

  const loadProfile = useCallback(() => {
    setProfileError(null);
    getProfile()
      .then((p) => setProfile(p))
      .catch((err: unknown) => setProfileError(err instanceof Error ? err.message : "Failed to load operator profile."));
  }, []);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  useEffect(() => {
    try {
      const prefs = loadPrefs();
      setOutputId(prefs.audioOutputId || "default");
    } catch {
      /* defaults */
    }
    enumerateAudioDevices()
      .then((d) => {
        if (d.outputs.length) setOutputs(d.outputs);
      })
      .catch(() => {
        /* default speaker remains */
      });
  }, []);

  // ---- actions ----
  const toggleTranslation = useCallback(() => {
    // Unknown behaves as OFF: flipping enables. Same POST pauses/resumes.
    const next = translationOn !== true;
    setTranslationLoading(true);
    setTranslation(callId, next)
      .then((t) => {
        setTranslationOn(t.enabled);
        setTranslationError(null);
        showToast(t.enabled ? "Translation resumed." : "Translation paused — originals preserved.");
      })
      .catch((err: unknown) => {
        setTranslationError(err instanceof Error ? err.message : "Failed to toggle translation.");
      })
      .finally(() => setTranslationLoading(false));
  }, [callId, translationOn, showToast]);

  const changeOperatorTongue = useCallback(
    (code: string) => {
      setProfilePending(true);
      putProfile({ default_language: code })
        .then((p) => {
          setProfile(p);
          setProfileError(null);
          showToast(`Operator language → ${p.default_language}. Caller audio renders into this tongue (toggle-gated).`);
        })
        .catch((err: unknown) => setProfileError(err instanceof Error ? err.message : "Failed to save operator language."))
        .finally(() => setProfilePending(false));
    },
    [showToast],
  );

  const changeVolume = useCallback((v: number) => {
    setVolume(v);
    setPlaybackVolume(v);
  }, []);

  const changeOutput = useCallback((id: string) => {
    setOutputId(id);
    setPlaybackSink(id);
    try {
      const prefs = loadPrefs();
      savePrefs({ ...prefs, audioOutputId: id });
    } catch {
      /* ignore */
    }
  }, []);

  const createIncident = useCallback(() => {
    const transcript = buildTranscriptText(utterances);
    if (!transcript.trim()) {
      showToast("No transcript yet — nothing to process.");
      return;
    }
    const lang = callerLang !== CALLER_AUTO ? callerLang : callerTongue !== "Unknown" ? callerTongue : undefined;
    setBusyAction("incident");
    setActionError(null);
    processCall(transcript, lang)
      .then((res) => {
        if (res.data.id) {
          setIncidentSignal({ id: res.data.id, at: new Date().toISOString() });
          showToast(`Incident created: ${res.data.id}`);
        } else {
          showToast("Incident processed (no record id returned).");
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "Create incident failed.";
        setActionError(msg);
        showToast(msg);
      })
      .finally(() => setBusyAction(null));
  }, [utterances, callerLang, callerTongue, showToast]);

  const dispatch = useCallback(
    async (kind: "transfer" | "escalate" | "marksafe" | "endmonitor", extra?: Record<string, unknown>) => {
      setBusyAction(kind);
      setActionError(null);
      const decisions: Record<string, string> = {
        transfer: "transfer-to-operator",
        escalate: "escalate",
        marksafe: "mark-safe",
        endmonitor: "monitoring-ended",
      };
      try {
        await postDispatch({ call_id: callId, decision: decisions[kind], ...(extra ?? {}) });
        showToast(
          kind === "endmonitor" ? "Monitoring ended (phone audio unaffected)." : `Dispatch logged: ${decisions[kind]}.`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Dispatch failed.";
        setActionError(msg);
        showToast(msg);
        throw err;
      } finally {
        setBusyAction(null);
      }
    },
    [callId, showToast],
  );

  const onRecordChange = useCallback((r: IncidentRecord | null) => {
    setRecord(r);
  }, []);

  // ---- render states ----
  const loadingFeed = feed.status === "connecting" && feed.events.length === 0;
  const notFound = !loadingFeed && !call && entries.length === 0 && feed.events.length > 0;
  const waitingForEvents = !loadingFeed && !call && entries.length === 0 && feed.events.length === 0;

  return (
    <Shell
      section="live"
      title={`Live call — ${maskCaller(call?.from)}`}
      crumbs={[{ label: "Live", href: "/live" }, { label: callId }]}
      liveStatus={feed.status}
      actions={
        <span className="flex flex-wrap items-center gap-2 text-xs">
          <span
            role="status"
            className={`rounded-full border px-2.5 py-1 font-semibold ${
              feed.status === "live" ? "border-ok/30 bg-okbg text-ok" : "border-warn/30 bg-warnbg text-warn"
            }`}
          >
            {feed.status === "live" ? "● Live" : `● ${feed.status} (retry ${feed.retryCount})`}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-line bg-paper px-2.5 py-1 font-semibold text-muted">
            <Translate size={14} aria-hidden weight="duotone" className="text-muted" />
            Translation {translationOn === null || translationLoading ? "…" : translationOn ? "ON" : "OFF"}
          </span>
        </span>
      }
    >
      {feed.status === "reconnecting" && (
        <div role="alert" className="mb-3 rounded-lg border border-warn/30 bg-warnbg px-3 py-2 text-sm text-warn">
          Reconnecting to the live feed{feed.nextRetryMs ? ` (retry in ~${Math.round(feed.nextRetryMs / 1000)}s)` : ""}…{" "}
          <button type="button" onClick={() => window.location.reload()} className="font-semibold underline">
            Retry now
          </button>
        </div>
      )}

      {(translationError || profileError || actionError) && (
        <div role="alert" className="mb-3 rounded-lg border border-danger/30 bg-dangerbg px-3 py-2 text-sm text-danger">
          {translationError && (
            <p>
              Translation state: {translationError}{" "}
              <button
                type="button"
                onClick={() => {
                  setTranslationLoading(true);
                  getTranslation(callId)
                    .then((t) => {
                      setTranslationOn(t.enabled);
                      setTranslationError(null);
                    })
                    .catch((e: unknown) => setTranslationError(e instanceof Error ? e.message : "Retry failed."))
                    .finally(() => setTranslationLoading(false));
                }}
                className="font-semibold underline"
              >
                Retry
              </button>
            </p>
          )}
          {profileError && (
            <p>
              Operator profile: {profileError}{" "}
              <button type="button" onClick={loadProfile} className="font-semibold underline">
                Retry
              </button>
            </p>
          )}
          {actionError && !translationError && !profileError && <p>{actionError}</p>}
        </div>
      )}

      {showSuggestion && suggestion && (
        <div
          role="status"
          aria-label="Translation suggestion"
          className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-warn/30 bg-warnbg px-3 py-2 text-sm text-ink"
        >
          <Translate size={18} aria-hidden weight="duotone" className="shrink-0 text-warn" />
          <p className="min-w-0 flex-1">
            <span className="font-semibold">Translation suggested</span> — Caller speaks {suggestion.language} — enable
            translation?
            {translationOn === null && <span className="ml-1 text-muted">(loading current state…)</span>}
          </p>
          <button
            type="button"
            onClick={toggleTranslation}
            disabled={translationLoading}
            className="inline-flex min-h-[48px] items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-semibold text-white disabled:opacity-60"
          >
            <Translate size={16} aria-hidden weight="duotone" />
            {translationLoading ? "Working…" : "Enable translation"}
          </button>
          <button
            type="button"
            onClick={() => setSuggestionDismissed(true)}
            aria-label="Dismiss translation suggestion"
            className="inline-flex min-h-[48px] items-center gap-1 rounded-lg border border-line bg-card px-3 text-sm font-medium text-ink"
          >
            <X size={16} aria-hidden weight="bold" />
            Dismiss
          </button>
        </div>
      )}

      {ended && (
        <div role="status" className="mb-3 rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink">
          Call ended{call?.endedReason ? ` — ${call.endedReason}` : ""}. Timeline frozen below.
          {record ? (
            <>
              {" "}Linked record: <span className="font-mono">{record.id}</span> — open it in{" "}
              <a href="/history" className="font-semibold text-primary underline">
                History
              </a>
              .
            </>
          ) : (
            <> No linked record yet — use Create incident to process the transcript.</>
          )}
        </div>
      )}

      {loadingFeed ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_minmax(0,1fr)_340px]" aria-label="Loading call workspace">
          <SkeletonCol />
          <SkeletonCol />
          <SkeletonCol />
        </div>
      ) : notFound ? (
        <div className="mx-auto max-w-lg rounded-xl2 bg-card p-6 text-center shadow-card">
          <h2 className="text-base font-semibold text-ink">Call not found</h2>
          <p className="mt-2 text-sm text-muted">
            No live state for <span className="font-mono">{callId}</span> in the recent event window. It may have ended
            long ago or the id may be wrong.
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="min-h-[44px] rounded-lg bg-primary px-4 text-sm font-semibold text-white"
            >
              Retry
            </button>
            <a
              href="/live"
              className="inline-flex min-h-[44px] items-center rounded-lg border border-line px-4 text-sm font-medium text-ink"
            >
              Back to Live
            </a>
          </div>
        </div>
      ) : waitingForEvents ? (
        <div className="mx-auto max-w-lg rounded-xl2 bg-card p-6 text-center shadow-card">
          <h2 className="text-base font-semibold text-ink">Waiting for live events…</h2>
          <p className="mt-2 text-sm text-muted">
            Connected, but no events for <span className="font-mono">{callId}</span> yet.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 min-h-[44px] rounded-lg bg-primary px-4 text-sm font-semibold text-white"
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_minmax(0,1fr)_340px]">
          <CallerPanel
            call={call}
            callId={callId}
            callback={callback}
            location={location}
            networkQuality={networkQuality}
            category={category}
            busyAction={busyAction}
            transcriptEmpty={utterances.length === 0}
            onTransfer={() => setDialog("transfer")}
            onEscalate={() => setDialog("escalate")}
            onMarkSafe={() => setDialog("marksafe")}
            onCreateIncident={createIncident}
          />
          <div className="order-first lg:order-none">
            <TimelinePanel
              entries={entries}
              translationOn={translationOn}
              operatorTongue={operatorTongue}
              callerLang={callerLang}
              ended={!!ended}
            />
          </div>
          <BriefPanel callId={callId} incidentSignal={incidentSignal} onRecordChange={onRecordChange} />
        </div>
      )}

      {!loadingFeed && !notFound && !waitingForEvents && (
        <ControlBar
          callerTongue={callerTongue}
          operatorTongue={operatorTongue}
          onOperatorTongueChange={changeOperatorTongue}
          profilePending={profilePending}
          callerLang={callerLang}
          onCallerLangChange={setCallerLang}
          translationOn={translationOn}
          translationLoading={translationLoading}
          onToggleTranslation={toggleTranslation}
          volume={volume}
          onVolumeChange={changeVolume}
          outputs={outputs}
          outputId={outputId}
          onOutputChange={changeOutput}
          incidentPending={busyAction === "incident"}
          transcriptEmpty={utterances.length === 0}
          onCreateIncident={createIncident}
          onEscalate={() => setDialog("escalate")}
          onEndMonitoring={() => setDialog("endmonitor")}
        />
      )}

      {/* Confirmations for dispatch/escalate + transfer assign dialog */}
      <AssignDialog
        open={dialog === "transfer"}
        operators={waitingOperators}
        busy={busyAction === "transfer"}
        error={actionError}
        onClose={() => {
          if (busyAction !== "transfer") {
            setDialog(null);
            setActionError(null);
          }
        }}
        onAssign={(opId) => {
          void dispatch("transfer", { operator: opId, note: `Handoff to ${opId}` })
            .then(() => {
              setDialog(null);
            })
            .catch(() => {});
        }}
      />
      <ConfirmDialog
        open={dialog === "escalate"}
        title="Escalate this call?"
        body={
          <p>
            Logs an <span className="font-semibold">escalate</span> dispatch entry for{" "}
            <span className="font-mono">{callId}</span>. Severity is carried as text, never color alone.
          </p>
        }
        confirmLabel="Confirm escalate"
        danger
        busy={busyAction === "escalate"}
        onClose={() => busyAction !== "escalate" && setDialog(null)}
        onConfirm={() => {
          void dispatch("escalate", { note: "Operator escalated from live workspace." })
            .then(() => setDialog(null))
            .catch(() => {});
        }}
      />
      <ConfirmDialog
        open={dialog === "marksafe"}
        title="Mark this call safe?"
        body={
          <p>
            Logs a <span className="font-semibold">mark-safe</span> dispatch entry for{" "}
            <span className="font-mono">{callId}</span>. Only confirm if the caller is verified safe.
          </p>
        }
        confirmLabel="Confirm mark safe"
        busy={busyAction === "marksafe"}
        onClose={() => busyAction !== "marksafe" && setDialog(null)}
        onConfirm={() => {
          void dispatch("marksafe", { note: "Operator marked safe from live workspace." })
            .then(() => setDialog(null))
            .catch(() => {});
        }}
      />
      <ConfirmDialog
        open={dialog === "endmonitor"}
        title="End monitoring?"
        body={
          <p>
            This only stops <span className="font-semibold">console monitoring</span> — the phone audio stays up on the
            carrier side, and nothing on the PSTN call is muted, held, or hung up (this console has no PSTN controls).
            A <span className="font-semibold">monitoring-ended</span> entry is logged, then you return to /live.
          </p>
        }
        confirmLabel="End monitoring"
        busy={busyAction === "endmonitor"}
        onClose={() => busyAction !== "endmonitor" && setDialog(null)}
        onConfirm={() => {
          void dispatch("endmonitor", { note: "Operator stopped monitoring; phone audio unaffected." })
            .then(() => router.push("/live"))
            .catch(() => {
              // Log failed but operator intent stands — still leave the view.
              router.push("/live");
            });
        }}
      />

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-4 left-1/2 z-50 w-max max-w-[90vw] -translate-x-1/2 rounded-lg bg-ink px-4 py-2 text-sm text-white shadow-card"
        >
          {toast}
        </div>
      )}
    </Shell>
  );
}

function loadPrefsSafe(): string {
  try {
    return loadPrefs().preferredLanguage || "hi-IN";
  } catch {
    return "hi-IN";
  }
}
