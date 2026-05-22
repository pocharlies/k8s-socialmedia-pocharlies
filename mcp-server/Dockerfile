FROM node:20-bookworm-slim

WORKDIR /app

# Install git, pnpm, and tsx globally
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@8.15.0 tsx@4.7.0

# Copy package files
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.json ./
COPY mcp-server/package.json mcp-server/tsconfig.json ./mcp-server/
COPY shared/package.json shared/tsconfig.json ./shared/

# Install dependencies
RUN pnpm install

# Copy source code
COPY mcp-server ./mcp-server
COPY shared ./shared

# Build shared package (ignore errors for development)
WORKDIR /app/shared
RUN pnpm exec tsc --skipLibCheck --noEmit false || true

# Stay in root app directory
WORKDIR /app

# Expose port
EXPOSE 3000

# Start in dev mode from root (no build required)
# Use sh -c to properly expand the command
CMD ["sh", "-c", "cd mcp-server && pnpm dev"]
