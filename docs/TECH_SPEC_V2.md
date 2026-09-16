# Rakshak AI V2 — Technical Specification (feat/v2-architecture)

Branch: `feat/v2-architecture` (all V2 work stays here; `master` frozen as Phase-1 prototype).
Canonical context: Master AI Development Prompt §§1–31.

## 1. Where we are (Phase-1 prototype, `master`)

Monolithic Python/Flask on `localhost:5000`:

- `app.py` — Flask REST: `/api/process-call` (text), `/api/process-audio` (batch file), `/api/records`, `/api/records/count`, `/api/records/:id/audio` (streamed, slim list by default), `/api/analytics`, `/api/tts`, `/api/dispatch`.
- `pipeline.py` — `RakshakPipeline.process_text/process_audio`: Sarvam lang-detect → translate EN/MR → `LLMService.extract` (Gemini `gemini-2.5-flash` → `gemini-2.0-flash` → rules fallback) → rule-floor priority + LLM `assess_priority` overlay → gender-appropriate Bulbul TTS (`priya`/`shubh`, `mr-IN`).
- `sarvam_client.py` / `llm.py` — Sarvam STT/translate/TTS + Gemini extraction/priority wrappers with timeouts (`timeouts.py`).
- `memory.py` — JSON persistence: `data/records.json` (+`.corrupt` safeguard, no silent overwrite), `data/dispatch_log.json` (capped 200, atomic tmp+replace). Analytics with correct `total_ms` averaging.
- `templates/dashboard.html` + `static/script.js/style.css` — 3-tab dashboard, audio via `/audio?which=` URLs, count endpoint.
- `mock_calls.py`, `test_rakshak.py` — mock data + live-pipeline smoke test.

Limits: batch-only (no partial transcripts), no telephony, no streaming WS, no Redis/queue, no Postgres/PostGIS/pgvector, no typed contracts, no audit/RBAC, no correlation/verification.

## 2. Where we are going (target, per §§4–8, 22–24)

```
Caller → SIP → Asterisk (PJSIP+ARI+External Media) → Media Gateway (Node/TS/Fastify+WS)
  → Sarvam Saaras Realtime (partial/final) → AI Engine (Node/TS) → Redis/BullMQ → WS Gateway
  → Next.js dashboard → Operator → Translation → Sarvam Bulbul → Asterisk → Caller
  → Postgres (PostGIS+pgvector) for incidents/transcripts/audit
```

Pillars: COMMUNICATE (STT/translation/TTS+barge-in) → UNDERSTAND (typed extraction/classification/priority+explanation) → CORRELATE (multi-source, verification).

Rules enforced: TS-first backend (§24), Asterisk isolated from AI (§6), gateway has no incident logic (§7), LLM never dispatches directly (§9, §12), original transcript always preserved (§16), streaming critical path vs queued secondary path (§26), small service count (§23).

## 3. Affected components for V2 scaffold (smallest coherent change)

| Prototype piece | V2 owner | Change |
|---|---|---|
| `app.py` Flask routes | `apps/api` (Fastify+TS) | Port `/api/health`, `/process-*`, `/records`, `/analytics`, `/tts`, `/dispatch` as typed REST; add WS gateway for `transcript.partial/final`, `incident.created/updated`, `priority.updated` events (§13). Keep Flask under `legacy/` read-only for reference. |
| `pipeline.py` + `llm.py` | `services/ai-engine` (TS orchestration) | Port as `LanguageProcessor → TranslationOrchestrator → EntityExtractor → Classifier → PriorityEngine + ExplanationEngine` with Zod-validated incident schema (§10). Sarvam/Gemini behind `ISpeechProvider` / `ILLMProvider` adapters so providers are swappable (§28). Keep Python out unless local inference justified (§24, §29). |
| `sarvam_client.py` batch STT | `services/media-gateway` (Node/TS) | New: Asterisk External Media WS intake → session manager → Sarvam Saaras Realtime WS → partial/final emit. TTS connector with barge-in (stop on `speech.started`). No AI logic here. |
| `memory.py` JSON files | `database/` (Postgres+PostGIS+pgvector) + Redis | Migrate entities (§15): `calls, transcripts/segments, incidents/entities/locations/sources, priority_assessments, ai_explanations, audit_logs`. Redis for call-session/ephemeral + BullMQ queues: `extraction, classification, location-resolution, incident-correlation, enrichment, notification` (§14). |
| `templates/` + `static/` | `apps/dashboard` (Next.js+TS+Tailwind+shadcn, TanStack Query, MapLibre) | Rebuild views: active calls, live original+translated transcript, incident card, map, priority+reasons, evidence/verification, timeline, operator actions (§20). Never expose SIP/AI keys to browser (§25). |
| `mock_calls.py` / tests | `packages/types`, `packages/events` + e2e harness | Shared TS types (`call, transcript, incident, priority, events`) consumed by api/gateway/dashboard. Event catalog versioned. |

## 4. Data flow (MVP vertical first, §4)

Critical (streaming, never queued): Audio → Gateway → Saaras partial → WS → dashboard (<1s target for first partial).
Secondary (queued): Final transcript → BullMQ `extraction` → AI engine → Postgres → `incident.created/updated` → WS → dashboard; enrichment/correlation async.

Two-way: Operator text → translate → Bulbul TTS → gateway → Asterisk; caller speech during TTS triggers barge-in → cancel TTS, resume STT.

Uncertainty preserved: `estimate/range + confidence + source` (e.g. "maybe 2–3 people" ≠ `affected: 3`); original + translated + segments with timestamps/confidence/speaker retained.

## 5. API / event / DB changes

- REST (Fastify, Zod): Flask response shapes kept (`{status, data}`); live `GET /api/stream` (WS), `POST /api/events/publish` (optional `EVENT_INGEST_KEY`), `GET /api/events/recent`, `GET /api/metrics/latency` (avg/p50/p95 per §26 timing). Batch endpoints fan out `transcript.final → incident.created → priority.updated`; `POST /api/process-audio?callId=` links gateway legs to records.
- Events (§13): in-memory bus + WS gateway today (Redis pub/sub when the worker fleet needs it); catalog in `packages/types` (`RakshakEvents`), envelope helper in `packages/events`.
- DB: `001_core.sql` (Postgres + PostGIS + pgvector, §15 tables) for the geo/vector phase; `002_records_store.sql` (records + dispatch_log) backs the live API via `pgstore.ts`. Backend selector: Postgres when `DATABASE_URL` works, else the file store — identical semantics locked by `pgstore.test.ts` equivalence coverage (pg-mem, no Docker needed).
- Validation: Zod on ingest routes; every LLM output JSON-parsed/validated before persist/emit; reject → rules fallback + `llm_used: rules`. Errors keep the `{status: "error"}` contract: 400s for bad input, 500s carry the generic message plus a truncated upstream `detail` (server logs keep the stack) so Neon/LLM blips are debuggable.
- Tests (TDD, vitest): ai-engine (extract/priority/correlation), gateway sessions, worker (feeds/verify), api (pgstore equivalence), dashboard (verification mapper). `npm run test --workspaces --if-present`.

## 6. Latency / reliability implications

- Measure explicitly (§26): ingestion, STT first-partial, finalization, translation, extraction, WS delivery, TTS first-audio, e2e conversational. Add `timings` (as today) + OpenTelemetry spans; Prometheus/Grafana later.
- Reliability (§25): per-hop timeouts/retries/circuit-breakers (reuse `timeouts.py` semantics in TS `p-timeout`/`cockatiel`); gateway reconnect/backpressure/session cleanup; non-critical enrichment failure must not kill call; rate-limit + RBAC + audit logs; secrets server-only.
- No audio path behind BullMQ; only enrichment/correlation queued.

## 7. Execution plan (phases §27, smallest-first) — status on this branch

1. **Scaffold: DONE.** Monorepo §23 + shared packages + compose + `001_core.sql` + Flask prototype moved to `legacy/` (history preserved via `git mv`).
2. **Phase 1 parity: DONE.** `apps/api` Fastify port (all legacy routes + slim audio streaming + dispatch persistence); `services/ai-engine` TS port (Sarvam/Gemini adapters, rules fallback, priority overlay); `apps/dashboard` Next.js console (intake, records, workspace, dispatch, analytics).
3. **Phase 2 realtime backbone: DONE.** Gateway WS transport (sessions, replay mode, barge-in hook, backpressure, idle sweep) + API event bus/WS gateway + latency percentiles + dashboard live wire. Saaras Realtime adapter boundary defined, unwired.
4. **Phase 3 Asterisk: CONFIGS DONE, live wiring pending.** `pjsip/ari/extensions` templates + nginx edge proxy; needs trunk + host to verify.
5. **Phase 4 two-way: PARTIAL.** `tts-stop` barge-in event path exists; Bulbul injection into Asterisk audio pending on Phase 3.
6. **Phase 5/6 aggregation: WORKER DONE, geo/vector pending.** RSS intake → six queues (direct-mode fallback) → offline-safe extraction → weighted correlation → verification ladder (operator-only confirmation). PostGIS/pgvector + dashboard correlation views are next.
7. **Hardening/verification (2026-09-16, live on Neon):** Marathi `process-call` (Roman + Devanagari) green; TTS→STT audio roundtrip green; ingestion `RUN_ONCE` fixture smoke green in direct mode; root `typecheck` covers Node workspaces + dashboard's own `tsconfig` (base excludes the Next app); `next build` green (105 kB); `docker compose config` validates. Still blocked: compose boot + BullMQ Redis mode (no Docker daemon / local Redis here), Asterisk live wiring (needs trunk + host).
8. **CORRELATE loop demonstrated live (2026-09-16):** call incident `LIVE-CF3841C9` (Fire, Sitabuldi market) + fixture RSS report correlated at 0.63 (`text-overlap + location-match + temporal + type:fire`) → worker published `ai.explanation.updated` + `incident.updated` (`verification: multiple_reports, corroborating_reports: 2`) to the API bus — the exact events the dashboard verification card consumes. No code change needed; the wiring was already in place. Note: the worker reads the live API via `API_URL` (compose sets `http://api:3001`; local runs must point it at the live port, e.g. `:3141`, or correlation sees zero incidents).
9. **Compose boot verified (2026-09-16, Docker Desktop):** all 7 services up — postgres+redis healthy, api `:3001` (postgres backend), gateway `:3002`, dashboard, nginx `:80`. Boot exposed and fixed 3 real bugs: (a) `.dockerignore` contained a Windows absolute path (builder `syntax error in pattern`); (b) `Dockerfile.dashboard` omitted `tsconfig.base.json` (Next `TS5083`); (c) worker crashed in Redis mode — BullMQ requires `maxRetriesPerRequest: null` (`queue.ts`). Redis-mode queue path proven in containers: report enqueued to BullMQ → full pipeline → 0.65 match → evidence events on the container API bus. Local port-remap override (host `:3000`/`:6379` taken by other projects) lives outside the repo; `docker-compose.yml` itself is unchanged.
10. **Saaras Realtime wired + proven live (2026-09-16):** `SaarasRealtimeAdapter` (`services/media-gateway/src/saaras.ts`) opens `wss://api.sarvam.ai/speech-to-text-realtime/ws` (`saaras:v3-realtime`, `api-subscription-key` header, `audio_input` base64 linear16) and maps `transcript.partial/final → bus`, `error → onError` (fatal closes), `REALTIME=saaras` selects it (default stays replay passthrough); gateway `/health` reports the adapter mode. Unit tests (6, injected socket) + build green. Live: Bulbul TTS wav (22050 Hz, resampled to 16k in harness) streamed through the real service → 58 Marathi partials + final `सीताबडी मार्केट जवळ आग लागली आहे, लवकर मदत पाठवा.` — first true streaming STT on the critical path. Note: TTS emits 22050 Hz; telephony/Asterisk legs must present 8k/16k linear16 (resampling belongs in the gateway when the first real leg lands).
11. **Neon geo/vector foundation live (2026-09-16):** `database/migrations/001_core.sql` applied to Neon (Postgres 18.6) — `postgis` 3.6.4 + `vector` 0.8.6 enabled; `operators, calls, transcripts, incidents (geom + embedding VECTOR(1536)), priority_assessments, ai_explanations, audit_logs` created. Additive only; live `records/dispatch_log` untouched.
12. **Verification ledger durable + audit trail (2026-09-16):** `003_verification_sources.sql` (`incident_sources`, idempotent per report) + `004_audit_log.sql` (`api_audit_log`) applied to Neon; both backends (file mirrors `incident_sources.json`/`audit_log.json`, parity-tested). New routes `POST /api/incidents/:key/sources`, `GET /api/incidents/:key/verification`, `GET /api/audit`; dispatch/delete/source-attach write audit rows with the `x-operator` actor (dashboard sends a stored callsign, editable in the Dispatch panel). Worker `recordSource()` posts to the ledger with in-memory fallback (unit-tested both paths).
13. **Geo enrichment + map (2026-09-16):** `services/ai-engine/src/geocode.ts` (Nominatim, cached, specificity fallback, never throws); API attaches `extraction.geo` fire-and-forget after save; `correlationScore` gains `geo-near` (+0.10 ≤25 km, haversine); worker forwards record geo into correlation; dashboard renders an OSM embed when `geo` is present. Full RBAC (passwords/sessions) still pending — audit identity is a callsign header, not authentication.
14. **Normalized backfill (2026-09-16):** `apps/api/src/sync.ts` projects stored records into `calls/transcripts/incidents/priority_assessments/ai_explanations` (geom from `extraction.geo`, re-runnable per-call replace); `POST /api/admin/sync-normalized` (Postgres-only, audited) triggers it; mapping covered by offline unit tests with a fake pool. Embeddings stay NULL until a 1536-dim provider decision is made.
15. **Operator auth (2026-09-16):** `005_operator_auth.sql` (bcrypt hashes, `operator_sessions` with 24h expiry, first-registered is admin); routes `POST /api/operators/register|login|logout`, `GET /api/operators/me`; actor order Bearer > `x-operator` > `operator`; mutating routes hard-require Bearer only when `AUTH_REQUIRED=1` (worker sends `OPERATOR_TOKEN` when set); dashboard Dispatch panel signs in/out and sends the token. Parity-tested both backends; hashes never leave the server. Migration notes: `operator_id` is TEXT without FK (001-UUID vs fresh-TEXT stores), `expires_at` app-supplied — pg-mem constraints documented inline.

Each step: types → events → migration → implementation → validation → docs update; never silently alter core architecture.
