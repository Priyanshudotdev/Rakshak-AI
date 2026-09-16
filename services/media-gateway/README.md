# @rakshak/media-gateway — realtime audio transport (replay mode)

Transport + sessions only. No incident-intelligence logic lives here (spec §7);
audio is forwarded to the API, which emits `incident.*` / `priority.*` events.

## Run

```bash
PORT=3002 API_URL=http://localhost:3001 npm run dev --workspace @rakshak/media-gateway
GET /health -> { status, service, mode: "replay", sessions }
```

## WS protocol — `/gateway/audio?callId=CALL_xxx`

Text frames are JSON, binary frames are audio chunks (any codec `/api/process-audio` accepts).

| Frame | Effect |
|---|---|
| `{type:"start", callId?, from?, to?}` | (re)start session → `call.answered` |
| `{type:"partial", text, language?}` | relay live partial → `transcript.partial` |
| `{type:"finalize", filename?}` | process buffered audio via `POST /api/process-audio?callId=` → `transcript.final` (+ `incident.created` / `priority.updated` from the API, same call id) |
| `{type:"tts-stop"}` | barge-in: caller spoke over TTS → `speech.started{barge_in:true}` |
| `{type:"end", reason?}` | `call.ended` + close |

Connect auto-starts the session and emits `call.started`.
Guards: 200-session cap (close 1008), 20 MB/session buffer (close 1009),
60 s idle sweep → `call.ended{reason:idle-timeout}`, 30 s WS heartbeat.

## Realtime STT (Asterisk phase)

Set `REALTIME=saaras` only when the Saaras Realtime session is wired
(`src/saaras.ts` throws until then). Until that phase, partials come from
the connected client (mic agent / Asterisk shim) — nothing is faked.
