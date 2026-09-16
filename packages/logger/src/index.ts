// Structured JSON logger — OpenTelemetry hook added in Phase 2.
export type LogLevel = "debug" | "info" | "warn" | "error";

export function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, msg, at: new Date().toISOString(), ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}
