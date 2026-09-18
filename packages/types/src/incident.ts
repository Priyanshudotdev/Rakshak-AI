import type { VerificationStatus } from "./call.js";

export interface IncidentLocation {
  raw: string;
  normalized?: string;
  city?: string;
  landmark?: string;
  /** WGS84 — persisted via PostGIS. */
  lat?: number;
  lon?: number;
  confidence?: number;
}

export interface PeopleCount {
  /** Preserve ranges — e.g. "2-3" stays a range with confidence, never silently exact. */
  estimate?: string;
  affected?: number;
  injured?: number;
  trapped?: number;
  confidence?: number;
}

export interface StructuredIncident {
  incidentType: string;
  status: "reported" | "corroborated" | "confirmed";
  verification: VerificationStatus;
  priority: "low" | "medium" | "high" | "critical";
  confidence: number;
  location: IncidentLocation;
  people: PeopleCount;
  threats: string[];
  weapons: string[];
  vehicles: string[];
  evidence: string[];
  /** Explainable reasons — shown to operator, never autonomous dispatch. */
  reasons: string[];
  sourceCallId?: string;
}
