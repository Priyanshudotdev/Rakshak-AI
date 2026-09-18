"use client";

import type { LiveEvent } from "../lib/live";
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
      </CardBody>
    </Card>
  );
}
