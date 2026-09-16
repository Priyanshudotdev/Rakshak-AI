export type Level = "LOW" | "MEDIUM" | "HIGH";

function defaultResponse(level: string, weaponPresent: boolean): string {
  if (level === "HIGH" && weaponPresent) return "2 police units plus ambulance, emergency dispatch";
  if (level === "HIGH") return "Priority police response plus medical as needed";
  if (level === "MEDIUM") return "1-2 police units, assess medical need";
  return "Single unit / report desk follow-up";
}

/** Rule floor can only raise the LLM level; HIGH floor always wins. Mirrors legacy. */
export function applyPriorityOverlay(extraction: any, llmPriority: any | null) {
  const weapon = extraction?.weapon_mentioned ?? {};
  const danger = extraction?.immediate_danger ?? {};
  const distress = extraction?.distress_indicators ?? {};
  const incident = extraction?.incident_type ?? {};

  const weaponPresent = Boolean(weapon.is_weapon_present);
  const immediateDanger = Boolean(danger.is_immediate_danger);
  const riskLevel = Number(danger.risk_level ?? 0);
  const callerState = String(distress.caller_state ?? "").toLowerCase();
  const primary = String(incident.primary ?? "").toLowerCase();

  let ruleLevel: Level = "LOW";
  let ruleConfidence = 0.75;
  const reasons: string[] = [];
  if (weaponPresent || immediateDanger || riskLevel >= 8) {
    ruleLevel = "HIGH"; ruleConfidence = 0.95;
    if (weaponPresent) reasons.push("weapon mentioned");
    if (immediateDanger) reasons.push("immediate danger");
    if (riskLevel >= 8) reasons.push(`risk level ${riskLevel}`);
  } else if (["panicked", "crying", "distressed"].includes(callerState) || primary.includes("violence") || primary.includes("accident") || primary.includes("medical") || primary.includes("fire")) {
    ruleLevel = "MEDIUM"; ruleConfidence = 0.85;
    reasons.push(callerState || primary || "urgent indicators");
  } else {
    reasons.push("no immediate threat indicators");
  }

  const llmLevel = String(llmPriority?.priority_level ?? "").toUpperCase();
  const rank: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  let finalLevel = ruleLevel;
  if (llmLevel in rank && rank[llmLevel] > rank[ruleLevel]) finalLevel = llmLevel as Level;
  if (ruleLevel === "HIGH") finalLevel = "HIGH";

  let confidence = Number(llmPriority?.confidence ?? ruleConfidence);
  if (!Number.isFinite(confidence)) confidence = ruleConfidence;
  if (ruleLevel === "HIGH") confidence = Math.max(confidence, ruleConfidence);

  const decisionFactors: string[] = [...(llmPriority?.decision_factors ?? [])];
  for (const r of reasons) if (!decisionFactors.includes(r)) decisionFactors.push(r);

  return {
    level: finalLevel,
    confidence: Math.round(Math.min(Math.max(confidence, 0), 1) * 100) / 100,
    reasoning: llmPriority?.explanation ?? `Based on: ${reasons.join(", ")}`,
    decision_factors: decisionFactors,
    risk_factors: llmPriority?.risk_factors ?? reasons,
    recommended_response: llmPriority?.recommended_response ?? defaultResponse(finalLevel, weaponPresent),
    dispatcher_notes: llmPriority?.dispatcher_notes ?? "",
    time_critical: Boolean(llmPriority?.time_critical ?? finalLevel === "HIGH"),
    rule_floor: ruleLevel,
  };
}
