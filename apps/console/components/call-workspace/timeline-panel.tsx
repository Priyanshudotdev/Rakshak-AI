"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { synthesize, translate } from "@/lib/api";
import { buildTranscriptText, formatClock, toVoiceCode, type TimelineEntry } from "./model";
import { playBase64 } from "./playback";

interface TimelinePanelProps {
  entries: TimelineEntry[];
  translationOn: boolean;
  operatorTongue: string;
  /** Caller language override ("auto" = live auto-detect); used as translate source hint + TTS fallback. */
  callerLang: string;
  ended: boolean;
}

type Rendition = { text?: string; pending: boolean; error?: string };

const SPEAKER_STYLE: Record<TimelineEntry["speaker"], string> = {
  Caller: "bg-primary-soft text-primary-dark border-primary/30",
  Operator: "bg-okbg text-ok border-ok/30",
  AI: "bg-warnbg text-warn border-warn/30",
  System: "bg-paper text-muted border-line",
};

/**
 * CENTER column: live bilingual conversation timeline.
 * Rendition policy: event-carried translations display as-is; otherwise, when
 * the per-call translation toggle is ON, the console fetches a rendition via
 * POST /api/translate into the operator tongue. Originals are always
 * preserved and shown — translation only adds a rendition, never replaces.
 */
export function TimelinePanel({ entries, translationOn, operatorTongue, callerLang, ended }: TimelinePanelProps): React.ReactElement {
  const [view, setView] = useState<"translated" | "original">("translated");
  const [query, setQuery] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [renditions, setRenditions] = useState<Record<string, Rendition>>({});
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const utterances = useMemo(() => entries.filter((e) => e.kind === "utterance"), [entries]);
  const finals = utterances;

  // Fetch missing renditions while the toggle is ON.
  useEffect(() => {
    if (!translationOn) return;
    let cancelled = false;
    const missing = finals.filter((e) => !e.translated && !renditions[e.key]);
    if (missing.length === 0) return;
    setRenditions((prev) => {
      const next = { ...prev };
      for (const e of missing) {
        if (!next[e.key]) next[e.key] = { pending: true };
      }
      return next;
    });
    void (async () => {
      for (const e of missing) {
        try {
          const source = callerLang !== "auto" && e.speaker === "Caller" ? callerLang : e.language;
          const res = await translate(e.original, operatorTongue, source);
          const text = res.data.translated_text?.trim();
          if (cancelled) return;
          setRenditions((prev) => ({ ...prev, [e.key]: { pending: false, text, error: text ? undefined : "Empty translation" } }));
        } catch (err) {
          if (cancelled) return;
          setRenditions((prev) => ({
            ...prev,
            [e.key]: { pending: false, error: err instanceof Error ? err.message : "Translation failed" },
          }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finals, translationOn, operatorTongue, callerLang]);

  const retryTranslations = (): void => {
    setRenditions((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) {
        if (next[k].error) delete next[k];
      }
      return next;
    });
  };

  // Auto-scroll: instant jump (no smooth motion) so reduced-motion is safe.
  useEffect(() => {
    if (!autoScroll || ended) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries.length, autoScroll, ended]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => {
      const r = renditions[e.key]?.text ?? e.translated ?? "";
      return e.original.toLowerCase().includes(q) || r.toLowerCase().includes(q);
    });
  }, [entries, query, renditions]);

  const translateErrors = Object.values(renditions).filter((r) => r.error && !r.text).length;
  const latestFinal = finals.length ? finals[finals.length - 1] : undefined;

  const onPlay = async (entry: TimelineEntry): Promise<void> => {
    setPlayError(null);
    setLoadingKey(entry.key);
    try {
      const rendition = renditions[entry.key]?.text ?? entry.translated;
      const text = rendition ?? entry.original;
      const lang = rendition ? operatorTongue : toVoiceCode(entry.language, operatorTongue);
      const res = await synthesize(text, lang);
      const b64 = res.data.audio_base64;
      if (!b64) throw new Error("TTS returned no audio.");
      setPlayingKey(entry.key);
      await playBase64(b64);
    } catch (err) {
      setPlayError(err instanceof Error ? err.message : "Playback failed.");
    } finally {
      setLoadingKey(null);
      setPlayingKey((k) => (k === entry.key ? null : k));
    }
  };

  const onCopy = async (): Promise<void> => {
    const text = buildTranscriptText(utterances);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section aria-label="Live bilingual conversation" className="flex min-h-0 flex-col rounded-xl2 bg-card p-4 shadow-card">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Transcript view" className="flex overflow-hidden rounded-lg border border-line">
          {(["translated", "original"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={`min-h-[40px] px-3 text-sm font-medium ${view === v ? "bg-ink text-white" : "text-muted"}`}
            >
              {v === "translated" ? "Translated" : "Original"}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search transcript…"
          aria-label="Search transcript"
          className="min-h-[40px] min-w-0 flex-1 rounded-lg border border-line bg-card px-3 text-sm text-ink"
        />
        <button
          type="button"
          onClick={() => setAutoScroll((v) => !v)}
          aria-pressed={autoScroll}
          title={ended ? "Timeline frozen — call ended" : "Follow new messages"}
          className="min-h-[40px] rounded-lg border border-line px-3 text-sm font-medium text-ink"
        >
          {autoScroll ? "❚❚ Pause" : "▶ Follow"}
        </button>
        <button
          type="button"
          onClick={() => void onCopy()}
          disabled={utterances.length === 0}
          className="min-h-[40px] rounded-lg border border-line px-3 text-sm font-medium text-ink disabled:opacity-50"
        >
          {copied ? "Copied ✓" : "Copy transcript"}
        </button>
      </div>

      {/* Degraded-mode banners: originals are always preserved. */}
      {!translationOn && (
        <div role="status" className="mt-3 rounded-lg border border-warn/30 bg-warnbg px-3 py-2 text-sm text-warn">
          Translation paused — showing original utterances. Resume it from the call controls below.
        </div>
      )}
      {translationOn && translateErrors > 0 && (
        <div role="alert" className="mt-3 rounded-lg border border-danger/30 bg-dangerbg px-3 py-2 text-sm text-danger">
          Translation service errored on {translateErrors} utterance(s) — originals preserved.{" "}
          <button type="button" onClick={retryTranslations} className="font-semibold underline">
            Retry
          </button>
        </div>
      )}

      {/* Polite announcer for new finals (screen readers). */}
      <div aria-live="polite" className="sr-only">
        {latestFinal ? `New ${latestFinal.speaker} message: ${latestFinal.original}` : ""}
      </div>

      {/* Timeline */}
      <div ref={scrollRef} role="log" aria-label="Conversation timeline" className="mt-3 max-h-[60vh] min-h-40 flex-1 overflow-y-auto pr-1 lg:max-h-none">
        {filtered.length === 0 && (
          <p className="py-8 text-center text-sm text-muted">
            {entries.length === 0 ? "No utterances yet — live finals appear here." : "No entries match the search."}
          </p>
        )}
        <ol className="flex flex-col gap-2">
          {filtered.map((e) =>
            e.kind === "system" ? (
              <li key={e.key} className="flex justify-center">
                <p className="rounded-full border border-line bg-paper px-3 py-1 text-center text-xs text-muted">
                  {e.original}
                  <span className="ml-1 text-faint">{formatClock(e.at)}</span>
                </p>
              </li>
            ) : (
              <li key={e.key} className="rounded-lg border border-line p-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${SPEAKER_STYLE[e.speaker]}`}>
                    {e.speaker}
                  </span>
                  {e.opLeg && (
                    <span className="rounded-full border border-line bg-paper px-2 py-0.5 text-xs text-muted" title="Attached via the operator-leg timing heuristic">
                      operator leg
                    </span>
                  )}
                  {e.language && <span className="text-xs text-muted">{e.language}</span>}
                  {typeof e.confidence === "number" && (
                    <span className="text-xs text-faint">{Math.round(e.confidence * 100)}%</span>
                  )}
                  <span className="ml-auto text-xs text-faint">{formatClock(e.at)}</span>
                </div>
                {(() => {
                  const rendition = renditions[e.key]?.text ?? e.translated;
                  const pending = !!renditions[e.key]?.pending;
                  const primary = view === "translated" ? (rendition ?? e.original) : e.original;
                  const secondary = view === "translated" ? (rendition ? e.original : undefined) : (rendition ?? undefined);
                  return (
                    <div className="mt-1.5">
                      <p className="text-sm text-ink">{primary}</p>
                      {view === "translated" && !rendition && translationOn && (
                        <p className="mt-0.5 text-xs italic text-muted" aria-label="Translation in progress">
                          {pending ? "Translating…" : "No rendition yet — original shown."}
                        </p>
                      )}
                      {secondary && <p className="mt-1 border-l-2 border-line pl-2 text-xs text-muted">{secondary}</p>}
                    </div>
                  );
                })()}
                <div className="mt-1.5">
                  <button
                    type="button"
                    onClick={() => void onPlay(e)}
                    disabled={loadingKey === e.key}
                    aria-label={`Play utterance from ${e.speaker} at ${formatClock(e.at)}`}
                    className="min-h-[36px] rounded-md border border-line px-2.5 text-xs font-medium text-ink disabled:opacity-50"
                  >
                    {loadingKey === e.key ? "Synthesizing…" : playingKey === e.key ? "Playing… ◉" : "▶ Play"}
                  </button>
                </div>
              </li>
            ),
          )}
        </ol>
      </div>

      {playError && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {playError}
        </p>
      )}
      <p className="mt-2 text-xs text-faint">
        {utterances.length} utterance(s). Caller finals drive incidents; operator finals translate toward the caller
        tongue and never create incidents.
      </p>
    </section>
  );
}
