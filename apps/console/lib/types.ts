/** Shared API shapes for the operator console. Backend: apps/api (Fastify). */

export interface HealthState {
  status: string;
  sarvam: boolean;
  gemini: boolean;
  store?: string;
  db?: string;
  migrations?: string;
}

export interface OperatorSession {
  name: string;
  role: string;
}

export interface OperatorProfile {
  operator_id: string;
  known_languages: string[];
  default_language: string;
  mobile_e164: string | null;
  active: boolean;
}

export interface IncidentRecord {
  id: string;
  call_id?: string;
  priority?: { level?: string; reasoning?: string };
  extraction?: {
    incident_type?: string;
    location?: string;
    summary?: string;
    caller_name?: string;
    people_involved?: number;
    injuries?: string;
    weapons?: string;
    landmark?: string;
    suspect?: string;
    vehicle?: string;
  };
  transcript_original?: string;
  transcript_marathi?: string;
  transcript_english?: string;
  original_language?: string;
  source?: string;
  dispatched?: boolean;
  created_at?: string;
}

export interface DispatchEntry {
  id?: string;
  call_id?: string;
  units?: string;
  operator?: string;
  decision?: string;
  note?: string;
  at?: string;
}

export interface AuditEntry {
  id?: string;
  actor?: string;
  action?: string;
  entity?: string;
  entity_id?: string;
  detail?: unknown;
  at?: string;
}

export const SUPPORTED_LANGUAGES = [
  "mr-IN",
  "hi-IN",
  "en-IN",
  "gu-IN",
  "ta-IN",
  "te-IN",
  "kn-IN",
  "ml-IN",
  "bn-IN",
  "pa-IN",
] as const;

export const AVAILABILITY = ["Available", "Busy", "Away", "Offline"] as const;
