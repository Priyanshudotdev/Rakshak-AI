# Phase-1 Flask prototype — frozen reference (read-only)

This directory holds the original `master` MVP verbatim (moved via `git mv` so history is preserved):

- `app.py` — Flask REST (`/api/process-call`, `/api/process-audio`, `/api/records`, `/api/tts`, `/api/dispatch`)
- `pipeline.py` — Sarvam STT/translate → Gemini extract → priority overlay → Bulbul TTS
- `memory.py` — `data/records.json` + `dispatch_log.json` persistence
- `static/` + `templates/` — 3-tab dashboard

Do not modify. All V2 work happens in `apps/`, `services/`, `packages/`, `database/`, `infrastructure/`.
Run legacy locally only if needed: `pip install -r legacy/requirements.txt && python legacy/app.py`.
