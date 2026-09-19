import { describe, expect, it } from "vitest";
import { fallbackExtract } from "./fallback.js";

describe("fallbackExtract", () => {
  it("detects Devanagari fire keywords and Nagpur areas", () => {
    const e = fallbackExtract("Manish Nagar madhe आग lagli aahe", "");
    expect(e.incident_type.primary).toBe("Fire");
    expect(e.location.area).toBe("Manish Nagar");
  });

  it("flags an explicitly mentioned knife", () => {
    const e = fallbackExtract("he has a knife, chakoo dikh raha hai", "");
    expect(e.weapon_mentioned.is_weapon_present).toBe(true);
    expect(e.weapon_mentioned.weapon_type).toBe("knife");
    expect(e.immediate_danger.is_immediate_danger).toBe(true);
  });

  it("stays Unknown on empty input instead of inventing", () => {
    const e = fallbackExtract("", "");
    expect(e.incident_type.primary).toBe("Unknown");
    expect(e.location.area).toBe("Not identified");
    expect(e.weapon_mentioned.is_weapon_present).toBe(false);
  });

  it("infers female caller from husband phrasing", () => {
    const e = fallbackExtract("my husband beats me every night", "");
    expect(e.caller_gender).toBe("Female");
  });

  it("never marks past incidents as immediate danger", () => {
    const e = fallbackExtract("kal raat chori hui thi, report दर्ज karni hai", "");
    expect(e.immediate_danger.is_immediate_danger).toBe(false);
  });

  it("detects romanized Marathi fire report", () => {
    const e = fallbackExtract("Aag lagli aahe, ek kamgar adakla aahe", "");
    expect(e.incident_type.primary).toBe("Fire");
  });

  it("does not match romanized keywords inside other words", () => {
    expect(fallbackExtract("mi saag bhaji banvat aahe", "").incident_type.primary).toBe("Unknown");
    expect(fallbackExtract("garden madhe mothi baag aahe", "").incident_type.primary).toBe("Unknown");
    expect(fallbackExtract("drop the anchor and check the chord", "").incident_type.primary).toBe("Unknown");
  });

  it("detects romanized injury and hospital mentions", () => {
    expect(fallbackExtract("to jakhmi zala aahe", "").incident_type.primary).toBe("Traffic Accident");
    expect(fallbackExtract("tyala davakhanyat nyave lagel", "").incident_type.primary).toBe("Medical Emergency");
  });
});
