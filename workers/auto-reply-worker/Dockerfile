# Standalone builder — no dependency on local sibling images for CI compatibility
FROM node:20-bookworm AS builder

WORKDIR /build-worker

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY index.ts ./
RUN npx tsc --skipLibCheck

# ─── Runtime image ────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim

WORKDIR /worker

COPY --from=builder /build-worker/dist ./dist
COPY --from=builder /build-worker/node_modules ./node_modules
COPY --from=builder /build-worker/package.json ./

ENV NODE_ENV=production
ENV CONFIG_PATH=/worker/config.json

CMD ["node", "/worker/dist/index.js"]
