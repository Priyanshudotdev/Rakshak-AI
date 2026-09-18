import { describe, expect, it } from "vitest";
import {
  applyHelloBackfill,
  backoffDelay,
  bilingualTranscripts,
  dedupeLiveEvents,
  groupTranscriptsByCall,
  liveEventKey,
  mergeLiveEvents,
  partialTextOf,
  type LiveEvent,
} from "./live";

function evt(
  name: string,
  callId: string,
  at: string,
  payload: Record<string, unknown> = {},
): LiveEvent {
  return { name, callId, at, payload };
}

const T0 = "2026-09-18T10:00:00.000Z";
const T1 = "2026-09-18T10:00:01.000Z";
const T2 = "2026-09-18T10:00:02.000Z";

describe("backoffDelay", () => {
  it("backs off 1s, 2s, 4s … capped at 15s", () => {
    expect(backoffDelay(0)).toBe(1000);
    expect(backoffDelay(1)).toBe(2000);
    expect(backoffDelay(2)).toBe(4000);
    expect(backoffDelay(3)).toBe(8000);
    expect(backoffDelay(4)).toBe(15_000);
    expect(backoffDelay(10)).toBe(15_000);
  });

  it("clamps garbage attempts to the base delay", () => {
    expect(backoffDelay(-3)).toBe(1000);
    expect(backoffDelay(Number.NaN)).toBe(1000);
  });
});

describe("liveEventKey / dedupeLiveEvents", () => {
  it("keys by callId+at+text (name included)", () => {
    const a = evt("transcript.final", "CALL-1", T0, { original_text: "hi" });
    const b = evt("transcript.final", "CALL-1", T0, { original_text: "hi" });
    const c = evt("transcript.final", "CALL-1", T0, { original_text: "bye" });
    expect(liveEventKey(a)).toBe(liveEventKey(b));
    expect(liveEventKey(a)).not.toBe(liveEventKey(c));
  });

  it("drops duplicates keeping first occurrence and order", () => {
    const a = evt("transcript.final", "CALL-1", T0, { original_text: "hi" });
    const dup = evt("transcript.final", "CALL-1", T0, { original_text: "hi" });
    const b = evt("transcript.final", "CALL-1", T1, { original_text: "hi" });
    expect(dedupeLiveEvents([a, dup, b])).toEqual([a, b]);
  });
});

describe("mergeLiveEvents (partials stream while speaking)", () => {
  it("prepends live frames newest-first, dedupes and caps", () => {
    const prev = [evt("transcript.final", "CALL-1", T0, { original_text: "first" })];
    const live = evt("transcript.partial", "CALL-1", T1, { original_text: "hearing…" });
    const merged = mergeLiveEvents(prev, live);
    expect(merged[0]).toMatchObject({ name: "transcript.partial" });
    expect(merged).toHaveLength(2);
    // Re-delivery of the same frame does not duplicate.
    expect(mergeLiveEvents(merged, live)).toHaveLength(2);
  });

  it("caps the feed (default 30)", () => {
    const prev = Array.from({ length: 30 }, (_, i) =>
      evt("transcript.final", `CALL-${i}`, T0, { original_text: `u${i}` }),
    );
    const merged = mergeLiveEvents(prev, evt("transcript.final", "CALL-NEW", T2, { original_text: "new" }));
    expect(merged).toHaveLength(30);
    expect(merged[0].callId).toBe("CALL-NEW");
  });
});

describe("applyHelloBackfill (reconnect without losing/duplicating history)", () => {
  it("merges recent[] with live-appended events, no duplicates, newest-first", () => {
    const liveA = evt("transcript.final", "CALL-1", T0, { original_text: "a" });
    const prev = [liveA];
    const recent = [
      evt("transcript.final", "CALL-1", T1, { original_text: "missed-while-down" }),
      evt("transcript.final", "CALL-1", T0, { original_text: "a" }),
    ];
    const merged = applyHelloBackfill(prev, recent);
    // Missed frame slots into front (newest-first), duplicate "a" appears once.
    expect(merged.map((e) => (e.payload as Record<string, string>).original_text)).toEqual([
      "missed-while-down",
      "a",
    ]);
  });

  it("keeps live events when the backfill is empty and caps", () => {
    const prev = [evt("transcript.final", "CALL-1", T0, { original_text: "a" })];
    expect(applyHelloBackfill(prev, [])).toEqual(prev);
    expect(applyHelloBackfill(prev, undefined)).toEqual(prev);
  });
});

describe("partialTextOf", () => {
  it("extracts partial text only from transcript.partial frames", () => {
    expect(partialTextOf(evt("transcript.partial", "C", T0, { original_text: "half…" }))).toBe("half…");
    expect(partialTextOf(evt("transcript.partial", "C", T0, {}))).toBeNull();
    expect(partialTextOf(evt("transcript.final", "C", T0, { original_text: "done" }))).toBeNull();
  });
});

describe("final grouping (newest-first, capped, by call)", () => {
  it("groups finals by call preserving newest-first call order", () => {
    const events = [
      evt("transcript.final", "CALL-2", T2, { original_text: "b", language: "hi-IN", role: "caller" }),
      evt("transcript.final", "CALL-1", T1, { original_text: "a", language: "mr-IN", role: "operator" }),
    ];
    const groups = groupTranscriptsByCall(bilingualTranscripts(events, 30));
    expect(groups.map((g) => g.callId)).toEqual(["CALL-2", "CALL-1"]);
    expect(groups[0].utterances[0]).toMatchObject({ role: "caller", language: "hi-IN" });
  });
});
