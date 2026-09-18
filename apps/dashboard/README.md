# @rakshak/dashboard — Operator Console (Next.js)

Real-time emergency-call intelligence UI for human operators.
AI assists with transcription, translation, extraction and priority
recommendations; **operators make all final decisions** (no autonomous dispatch).

## Stack

Next.js 14 (App Router) + TypeScript + Tailwind CSS + TanStack Query.
Polling (3–5 s) keeps panels live until the Phase-2 WebSocket gateway lands;
the event names in `@rakshak/types` already match the future WS contract.

## Views

- **Header** — API/STT/LLM health + live record count.
- **Analytics strip** — totals, HIGH priority, immediate danger, dispatched, latencies.
- **New incident** — transcript tab (`POST /api/process-call`) and audio tab
  (`POST /api/process-audio`, ≤10 MB).
- **Incident records** — search (id/transcript/location/type), priority filter,
  slim list (audio streams on demand via `/api/records/:id/audio`).
- **Incident workspace** — original + Marathi + English transcripts, extracted
  entities, explainable priority, audio players, Marathi TTS reply box,
  dispatch-decision form, delete with confirm.
- **Dispatch log** — auditable operator decisions.

## Run

```bash
cp .env.example .env.local   # NEXT_PUBLIC_API_URL=http://localhost:3001
npm run dev --workspace @rakshak/dashboard   # :3000
npm run build --workspace @rakshak/dashboard # production verify
```

Needs `apps/api` running (default `http://localhost:3001`).
No secrets in the browser — only the public API base URL.
