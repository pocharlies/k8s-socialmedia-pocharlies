# mcp-socialmedia

Personal-use MCP (Model Context Protocol) server that bridges WhatsApp, Telegram and Instagram to Claude / LLMs. Stores messages in PostgreSQL + pgvector, caches in Redis, files in MinIO, events in NATS. LLM access via LiteLLM proxy.

Repo: `git@github.com:pocharlies/whatsappmcp.git` (the directory is `mcp-socialmedia`; the GitHub name is legacy).

## Connectors

| Service | Port | Purpose |
|---|---|---|
| `whatsapp-connector` (whatsapp-web.js / Baileys) | 3001 | Personal WhatsApp Web account, persistent session |
| `telegram-connector` (gramjs) | 3002 | Telegram API, send + realtime |
| `telegram-sync` (telethon, Python) | 3080 | Telegram message ingestion to Postgres |
| `instagram-connector` (Graph API) | 3003 | Multi-account Instagram (DMs, comments, publish) |
| `whatsapp-cloud-connector` (Cloud API) | 3004 | Deferred — pending dedicated phone |
| `mcp-server` | 3000 | Internal MCP server (HTTP) |
| `mcp-sse` | 3010 | Public MCP over SSE for Claude / clients |
| `auto-reply-worker` | 3090 | Rule-based auto-replies across platforms |

Tool inventory (49 tools across the 3 platforms): see [MCP.md](./MCP.md).

## Layout

```
mcp-socialmedia/
├── connectors/
│   ├── whatsapp-web/        # whatsapp-web.js / Baileys connector (3001)
│   ├── whatsapp-cloud/      # WhatsApp Cloud API connector (3004, deferred)
│   ├── telegram/            # gramjs connector — send + realtime (3002)
│   ├── telegram-sync/       # telethon ingestion to Postgres (3080)
│   └── instagram/           # Graph API connector (3003)
├── workers/
│   └── auto-reply-worker/   # NATS-driven rule-based replies (3090)
├── mcp-server/              # MCP server + SSE entrypoint (3000 / 3010)
├── shared/                  # Shared TS utilities
├── config/                  # nats / redis / minio configs
├── certs/                   # mTLS certs for inter-service comms
├── deploy/                  # Per-service compose fragments
└── docker-compose.yml       # Main compose; docker-compose.override.yml for prod
```

## LLM

Code uses LiteLLM (commit `07fa1db`) — Ollama removed.

```
LLM_BASE_URL=http://litellm-router:4000/v1   # local LiteLLM proxy
LLM_CHAT_MODEL=...                           # whatever LiteLLM is routing
```

Falls back to OpenAI `gpt-4o-mini` if `LLM_BASE_URL` is unset.

Embeddings: pgvector + bge-m3 via infinity-emb. The OpenAI SDK must use `encoding_format: 'float'` — see [MEMORY](./.claude/projects/-home-dibanez-mcp-socialmedia/memory/openai_sdk_v4_base64_dim_bug.md).

## Quick start

```bash
# 1. Configure
cp .env.example .env
# Edit .env — Telegram API id/hash + session, Instagram tokens, encryption keys

# 2. Generate mTLS certs (postgres / redis / nats / minio / clients)
./scripts/generate-certs.sh

# 3. Build and run
docker compose up -d --build

# 4. Verify
for p in 3001 3002 3003 3004 3010 3080 3090; do
  echo -n "port $p: "
  curl -s --max-time 3 "http://localhost:$p/health" || \
  curl -s --max-time 3 "http://localhost:$p/status"
  echo
done

# 5. WhatsApp — pair phone (first time)
curl http://localhost:3001/api/v1/auth/qr   # scan with WhatsApp mobile

# 6. Telegram — generate session string (first time)
docker compose exec telegram-connector npx tsx src/generate-session.ts
# Copy the printed session into .env as TELEGRAM_SESSION_STRING and restart

# 7. Print MCP config for Claude / MCPorter
pnpm mcp:print-config
```

## Key environment

```bash
# Postgres / Redis / NATS / MinIO — strong passwords in prod
POSTGRES_PASSWORD=
MINIO_ROOT_USER=
MINIO_ROOT_PASSWORD=

# Inter-service auth
CONNECTOR_SHARED_SECRET=
ENCRYPTION_KEY=
SESSION_ENCRYPTION_KEY=

# Telegram (https://my.telegram.org/apps)
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_SESSION_STRING=        # gramjs (telegram-connector)
TELETHON_SESSION_STRING=        # telethon (telegram-sync)

# Instagram (multiple accounts)
INSTAGRAM_ACCOUNTS=skirmshop,barbelpapis
INSTAGRAM_SKIRMSHOP_ACCESS_TOKEN=
INSTAGRAM_SKIRMSHOP_BUSINESS_ACCOUNT_ID=
INSTAGRAM_BARBELPAPIS_ACCESS_TOKEN=
INSTAGRAM_BARBELPAPIS_BUSINESS_ACCOUNT_ID=
FACEBOOK_APP_ID=
FACEBOOK_APP_SECRET=
INSTAGRAM_WEBHOOK_VERIFY_TOKEN=

# WhatsApp Cloud (deferred — needs dedicated phone)
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_BUSINESS_ACCOUNT_ID=
WHATSAPP_WEBHOOK_VERIFY_TOKEN=

# LLM
LLM_BASE_URL=http://litellm-router:4000/v1
LLM_CHAT_MODEL=

# Embeddings
EMBEDDING_BASE_URL=http://bge-m3-embedding:8000/v1
EMBEDDING_MODEL=bge-m3
EMBEDDING_DIMENSION=1024

# Sending
ENABLE_SENDING=true
EMERGENCY_DISABLE_SENDING=false

# MCP SSE auth (clients use Bearer)
MCP_SSE_AUTH_TOKEN=
```

## Security

- **Sending is gated** by `ENABLE_SENDING` (kill switch: `EMERGENCY_DISABLE_SENDING=true`).
- **mTLS everywhere** between services (postgres / redis / nats / minio / clients).
- **WhatsApp session encrypted at rest** (`SESSION_ENCRYPTION_KEY`).
- **MCP SSE** requires `Authorization: Bearer <MCP_SSE_AUTH_TOKEN>`.

## Importing existing chats

```bash
# WhatsApp chat export (Settings > Chats > Export Chat)
tsx scripts/import-data.ts whatsapp-txt "Chat - John.txt" "John" "Your Name"

# Telegram Desktop export (Settings > Advanced > Export Telegram data, JSON)
tsx scripts/import-data.ts telegram result.json your-telegram-id
```

## Common operations

```bash
# Status of all connectors
for p in 3001 3002 3003 3010 3080 3090; do curl -s http://localhost:$p/health; echo; done

# Message counts per platform
docker exec whatsappmcp-postgres-1 psql -U whatsappmcp -d whatsappmcp \
  -c "select platform, count(*) from messages group by platform;"

# Live logs
docker logs -f whatsappmcp-whatsapp-connector-1
docker logs -f telegram-sync
```

## Troubleshooting

- **WhatsApp lost session** — `rm -rf connectors/whatsapp-web/session-data/* && docker compose restart whatsapp-connector`, then re-scan QR.
- **Telegram realtime dead but `/health` OK** — gramjs `useWSS:true` bug. Confirm `useWSS: false` in [connectors/telegram/src/telegram-client.ts](./connectors/telegram/src/telegram-client.ts). See [memory note](./.claude/projects/-home-dibanez-mcp-socialmedia/memory/telegram_connector_useWSS_false.md).
- **Telegram messages stop landing in Postgres** — debug `telegram-sync`, not `telegram-connector` (the latter has no DB consumer). See [memory note](./.claude/projects/-home-dibanez-mcp-socialmedia/memory/telegram_ingestion_path.md).
- **Embedding dim mismatch (`expected 1024, got 256`)** — force `encoding_format: 'float'` on the OpenAI SDK call.

## License

Personal use only. Not affiliated with WhatsApp, Telegram, Meta, or any platform.
