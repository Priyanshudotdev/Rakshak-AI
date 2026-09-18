import { describe, expect, it } from "vitest";
import {
  bilingualTranscripts,
  groupTranscriptsByCall,
  isOperatorWaiting,
  operatorWaitingState,
  translationToggleHistory,
} from "./live";
import type { LiveEvent } from "./live";

function evt(name: string, callId: string, payload: Record<string, unknown> = {}): LiveEvent {
  return { name, callId, at: new Date().toISOString(), payload };
}

describe("bilingualTranscripts", () => {
  it("maps language + role per utterance, falling back to Unknown", () => {
    const events = [
      evt("transcript.final", "CALL-1", { original_text: "madad chahiye", language: "hi-IN", role: "caller" }),
      evt("transcript.final", "CALL-1", { original_text: "help is coming", role: "operator" }),
      evt("transcript.partial", "CALL-1", { original_text: "half…" }),
    ];
    const out = bilingualTranscripts(events);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ callId: "CALL-1", language: "hi-IN", role: "caller" });
    // Missing language falls back to "Unknown"; missing role defaults to caller.
    expect(out[1]).toMatchObject({ language: "Unknown", role: "operator" });
  });

  it("caps the list at 30 utterances", () => {
    const events = Array.from({ length: 40 }, (_, i) =>
      evt("transcript.final", `CALL-${i}`, { original_text: `u${i}`, language: "hi-IN", role: "caller" }),
    );
    expect(bilingualTranscripts(events)).toHaveLength(30);
  });
});

describe("groupTranscriptsByCall", () => {
  it("groups utterances by call, preserving first-seen order", () => {
    const groups = groupTranscriptsByCall(
      bilingualTranscripts([
        evt("transcript.final", "CALL-2", { original_text: "b", language: "hi-IN", role: "caller" }),
        evt("transcript.final", "CALL-1", { original_text: "a", language: "mr-IN", role: "operator" }),
        evt("transcript.final", "CALL-2", { original_text: "c", role: "caller" }),
      ]),
    );
    expect(groups.map((g) => g.callId)).toEqual(["CALL-2", "CALL-1"]);
    expect(groups[0].utterances).toHaveLength(2);
    expect(groups[1].utterances[0]).toMatchObject({ role: "operator", language: "mr-IN" });
  });
});

describe("operatorWaitingState", () => {
  it("shows waiting on operator.waiting with no live call", () => {
    const s = operatorWaitingState([evt("operator.waiting", "", { operator_id: "OP-1" })]);
    expect(s).toMatchObject({ waiting: true, operatorId: "OP-1" });
    expect(isOperatorWaiting([evt("operator.waiting", "", { operator_id: "OP-1" })])).toBe(true);
  });

  it("clears on operator.joined", () => {
    const events = [
      evt("operator.joined", "CALL-1", { call_id: "CALL-1", operator_id: "OP-1" }),
      evt("operator.waiting", "", { operator_id: "OP-1" }),
    ];
    expect(isOperatorWaiting(events)).toBe(false);
  });

  it("clears on call.ended", () => {
    const events = [evt("call.ended", "CALL-1", {}), evt("operator.waiting", "", { operator_id: "OP-1" })];
    expect(isOperatorWaiting(events)).toBe(false);
  });

  it("clears on fresh live-caller activity", () => {
    const events = [
      evt("transcript.final", "CALL-9", { original_text: "hello", language: "hi-IN", role: "caller" }),
      evt("operator.waiting", "", { operator_id: "OP-1" }),
    ];
    expect(isOperatorWaiting(events)).toBe(false);
  });

  it("is not waiting with no events", () => {
    expect(isOperatorWaiting([])).toBe(false);
  });
});

describe("translationToggleHistory", () => {
  it("returns toggles for one call, newest-first", () => {
    const events = [
      evt("translation.toggled", "CALL-1", { call_id: "CALL-1", enabled: true, by: "op1" }),
      evt("transcript.final", "CALL-1", { original_text: "hi" }),
      evt("translation.toggled", "CALL-1", { call_id: "CALL-1", enabled: false, by: "op1" }),
      evt("translation.toggled", "CALL-2", { call_id: "CALL-2", enabled: true, by: "op2" }),
    ];
    const h = translationToggleHistory(events, "CALL-1");
    expect(h).toHaveLength(2);
    expect(h[0]).toMatchObject({ callId: "CALL-1", enabled: true, by: "op1" });
    expect(h[1]).toMatchObject({ enabled: false });
  });
});
