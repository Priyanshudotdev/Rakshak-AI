"use client";

// Single place that talks to the Fastify API. Base URL is public config;
// no telephony or AI keys ever touch the browser.
export const API_URL =
  (process.env.NEXT_PUBLIC_API_URL as string | undefined) ?? "http://localhost:3001";

export interface ApiHttpError extends Error {
  status?: number;
}

/** True when the API rejected the call for lack of a session (401). Callers
 *  use this to show "sign in required" guidance instead of a raw error. */
export function isAuthError(e: unknown): boolean {
  if (!e) return false;
  const status = (e as { status?: unknown }).status;
  if (status === 401) return true;
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /401|sign-?in required|unauthorized|invalid credentials|admin sign-in required/i.test(msg);
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const err = (await res.json()) as { message?: string };
      if (err?.message) detail = err.message;
    } catch {
      /* keep status text */
    }
    const e = new Error(detail || `Request failed (${res.status})`) as ApiHttpError;
    e.status = res.status;
    throw e;
  }
  return (await res.json()) as T;
}

export interface HealthState {
  status: string;
  sarvam: boolean;
  gemini: boolean;
  store?: string;
  count?: number;
}

/** GET /api/health — raw envelope (no {status,data} wrapper). */
export async function getHealth(): Promise<HealthState> {
  const res = await fetch(`${API_URL}/api/health`, { cache: "no-store" });
  return json<HealthState>(res);
}

export async function processCall(transcript: string, language?: string) {
  const res = await fetch(`${API_URL}/api/process-call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript, language }),
  });
  return json<{ status: string; data: import("./types").IncidentRecord }>(res);
}

export async function processAudioFile(file: File) {
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await fetch(`${API_URL}/api/process-audio`, { method: "POST", body: form });
  return json<{ status: string; data: import("./types").IncidentRecord }>(res);
}

export interface RecordQuery {
  q?: string;
  priority?: string;
  language?: string;
  limit?: number;
  offset?: number;
}

export async function listRecords(query: RecordQuery = {}) {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.priority) params.set("priority", query.priority);
  if (query.language) params.set("language", query.language);
  params.set("limit", String(query.limit ?? 50));
  params.set("offset", String(query.offset ?? 0));
  const res = await fetch(`${API_URL}/api/records?${params}`, { cache: "no-store" });
  return json<{ status: string; data: import("./types").IncidentRecord[]; count: number }>(res);
}

export async function getRecordCount(): Promise<number> {
  const res = await fetch(`${API_URL}/api/records/count`, { cache: "no-store" });
  const body = await json<{ status: string; data: { count: number } }>(res);
  return body.data.count;
}

export async function getAnalytics() {
  const res = await fetch(`${API_URL}/api/analytics`, { cache: "no-store" });
  return json<{ status: string; data: import("./types").Analytics }>(res);
}

/** GET /api/dispatch — raw array (no {status,data} wrapper). Accepts the
 *  {log}/{data} shapes too so POST responses stay renderable. */
export async function getDispatchLog(): Promise<import("./types").DispatchEntry[]> {
  const res = await fetch(`${API_URL}/api/dispatch`, {
    cache: "no-store",
    headers: { "x-operator": operatorName(), ...authHeaders() },
  });
  const body = await json<unknown>(res);
  if (Array.isArray(body)) return body as import("./types").DispatchEntry[];
  if (body && typeof body === "object") {
    const b = body as { log?: unknown; data?: unknown };
    if (Array.isArray(b.log)) return b.log as import("./types").DispatchEntry[];
    if (Array.isArray(b.data)) return b.data as import("./types").DispatchEntry[];
  }
  return [];
}

const OPERATOR_KEY = "rakshak.operator";
const TOKEN_KEY = "rakshak.token";

function authHeaders(): Record<string, string> {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

export function signedInOperator(): { name: string; role: string } | null {
  try {
    const raw = localStorage.getItem("rakshak.session");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { name?: string; role?: string };
    return parsed.name ? { name: parsed.name, role: parsed.role ?? "operator" } : null;
  } catch {
    return null;
  }
}

/** Client-side role guard: delete/clear buttons are admin-only. Operators keep
 *  dispatch-logging; anything destructive checks this first. */
export function isSignedInAdmin(): boolean {
  return signedInOperator()?.role === "admin";
}

export async function login(name: string, password: string) {
  const res = await fetch(`${API_URL}/api/operators/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, password }),
  });
  const body = await json<{ status: string; data: { token: string; operator: { name: string; role: string } } }>(res);
  try {
    localStorage.setItem(TOKEN_KEY, body.data.token);
    localStorage.setItem("rakshak.session", JSON.stringify(body.data.operator));
    localStorage.setItem(OPERATOR_KEY, body.data.operator.name);
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
    localStorage.removeItem("rakshak.session");
  } catch {
    /* ignore */
  }
}

/** Operator callsign for the audit trail (stored locally, sent as x-operator). */
export function operatorName(): string {
  try {
    return (localStorage.getItem(OPERATOR_KEY) ?? "").trim().slice(0, 100) || "operator";
  } catch {
    return "operator";
  }
}

export function setOperatorName(name: string): void {
  try {
    localStorage.setItem(OPERATOR_KEY, name.trim().slice(0, 100));
  } catch {
    /* private mode — audit falls back to "operator" */
  }
}

export async function postDispatch(entry: {
  call_id?: string;
  location?: string;
  incident_type?: string;
  priority?: string;
  units?: string;
}) {
  const res = await fetch(`${API_URL}/api/dispatch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-operator": operatorName(), ...authHeaders() },
    body: JSON.stringify(entry),
  });
  return json<{ status: string; data: import("./types").DispatchEntry; log: import("./types").DispatchEntry[] }>(res);
}

export type ListenVoice = "en-IN" | "hi-IN" | "mr-IN";

export async function translate(text: string, target: ListenVoice, source?: string) {
  const res = await fetch(`${API_URL}/api/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-operator": operatorName(), ...authHeaders() },
    body: JSON.stringify({ text, target_language_code: target, source_language_code: source }),
  });
  return json<{ status: string; data: { translated_text: string; target: string } }>(res);
}

export async function synthesize(text: string, opts?: { language_code?: string; speaker?: string; record_id?: string }) {
  const res = await fetch(`${API_URL}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-operator": operatorName(), ...authHeaders() },
    body: JSON.stringify({ text, ...opts }),
  });
  return json<{ status: string; data: { audio_base64: string; speaker: string; language_code: string } }>(res);
}

export async function deleteRecord(id: string) {
  const res = await fetch(`${API_URL}/api/records/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "x-operator": operatorName(), ...authHeaders() },
  });
  return json<{ status: string; message: string }>(res);
}

/** DELETE /api/records — clears all incident records. Admin-gated in the UI. */
export async function clearRecords() {
  const res = await fetch(`${API_URL}/api/records`, {
    method: "DELETE",
    headers: { "x-operator": operatorName(), ...authHeaders() },
  });
  return json<{ status: string; message: string }>(res);
}

export interface AuditEntry {
  id?: string | number;
  created_at?: string;
  at?: string;
  actor?: string;
  action?: string;
  entity?: string;
  entity_id?: string;
  detail?: unknown;
}

/** GET /api/audit?limit — newest-first audit entries ({status, data}). */
export async function getAuditLog(limit = 50) {
  const res = await fetch(`${API_URL}/api/audit?limit=${encodeURIComponent(String(limit))}`, {
    cache: "no-store",
  });
  return json<{ status: string; data: AuditEntry[] }>(res);
}

export function audioUrl(id: string, which: "original" | "translated"): string {
  return `${API_URL}/api/records/${encodeURIComponent(id)}/audio?which=${which}`;
}

/* ---------------- Operator profile + per-call translation ---------------- */

export interface OperatorProfile {
  operator_id: string;
  known_languages: string[];
  default_language: string;
  mobile_e164: string;
  active: boolean;
}

export interface ProfilePatch {
  known_languages?: string[];
  default_language?: string;
  mobile_e164?: string;
}

export interface TranslationState {
  call_id: string;
  enabled: boolean;
}

export async function getProfile(): Promise<OperatorProfile> {
  const res = await fetch(`${API_URL}/api/operators/profile`, {
    cache: "no-store",
    headers: { "x-operator": operatorName(), ...authHeaders() },
  });
  return json<OperatorProfile>(res);
}

export async function putProfile(patch: ProfilePatch): Promise<OperatorProfile> {
  const res = await fetch(`${API_URL}/api/operators/profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-operator": operatorName(), ...authHeaders() },
    body: JSON.stringify(patch),
  });
  return json<OperatorProfile>(res);
}

export async function getTranslation(callId: string): Promise<TranslationState> {
  const res = await fetch(`${API_URL}/api/calls/${encodeURIComponent(callId)}/translation`, {
    cache: "no-store",
    headers: { "x-operator": operatorName(), ...authHeaders() },
  });
  return json<TranslationState>(res);
}

export async function setTranslation(callId: string, enabled: boolean): Promise<TranslationState> {
  const res = await fetch(`${API_URL}/api/calls/${encodeURIComponent(callId)}/translation`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-operator": operatorName(), ...authHeaders() },
    body: JSON.stringify({ enabled }),
  });
  return json<TranslationState>(res);
}
