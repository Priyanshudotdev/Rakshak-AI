import { describe, expect, it, vi } from "vitest";
import {
  buildFinalPayload,
  buildPartialPayload,
  isPublishableText,
  normalizeLanguage,
  normalizeRole,
  normalizeText,
  PARTIAL_MIN_INTERVAL_MS,
  PartialThrottle,
} from "./transcripts.js";

describe("transcript payload builders", () => {
  it("partial always carries original_text, language fallback and role", () => {
    expect(buildPartialPayload("aag lagli", "mr-IN", "caller")).toEqual({
      original_text: "aag lagli",
      language: "mr-IN",
      role: "caller",
    });
    // Language falls back to "Unknown"; role defaults to caller.
    expect(buildPartialPayload("hello", undefined, undefined)).toEqual({
      original_text: "hello",
      language: "Unknown",
      role: "caller",
    });
    expect(buildPartialPayload("hello", "  ", "operator")).toMatchObject({
      language: "Unknown",
      role: "operator",
    });
    // original_text is never undefined — non-strings coerce to "".
    expect(buildPartialPayload(undefined, "hi-IN", "caller").original_text).toBe("");
    expect(buildPartialPayload(42, "hi-IN", "caller").original_text).toBe("");
  });

  it("final carries confidence only when it is a finite number", () => {
    expect(buildFinalPayload("t", "mr-IN", "caller", 0.9)).toMatchObject({
      original_text: "t",
      language: "mr-IN",
      role: "caller",
      confidence: 0.9,
    });
    expect(buildFinalPayload("t", "mr-IN", "operator", undefined)).not.toHaveProperty("confidence");
    expect(buildFinalPayload("t", "mr-IN", "caller", "high")).not.toHaveProperty("confidence");
    expect(buildFinalPayload("t", "mr-IN", "caller", Number.NaN)).not.toHaveProperty("confidence");
  });

  it("normalizers fall back sanely", () => {
    expect(normalizeLanguage(" hi-IN ")).toBe("hi-IN");
    expect(normalizeLanguage("")).toBe("Unknown");
    expect(normalizeLanguage(undefined)).toBe("Unknown");
    expect(normalizeRole("operator")).toBe("operator");
    expect(normalizeRole("caller")).toBe("caller");
    expect(normalizeRole("weird")).toBe("caller");
    expect(normalizeRole(undefined)).toBe("caller");
    expect(normalizeText("x")).toBe("x");
    expect(normalizeText(undefined)).toBe("");
    expect(isPublishableText("  hello ")).toBe(true);
    expect(isPublishableText("   ")).toBe(false);
    expect(isPublishableText("")).toBe(false);
    expect(isPublishableText(undefined)).toBe(false);
  });

  it("exposes the ~5/s throttle interval", () => {
    expect(PARTIAL_MIN_INTERVAL_MS).toBe(200);
  });
});

describe("PartialThrottle", () => {
  it("sends the leading edge then coalesces faster-than-5/s frames", () => {
    let now = 1_000;
    const throttle = new PartialThrottle(200, () => now);
    expect(throttle.shouldSend("CALL-A")).toBe(true);
    // 10 rapid frames inside the window all coalesce.
    for (let i = 0; i < 10; i++) {
      expect(throttle.shouldSend("CALL-A")).toBe(false);
    }
    now += 199;
    expect(throttle.shouldSend("CALL-A")).toBe(false);
    now += 1;
    expect(throttle.shouldSend("CALL-A")).toBe(true);
  });

  it("throttles per callId independently", () => {
    let now = 5_000;
    const throttle = new PartialThrottle(200, () => now);
    expect(throttle.shouldSend("CALL-A")).toBe(true);
    expect(throttle.shouldSend("CALL-B")).toBe(true);
    expect(throttle.shouldSend("CALL-A")).toBe(false);
    expect(throttle.shouldSend("CALL-B")).toBe(false);
  });

  it("reset re-arms the next partial immediately (used after finals)", () => {
    let now = 9_000;
    const throttle = new PartialThrottle(200, () => now);
    expect(throttle.shouldSend("CALL-A")).toBe(true);
    expect(throttle.shouldSend("CALL-A")).toBe(false);
    throttle.reset("CALL-A");
    expect(throttle.shouldSend("CALL-A")).toBe(true);
  });

  it("markSent records a send without a check", () => {
    let now = 11_000;
    const throttle = new PartialThrottle(200, () => now);
    throttle.markSent("CALL-A");
    expect(throttle.shouldSend("CALL-A")).toBe(false);
    now += 200;
    expect(throttle.shouldSend("CALL-A")).toBe(true);
  });

  it("supports injectable clocks (vi.fn)", () => {
    const nowFn = vi.fn(() => 100);
    const throttle = new PartialThrottle(200, nowFn);
    expect(throttle.shouldSend("C")).toBe(true);
    expect(nowFn).toHaveBeenCalled();
  });
});
