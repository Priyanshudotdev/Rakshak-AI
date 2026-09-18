# Rakshak AI — Basics: jargon A to Z with examples

Every term we use in this project, in plain words, each with a concrete
example from our own setup. Cross-references point to the real files.

---

## A

**AI Engine** — Our core intelligence service (`services/ai-engine`). Takes a
transcript and returns structured incident data (type, location, priority).
*Example: Marathi text in → `{ incident_type: "Fire", location: "Sitabuldi market", priority: "HIGH" }` out.*

**API (REST)** — Our Fastify server (`apps/api`) that speaks HTTP + JSON.
*Example: `POST /api/process-call` with `{"transcript": "..."}` returns `{"status": "success", "data": {...}}`.*

**ARI (Asterisk REST Interface)** — Lets our code control live phone calls
(answer, bridge, play audio, hang up) over HTTP/WebSocket.
*Example: when you dial `9000`, the dialplan runs `Stasis(rakshak,…)` and our
media gateway takes over that call through ARI.*

**Asterisk** — Free, open-source software that acts as a **telephone exchange
(PBX)**. It receives SIP calls and routes them. It knows nothing about AI.
*Example: runs as the `asterisk` service in our docker-compose; your Linphone
registers to it.*

**Audit log** — A permanent diary of who did what (`api_audit_log` table).
*Example: `{ actor: "priya", action: "dispatch", entity_id: "LIVE-123" }`.*

**Authentication (auth)** — Proving *who you are* (login with password).
Different from authorization (what you're allowed to do).
*Example: `POST /api/operators/login` returns a token; first registered user
becomes `admin`.*

## B

**Bearer token** — A secret string sent in the `Authorization: Bearer <token>`
header to prove you're signed in.
*Example: dashboard stores it as `rakshak.token` and sends it on every
dispatch/delete call.*

**Barge-in** — Caller interrupts the system's spoken reply; the system stops
talking and listens. Essential for natural emergency calls.
*Example: TTS is playing "madat pathvat aahe…" and you shout "thamba!" →
`tts-stop` event → audio stops.*

**bcrypt** — A password-hashing algorithm. We store hashes, never passwords.
*Example: `password_hash` column holds `$2b$10$…`, login compares with
`bcrypt.compare`.*

**BullMQ** — A job-queue library on top of Redis. Slow background work goes
here so live calls never wait.
*Example: queues `extraction → classification → … → notification`; proven in
`redis` mode inside our containers.*

**Bulbul** — Sarvam's text-to-speech (TTS) product.
*Example: `POST /api/tts {"text": "madat pathvat aahe"}` returns Marathi audio.*

## C

**Callsign** — The operator's display name used in the audit trail.
*Example: the Dispatch panel's "Callsign" box; sent as the `x-operator` header.*

**Codec (ulaw/alaw)** — How voice is compressed on phone lines (8 kHz,
telephone quality). Both phones and Asterisk must agree on one.
*Example: our `pjsip.conf` has `allow = ulaw,alaw`.*

**Correlation** — Deciding that *two different reports describe the same real
incident* (text overlap + location + time + type + geo signals, ≥ 0.55).
*Example: a call about "Sitabuldi fire" + an RSS report "Fire at Sitabuldi
market" scored 0.65 → attached as evidence, not a new incident.*

**Cron / polling** — The ingestion worker re-checks RSS feeds every few
minutes (`POLL_MS`).
*Example: `RUN_ONCE=1` runs one poll and exits (our smoke test).*

## D

**Dashboard** — The operator's web screen (`apps/dashboard`, Next.js).
*Example: open `http://127.0.0.1:3005` → intake, records, workspace, dispatch,
analytics tabs.*

**Dialplan** — Asterisk's call-routing script (`extensions.conf`). Switching
only — no AI here.
*Example: `exten = 1002 → Dial(PJSIP/1002)`; `exten = 9000 → Stasis(rakshak)`.*

**DID (Direct Inward Dialing)** — A real phone number rented from a provider
that routes calls to your server.
*Example: what you'd buy from Exotel/Plivo (~₹100–300/month) so anyone can
call Rakshak from a normal dialer.*

**Direct mode** — Ingestion worker fallback when Redis is unreachable: jobs
run inline instead of queuing. Same pipeline, zero infrastructure.
*Example: local smoke test logs `"mode":"direct"`.*

**Dispatch** — A human operator assigning real-world units to an incident.
AI only *recommends*; humans dispatch.
*Example: `POST /api/dispatch {"call_id": "LIVE-1", "units": "Fire tender 3"}`.*

**Docker / compose** — Containers (mini-computers) for each service, started
together by `docker-compose.yml`.
*Example: `docker compose up --build -d` runs api, postgres, redis, gateway,
worker, dashboard, nginx, asterisk.*

## E

**Embedding** — Text turned into a list of 1536 numbers capturing *meaning*;
similar meanings → nearby numbers. Enables semantic search.
*Example: "shop on fire" scores 0.744 against a Fire incident via pgvector.*

**Endpoint (SIP)** — A phone/user account on Asterisk (number + password).
*Example: `1001` / `1002` for your two Linphones; `pjsip show endpoints`.*

**eSIM** — A SIM card built into the phone (no plastic). Still just a mobile
number — it **cannot** route calls to a server.
*Example: buying an eSIM does NOT give Rakshak a callable number; a virtual
DID from Exotel does.*

**Event bus** — Live message stream: services publish events, dashboards
subscribe over WebSocket.
*Example: `transcript.final → incident.created → priority.updated`;
`GET /api/stream`.*

**Extension** — A short internal number dialed inside your phone system
(not a real phone number).
*Example: dial `1002` or `9000` from Linphone.*

**External Media** — Asterisk feature that forks call audio (RTP) to an
outside app for processing.
*Example: the future path feeding live caller audio to the media gateway.*

## F

**Fastify** — The Node.js web framework our API uses (fast JSON REST).
*Example: `apps/api/src/index.ts` defines all `/api/*` routes.*

**Fallback** — When AI fails, deterministic rules answer instead of crashing.
*Example: LLM down → `fallbackExtract` still returns type/location; marked
`llm_used: "rules"`.*

## G

**Gateway (media gateway)** — `services/media-gateway`: moves audio between
Asterisk and speech AI, owns call sessions. No incident logic inside.
*Example: `:3002/gateway/audio` WebSocket; health at `:3002/health`.*

**Gemini** — Google's LLM; our backup extractor + embedding provider.
*Example: extraction via `gemini-2.5-flash`; vectors via
`gemini-embedding-001` (1536 dims).*

**Geocode** — Text place → coordinates (`Nominatim`/OSM, free, no key).
*Example: `"Ramdaspeth, Nagpur"` → `{ lat: 21.136, lon: 79.074 }`, stored as
`extraction.geo`, drawn on the dashboard map.*

**GSM gateway** — A box (or spare phone + app) holding a SIM that bridges
mobile calls to SIP. A hacky way to use an eSIM with Asterisk.
*Example: GOIP box ~₹8–15k; works for demos, not production.*

## H

**Health check** — A tiny endpoint proving a service is alive.
*Example: `/api/health` → `{ status: "ok", sarvam: true, gemini: true,
store: "postgres" }`; compose uses them to order startup.*

**Human-in-the-loop** — AI recommends, humans decide. Never violated.
*Example: priority says HIGH; only the operator presses dispatch.*

## I

**Incident** — One real-world emergency, possibly built from many reports.
*Example: `LIVE-CF3841C9` (Fire, Sitabuldi market) + 1 RSS report =
`multiple_reports`.*

**Ingestion worker** — `services/ingestion-worker`: eats RSS/news feeds and
correlates them against call incidents.
*Example: `RUN_ONCE=1 RSS_FIXTURE=<xml>` smoke run.*

**Intercom** — Direct phone-to-phone call inside Asterisk (no AI involved).
*Example: phone `1001` dials `1002`.*

## J

**JSON** — The text format all our APIs speak.
*Example: `{"status": "success", "data": {...}}`.*

## L

**Linphone** — Free, open-source SIP phone app for Android/iPhone.
*Example: registers as `1001`/`rakshak-phone-1` to `10.238.252.229:5060`.*

**LLM (Large Language Model)** — AI that reads/writes text (Sarvam-105b,
Gemini). Never touches dispatch directly.
*Example: turns "aag lagli" into `{ incident_type: "Fire", … }`.*

## M

**Map (OSM embed)** — Dashboard shows an OpenStreetMap frame when a record
has coordinates.
*Example: Ramdaspeth record → map pin at 21.136, 79.074.*

**Migration** — Numbered SQL files (`database/migrations/`) that build the
database step by step. Never edit an applied one; add a new file.
*Example: `005_operator_auth.sql` added logins on top of `001–004`.*

**Monorepo** — One git repo holding all services (`apps/*`, `services/*`,
`packages/*`).
*Example: this whole project; shared types in `packages/types`.*

## N

**NAT** — Home/office routers hide devices behind one public IP; phones
register *outbound* so no router holes are needed.
*Example: Linphone on WiFi reaches Asterisk on the PC with zero router setup.*

**Neon** — Our hosted Postgres in the cloud (holds live data).
*Example: `DATABASE_URL` points here; has PostGIS + pgvector + all migrations.*

**Next.js** — React framework for the dashboard (server render + build).
*Example: `npm run build --workspace apps/dashboard` → 105 kB console.*

**Nominatim** — Free OpenStreetMap geocoding API (1 req/sec, needs a
User-Agent, no key).
*Example: used by `services/ai-engine/src/geocode.ts` with caching.*

**Normalization** — Copying the free-form record JSON into proper relational
tables (`calls/transcripts/incidents/…`).
*Example: `POST /api/admin/sync-normalized` → `{ synced: 11 }`.*

## O

**Operator** — The trained human answering emergencies via the dashboard.
*Example: first registered account (`priya`) is `admin`; audit rows carry the
actor name.*

**OSM (OpenStreetMap)** — Free, community-built world map (+ Nominatim
geocoder above).
*Example: dashboard map iframe + "Open location in OpenStreetMap ↗" link.*

## P

**Partial transcript** — Live, in-progress STT text that keeps updating while
the caller speaks (vs `final`, settled at turn end).
*Example: `सी → सीता → सीताबडी → सीताबडी मार्केटजवळ आग लागली आहे` streamed
58 times before the final.*

**PBX** — Private telephone exchange = Asterisk's job.
*Example: our Asterisk box.*

**pgvector** — Postgres extension for similarity search over embeddings.
*Example: `POST /api/incidents/similar` ranks by `embedding <=> query`.*

**PJSIP** — Asterisk's modern SIP stack (replaces old chan_sip).
*Example: everything in `pjsip.conf`; check with `pjsip show endpoints`.*

**PostGIS** — Postgres extension for maps/geo queries.
*Example: `GET /api/incidents/nearby?lat=21.14&lon=79.07` → hits @641 m.*

**Postgres** — Our main database (Neon in cloud, `pgvector/pgvector:pg16` in
compose).
*Example: `/api/health` reports `store: "postgres"` when reachable, else the
file store.*

**Priority** — AI's urgency recommendation with reasons, never an order.
*Example: `HIGH — "Two people potentially trapped"`; operator still decides.*

**PSTN** — The public phone network (Jio/Airtel/Vi). Reaching it needs a paid
trunk; SIP softphones bypass it over the internet.
*Example: Linphone-to-Linphone = free; dialer-to-Rakshak needs a DID.*

## Q

**Queue** — See BullMQ. Background jobs; never on the live audio path.
*Example: `extraction` queue carries RSS reports to the correlator.*

## R

**RBAC (role-based access control)** — Permissions by role (`admin` vs
`operator`). Only admins can register new operators.
*Example: `403 "Admin role required"`.*

**Realtime (Saaras)** — Sarvam's WebSocket STT: partials *while* you speak.
*Example: `SaarasRealtimeAdapter` (`REALTIME=saaras`), proven live with 58
Marathi partials.*

**Redis** — In-memory store used for BullMQ queues (and ephemeral state).
*Example: `redis` service in compose; worker logs `"mode":"redis"`.*

**RTP** — Protocol carrying actual voice packets (UDP 10000–10100 here).
SIP sets up the call; RTP carries the sound.
*Example: compose publishes `10000-10100:10000-10100/udp` for phone audio.*

## S

**Saaras** — Sarvam's speech-recognition (STT) product line (batch `v3`,
streaming `v3-realtime`).
*Example: batch transcribes uploaded files; realtime streams partials.*

**Sarvam** — Indian AI company; our speech provider (STT/translation/TTS).
*Example: needs `SARVAM_API_KEY` + `api-subscription-key` header.*

**Session** — One call leg's state (audio buffer, TTS flag, idle timer).
*Example: `SessionManager` caps at 200 sessions, sweeps idle ones.*

**SIP** — The signalling protocol phones use to call ("ring 1002", "hang up").
Audio itself rides RTP.
*Example: Linphone → `10.238.252.229:5060` UDP.*

**STT (speech-to-text)** — Audio → words.
*Example: Marathi TTS audio → `सीताबडी मार्केट जवळ आग लागली आहे`.*

**Stasis** — Dialplan command handing a live call to an ARI app.
*Example: `same = n,Stasis(rakshak,9000,1001)`.*

## T

**Transcription + translation** — We keep the *original* words AND English +
Marathi versions; translation never replaces the original.
*Example: `transcript_original` (Marathi) + `transcript_english` side by side.*

**Trunk** — Asterisk's connection to a phone provider (carries the paid DID).
*Example: template at `pjsip.d/20-trunk.conf.example`; not mounted until you
buy a number.*

**TTS (text-to-speech)** — Words → spoken audio (Sarvam Bulbul, `mr-IN`).
*Example: operator reply → calm Marathi voice on the caller's phone.*

## U

**ulaw** — See Codec. North-America/Japan phone standard; ours allows it.
*Example: `allow = ulaw,alaw`.*

## V

**Verification ladder** — Trust levels: `unverified → multiple_reports →
corroborated → officially_confirmed` (last step is operators only).
*Example: 1 RSS match → `multiple_reports, reports: 2` on the incident card.*

## W

**WebSocket (WS)** — A persistent two-way connection (vs one-shot HTTP).
Used for live audio + live dashboard events.
*Example: gateway `/gateway/audio?callId=…`; dashboard `/api/stream`.*

**Worker** — See Ingestion worker.

## X

**x-operator** — HTTP header carrying the callsign for the audit trail when no
login token is present.
*Example: dashboard sends it on dispatch/delete; server falls back to it
behind a valid Bearer token.*

## Z

**Zod** — The library validating every API input (wrong shape → 400, never a
crash).
*Example: `processCallSchema` rejects empty transcripts with
`"Transcript is required"`.*
