# Asterisk telephony foundation (spec §6) — Phase 3

Asterisk owns SIP/telephony only: PJSIP trunk, dialplan switching, ARI call
control, External Media streaming. Application intelligence stays in
`services/media-gateway` + `services/ai-engine`. Nothing in the dialplan
decides incidents, priorities or dispatches.

## Files

| File | Purpose |
|---|---|
| `pjsip.conf` | Transports + local softphone extensions `1000/1001/1002` (no provider needed) |
| `pjsip.d/20-trunk.conf.example` | Provider trunk template → copy to `20-trunk.conf` (git-ignored) at deploy |
| `extensions.conf` | `1001↔1002` intercom (direct Dial) + `9000/1000` → `rakshak-emergency` → `Stasis(rakshak,…)`. Switching only. |
| `ari.conf` | ARI user `rakshak-gateway` for the media gateway (password injected at deploy) |
| `http.conf` / `rtp.conf` | ARI HTTP on 8088; RTP range 10000–10100 (matches compose ports) |

## Bring-up (single host, Docker)

1. Create the secret includes (git-ignored):
   - `pjsip.d/10-trunk-auth.conf` — real `[trunk-auth]` password + host
   - `ari.d/10-password.conf` — real `[rakshak-gateway]` password
2. Mount this directory read-only into the Asterisk container and
   `envsubst` the `${VAR:-default}` placeholders at container start.
3. Point `RAKSHAK_MEDIA_WS` at the gateway (`ws://media-gateway:3002/gateway/audio`).
4. Register two real phones (Linphone, same WiFi) as `1001` / `1002` and
   dial each other, or dial `9000` for the emergency test line
   (needs the gateway ARI client — Phase 4).

## Two real phones, same WiFi (free, no provider)

Phones use the host's mDNS name (survives DHCP/WiFi moves — never use a raw
IP, it rots). After changing WiFi, just restart the asterisk container; no
config edits needed. Current host: `ROLEXHQ.local` (= `192.168.1.52` today).

| Linphone field | Phone 1 | Phone 2 |
|---|---|---|
| Username | `1001` | `1002` |
| Password | `rakshak-phone-1` | `rakshak-phone-2` |
| Domain | `10.238.252.229` | `10.238.252.229` |
| Port / Transport | `5060` / UDP | `5060` / UDP |

Then: phone 1 dials `1002` (intercom), either phone dials `9000`
(emergency line → ARI app `rakshak`). Verify on the box:
`docker exec <asterisk> asterisk -rx "pjsip show endpoints"`.

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

Recording: both `rakshak-incoming` (PSTN DID path) and `rakshak-emergency`
`MixMonitor(rakshak-${UNIQUEID}.wav)` before `Stasis`, landing in the default
spool dir `/var/spool/asterisk/monitor` (setup.sh guarantees it, `asterisk` user).

Operator audio separation (9002 join leg vs caller leg) is gateway-driven via
the ARI bridge — no dialplan change needed for it.
