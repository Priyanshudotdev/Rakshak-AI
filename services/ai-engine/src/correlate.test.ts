import { describe, expect, it } from "vitest";
import { correlationScore, isCandidate } from "./correlate.js";

const FIRE = {
  text: "Fire in Manish Nagar, two people trapped",
  location: "Manish Nagar",
  time: "2026-09-16T10:00:00.000Z",
  incidentType: "Fire",
  weapon: null,
};

describe("correlationScore", () => {
  it("scores identical reports as a strong match", () => {
    const r = correlationScore(FIRE, { ...FIRE, time: "2026-09-16T10:05:00.000Z" });
    expect(r.score).toBeGreaterThanOrEqual(0.75);
    expect(r.signals).toContain("location-match");
    expect(isCandidate(r)).toBe(true);
  });

  it("rejects unrelated reports", () => {
    const r = correlationScore(FIRE, {
      text: "Cricket tournament concludes peacefully downtown",
      location: "Sadar",
      time: "2026-09-10T10:00:00.000Z",
      incidentType: "Unknown",
    });
    expect(r.score).toBeLessThan(0.55);
    expect(isCandidate(r)).toBe(false);
  });

  it("scores empty input as zero without crashing", () => {
    const r = correlationScore({ text: "" }, { text: "" });
    expect(r.score).toBe(0);
    expect(r.signals).toEqual([]);
  });

  it("decays the temporal signal beyond six hours", () => {
    const near = correlationScore(
      { text: "fire nagar", time: "2026-09-16T10:00:00.000Z" },
      { text: "fire nagar", time: "2026-09-16T11:00:00.000Z" },
    );
    const far = correlationScore(
      { text: "fire nagar", time: "2026-09-16T10:00:00.000Z" },
      { text: "fire nagar", time: "2026-09-17T10:00:00.000Z" },
    );
    expect(far.score).toBeLessThan(near.score);
  });

  it("matches locations on containment, not only equality", () => {
    const r = correlationScore(
      { text: "fire nagar", location: "Near Manish Nagar market" },
      { text: "fire nagar", location: "manish nagar" },
    );
    expect(r.signals).toContain("location-match");
  });

  it("holds the 0.55 candidate threshold", () => {
    expect(isCandidate({ score: 0.55, signals: [] })).toBe(true);
    expect(isCandidate({ score: 0.549, signals: [] })).toBe(false);
  });

  it("adds a geo-near signal for coordinates within 25 km", () => {
    // Sitabuldi ↔ Dharampeth are ~2 km apart in Nagpur.
    const r = correlationScore(
      { text: "fire", lat: 21.1495, lon: 79.0800 },
      { text: "fire", lat: 21.1390, lon: 79.0700 },
    );
    expect(r.signals.some((s) => s.startsWith("geo-near:"))).toBe(true);
    // Nagpur ↔ Mumbai (~840 km) earns nothing.
    const far = correlationScore(
      { text: "fire", lat: 21.1495, lon: 79.0800 },
      { text: "fire", lat: 19.0760, lon: 72.8777 },
    );
    expect(far.signals.some((s) => s.startsWith("geo-near:"))).toBe(false);
  });

  it("ignores missing coordinates without crashing", () => {
    const r = correlationScore({ text: "fire", lat: null }, { text: "fire" });
    expect(r.signals.some((s) => s.startsWith("geo-near:"))).toBe(false);
  });
});
