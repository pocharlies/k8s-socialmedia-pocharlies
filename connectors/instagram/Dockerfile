FROM node:20-bookworm

WORKDIR /app

RUN npm install -g pnpm@8.15.0 tsx@4.7.0

# Copy package files
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.json ./
COPY connectors/tsconfig.json ./connectors/tsconfig.json
COPY connectors/instagram/package.json connectors/instagram/tsconfig.json ./connectors/instagram/
COPY shared/package.json shared/tsconfig.json ./shared/

# Install dependencies
RUN pnpm install

# Copy source code
COPY connectors/instagram ./connectors/instagram
COPY shared ./shared

# Build shared package
WORKDIR /app/shared
RUN pnpm exec tsc --skipLibCheck --noEmit false || true

WORKDIR /app

EXPOSE 3003

CMD ["sh", "-c", "cd connectors/instagram && pnpm dev"]
