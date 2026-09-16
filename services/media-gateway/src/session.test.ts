import { describe, expect, it } from "vitest";
import { SessionManager } from "./session.js";

describe("SessionManager", () => {
  it("starts idempotently: same call id returns one session", () => {
    const mgr = new SessionManager();
    mgr.start("CALL-A", "1000", "1001");
    mgr.start("CALL-A");
    expect(mgr.size).toBe(1);
    expect(mgr.get("CALL-A")?.from).toBe("1000");
  });

  it("refuses new sessions at capacity", () => {
    const mgr = new SessionManager(1);
    mgr.start("CALL-A");
    expect(() => mgr.start("CALL-B")).toThrow(/capacity/);
  });

  it("applies backpressure when the buffer is full", () => {
    const mgr = new SessionManager(10, 8);
    mgr.start("CALL-A");
    expect(mgr.pushAudio("CALL-A", Buffer.alloc(5))).toBe(true);
    expect(mgr.pushAudio("CALL-A", Buffer.alloc(5))).toBe(false);
    expect(mgr.pushAudio("CALL-UNKNOWN", Buffer.alloc(1))).toBe(false);
  });

  it("drains the buffer and re-arms for the next utterance", () => {
    const mgr = new SessionManager();
    mgr.start("CALL-A");
    mgr.pushAudio("CALL-A", Buffer.from([1, 2, 3]));
    const first = mgr.takeAudio("CALL-A");
    expect(first?.bytes.length).toBe(3);
    expect(first?.session.utterances).toBe(1);
    expect(mgr.takeAudio("CALL-A")).toBeNull();
    expect(mgr.pushAudio("CALL-A", Buffer.from([9]))).toBe(true);
    expect(mgr.takeAudio("CALL-A")?.bytes.length).toBe(1);
  });

  it("sweeps only idle sessions", async () => {
    const mgr = new SessionManager();
    mgr.start("CALL-IDLE");
    await new Promise((r) => setTimeout(r, 15));
    mgr.start("CALL-FRESH");
    const idle = mgr.sweepIdle(5);
    expect(idle.map((s) => s.callId)).toEqual(["CALL-IDLE"]);
    expect(mgr.get("CALL-FRESH")?.callId).toBe("CALL-FRESH");
  });

  it("tracks barge-in only for live sessions", () => {
    const mgr = new SessionManager();
    expect(mgr.stopTts("CALL-GHOST")).toBe(false);
    mgr.start("CALL-A");
    expect(mgr.stopTts("CALL-A")).toBe(true);
    expect(mgr.get("CALL-A")?.ttsStopped).toBe(true);
  });

  it("ends and forgets sessions", () => {
    const mgr = new SessionManager();
    mgr.start("CALL-A");
    expect(mgr.end("CALL-A")?.callId).toBe("CALL-A");
    expect(mgr.end("CALL-A")).toBeUndefined();
    expect(mgr.size).toBe(0);
  });
});
