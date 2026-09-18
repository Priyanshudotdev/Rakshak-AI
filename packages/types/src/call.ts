// Shared Rakshak domain types — consumed by api, gateway, ai-engine, dashboard.
// Original transcript is always preserved alongside translations (spec §16).

export type VerificationStatus =
  | "unverified"
  | "multiple_reports"
  | "corroborated"
  | "officially_confirmed";

export interface CallSession {
  callId: string;
  asteriskChannelId?: string;
  from?: string;
  to?: string;
  startedAt: string;
  status: "started" | "answered" | "ended";
}
