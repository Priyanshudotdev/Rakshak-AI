"use client";

import { SUPPORTED_LANGUAGES } from "@/lib/types";
import type { AudioDevice } from "@/lib/prefs";
import { canSelectSink } from "./playback";

export const CALLER_AUTO = "auto";

interface ControlBarProps {
  // Translation direction (live values from events + profile).
  callerTongue: string;
  operatorTongue: string;
  onOperatorTongueChange: (code: string) => void;
  profilePending: boolean;
  callerLang: string;
  onCallerLangChange: (v: string) => void;
  // Translation toggle.
  translationOn: boolean;
  translationLoading: boolean;
  onToggleTranslation: () => void;
  // Playback audio (utterance playback only — never the live call).
  volume: number;
  onVolumeChange: (v: number) => void;
  outputs: AudioDevice[];
  outputId: string;
  onOutputChange: (id: string) => void;
  // Actions.
  incidentPending: boolean;
  transcriptEmpty: boolean;
  onCreateIncident: () => void;
  onEscalate: () => void;
  onEndMonitoring: () => void;
}

/**
 * BOTTOM call controls — large, stress-suitable targets.
 * Deliberately absent (no backend exists): Hold, PSTN mute, End PSTN call,
 * push-to-talk-into-call, hardware transfer. Only real controls ship.
 */
export function ControlBar(props: ControlBarProps): React.ReactElement {
  const {
    callerTongue,
    operatorTongue,
    onOperatorTongueChange,
    profilePending,
    callerLang,
    onCallerLangChange,
    translationOn,
    translationLoading,
    onToggleTranslation,
    volume,
    onVolumeChange,
    outputs,
    outputId,
    onOutputChange,
    incidentPending,
    transcriptEmpty,
    onCreateIncident,
    onEscalate,
    onEndMonitoring,
  } = props;

  return (
    <div className="sticky bottom-0 z-30 -mx-4 mt-4 border-t border-line bg-card/95 px-4 py-3 shadow-card backdrop-blur">
      {/* Translation direction indicator */}
      <p role="status" aria-label="Translation direction" className="text-center text-xs text-muted">
        Caller speech: <span className="font-semibold text-ink">{callerTongue}</span> →{" "}
        <span className="font-semibold text-ink">{operatorTongue}</span> (operator tongue)
        <span className="mx-2 text-faint">•</span>
        Operator speech: <span className="font-semibold text-ink">{operatorTongue}</span> →{" "}
        <span className="font-semibold text-ink">{callerTongue}</span> (caller tongue)
        {!translationOn && <span className="ml-2 font-semibold text-warn">— translation paused</span>}
      </p>

      <div className="mx-auto mt-2 grid max-w-6xl grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {/* Playback audio */}
        <fieldset className="rounded-lg border border-line p-2.5">
          <legend className="px-1 text-xs font-semibold text-muted">Playback audio (utterances only)</legend>
          <label htmlFor="spk-vol" className="flex items-center justify-between text-xs text-ink">
            Speaker volume <span className="font-mono">{Math.round(volume * 100)}%</span>
          </label>
          <input
            id="spk-vol"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => onVolumeChange(Number(e.target.value))}
            className="mt-1 min-h-[44px] w-full"
          />
          <label htmlFor="spk-out" className="mt-1 block text-xs text-ink">
            Audio output
          </label>
          <select
            id="spk-out"
            value={outputId}
            onChange={(e) => onOutputChange(e.target.value)}
            className="mt-1 min-h-[44px] w-full rounded-lg border border-line bg-card px-2 text-sm text-ink"
          >
            {outputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
          {!canSelectSink() && (
            <p className="mt-1 text-[11px] text-faint">Per-device routing unsupported in this browser — default output used.</p>
          )}
        </fieldset>

        {/* Languages */}
        <fieldset className="rounded-lg border border-line p-2.5">
          <legend className="px-1 text-xs font-semibold text-muted">Languages</legend>
          <label htmlFor="op-lang" className="block text-xs text-ink">
            Operator language (effective: <span className="font-semibold">{operatorTongue}</span>)
          </label>
          <select
            id="op-lang"
            value={operatorTongue}
            onChange={(e) => onOperatorTongueChange(e.target.value)}
            disabled={profilePending}
            className="mt-1 min-h-[44px] w-full rounded-lg border border-line bg-card px-2 text-sm text-ink disabled:opacity-50"
          >
            {SUPPORTED_LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <label htmlFor="caller-lang" className="mt-2 block text-xs text-ink">
            Caller language (auto-detect default ON)
          </label>
          <select
            id="caller-lang"
            value={callerLang}
            onChange={(e) => onCallerLangChange(e.target.value)}
            className="mt-1 min-h-[44px] w-full rounded-lg border border-line bg-card px-2 text-sm text-ink"
          >
            <option value={CALLER_AUTO}>Auto-detect (recommended)</option>
            {SUPPORTED_LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          {callerLang !== CALLER_AUTO && (
            <p className="mt-1 text-[11px] text-faint">
              Manual override affects console playback/display only — live detection stays automatic.
            </p>
          )}
        </fieldset>

        {/* Translation toggle */}
        <fieldset className="rounded-lg border border-line p-2.5">
          <legend className="px-1 text-xs font-semibold text-muted">Translation</legend>
          <button
            type="button"
            onClick={onToggleTranslation}
            disabled={translationLoading}
            aria-pressed={translationOn}
            className={`min-h-[52px] w-full rounded-lg px-4 text-sm font-semibold text-white disabled:opacity-50 ${
              translationOn ? "bg-warn" : "bg-ok"
            }`}
          >
            {translationLoading ? "Working…" : translationOn ? "❚❚ Pause translation" : "▶ Resume translation"}
          </button>
          <p className="mt-1 text-[11px] text-faint">Per-call toggle. Originals are always preserved.</p>
        </fieldset>

        {/* Response actions */}
        <fieldset className="rounded-lg border border-line p-2.5">
          <legend className="px-1 text-xs font-semibold text-muted">Response</legend>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={onCreateIncident}
              disabled={incidentPending || transcriptEmpty}
              title={transcriptEmpty ? "No transcript yet" : "Process transcript into an incident"}
              className="min-h-[48px] rounded-lg bg-primary px-3 text-sm font-semibold text-white disabled:opacity-50"
            >
              {incidentPending ? "Creating…" : "Create incident"}
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onEscalate}
                className="min-h-[48px] flex-1 rounded-lg border border-danger/40 bg-dangerbg px-3 text-sm font-semibold text-danger"
              >
                Escalate
              </button>
              <button
                type="button"
                onClick={onEndMonitoring}
                title="Stop monitoring this call in the console"
                className="min-h-[48px] flex-1 rounded-lg border border-line px-3 text-sm font-semibold text-ink"
              >
                End monitoring
              </button>
            </div>
          </div>
        </fieldset>
      </div>
    </div>
  );
}
