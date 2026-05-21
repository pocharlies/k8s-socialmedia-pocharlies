FROM node:20-bookworm-slim

WORKDIR /app

# Baileys is a pure Node.js WebSocket client — no Chromium/Puppeteer needed.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm tsx

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.json ./
COPY connectors/whatsapp-web/package.json connectors/whatsapp-web/tsconfig.json ./connectors/whatsapp-web/
COPY shared/package.json shared/tsconfig.json ./shared/

RUN pnpm install

COPY connectors/whatsapp-web ./connectors/whatsapp-web
COPY shared ./shared

WORKDIR /app/shared
RUN pnpm exec tsc --skipLibCheck --noEmit false || true

WORKDIR /app

EXPOSE 3001

CMD ["sh", "-c", "cd connectors/whatsapp-web && pnpm dev"]
