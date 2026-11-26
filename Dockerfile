FROM node:24.22.3-bookworm-slim

WORKDIR /app
COPY package.json ./
COPY src/capacity.ts src/discord-voice-gateway.ts src/discord.ts src/schedule-text.ts \
  src/server.ts src/store.ts src/types.ts src/voice-pilot.ts src/voice-room-registry.ts src/voice-rooms.ts ./src/
RUN install -d -o node -g node -m 0700 /data/squadwaddle

ENV HOST=0.0.0.0 PORT=3000 DB_PATH=/data/squadwaddle/sessions.sqlite
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "src/server.ts"]
