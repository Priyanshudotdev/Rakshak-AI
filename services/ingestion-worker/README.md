# @rakshak/ingestion-worker — multi-source intake (Phase 5)

Polls external reports (RSS today; news/official/citizen connectors next),
extracts with the shared rules engine, correlates against live incidents and
publishes evidence + verification updates. Fully async — never on the live
audio/STT critical path (spec §14).

## Rules that are never bent

- Reports are **evidence, never incidents**. Unverified sources cannot create
  incidents or dispatch anything (§12, §19).
- Matches annotate: `ai.explanation.updated` (score, signals, source) and
  `incident.updated` (verification ladder) on the matched call id.
- Verification ladder: 1 report → `unverified`, 2–3 → `multiple_reports`,
  4+ → `corroborated`. `officially_confirmed` is operator-only.

## Run

```bash
RSS_FEEDS=https://example.com/feed.xml npm run dev --workspace @rakshak/ingestion-worker
# Without Redis it runs in DIRECT mode (inline pipeline, same stages).
# Smoke: RSS_FIXTURE='<rss>…' RUN_ONCE=1 node services/ingestion-worker/dist/index.js
```

Needs `API_URL` (default `http://localhost:3001`) for recent incidents and
the event bus. Queues (`extraction → classification → location-resolution →
incident-correlation → enrichment → notification`) use BullMQ when Redis is
reachable, direct mode otherwise.
