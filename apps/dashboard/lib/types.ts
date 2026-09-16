// Thin client-side mirror of the Fastify API shapes ({status, data}).
// Server is the source of truth; these types only describe what we render.

export interface Priority {
  level?: string;
  confidence?: number;
  reasoning?: string;
  decision_factors?: string[];
  risk_factors?: string[];
  recommended_response?: string;
  dispatcher_notes?: string;
  time_critical?: boolean;
  rule_floor?: string;
}

export interface GeoPoint {
  lat: number;
  lon: number;
  display?: string;
}

export interface Extraction {
  location?: string;
  landmark?: string;
  address?: string;
  geo?: GeoPoint;
  incident_type?: string;
  incident_secondary?: string;
  people_involved?: string;
  weapon_mentioned?: boolean;
  weapon_type?: string | null;
  immediate_danger?: boolean;
  risk_level?: number | null;
  caller_state?: string;
  caller_gender?: string;
  summary?: string;
}

export interface IncidentRecord {
  id: string;
  call_id: string;
  scenario?: string;
  source?: string;
  created_at?: string;
  timestamp_formatted?: string;
  original_language?: string;
  language_code?: string | null;
  language_confidence?: number;
  transcript_original?: string;
  transcript_english?: string;
  transcript_marathi?: string;
  speaker_gender?: string;
  speaker_used?: string;
  extraction?: Extraction;
  priority?: Priority;
  timings?: Record<string, number>;
  llm_used?: string;
  dispatched?: boolean;
  has_original_audio?: boolean;
  has_translated_audio?: boolean;
}

export interface Analytics {
  total_records: number;
  priority_breakdown: Record<string, number>;
  language_distribution: Record<string, number>;
  incident_types: Record<string, number>;
  location_distribution: Record<string, number>;
  weapon_stats: { present: number; not_present: number; types: Record<string, number> };
  immediate_danger_count: number;
  dispatched_count: number;
  caller_states: Record<string, number>;
  average_latencies: Record<string, number>;
}

export interface DispatchEntry {
  id?: string;
  time?: string;
  call_id?: string;
  location?: string;
  incident_type?: string;
  priority?: string;
  units?: string;
  operator?: string;
}

export type PriorityLevel = "HIGH" | "MEDIUM" | "LOW" | "CRITICAL";
