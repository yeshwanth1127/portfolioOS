# Orbit Meetings: our own LiveKit media server (and, from phase 2, the Qlix meeting bot).
# Build context is sona-ecosystem/ — see docker-compose.yml service `meetings`.
FROM livekit/livekit-server:v1.13.10 AS livekit

FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl tini supervisor \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/log/supervisor /etc/livekit
COPY --from=livekit /livekit-server /usr/local/bin/livekit-server

# The meeting bot (Qlix Meeting Assistant's ears). Speech-to-text is Qlix's whisper-server.
COPY services/meeting-bot/requirements.txt /opt/meeting-bot/requirements.txt
RUN python -m venv /opt/meeting-bot/.venv \
 && /opt/meeting-bot/.venv/bin/pip install --no-cache-dir -r /opt/meeting-bot/requirements.txt
COPY services/meeting-bot/bot.py /opt/meeting-bot/bot.py
COPY docker/meetings/supervisord.conf /etc/supervisor/conf.d/meetings.conf
COPY docker/meetings/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 7880 signalling + API (behind nginx as wss://<domain>/lk), 7881 ICE/TCP, 7882 ICE/UDP (single-port mux)
EXPOSE 7880 7881 7882/udp
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD curl -fsS http://127.0.0.1:7880/ >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
