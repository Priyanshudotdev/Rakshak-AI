import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordSource, resetVerification, seedIncident, verificationFor } from "./verify.js";

describe("verification ladder", () => {
  beforeEach(() => resetVerification());

  it("starts unverified on the first report", () => {
    expect(verificationFor("INC-1", 0)).toEqual({ status: "unverified", reports: 1 });
  });

  it("climbs to multiple_reports on the second report", () => {
    seedIncident("INC-2");
    expect(verificationFor("INC-2", 1)).toEqual({ status: "multiple_reports", reports: 2 });
  });

  it("reaches corroborated at four reports and holds", () => {
    seedIncident("INC-3");
    verificationFor("INC-3", 1);
    verificationFor("INC-3", 1);
    expect(verificationFor("INC-3", 1)).toEqual({ status: "corroborated", reports: 4 });
    expect(verificationFor("INC-3", 2).status).toBe("corroborated");
  });

  it("never confirms officially — that is operator-only", () => {
    seedIncident("INC-4");
    const statuses = Array.from({ length: 10 }, () => verificationFor("INC-4", 3).status);
    expect(statuses).not.toContain("officially_confirmed");
  });

  it("tracks incidents independently", () => {
    seedIncident("INC-A");
    seedIncident("INC-B");
    verificationFor("INC-A", 3);
    expect(verificationFor("INC-B", 0).status).toBe("unverified");
  });
});

describe("recordSource (durable ledger with memory fallback)", () => {
  const report = { id: "R-1", source: "fixture", title: "Fire at Sadar" };

  afterEach(() => {
    vi.unstubAllGlobals();
    resetVerification();
  });

  it("returns the API-derived status when the ledger is reachable", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { verification: "multiple_reports", reports: 2 } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await recordSource("INC-API", report, 0.63, ["location-match"]);
    expect(out).toEqual({ status: "multiple_reports", reports: 2 });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/incidents/INC-API/sources"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("falls back to the memory ladder when the API is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    const out = await recordSource("INC-OFFLINE", report, 0.63, []);
    expect(out).toEqual({ status: "multiple_reports", reports: 2 });
  });

  it("falls back when the API rejects or answers badly", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    expect((await recordSource("INC-500", report, 0.5, [])).status).toBe("multiple_reports");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    expect((await recordSource("INC-BAD", report, 0.5, [])).status).toBe("multiple_reports");
  });
});
