import { describe, expect, it } from "vitest";
import { summarizeVerification } from "./verification";
import type { LiveEvent } from "./live";

function evt(name: string, callId: string, payload: Record<string, unknown>): LiveEvent {
  return { name, callId, at: new Date().toISOString(), payload };
}

describe("summarizeVerification", () => {
  it("defaults to unverified with no evidence", () => {
    expect(summarizeVerification([], "CALL-1")).toEqual({ status: "unverified", reports: 0, evidence: [] });
  });

  it("collects explanation evidence with scores", () => {
    const s = summarizeVerification(
      [
        evt("ai.explanation.updated", "CALL-1", {
          report_id: "SRC-1",
          report_source: "rss",
          report_title: "Fire downtown",
          correlation_score: 0.65,
          signals: ["location-match"],
          verification: "multiple_reports",
          corroborating_reports: 2,
        }),
      ],
      "CALL-1",
    );
    expect(s.status).toBe("multiple_reports");
    expect(s.reports).toBe(2);
    expect(s.evidence).toHaveLength(1);
    expect(s.evidence[0].correlation_score).toBe(0.65);
  });

  it("lets incident.updated override the status", () => {
    const s = summarizeVerification(
      [
        evt("ai.explanation.updated", "CALL-1", { report_id: "SRC-1", verification: "multiple_reports", corroborating_reports: 2 }),
        evt("incident.updated", "CALL-1", { verification: "corroborated", corroborating_reports: 4 }),
      ],
      "CALL-1",
    );
    expect(s.status).toBe("corroborated");
    expect(s.reports).toBe(4);
  });

  it("dedupes repeat evidence by report, keeping the best score", () => {
    const s = summarizeVerification(
      [
        evt("ai.explanation.updated", "CALL-1", { report_id: "SRC-1", correlation_score: 0.6 }),
        evt("ai.explanation.updated", "CALL-1", { report_id: "SRC-1", correlation_score: 0.8, signals: ["type:fire"] }),
      ],
      "CALL-1",
    );
    expect(s.evidence).toHaveLength(1);
    expect(s.evidence[0].correlation_score).toBe(0.8);
  });

  it("ignores other calls and unrelated events", () => {
    const s = summarizeVerification(
      [
        evt("ai.explanation.updated", "CALL-OTHER", { report_id: "SRC-9", verification: "corroborated" }),
        evt("transcript.partial", "CALL-1", { original_text: "hello" }),
      ],
      "CALL-1",
    );
    expect(s).toEqual({ status: "unverified", reports: 0, evidence: [] });
  });
});
