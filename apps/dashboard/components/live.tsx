"use client";

import type { LiveEvent } from "../lib/live";
import { bilingualTranscripts, groupTranscriptsByCall, operatorWaitingState } from "../lib/live";
import { Badge, Card, CardBody, CardHead, EmptyState } from "./ui";

const TONE: Record<string, "neutral" | "info" | "ok" | "warn" | "bad"> = {
  "call.started": "info",
  "call.answered": "info",
  "call.ended": "neutral",
  "speech.started": "warn",
  "transcript.partial": "warn",
  "transcript.final": "ok",
  "incident.created": "bad",
  "incident.updated": "bad",
  "priority.updated": "bad",
};

export interface LiveFeed {
  connected: boolean;
  events: LiveEvent[];
  lastPartial: string | null;
}

/** Waiting-room banner: a policeman is holding with no live caller. Shows on
 *  `operator.waiting`, clears on `operator.joined` / `call.ended` (see
 *  operatorWaitingState). */
export function WaitingRoomBanner({ events }: { events: LiveEvent[] }) {
  const state = operatorWaitingState(events);
  if (!state.waiting) return null;
  return (
    <div
      role="status"
      className="mb-3 rounded-md2 border border-priomed/40 bg-priomed/10 p-2.5"
    >
      <p className="text-sm text-cream">
        Operator holding — no live caller{state.operatorId ? ` · ${state.operatorId}` : ""}
      </p>
    </div>
  );
}

/** Bilingual transcript view: `transcript.final` utterances grouped by call,
 *  each with a language badge (fallback "Unknown") and a caller/operator role
 *  badge. Capped at the last 30 utterances for perf. */
export function BilingualTranscriptList({ events }: { events: LiveEvent[] }) {
  const groups = groupTranscriptsByCall(bilingualTranscripts(events, 30));
  if (!groups.length) {
    return <p className="mt-3 text-xs text-muted">No bilingual transcript yet — live caller/operator utterances appear here.</p>;
  }
  return (
    <div className="mt-3 space-y-3">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted">
        Bilingual transcript · last 30
      </p>
      {groups.map((g) => (
        <div key={g.callId}>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="truncate font-mono text-xs text-muted">{g.callId}</span>
            <Badge tone="neutral">{g.utterances.length}</Badge>
          </div>
          <ul className="space-y-1.5">
            {g.utterances.map((u, i) => {
              const isOp = u.role === "operator";
              return (
                <li
                  key={`${u.at}-${i}`}
                  className={`rounded-md2 border px-2 py-1.5 text-xs ${
                    isOp ? "border-accent/40 bg-accent/5" : "border-line/70 bg-ink"
                  }`}
                >
                  <div className="mb-1 flex flex-wrap items-center gap-1.5">
                    <Badge tone={isOp ? "ok" : "info"}>{u.role}</Badge>
                    <Badge tone="neutral">{u.language}</Badge>
                    <span className="ml-auto shrink-0 font-mono text-muted">
                      {u.at.slice(11, 19)}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap text-sm text-cream">{u.text || "—"}</p>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function LivePanel({ feed }: { feed: LiveFeed }) {
  const { connected, events, lastPartial } = feed;
  return (
    <Card>
      <CardHead
        title="Live wire"
        sub="WebSocket event stream · polling keeps panels fresh if it drops"
        right={
          <Badge tone={connected ? "ok" : "bad"}>
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${connected ? "bg-priolow" : "bg-priohigh"}`} />
            {connected ? "live" : "reconnecting"}
          </Badge>
        }
      />
      <CardBody>
        <WaitingRoomBanner events={events} />
        {lastPartial ? (
          <div className="mb-3 rounded-md2 border border-priomed/40 bg-priomed/10 p-2.5">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-[#f0c94e]">Hearing now (partial)</p>
            <p className="text-sm text-cream">{lastPartial}</p>
          </div>
        ) : null}
        {!events.length ? (
          <EmptyState title="No live events yet" sub="Analyze a call or connect the media gateway to see the stream." />
        ) : (
          <ul className="max-h-[260px] space-y-1.5 overflow-y-auto pr-1">
            {events.slice(0, 15).map((e, i) => (
              <li key={`${e.at}-${i}`} className="flex items-center gap-2 rounded-md2 border border-line/70 bg-ink px-2 py-1.5 text-xs">
                <Badge tone={TONE[e.name] ?? "neutral"}>{e.name}</Badge>
                <span className="truncate font-mono text-muted">{e.callId}</span>
                <span className="ml-auto shrink-0 font-mono text-muted">
                  {e.at.slice(11, 19)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <BilingualTranscriptList events={events} />
      </CardBody>
    </Card>
  );
}
