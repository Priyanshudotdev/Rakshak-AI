"use client";

/**
 * Single place that talks to the Fastify API (apps/api).
 * Base URL is public config; no telephony or AI keys ever touch the browser.
 * Response contracts mirror apps/api/src/index.ts — verify there if in doubt:
 * reads are mostly {status, data}, profile/translation bodies are raw.
 */

export const API_URL =
  (process.env.NEXT_PUBLIC_API_URL as string | undefined) ?? "http://localhost:3001";

const TOKEN_KEY = "rakshak.console.token";
const SESSION_KEY = "rakshak.console.session";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const err = (await res.json()) as { message?: string };
      if (err?.message) detail = err.message;
    } catch {
      /* keep status text */
    }
    const e = new Error(detail || `Request failed (${res.status})`) as Error & { status?: number };
    e.status = res.status;
    throw e;
  }
  return (await res.json()) as T;
}

function authHeaders(): Record<string, string> {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

export function operatorName(): string {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return "operator";
    const parsed = JSON.parse(raw) as { name?: string };
    return parsed.name?.trim().slice(0, 100) || "operator";
  } catch {
    return "operator";
  }
}

/* ---------------- auth ---------------- */

export async function login(name: string, password: string) {
  const res = await fetch(`${API_URL}/api/operators/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, password }),
  });
  const body = await json<{ status: string; data: { token: string; operator: { name: string; role: string } } }>(res);
  try {
    localStorage.setItem(TOKEN_KEY, body.data.token);
    localStorage.setItem(SESSION_KEY, JSON.stringify(body.data.operator));
  } catch {
    /* private mode */
  }
  return body.data.operator;
}

export async function register(name: string, password: string) {
  const res = await fetch(`${API_URL}/api/operators/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, password }),
  });
  return json<{ status: string; data: { name: string; role: string } }>(res);
}

export async function logout() {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) {
      await fetch(`${API_URL}/api/operators/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    }
  } catch {
    /* best-effort */
  }
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export function getSession(): { name: string; role: string } | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { name?: string; role?: string };
    return parsed.name ? { name: parsed.name, role: parsed.role ?? "operator" } : null;
  } catch {
    return null;
  }
}

/* ---------------- health & data ---------------- */

export async function getHealth() {
  const res = await fetch(`${API_URL}/api/health`, { cache: "no-store" });
  return json<{ status: string; sarvam: boolean; gemini: boolean; store?: string; db?: string }>(res);
}

export async function listRecords(params: { q?: string; priority?: string; language?: string; limit?: number; offset?: number } = {}) {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.priority && params.priority !== "ALL") qs.set("priority", params.priority);
  if (params.language) qs.set("language", params.language);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.offset) qs.set("offset", String(params.offset));
  const res = await fetch(`${API_URL}/api/records?${qs}`, { cache: "no-store" });
  return json<{ status: string; data: import("./types").IncidentRecord[]; count?: number }>(res);
}

export async function getRecord(id: string) {
  const res = await fetch(`${API_URL}/api/records/${encodeURIComponent(id)}`, { cache: "no-store" });
  return json<{ status: string; data: import("./types").IncidentRecord }>(res);
}

export async function getRecordCount() {
  const res = await fetch(`${API_URL}/api/records/count`, { cache: "no-store" });
  return json<{ status: string; data: { count: number } }>(res);
}

export async function getAnalytics() {
  const res = await fetch(`${API_URL}/api/analytics`, { cache: "no-store" });
  return json<{ status: string; data: Record<string, unknown> }>(res);
}

export async function getDispatchLog() {
  const res = await fetch(`${API_URL}/api/dispatch`, {
    cache: "no-store",
    headers: { "x-operator": operatorName(), ...authHeaders() },
  });
  const body = (await res.json()) as unknown;
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  if (Array.isArray(body)) return body as import("./types").DispatchEntry[];
  const data = (body as { data?: unknown; log?: unknown }).data ?? (body as { log?: unknown }).log;
  return (Array.isArray(data) ? data : []) as import("./types").DispatchEntry[];
}

export async function postDispatch(entry: Record<string, unknown>) {
  const res = await fetch(`${API_URL}/api/dispatch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-operator": operatorName(), ...authHeaders() },
    body: JSON.stringify(entry),
  });
  return json<{ status: string; data?: unknown }>(res);
}

export async function getAuditLog(limit = 100) {
  const res = await fetch(`${API_URL}/api/audit?limit=${limit}`, {
    cache: "no-store",
    headers: { "x-operator": operatorName(), ...authHeaders() },
  });
  return json<{ status: string; data: import("./types").AuditEntry[] }>(res);
}

/* ---------------- AI helpers ---------------- */

export async function synthesize(text: string, language_code = "mr-IN") {
  const res = await fetch(`${API_URL}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-operator": operatorName(), ...authHeaders() },
    body: JSON.stringify({ text, language_code }),
  });
  return json<{ status: string; data: { audio_base64?: string } }>(res);
}

export async function translate(text: string, target_language_code: string, source_language_code?: string) {
  const res = await fetch(`${API_URL}/api/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-operator": operatorName(), ...authHeaders() },
    body: JSON.stringify({ text, target_language_code, source_language_code }),
  });
  return json<{ status: string; data: { translated_text?: string } }>(res);
}

export async function processCall(transcript: string, language?: string) {
  const res = await fetch(`${API_URL}/api/process-call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript, language }),
  });
  return json<{ status: string; data: { id?: string } }>(res);
}

/* ---------------- operator profile + translation toggle ---------------- */

export async function getProfile() {
  const res = await fetch(`${API_URL}/api/operators/profile`, {
    cache: "no-store",
    headers: { "x-operator": operatorName(), ...authHeaders() },
  });
  return json<import("./types").OperatorProfile>(res);
}

export async function putProfile(patch: { known_languages?: string[]; default_language?: string; mobile_e164?: string }) {
  const res = await fetch(`${API_URL}/api/operators/profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-operator": operatorName(), ...authHeaders() },
    body: JSON.stringify(patch),
  });
  return json<import("./types").OperatorProfile>(res);
}

export async function getTranslation(callId: string) {
  const res = await fetch(`${API_URL}/api/calls/${encodeURIComponent(callId)}/translation`, {
    cache: "no-store",
    headers: { "x-operator": operatorName(), ...authHeaders() },
  });
  return json<{ call_id: string; enabled: boolean }>(res);
}

export async function setTranslation(callId: string, enabled: boolean) {
  const res = await fetch(`${API_URL}/api/calls/${encodeURIComponent(callId)}/translation`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-operator": operatorName(), ...authHeaders() },
    body: JSON.stringify({ enabled }),
  });
  return json<{ call_id: string; enabled: boolean }>(res);
}

export async function getEventsRecent(limit = 50) {
  const res = await fetch(`${API_URL}/api/events/recent?limit=${limit}`, { cache: "no-store" });
  return json<{ status: string; data: unknown[] }>(res);
}

/* ---------------- console additions (incident detail + settings) ---------------- */

/**
 * Direct URL for a native <audio> element. The route serves raw bytes and is
 * intentionally open (an <audio> tag cannot send Authorization headers).
 * Backend: GET /api/records/:id/audio (?which=translated). 404 when absent.
 */
export function audioUrl(id: string, which?: "translated"): string {
  const q = which ? `?which=${encodeURIComponent(which)}` : "";
  return `${API_URL}/api/records/${encodeURIComponent(id)}/audio${q}`;
}

export interface VerificationState {
  verification: string;
  reports: number;
  evidence: unknown[];
}

/**
 * Corroboration ledger: GET /api/incidents/:key/verification ->
 * { status:"success", data:{ verification, reports, evidence } }.
 */
export async function getVerification(key: string) {
  const res = await fetch(`${API_URL}/api/incidents/${encodeURIComponent(key)}/verification`, {
    cache: "no-store",
  });
  return json<{ status: string; data: VerificationState }>(res);
}

/**
 * POST /api/operators/change-password { currentPassword, newPassword }.
 * The server revokes every other session on success.
 */
export async function changePassword(currentPassword: string, newPassword: string) {
  const res = await fetch(`${API_URL}/api/operators/change-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  return json<{ status: string; message?: string }>(res);
}
