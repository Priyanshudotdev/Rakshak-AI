#!/usr/bin/env bash
# voice-setup.sh — deploy apps/api + services/media-gateway natively on the
# voice box (Ubuntu 24.04, same host as Asterisk). Idempotent: re-runs on
# every push touching the voice tree.
#
# Layout: /opt/rakshak/src (tracked files only, via git archive — never .env),
# services run as the `asterisk` user so the gateway can write TTS wavs where
# Asterisk plays them from. Everything voice stays on loopback; only
# SIP(5060/udp)+RTP(10000-10009/udp) are public (security group).
#
# Env (from CI secrets / operator):
#   SARVAM_API_KEY, GEMINI_API_KEY, DATABASE_URL (required)
set -euo pipefail

: "${SARVAM_API_KEY:?set SARVAM_API_KEY}"
: "${GEMINI_API_KEY:?set GEMINI_API_KEY}"
: "${DATABASE_URL:?set DATABASE_URL}"

STAGE=/tmp/voice-deploy
DST=/opt/rakshak/src
TTS_DIR=/usr/share/asterisk/sounds/en/tts
DATA_DIR=/var/lib/rakshak/data

log() { echo "[voice] $*"; }

# --- 1. Node 20 ---------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  log "installing nodejs 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
else
  log "node present: $(node -v)"
fi

# --- 2. Sync tree --------------------------------------------------------------
if [ ! -f "$STAGE/package.json" ]; then
  echo "[voice] FATAL: staged tree missing at $STAGE" >&2
  exit 1
fi
rm -rf "$DST"
cp -a "$STAGE" "$DST"
chown -R asterisk:asterisk /opt/rakshak

# --- 3. Install + build (dep order; dashboard/worker ship but never build) ----
cd "$DST"
log "npm ci (all workspaces, ~2-4 min on 1 vCPU)..."
sudo -u asterisk npm ci --no-audit --no-fund
for w in @rakshak/types @rakshak/events @rakshak/config @rakshak/logger @rakshak/ai-engine @rakshak/api @rakshak/media-gateway; do
  log "building $w..."
  sudo -u asterisk npm run build --workspace "$w" --if-present
done
test -f apps/api/dist/index.js || { echo "[voice] FAIL: api build missing" >&2; exit 1; }
test -f services/media-gateway/dist/index.js || { echo "[voice] FAIL: gateway build missing" >&2; exit 1; }

# --- 4. Env files (python-quoted: values may contain $, quotes, !) -------------
python3 - <<'EOF'
import os
api = {
    "PORT": "3001",
    "DATABASE_URL": os.environ["DATABASE_URL"],
    "SARVAM_API_KEY": os.environ["SARVAM_API_KEY"],
    "GEMINI_API_KEY": os.environ["GEMINI_API_KEY"],
    "DATA_DIR": "/var/lib/rakshak/data",
}
gw = {
    "PORT": "3002",
    "API_URL": "http://127.0.0.1:3001",
    "REALTIME": "saaras",
    "SARVAM_API_KEY": os.environ["SARVAM_API_KEY"],
    "ARI_URL": "http://127.0.0.1:8088",
    "GATEWAY_RTP_HOST": "127.0.0.1",
    "GATEWAY_RTP_BASE": "17777",
    "TTS_FILE_DIR": "/usr/share/asterisk/sounds/en/tts",
}
for path, mapping in (("/opt/rakshak/api.env", api), ("/opt/rakshak/gateway.env", gw)):
    with open(path, "w") as f:
        for k, v in mapping.items():
            f.write(f"{k}={v}\n")
print("[voice] env files written")
EOF
chmod 600 /opt/rakshak/api.env /opt/rakshak/gateway.env
chown asterisk:asterisk /opt/rakshak/api.env /opt/rakshak/gateway.env

# --- 5. Shared dirs -------------------------------------------------------------
mkdir -p "$TTS_DIR" "$DATA_DIR"
chown asterisk:asterisk "$TTS_DIR" "$DATA_DIR"

# --- 6. systemd ------------------------------------------------------------------
install -m 644 "$DST/infrastructure/vps/rakshak-api.service" /etc/systemd/system/rakshak-api.service
install -m 644 "$DST/infrastructure/vps/rakshak-gateway.service" /etc/systemd/system/rakshak-gateway.service
systemctl daemon-reload
systemctl enable --now rakshak-api >/dev/null 2>&1 || systemctl restart rakshak-api
systemctl enable --now rakshak-gateway >/dev/null 2>&1 || systemctl restart rakshak-gateway
sleep 10

# --- 7. Verify --------------------------------------------------------------------
fail=0
systemctl is-active --quiet rakshak-api && log "OK api service active" \
  || { echo "[voice] FAIL: rakshak-api not active" >&2; fail=1; }
systemctl is-active --quiet rakshak-gateway && log "OK gateway service active" \
  || { echo "[voice] FAIL: rakshak-gateway not active" >&2; fail=1; }
curl -fsS -m 10 http://127.0.0.1:3001/api/health | head -c 300; echo \
  && log "OK api /api/health answers" \
  || { echo "[voice] FAIL: api health" >&2; fail=1; }
curl -fsS -m 10 http://127.0.0.1:3002/health | head -c 300; echo \
  && log "OK gateway /health answers" \
  || { echo "[voice] FAIL: gateway health" >&2; fail=1; }
log "--- gateway log tail (ARI link?) ---"
journalctl -u rakshak-gateway --no-pager -n 15 || true
if [ "$fail" -ne 0 ]; then
  journalctl -u rakshak-api --no-pager -n 30 >&2 || true
  exit 1
fi
log "VOICE GREEN — api+gateway live on loopback, ARI app should be subscribed"
