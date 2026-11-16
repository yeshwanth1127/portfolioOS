#!/bin/sh
# Writes the LiveKit config from the environment, then starts supervisord.
set -eu

if [ -z "${LIVEKIT_API_KEY:-}" ] || [ -z "${LIVEKIT_API_SECRET:-}" ]; then
  # Idle instead of crash-looping: Meetings stays off until the secret is set (docs/MEETINGS.md).
  echo "[meetings] LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not set — Meetings is off. Set them in .env and recreate this container."
  exec sleep infinity
fi
WEBHOOK_URL="${LIVEKIT_WEBHOOK_URL:-http://portfolio:4001/livekit/webhook}"

# Public servers discover their external IP via STUN. On a laptop, advertise 127.0.0.1 instead
# (LIVEKIT_NODE_IP=127.0.0.1, LIVEKIT_USE_EXTERNAL_IP=false) so the browser can reach the ports.
if [ -n "${LIVEKIT_NODE_IP:-}" ]; then NODE_IP_LINE="  node_ip: ${LIVEKIT_NODE_IP}"; else NODE_IP_LINE=""; fi

cat > /etc/livekit/livekit.yaml <<YAML
port: 7880
log_level: ${LIVEKIT_LOG_LEVEL:-info}
rtc:
  tcp_port: 7881
  udp_port: 7882
  use_external_ip: ${LIVEKIT_USE_EXTERNAL_IP:-true}
${NODE_IP_LINE}
keys:
  ${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}
webhook:
  api_key: ${LIVEKIT_API_KEY}
  urls:
    - ${WEBHOOK_URL}
room:
  # Close a room 5 minutes after the last person leaves (or 20 s if it never filled).
  empty_timeout: 300
  departure_timeout: 20
  max_participants: ${LIVEKIT_MAX_PARTICIPANTS:-50}
YAML
chmod 600 /etc/livekit/livekit.yaml

export MEETING_BOT_AUTOSTART="${MEETING_BOT_AUTOSTART:-true}"
exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
