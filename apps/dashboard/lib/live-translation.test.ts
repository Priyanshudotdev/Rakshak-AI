import { describe, expect, it } from "vitest";
import { activeLiveCallId, shouldShowTranslationNudge, translationSuggestionForCall } from "./live";
import type { LiveEvent } from "./live";

function evt(name: string, callId: string, payload: Record<string, unknown> = {}): LiveEvent {
  return { name, callId, at: new Date().toISOString(), payload };
}

describe("activeLiveCallId", () => {
  it("returns null with no transcript.final", () => {
    expect(activeLiveCallId([])).toBeNull();
    expect(activeLiveCallId([evt("transcript.partial", "CALL-1")])).toBeNull();
  });

  it("returns the newest transcript.final call (feed is newest-first)", () => {
    const events = [evt("transcript.final", "CALL-2"), evt("transcript.final", "CALL-1")];
    expect(activeLiveCallId(events)).toBe("CALL-2");
  });
});

describe("translationSuggestionForCall", () => {
  it("returns null without an active call or matching event", () => {
    expect(translationSuggestionForCall([], null)).toBeNull();
    expect(translationSuggestionForCall([evt("transcript.final", "CALL-1")], "CALL-1")).toBeNull();
  });

  it("picks the suggestion for the active call only", () => {
    const events = [
      evt("translation.suggested", "CALL-1", { caller_language: "ta-IN", operator_id: "op1" }),
      evt("transcript.final", "CALL-1", { original_text: "help" }),
      evt("translation.suggested", "CALL-OTHER", { caller_language: "bn-IN" }),
    ];
    const s = translationSuggestionForCall(events, "CALL-1");
    expect(s).toMatchObject({ callId: "CALL-1", callerLanguage: "ta-IN", operatorId: "op1" });
    expect(translationSuggestionForCall(events, "CALL-OTHER")?.callerLanguage).toBe("bn-IN");
    expect(translationSuggestionForCall(events, "CALL-MISSING")).toBeNull();
  });
});

describe("shouldShowTranslationNudge", () => {
  it("shows only when suggestion exists and toggle is OFF", () => {
    const events = [
      evt("translation.suggested", "CALL-1", { caller_language: "hi-IN" }),
      evt("transcript.final", "CALL-1", {}),
    ];
    expect(shouldShowTranslationNudge(events, "CALL-1", false)).toBe(true);
    expect(shouldShowTranslationNudge(events, "CALL-1", true)).toBe(false);
    expect(shouldShowTranslationNudge([evt("transcript.final", "CALL-1")], "CALL-1", false)).toBe(false);
  });
});
