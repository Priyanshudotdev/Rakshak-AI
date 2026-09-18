export interface PriorityAssessment {
  level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  confidence: number;
  reasoning: string;
  decisionFactors: string[];
  riskFactors: string[];
  recommendedResponse?: string;
  dispatcherNotes?: string;
  timeCritical: boolean;
  /** Rule floor can only raise, never lower, the LLM recommendation. */
  ruleFloor: "LOW" | "MEDIUM" | "HIGH";
}
