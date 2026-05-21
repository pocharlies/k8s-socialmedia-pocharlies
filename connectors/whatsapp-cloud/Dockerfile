FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache git
RUN npm install -g pnpm tsx

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.json ./
COPY connectors/whatsapp-cloud/package.json connectors/whatsapp-cloud/tsconfig.json ./connectors/whatsapp-cloud/
COPY shared/package.json shared/tsconfig.json ./shared/

RUN pnpm install

COPY connectors/whatsapp-cloud ./connectors/whatsapp-cloud
COPY shared ./shared

WORKDIR /app/shared
RUN pnpm exec tsc --skipLibCheck --noEmit false || true

WORKDIR /app

EXPOSE 3004

CMD ["sh", "-c", "cd connectors/whatsapp-cloud && pnpm dev"]
