import { describe, expect, it } from "vitest";
import {
  actorFrom,
  authenticate,
  hashPassword,
  newToken,
  tokenExpiry,
  verifyPassword,
} from "./auth.js";

describe("passwords", () => {
  it("hashes and verifies, rejecting wrong passwords", async () => {
    const hash = await hashPassword("s3cret-dispatch");
    expect(hash).not.toContain("s3cret-dispatch");
    expect(await verifyPassword("s3cret-dispatch", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
  });

  it("mints unique tokens with future expiry", () => {
    expect(newToken()).toHaveLength(48);
    expect(newToken()).not.toBe(newToken());
    expect(new Date(tokenExpiry()).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("authenticate", () => {
  const store = {
    findOperatorByName: async () => null,
    resolveSession: async (token: string) =>
      token === "good" ? { id: "1", name: "Ops", role: "operator" } : null,
  };

  it("resolves valid bearer sessions", async () => {
    expect(await authenticate(store, { authorization: "Bearer good" })).toMatchObject({ name: "Ops" });
  });

  it("returns null for bad, missing, or malformed credentials", async () => {
    expect(await authenticate(store, { authorization: "Bearer bad" })).toBeNull();
    expect(await authenticate(store, {})).toBeNull();
    expect(await authenticate(store, { authorization: "Token good" })).toBeNull();
  });

  it("prefers session identity over the callsign header", async () => {
    expect(actorFrom({ "x-operator": "anon" }, { name: "Ops" })).toBe("Ops");
    expect(actorFrom({ "x-operator": "anon" }, null)).toBe("anon");
    expect(actorFrom({}, null)).toBe("operator");
  });
});
