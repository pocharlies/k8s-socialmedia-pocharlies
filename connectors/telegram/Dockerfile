FROM node:20-alpine

RUN apk add --no-cache git python3 make g++

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY pnpm-workspace.yaml ./
COPY package.json ./
COPY pnpm-lock.yaml* ./

COPY shared ./shared
COPY connectors/telegram ./connectors/telegram

# Install with --no-optional to skip bufferutil native build issues
RUN pnpm install --no-optional || pnpm install --ignore-scripts

WORKDIR /app/shared
RUN pnpm build || true

WORKDIR /app/connectors/telegram

EXPOSE 3002

CMD ["pnpm", "dev"]
