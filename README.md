# 🛡️ Rakshak AI built by _Team Falcons_

**AI-powered emergency call copilot for faster and smarter emergency response.**

Rakshak AI processes emergency calls in real time to:

- 🎙️ Transcribe speech
- 🌐 Detect and translate languages
- 🧠 Extract critical information
- 🚨 Detect urgency and priority
- 📍 Identify location and incident details
- 📋 Generate concise incident summaries

> Branch note: `master` holds the original Flask prototype (now also preserved
> read-only under `legacy/`). All V2 architecture work happens on
> `feat/v2-architecture` — see `docs/TECH_SPEC_V2.md`.

### Tech Stack (V2)

TypeScript-first monorepo: Fastify API · AI engine (Sarvam + Gemini with
rules fallback) · media gateway (WS audio transport) · ingestion worker
(RSS → correlation → verification) · Next.js operator dashboard ·
PostgreSQL (file-store fallback) · Redis/BullMQ (worker queues, direct-mode
fallback) · Docker.

### Run Locally

1. Copy `.env.example` to `.env` and fill in your API keys:

   ```
   SARVAM_API_KEY=your_sarvam_key      # required for live STT/translation/TTS
   GEMINI_API_KEY=your_gemini_key      # optional extraction fallback
   DATABASE_URL=postgres://…           # optional; file store is the fallback
   ```

   Without keys everything runs offline on the keyword-rules engine.

2. Install and start the API (`:3001`) + dashboard (`:3000`):

   ```bash
   npm install
   npm run dev --workspace @rakshak/api
   npm run dev --workspace @rakshak/dashboard
   ```

3. Optional realtime leg: `npm run dev --workspace @rakshak/media-gateway`
   (`:3002`), ingestion: `npm run dev --workspace @rakshak/ingestion-worker`.

### Test (TDD — vitest, pg-mem for DB tests, no Docker needed)

```bash
npm run test --workspace @rakshak/ai-engine
npm run test --workspace @rakshak/media-gateway
npm run test --workspace @rakshak/ingestion-worker
npm run test --workspace @rakshak/api
npm run test --workspace @rakshak/dashboard
```

### Legacy Flask prototype (reference only)

```bash
pip install -r legacy/requirements.txt && python legacy/app.py   # :5000
```

Do not modify `legacy/` — it is the frozen Phase-1 baseline.
