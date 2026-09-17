# Rakshak AI — full session context (2026-09-16, feat/v2-architecture)

opencode session id: `ses_f567fed93ffeUmx0yds8Wt0GjE` (slug `glowing-cactus`,
project dir `C:/Users/priya/Code/testing/hack/Rakshak AI - Vikshit Bharat Hackathon`). {opencode -s ses_f567fed93ffeUmx0yds8Wt0GjE}

Handoff file: everything done, everything verified, and the one open issue
with the complete debugging trail. Next session: start at "Open issue".

## 1. Objective

Rebuild Rakshak AI on branch `feat/v2-architecture` as a TypeScript-first
real-time emergency-call intelligence platform. `master` stays frozen; the
Flask prototype lives read-only in `legacy/`. Pillars:
COMMUNICATE → UNDERSTAND → CORRELATE. Human-in-the-loop, no autonomous
dispatch. Spec: `docs/TECH_SPEC_V2.md` (§§1–17). Glossary: `docs/basics.md`.

## 2. Work completed and verified

- Monorepo: `apps/api` (Fastify), `apps/dashboard` (Next.js 14),
  `services/media-gateway|ai-engine|ingestion-worker`,
  `packages/types|events|config|logger`, `database/migrations/001–005`.
- API: all legacy routes + WS event bus (`/api/stream`), publish/recent,
  latency percentiles, slim audio, `?callId=` link, error `detail` field.
- Backends: Postgres when `DATABASE_URL` works else file store; pg-mem
  equivalence tests (file↔pg parity incl. sources, audit, geo, operators).
- AI engine: Sarvam + Gemini adapters, rules fallback, priority overlay,
  correlation scorer (≥0.55 + `geo-near`), Nominatim geocode (cached,
  fallback chain), Gemini embeddings (1536-dim decision).
- Ingestion: RSS → 6 BullMQ queues (direct-mode fallback) → correlation →
  verification ladder; worker→API event publishing.
- Verification ledger durable (`incident_sources`), audit trail
  (`api_audit_log`, `x-operator`/Bearer actor), PostGIS backfill (`sync.ts`
  + admin route), nearby/similar search routes.
- Auth: bcrypt, sessions (24h), first-is-admin, change-password, dashboard
  sign-in, `AUTH_REQUIRED` gate (default off).
- Media gateway: replay mode + **Saaras realtime adapter** (58 Marathi
  partials + final proven live) + **ARI client** (answer, slin16 external
  media, bridge, RTP in/out, teardown, reconnect loop, fork guards).
- Dashboard: intake/records/workspace/dispatch/analytics, live events,
  verification card, OSM map embed, callsign + sign-in.
- Docker: 8 services compose (api, postgres, redis, gateway, worker,
  dashboard, nginx, asterisk). Boot fixed 3 real bugs (dockerignore pattern,
  dashboard tsconfig, BullMQ `maxRetriesPerRequest`).
- Neon (PG 18.6): 001–005 applied (postgis 3.6.4, vector 0.8.6, all tables).
- Live proofs: Marathi process-call, TTS→STT roundtrip, CORRELATE loop
  (0.63–0.65), Redis queue mode in containers, realtime STT, nearby (2 hits
  @641 m), semantic similar (Fire 0.744 top), sync `{synced:11}`.
- Test scoreboard (all green): api 30, ai-engine 27, gateway 24, worker 14,
  dashboard 5; root typecheck clean; all builds green.

## 3. Live environment (same-WiFi demo)

- Laptop WiFi IP: `10.238.252.229` (re-check if WiFi reconnects).
- Host ports: API dev `:3141`, compose api `:3001`, gateway `:3002`,
  dashboard `:3005` (host `:3000` taken by another project), nginx `:80`,
  Asterisk SIP `:5060/udp+tcp`, RTP `10000–10009/udp`, ARI `:8088`,
  redis `:6380` (host `:6379` taken), postgres `:5432`.
- Local port-remap override lives OUTSIDE the repo:
  `C:\Users\priya\AppData\Local\Temp\opencode\compose.ports.yml`
  (redis `!override 6380:6379`, dashboard `!override 3005:3000`).
- `.env` (git-ignored) has SARVAM/GEMINI keys, Neon DATABASE_URL,
  `PORT=5000`, plus `REALTIME=saaras` (appended for the live leg).
- Dev API launcher: `Temp\opencode\start-api.ps1 -Repo <repo>` (loads .env,
  forces PORT=3141). Logs: `Temp\opencode\pg-api3*.log`.
- Docker Desktop was installed-but-stopped; started this session. Daemon
  crashes lose `asterisk` (now `restart: unless-stopped`).

## 4. Credentials map (test-only unless noted)

- Linphone phone 1: `1001` / `rakshak-phone-1`; phone 2: `1002` /
  `rakshak-phone-2`; domain `10.238.252.229:5060/UDP`; STUN+ICE off;
  registrar `sip:10.238.252.229:5060`; proxy empty; PCMU enabled.
- Test lines: `1001↔1002` intercom, `9001` echo, `9000` emergency (ARI).
- ARI user `rakshak-gateway` / `rakshak-ari-test-only`.
- Neon operator `priya` / admin — password was shared in chat on 2026-09-16
  and is NOT stored in this repo. (Change it via
  `POST /api/operators/change-password`.)
- Secrets hygiene: real keys only in git-ignored `.env`; `docker compose
  config` prints them (standard compose interpolation) — never paste that.

## 5. OPEN ISSUE — 9000-call audio (status at shutdown)

**Working:** SIP registration, call setup/bridging, RTP phone→Asterisk→
gateway→Saaras (partials + finals reach the bus; e.g. ARI-17895839), TTS
injection path (caller hears *something*), intercom `1001↔1002` smooth,
echo `9001` works.

**Broken:** the TTS reply plays as old-TV static/crackle, latest attempt
went fully silent.

**Facts from logs (not guesses):**
- TTS wavs are clean: 22050 Hz mono16, data at offset 44 (chunk-walking
  parser + per-reply log line confirm).
- Inbound leg healthy at times (rxPackets 1079–1490, 640 B/packet = 20 ms
  slin16), but one call showed rxPackets 0 (intermittent inbound).
- First fix (PT=0 hardcoded → decoded as mu-law static) was correct
  mechanism but reply went silent after mirroring learned PT=118.
- `rtp set debug on` captured nothing useful (coordination misses).

**Current hypothesis:** reply payload-type handling (learned PT=118 may be a
non-audio packet) or Asterisk dropping our packets (SSRC/timestamp/marker).

**Next steps (in order):**
1. Enable `rtp set debug on`, make ONE `9000` call with 20 s continuous
   talk, capture `Got/Sent RTP` lines with PT values both directions.
2. If needed: pin reply PT from observed audio PT (not first packet), or
   strip marker bit; verify with `tts reply parsed` + `rtp flowing` lines.
3. Watch for stuck `UnicastRTP` channels (`core show channels`) — teardown
   now hangs up the fork too, but confirm no leaks across redials.
4. Then: incident cards from ARI finals already flow via `handleFinal` →
   process-call; confirm card appears for a 9000 call.

## 6. Remaining roadmap (after audio)

- TTS reply volume/pacing tuning against a real ear; per-utterance incident
  merging for multi-turn calls.
- `AUTH_REQUIRED=1` + `OPERATOR_TOKEN` hardening for staging.
- SIP trunk purchase (Exotel/Plivo virtual DID, NOT an eSIM) + public host
  (UDP 5060, 10000–20000) for PSTN; trunk template ready at
  `infrastructure/asterisk/pjsip.d/20-trunk.conf.example`.
- Compose postgres is record-store-only (no PostGIS in pgvector image);
  geo/vector search is Neon-tier (clear 400s returned otherwise).

## 7. Key files

- `apps/api/src/index.ts|pgstore.ts|store.ts|sync.ts|auth.ts`
- `services/ai-engine/src/pipeline|llm|sarvam|correlate|geocode|embeddings.*`
- `services/media-gateway/src/index|session|saaras|ari.*`
- `services/ingestion-worker/src/queue|pipeline|verify.*`
- `infrastructure/asterisk/*`, `docker-compose.yml`, `database/migrations/*`
