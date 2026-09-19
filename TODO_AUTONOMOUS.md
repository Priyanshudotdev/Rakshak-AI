# TODO_AUTONOMOUS — continuous improvement queue

> Agent: read `AUTONOMOUS.md` for the loop contract. Pick top `- [ ]`, do it,
> validate, flip to `- [x]` with test evidence, append discoveries under `## Discovered`, repeat.
> Human: add items anytime. Agent must not delete human items, only check them off with evidence.
> Stop the loop by creating file `AUTONOMOUS.STOP` or pressing Ctrl+C in the runner terminal.

## Queue (agent works top-down, one at a time)

- [ ] Typecheck + unit sweep: run `npm run typecheck` and `vitest run` for `@rakshak/ai-engine`, `@rakshak/media-gateway`, `@rakshak/ingestion-worker`, `@rakshak/api`, dashboard; record failures as new items under Discovered
- [ ] Harden API input validation: audit every `/api/*` route in `apps/api/src` for missing zod schema / unvalidated query params; add schemas + tests
- [ ] Auth/session audit: verify operator auth (bcrypt, session expiry, rate-limit on login) has tests; fix gaps without breaking existing flows
- [ ] Ingestion robustness: RSS fetch timeouts, SSRF allowlist, BullMQ direct-mode fallback covered by tests; add missing cases
- [ ] Media-gateway WS safety: auth on socket, max payload / backpressure, clean disconnect; add or fix tests
- [ ] AI-engine fallback: Sarvam/Gemini down → keyword-rules path must stay green offline; add regression test with keys unset
- [ ] Secrets hygiene: `rg -n "SARVAM|GEMINI|DATABASE_URL|password|secret|token" apps services packages --glob '!node_modules'` — remove any hardcoded value, ensure `.env.example` documents without real secrets
- [ ] Dead code + TODO sweep: resolve or file every `TODO|FIXME|HACK|@ts-ignore` with a test or a Discovered entry
- [ ] Docs drift: reconcile `docs/TECH_SPEC_V2.md` + `README.md` with actual ports, scripts, and env vars; fix mismatches
- [ ] Perf pass: find N+1 DB queries, unbounded `SELECT *`, missing pagination on `/api/records`, `/api/audit`, `/api/events/recent`; cap with limit/offset + test

## Discovered (agent appends here, newest at bottom)

- [ ] (example — delete me) Verify `npm run selftest` passes against local API on :3001 once API is up

## Done log (agent appends: date, item, files, tests)

(none yet)
