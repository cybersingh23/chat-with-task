# Chat with Task — single long-lived Node process.
# Needs persistent volumes for /app/workspace (tasks), /app/data (users),
# and /app/spec (customer docs — never baked into the image or git).
FROM node:22-slim

# unzip: delivery .zip extraction; curl: container healthcheck
RUN apt-get update \
  && apt-get install -y --no-install-recommends unzip curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY src ./src
COPY public ./public
COPY spec/README.md ./spec/README.md

RUN mkdir -p /app/workspace /app/data /app/spec \
  && chown -R node:node /app
USER node

ENV PORT=4100 \
    WORKSPACE_ROOT=/app/workspace \
    DATA_DIR=/app/data \
    SPEC_DIR=/app/spec \
    DELIVERY_ROOTS=/app/deliveries

EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD curl -fsS http://localhost:4100/healthz || exit 1

CMD ["node", "server.js"]
