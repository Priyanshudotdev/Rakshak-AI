// Verification ladder (spec §19). Reports corroborate; only operators confirm.
// Counts live in memory for now (Postgres incident_sources in the DB phase).

export type Verification = "unverified" | "multiple_reports" | "corroborated" | "officially_confirmed";

const counts = new Map<string, number>();

export function verificationFor(incidentId: string, newMatches: number): { status: Verification; reports: number } {
  const total = (counts.get(incidentId) ?? 1) + Math.max(0, newMatches);
  counts.set(incidentId, total);
  if (total >= 4) return { status: "corroborated", reports: total };
  if (total >= 2) return { status: "multiple_reports", reports: total };
  return { status: "unverified", reports: total };
}

export function seedIncident(incidentId: string): void {
  if (!counts.has(incidentId)) counts.set(incidentId, 1);
}

export function resetVerification(): void {
  counts.clear();
}
