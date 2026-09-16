import { beforeEach, describe, expect, it } from "vitest";
import { resetVerification, seedIncident, verificationFor } from "./verify.js";

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
