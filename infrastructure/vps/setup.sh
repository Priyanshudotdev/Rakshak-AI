#!/usr/bin/env bash
# setup.sh — idempotent Asterisk provision for the Rakshak public SIP box
# (Ubuntu 24.04, e.g. AWS EC2 t2.small/t3.micro in ap-south-1).
#
# Run on EVERY deploy (CI runs it on each push touching asterisk configs):
#   1. installs Asterisk 20 from Ubuntu repos if missing, enables the service
#   2. syncs infrastructure/asterisk/*.conf -> /etc/asterisk/ (with one backup)
#   3. applies VPS overrides (Elastic IP as external signaling+media address)
#   4. renders pjsip.d/20-trunk.conf from the example ONLY when TRUNK_* are set
#   5. restarts Asterisk and verifies transports/endpoints/dialplan (fail = red CI)
#
# Env:
#   PUBLIC_IP   (required) Elastic IP of this box, e.g. 52.66.170.226
#   VPC_CIDR    (optional) default 172.31.0.0/16 (AWS default VPC)
#   SRC_DIR     (optional) staged configs, default /tmp/rakshak-deploy/infrastructure/asterisk
#   TRUNK_HOST / TRUNK_USER / TRUNK_PASS (optional) provider trunk; skipped when unset
#
# Phase note: this box hosts Asterisk ONLY for now. Stasis() calls park until
# the media-gateway connects over ARI (SSH tunnel, later step) — 9001 echo and
# dialplan switching work immediately, which is what proves PSTN<->VPS audio.
set -euo pipefail

PUBLIC_IP="${PUBLIC_IP:?set PUBLIC_IP to the box Elastic IP}"
VPC_CIDR="${VPC_CIDR:-172.31.0.0/16}"
SRC_DIR="${SRC_DIR:-/tmp/rakshak-deploy/infrastructure/asterisk}"
TRUNK_HOST="${TRUNK_HOST:-}"
TRUNK_USER="${TRUNK_USER:-}"
TRUNK_PASS="${TRUNK_PASS:-}"

log() { echo "[setup] $*"; }

# --- 1. Asterisk -------------------------------------------------------------
if ! command -v asterisk >/dev/null 2>&1; then
  log "installing asterisk (Ubuntu repos, ~2 min)..."
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq asterisk python3
else
  log "asterisk already installed: $(asterisk -V)"
fi
systemctl enable --now asterisk >/dev/null 2>&1 || true

# --- 2. Sync configs ----------------------------------------------------------
if [ ! -d "$SRC_DIR" ]; then
  echo "[setup] FATAL: staged configs missing at $SRC_DIR" >&2
  exit 1
fi
if [ ! -d /etc/asterisk.dist-orig ]; then
  log "one-time backup of stock configs -> /etc/asterisk.dist-orig"
  cp -a /etc/asterisk /etc/asterisk.dist-orig
fi
mkdir -p /etc/asterisk/pjsip.d /etc/asterisk/ari.d
for f in pjsip.conf extensions.conf ari.conf http.conf rtp.conf; do
  install -o asterisk -g asterisk -m 640 "$SRC_DIR/$f" "/etc/asterisk/$f"
done
# Tracked pjsip.d snippets (e.g. 10-provider.conf). Never touch the example
# template or a rendered 20-trunk.conf holding live secrets.
for f in "$SRC_DIR"/pjsip.d/*.conf; do
  base=$(basename "$f")
  case "$base" in
    *.example|20-trunk.conf) continue ;;
    *) install -o asterisk -g asterisk -m 640 "$f" "/etc/asterisk/pjsip.d/$base" ;;
  esac
done
log "configs synced from $SRC_DIR"

# The repo keeps the trunk in pjsip.d/ (git-ignored) but the base files have no
# #include for it, so without this the trunk file would silently never load.
grep -q '#include "pjsip.d/\*.conf"' /etc/asterisk/pjsip.conf \
  || echo '#include "pjsip.d/*.conf"' >> /etc/asterisk/pjsip.conf
grep -q '#include "ari.d/\*.conf"' /etc/asterisk/ari.conf \
  || echo '#include "ari.d/*.conf"' >> /etc/asterisk/ari.conf
# An #include glob matching zero files can fail the load on some builds —
# guarantee at least one file exists in each include dir.
if ! ls /etc/asterisk/pjsip.d/*.conf >/dev/null 2>&1; then
  echo "; placeholder — trunk rendered here when TRUNK_* are set" > /etc/asterisk/pjsip.d/00-placeholder.conf
fi
if ! ls /etc/asterisk/ari.d/*.conf >/dev/null 2>&1; then
  echo "; placeholder — secret includes land here" > /etc/asterisk/ari.d/00-placeholder.conf
fi
chown -R asterisk:asterisk /etc/asterisk/pjsip.d /etc/asterisk/ari.d

# --- 3. VPS overrides: Elastic IP is what the world sees in SDP ---------------
python3 - "$PUBLIC_IP" "$VPC_CIDR" <<'EOF'
import re, sys
pub, cidr = sys.argv[1], sys.argv[2]
p = "/etc/asterisk/pjsip.conf"
s = open(p).read()
in_t = False
out = []
seen = set()
for line in s.splitlines():
    m = re.match(r"\[(.+)\]", line.strip())
    if m:
        if in_t and "transport-udp" not in seen:
            pass
        in_t = (m.group(1) == "transport-udp")
    if in_t and re.match(r"(external_media_address|external_signaling_address|local_net)\s*=", line):
        key = line.split("=")[0].strip()
        seen.add(key)
        continue  # drop stale value, re-added below
    out.append(line)
    if in_t and line.strip() == "bind = 0.0.0.0:5060":
        if "external_media_address" not in seen:
            out.append(f"external_media_address = {pub}")
            seen.add("external_media_address")
        if "external_signaling_address" not in seen:
            out.append(f"external_signaling_address = {pub}")
            seen.add("external_signaling_address")
        if "local_net" not in seen:
            out.append(f"local_net = {cidr}")
            seen.add("local_net")
open(p, "w").write("\n".join(out) + "\n")
print(f"[setup] transport-udp -> external={pub} local_net={cidr}")
EOF
chown asterisk:asterisk /etc/asterisk/pjsip.conf /etc/asterisk/ari.conf

# --- 4. Provider trunk (optional) ---------------------------------------------
if [ -n "$TRUNK_HOST" ] && [ -n "$TRUNK_USER" ] && [ -n "$TRUNK_PASS" ]; then
  python3 - "$TRUNK_HOST" "$TRUNK_USER" "$TRUNK_PASS" "$SRC_DIR/pjsip.d/20-trunk.conf.example" <<'EOF'
import sys
host, user, pw, src = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
s = open(src).read()
s = s.replace("SIP_TRUNK_HOST", host).replace("SIP_TRUNK_USER", user).replace("SIP_TRUNK_PASSWORD", pw)
open("/etc/asterisk/pjsip.d/20-trunk.conf", "w").write(s)
print(f"[setup] trunk rendered for {user}@{host}")
EOF
  chmod 640 /etc/asterisk/pjsip.d/20-trunk.conf
  chown asterisk:asterisk /etc/asterisk/pjsip.d/20-trunk.conf
else
  log "no TRUNK_* set — skipping provider trunk (base loads cleanly without it)"
fi

# --- 5. Restart + verify -------------------------------------------------------
log "restarting asterisk..."
systemctl restart asterisk
sleep 8

if ! systemctl is-active --quiet asterisk; then
  echo "[setup] FAIL: asterisk service not running" >&2
  journalctl -u asterisk --no-pager -n 30 >&2 || true
  exit 1
fi

log "--- diagnostics (always printed) ---"
asterisk -rx "pjsip show transports" || true
asterisk -rx "pjsip show endpoints" || true
asterisk -rx "dialplan show rakshak-incoming" | head -25 || true
log "--- end diagnostics ---"

fail=0
# NOTE: `pjsip show transports` prints bind addresses (0.0.0.0:5060), never the
# external IP — so the public-IP assertion checks the deployed FILE, while the
# CLI assertion checks the transport actually loaded.
grep -q "external_media_address = $PUBLIC_IP" /etc/asterisk/pjsip.conf \
  && grep -q "external_signaling_address = $PUBLIC_IP" /etc/asterisk/pjsip.conf \
  && log "OK pjsip.conf carries external=$PUBLIC_IP" \
  || { echo "[setup] FAIL: VPS overrides missing in pjsip.conf" >&2; fail=1; }
# arix: single `asterisk -rx` invocations intermittently return empty on a
# freshly restarted 1-vCPU box while the identical command succeeds seconds
# apart (observed across three different checks). Retry, then evaluate.
arix() {
  local i out
  for i in 1 2 3 4; do
    out=$(asterisk -rx "$1" 2>/dev/null || true)
    if [ -n "$out" ]; then
      printf '%s\n' "$out"
      return 0
    fi
    sleep 5
  done
  return 1
}
t_out=$(arix "pjsip show transports" || true)
printf '%s' "$t_out" | grep -q "transport-udp" \
  && log "OK transport-udp loaded" \
  || { echo "[setup] FAIL: transport-udp not loaded" >&2; fail=1; }
# Match endpoints on the InAuth lines — unique, single-space, no format ambiguity.
e_out=$(arix "pjsip show endpoints" || true)
printf '%s' "$e_out" | grep -q "1001-auth" && printf '%s' "$e_out" | grep -q "1002-auth" \
  && log "OK endpoints 1001/1002 present" \
  || { echo "[setup] FAIL: endpoints 1001/1002 missing" >&2; fail=1; }
d_out=$(arix "dialplan show rakshak-incoming" || true)
printf '%s' "$d_out" | grep -q "Stasis" \
  && log "OK dialplan rakshak-incoming hands to Stasis" \
  || { echo "[setup] FAIL: dialplan broken" >&2; fail=1; }

if [ "$fail" -ne 0 ]; then
  asterisk -rx "pjsip show transports" || true
  exit 1
fi
log "PROVISION GREEN — box ready (echo test 9001 live; ARI app pending gateway link)"
