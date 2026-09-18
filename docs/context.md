# Rakshak AI — full session context (2026-09-18, feat/v2-architecture)

Branch: `feat/v2-architecture` (all work). `master` frozen as stable fallback.
Flask prototype read-only in `legacy/`. Spec: `docs/TECH_SPEC_V2.md`.
Glossary: `docs/basics.md`. Pillars: COMMUNICATE → UNDERSTAND → CORRELATE.
Human-in-the-loop, no autonomous dispatch.

## 1. Where the system runs now (AWS, not Docker)

- Voice box: EC2 `t2.small` (1 vCPU, 2 GB), Ubuntu 24.04, region
  `ap-south-1` (Mumbai). Instance `i-0eb21521cc7e87a82`, key `rakshak-rakshak`.
- Elastic IP (static): `52.66.170.226`. SG `launch-wizard-2`: SSH 22 open
  (needed for GitHub runners), UDP 5060 + UDP 10000–10009 + TCP 3001 open.
  Orphan SG `launch-wizard-1` from a failed launch — delete when convenient.
- On the box (all loopback, nothing else public): Asterisk 20 (SIP/RTP),
  `rakshak-api` (:3001, systemd), `rakshak-gateway` (:3002, systemd).
  ARI `127.0.0.1:8088`, RTP fork base `17777`, TTS dir
  `/usr/share/asterisk/sounds/en/tts`, recordings
  `/var/spool/asterisk/monitor/`.
- PSTN: VoiceLink DID `919429397596` → trunk `rakshak-ai` → `52.66.170.226:5060/UDP`,
  G.711 both, inbound route active. VoiceLink source observed: `160.30.71.89:3300`
  (identify match `160.30.71.0/24`).
- Neon Postgres (cloud): app tables + `operator_profiles` + `call_translation`
  (migration 006). Sarvam + Gemini keys in GitHub Secrets, never in repo/chat.
- CI/CD (GitHub Actions, serialized via `concurrency: vps`):
  `deploy-asterisk.yml` (configs → setup.sh, verify) +
  `deploy-voice.yml` (git archive → voice-setup.sh, build, systemd, verify).
  Secrets: VPS_HOST/VPS_USER/VPS_SSH_KEY + SARVAM/GEMINI/DATABASE_URL.
- Laptop public IP (home): `45.116.149.217` (dynamic — re-check).
  Local dev: dashboard `:3000`, console `:3005`, API targets VPS via
  `NEXT_PUBLIC_API_URL=http://52.66.170.226:3001` (`.env.local`, git-ignored).
- WSL2 Ubuntu-24.04 exists with native Asterisk (fallback path, idle).
- Billing watch: t2.small ~$0.55/day — STOP the instance when idle; zero-spend
  budget alarm set. vCPU limit increase requested (for future t3.micro).

## 2. What works live (verified with real calls)

- PSTN inbound: mobile → DID → trunk → Asterisk (was 401-no-endpoint, fixed
  with `pjsip.d/10-provider.conf`) → Stasis(rakshak) → Marathi greeting.
  50 s test call, clean BYE/200.
- AI loop: Saaras v3-realtime STT partials + finals, Marathi TTS replies via
  file playback, incident pipeline. First full loop done on a 140 s live call
  (final → English ack "got it").
- Softphone echo `9001` via MicroSIP→VPS (free audio-path test).
- Box→Sarvam proven independently: `scripts/saaras-probe.mjs --tts` from the
  box yields vad + partials + final in ~2 s.
- Pipelines green; box SIP-probed 401-alive repeatedly.
- Dashboards: old dark dashboard (localhost:3000) + new light console
  (localhost:3005, `@rakshak/console`, Sarvam-inspired, all routes build).

## 3. Operator translation platform (phases 1–3 shipped, test pending)

- Policeman dials the SAME DID from his mobile → CLI whitelist lookup
  (`normalizeCli` ≡ API normalize, both strip/+91) → operator flow; strangers
  → emergency flow. Lookup failures fail CLOSED to caller flow. Legacy `9002`
  softphone join kept.
- Profile: known_languages[] + default_language + mobile_e164 (dashboard card,
  migration 006, dual-store). Toggle per call, default OFF, operator flips it;
  dashboard nudge (`translation.suggested`) on mismatch.
- Audio separation: operator channel never joins caller bridge; directional
  TTS renditions both ways (translation-only). Per-leg snoop taps
  (`spy=in`) so STT never hears our own TTS. Waiting room with hold message.
- Language fallback: finals below 0.6 confidence fall back to call tongue /
  Marathi default (fixes English misdetect of Marathi @ 0.4).
- Audit: translation/operator events auto-audited (both backends).
- Bilingual transcript, waiting banner, role guards, translation history in UI.

## 4. OPEN ISSUES (ordered)

1. **Fan-noise endpointing (demo risk):** test room has 2 high-speed fans;
   fork audio is 100% loud, zero silence → VAD never endpoints → ~1 final
   per 70+ s. Not Sarvam's speed (1–3 s after speech end, proven). Mitigations
   shipped: VAD knob exposure (defaults = server), confidence fallback.
   MUST-DO: retest with fans OFF/low to validate the clean loop; noisy-room
   robustness (gate/AGC/endpoint tuning) is a follow-up, not today's blocker.
2. **Snoop taps untested against real Asterisk** (unit-tested only). First live
   call after deploy: watch for `fork setup failed` / zero partials.
3. **Reply language**: Marathi caller got English ack (misdetect, fallback now
   covers). Confirm Marathi replies in clean-audio test.
4. **No DTMF PIN fallback**: suppressed-CLI operator → misclassified as caller.
5. **Dashboard reachability**: both UIs run on the laptop; policeman has no
   remote console. Options: VPS+Caddy (recommended) / Vercel / Tailscale.
6. **Secrets/auth hardening** (queued, from audit): test creds as defaults,
   open API routes, `allowed_origins=*`, no TLS, ARI key in query strings.
   Time-box public exposure; restrict/remove after demo.
7. **Cost/discipline**: stop instance when idle; recordings/TTS/journals grow
   unbounded (no janitor); per-final AI fan-out has no budget guard.
8. Kernel reboot pending (`System restart required` banner) — do AFTER demo
   path is green, never mid-test.
9. MicroSIP gotcha: minimizes to tray holding UDP 5060; stale `.env.local`
   / dev-server restarts needed for env changes.

## 5. Test scoreboard (all green at push)

- api 77 (incl. events audit + app contract tests), gateway 73 (incl. snoop,
  toggle, diagnostics), dashboard 39, console typecheck+build clean.
- ai-engine/worker suites untouched this session (were green).
- Live probes: SIP 401s, `/api/health` ok (sarvam/gemini/postgres), CORS ACAO
  for localhost:3000, ARI stable 19+ min, `VOICE GREEN` + `PROVISION GREEN`.

## 6. Key files

- `services/media-gateway/src/ari.ts` (routing, forkMedia, snoop, waiting room),
  `conversation.ts` (rendition policy, fallback), `saaras.ts` (VAD knobs,
  confidence, send tripwire), `index.ts` (env: ARI_URL, RTP host/base, TTS dir).
- `apps/api/src/app.ts` (routes; was index.ts), `events.ts` (audit),
  `stores.ts|pgstore.ts|store.ts|db.ts`, `database/migrations/006_*`.
- `apps/console/**` (new light console: shell/login/onboarding/home/live,
  live/[callId], incidents, history, analytics, settings, lib/api|live|prefs).
- `apps/dashboard/**` (old console, still maintained).
- `infrastructure/asterisk/{pjsip.conf,extensions.conf,ari.conf,http.conf,rtp.conf,pjsip.d/10-provider.conf}`,
  `infrastructure/vps/{setup.sh,voice-setup.sh,rakshak-*.service}`.
- `.github/workflows/deploy-{asterisk,voice}.yml`.
- `scripts/saaras-probe.mjs` (STT session check), `scripts/rtp-analyze.mjs`
  (pcap/wav forensics), `scripts/operator-reset.mjs` (box-side admin recovery),
  `scripts/selftest.mjs`.
- `.gitattributes` forces LF for sh/service/yml/conf (CRLF broke Ubuntu once).

## 7. Credentials & hygiene (NO VALUES HERE — ever)

- All secrets live in: git-ignored laptop `.env`, GitHub repo Secrets,
  `/opt/rakshak/*.env` on the box (600, asterisk user). Nothing in repo/chat.
- Test SIP passwords + ARI password are test-only defaults; rotate before any
  production use. Demo console password `admin@9900` set via operator-reset —
  replace with a strong password post-demo.
- Never paste: API keys, Neon URL, .pem contents, passwords, full .env.

## 8. Standing procedures

- Config change → commit → push → watch pipeline (asterisk ~2 min, voice
  ~10 min first run) → verify (`PROVISION GREEN` / `VOICE GREEN`) → test.
- No two deploys overlap (concurrency group); no infra edits mid-test.
- Pasted third-party diagnoses are 50/50: verify each claim against repo/log
  before applying (they once prescribed a nonexistent context + stale runs).
- `asterisk -rx` single shots flake on 1 vCPU — `arix()` retry helper exists
  in setup.sh; voice-setup health checks are still single-shot (known gap).
- Browser terminal (EC2 Instance Connect) is the box eyes: journalctl,
  tcpdump, node scripts. `tail -2xxx` paste accidents: Ctrl+C for clean prompt.
- Two-phone test script + report format: agreed flow is profile → caller call
  → operator call → nudge → toggle ON → converse → toggle OFF → transcript/
  audit check. Trial channels must allow 2 concurrent legs — verify.
