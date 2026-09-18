// Central env access — never expose telephony/AI keys to the browser (spec §25).
export const config = {
  port: Number(process.env.PORT ?? 3001),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://rakshak:rakshak@localhost:5432/rakshak",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  sarvamApiKey: process.env.SARVAM_API_KEY ?? "",
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
};
