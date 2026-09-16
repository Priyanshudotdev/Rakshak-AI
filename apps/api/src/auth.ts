import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import type { Doc } from "./store.js";

// Operator auth (§25): bcrypt passwords, random hex bearer tokens (24h).
// Actor resolution order everywhere: valid Bearer > x-operator > "operator".

export const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

export function newToken(): string {
  return randomBytes(24).toString("hex");
}

export function tokenExpiry(): string {
  return new Date(Date.now() + TOKEN_TTL_MS).toISOString();
}

export interface AuthStore {
  findOperatorByName(name: string): Promise<Doc | null>;
  resolveSession(token: string): Promise<Doc | null>;
}

export interface AuthHeaders {
  authorization?: string;
  "x-operator"?: string | string[];
}

/** Resolve the acting operator from headers. Never throws, never leaks why. */
export async function authenticate(store: AuthStore, headers: AuthHeaders): Promise<Doc | null> {
  const raw = headers.authorization ?? "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : "";
  if (token) {
    try {
      const op = await store.resolveSession(token);
      if (op) return op;
    } catch {
      /* fall through to callsign */
    }
  }
  return null;
}

export function actorFrom(headers: AuthHeaders, authed: Doc | null): string {
  if (authed?.name) return String(authed.name).slice(0, 100);
  const h = headers["x-operator"];
  const callsign = Array.isArray(h) ? h[0] : h;
  return (callsign ?? "operator").toString().slice(0, 100) || "operator";
}

/** Hard gate for mutating routes when AUTH_REQUIRED=1 (staging/prod). */
export function authRequired(): boolean {
  return (process.env.AUTH_REQUIRED ?? "") === "1";
}
