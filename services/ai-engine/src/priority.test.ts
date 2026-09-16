import { describe, expect, it } from "vitest";
import { applyPriorityOverlay } from "./priority.js";

const ARMED = {
  weapon_mentioned: { is_weapon_present: true },
  immediate_danger: { is_immediate_danger: true, risk_level: 9 },
  distress_indicators: { caller_state: "calm" },
  incident_type: { primary: "Theft" },
};

const CALM = {
  weapon_mentioned: { is_weapon_present: false },
  immediate_danger: { is_immediate_danger: false, risk_level: 2 },
  distress_indicators: { caller_state: "calm" },
  incident_type: { primary: "Theft" },
};

describe("applyPriorityOverlay", () => {
  it("never lets the LLM lower a HIGH rule floor", () => {
    const p = applyPriorityOverlay(ARMED, {
      priority_level: "LOW",
      confidence: 0.9,
      decision_factors: ["looks fine"],
    });
    expect(p.level).toBe("HIGH");
    expect(p.rule_floor).toBe("HIGH");
  });

  it("lets the LLM raise above the rule floor", () => {
    const p = applyPriorityOverlay(CALM, { priority_level: "HIGH", confidence: 0.8 });
    expect(p.level).toBe("HIGH");
    expect(p.rule_floor).toBe("LOW");
  });

  it("defaults a calm report to LOW without LLM input", () => {
    const p = applyPriorityOverlay(CALM, null);
    expect(p.level).toBe("LOW");
    expect(p.time_critical).toBe(false);
    expect(p.decision_factors).toContain("no immediate threat indicators");
  });

  it("clamps confidence into 0..1", () => {
    const p = applyPriorityOverlay(CALM, { priority_level: "LOW", confidence: 5 });
    expect(p.confidence).toBeLessThanOrEqual(1);
    expect(p.confidence).toBeGreaterThanOrEqual(0);
  });

  it("marks HIGH as time-critical by default", () => {
    const p = applyPriorityOverlay(ARMED, null);
    expect(p.time_critical).toBe(true);
    expect(p.recommended_response).toMatch(/police/i);
  });
});
