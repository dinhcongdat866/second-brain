FROM node:20-slim
WORKDIR /app
# corepack ships with node 20 and reads packageManager from package.json, so the
# image builds with the same pnpm the repo uses rather than whatever is newest.
RUN corepack enable
# Frozen lockfile, not a fresh resolve: this process is now the thing standing
# between a room name and someone else's notebook, so what gets installed should
# not depend on the day the image was built.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY server.js .
ENV HOST=0.0.0.0 PORT=1234
EXPOSE 1234
# Not y-websocket's own bin/server.js: that one lets anybody into any room.
# server.js wraps it with room-token verification. SYNC_JWT_SECRET must be set
# (fly secrets set) — the process exits rather than starting unauthenticated.
CMD ["node", "server.js"]
