// Realtime event names (spec §13). Critical path streams; secondary path queues.
export const RakshakEvents = [
  "call.started",
  "call.answered",
  "operator.waiting",
  "operator.joined",
  "speech.started",
  "transcript.partial",
  "transcript.final",
  "language.detected",
  "translation.updated",
  "translation.toggled",
  "translation.suggested",
  "incident.created",
  "incident.updated",
  "location.updated",
  "priority.updated",
  "ai.explanation.updated",
  "call.ended",
] as const;

export type RakshakEventName = (typeof RakshakEvents)[number];

export interface RakshakEvent<T = unknown> {
  name: RakshakEventName;
  callId: string;
  at: string;
  payload: T;
}
