"use client";

// Single place that talks to the Fastify API. Base URL is public config;
// no telephony or AI keys ever touch the browser.
export const API_URL =
  (process.env.NEXT_PUBLIC_API_URL as string | undefined) ?? "http://localhost:3001";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const err = (await res.json()) as { message?: string };
      if (err?.message) detail = err.message;
    } catch {
      /* keep status text */
    }
    throw new Error(detail || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export async function getHealth(): Promise<{ status: string; sarvam: boolean; gemini: boolean }> {
  const res = await fetch(`${API_URL}/api/health`, { cache: "no-store" });
  return json(res);
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

export async function getDispatchLog(): Promise<import("./types").DispatchEntry[]> {
  const res = await fetch(`${API_URL}/api/dispatch`, { cache: "no-store" });
  const body = await res.json();
  if (Array.isArray(body)) return body;
  return body?.log ?? body?.data ?? [];
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  });
  return json<{ status: string; data: import("./types").DispatchEntry; log: import("./types").DispatchEntry[] }>(res);
}

export async function synthesize(text: string, opts?: { language_code?: string; speaker?: string; record_id?: string }) {
  const res = await fetch(`${API_URL}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, ...opts }),
  });
  return json<{ status: string; data: { audio_base64: string; speaker: string; language_code: string } }>(res);
}

export async function deleteRecord(id: string) {
  const res = await fetch(`${API_URL}/api/records/${encodeURIComponent(id)}`, { method: "DELETE" });
  return json<{ status: string; message: string }>(res);
}

export function audioUrl(id: string, which: "original" | "translated"): string {
  return `${API_URL}/api/records/${encodeURIComponent(id)}/audio?which=${which}`;
}
