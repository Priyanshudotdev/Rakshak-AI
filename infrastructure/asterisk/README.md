# Asterisk telephony foundation (spec §6) — Phase 3

Asterisk owns SIP/telephony only: PJSIP trunk, dialplan switching, ARI call
control, External Media streaming. Application intelligence stays in
`services/media-gateway` + `services/ai-engine`. Nothing in the dialplan
decides incidents, priorities or dispatches.

## Files

| File | Purpose |
|---|---|
| `pjsip.conf` | Transports, provider trunk (credential placeholders only), test extension `1000` |
| `extensions.conf` | `rakshak-incoming` context → `Stasis(rakshak,…)`, then hangup. Switching only. |
| `ari.conf` | ARI user `rakshak-gateway` for the media gateway (password injected at deploy) |

## Bring-up (single host, Docker)

1. Create the secret includes (git-ignored):
   - `pjsip.d/10-trunk-auth.conf` — real `[trunk-auth]` password + host
   - `ari.d/10-password.conf` — real `[rakshak-gateway]` password
2. Mount this directory read-only into the Asterisk container and
   `envsubst` the `${VAR:-default}` placeholders at container start.
3. Point `RAKSHAK_MEDIA_WS` at the gateway (`ws://media-gateway:3002/gateway/audio`).
4. Register a softphone as `1000` and dial `1000` to exercise the
   SIP leg → ARI → gateway → incident-card loop.

## Security notes (spec §25)

- Trunk/ARI credentials are deploy-time secrets — never committed, never sent
  to the browser, never logged.
- Prefer outbound trunk registration so Asterisk needs no inbound SIP exposure.
- Pin `allowed_origins` in `ari.conf` to the gateway host in production.
- Recordings retention follows the deployment's legal policy; the DB stores
  metadata, audio blobs live in object storage with TTLs.

## Call flow (target)

```
SIP provider ──PJSIP──▶ Asterisk ──Stasis(rakshak)──▶ ARI ──External Media──▶ media-gateway:3002
                                                        │                              │
                                                        │                    Sarvam Saaras Realtime
                                                        │                              │
                                                        └──────── TTS audio ◀──────────┘ (Phase 4)
```
