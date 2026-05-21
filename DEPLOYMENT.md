# Deployment

The setup is a **single-host docker-compose** stack on x86 at `192.168.50.142`. There is no lab/prod split, no remote registry, no CI deploys — push to `main`, pull on the host, rebuild.

> **Legacy:** `deploy/docker-compose.{lab,prod,base,ollama,whatsapp,telegram,mcp-server}.yml` and `scripts/setup-ollama.sh` are unused leftovers from an earlier multi-environment design. The active compose files are at the repo root: [docker-compose.yml](./docker-compose.yml) + [docker-compose.override.yml](./docker-compose.override.yml).

## Topology

```
┌────────────────── x86  192.168.50.142 ────────────────────┐
│                                                            │
│  Infra (docker-compose.yml):                              │
│    postgres (pgvector)  redis  nats  minio                │
│                                                            │
│  Connectors:                                               │
│    whatsapp-connector       :3001  (whatsapp-web.js)      │
│    telegram-connector       :3002  (gramjs, send/realtime)│
│    telegram-sync            :3080  (telethon, ingest→DB)  │
│    instagram-connector      :3003  (Graph API, multi-acct)│
│    whatsapp-cloud-connector :3004  (deferred)             │
│                                                            │
│  Server / workers:                                         │
│    mcp-server               :3000  (internal HTTP)        │
│    mcp-sse                  :3010  (public SSE for Claude)│
│    auto-reply-worker        :3090                          │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

## Prerequisites

- Docker + Docker Compose v2
- mTLS certs in [certs/](./certs/) (regenerate with [scripts/generate-certs.sh](./scripts/generate-certs.sh))
- A populated `.env` (see [README.md](./README.md#key-environment))
- LiteLLM proxy reachable at `LLM_BASE_URL` (separate stack — not part of this repo)
- Embedding server reachable at `EMBEDDING_BASE_URL` (e.g. `bge-m3-embedding:8000/v1`)

## Deploying changes

```bash
cd /home/dibanez/mcp-socialmedia
git pull origin main
docker compose build
docker compose up -d
```

Build alone takes ~10 min (whatsapp-web pulls Chromium, telegram-sync pulls whisper). `up -d` recreates only changed containers.

## Health checks

```bash
# Connector liveness — should all return ok / connected:true
echo -n "whatsapp 3001:        "; curl -s http://localhost:3001/status
echo -n "telegram 3002:        "; curl -s http://localhost:3002/health
echo -n "telegram-sync 3080:   "; curl -s http://localhost:3080/health
echo -n "instagram 3003:       "; curl -s http://localhost:3003/health
echo -n "whatsapp-cloud 3004:  "; curl -s http://localhost:3004/status   # connected:false expected (deferred)
echo -n "mcp-sse 3010:         "; curl -s http://localhost:3010/health
echo -n "auto-reply 3090:      "; curl -s http://localhost:3090/health

# Container state
docker ps --filter "name=whatsappmcp" --format 'table {{.Names}}\t{{.Status}}'
docker ps --filter "name=telegram-sync" --format 'table {{.Names}}\t{{.Status}}'
```

## Logs

```bash
# Stream a single connector
docker logs -f whatsappmcp-whatsapp-connector-1
docker logs -f whatsappmcp-telegram-connector-1
docker logs -f whatsappmcp-instagram-connector-1
docker logs -f telegram-sync
docker logs -f whatsappmcp-mcp-server-1
docker logs -f whatsappmcp-mcp-sse-1
docker logs -f whatsappmcp-auto-reply-worker-1

# All at once (Ctrl+C to stop)
docker compose logs -f --tail=50
```

## Database

```bash
# psql shell
docker exec -it whatsappmcp-postgres-1 psql -U whatsappmcp -d whatsappmcp

# Common queries
docker exec whatsappmcp-postgres-1 psql -U whatsappmcp -d whatsappmcp \
  -c "select platform, count(*) from messages group by platform;"

docker exec whatsappmcp-postgres-1 psql -U whatsappmcp -d whatsappmcp \
  -c "select platform, max(timestamp) as last_msg from messages group by platform;"
```

Migrations: `pnpm db:migrate` (runs [scripts/db-migrate.sh](./scripts/db-migrate.sh)).

## Restart / restart only one service

```bash
docker compose restart whatsapp-connector
docker compose restart telegram-connector
docker compose restart instagram-connector
docker compose restart telegram-sync
docker compose restart mcp-server mcp-sse
```

If `telegram-sync` logs show `Cannot send requests while disconnected`, restart it — it does not auto-recover from that state.

## Stop everything

```bash
docker compose down                  # keeps volumes (data preserved)
docker compose down -v               # WIPES volumes (postgres, redis, nats, minio data) — use with caution
```

## WhatsApp session

The personal WhatsApp Web session is persistent at [connectors/whatsapp-web/session-data/](./connectors/whatsapp-web/session-data/) (gitignored, encrypted with `SESSION_ENCRYPTION_KEY`).

If the session expires:
```bash
rm -rf connectors/whatsapp-web/session-data/*
docker compose restart whatsapp-connector
curl http://localhost:3001/api/v1/auth/qr   # scan with mobile
```

## Telegram session

Two separate MTProto sessions against the same account (paxanguero):
- `telegram-connector` (gramjs, Node) — env `TELEGRAM_SESSION_STRING`
- `telegram-sync` (telethon, Python) — env `TELETHON_SESSION_STRING`

Regenerate gramjs:
```bash
docker compose exec telegram-connector npx tsx src/generate-session.ts
```

Regenerate telethon:
```bash
docker compose exec telegram-sync python gen_session.py
```

## Backups

Postgres volume `whatsappmcp_postgres_data` holds all messages, drafts, embeddings, style profiles. Recommended: nightly `pg_dump` to a separate disk.

```bash
# Manual snapshot
docker exec whatsappmcp-postgres-1 pg_dump -U whatsappmcp whatsappmcp | gzip > backup-$(date +%F).sql.gz
```

## Troubleshooting

**Build fails on whatsapp-connector** — Chromium / Puppeteer download flaky. Retry; the layer is cached.

**`pnpm install` fails on telegram-connector** — bufferutil / utf-8-validate native build. The Dockerfile already passes `--no-optional` as fallback.

**Health check on whatsapp-cloud-connector returns `connected:false`** — expected. The Cloud API connector is deferred until a dedicated phone number is provisioned (`WHATSAPP_PHONE_NUMBER_ID` is set but no session exists).

**Instagram DM tools return empty `data:[]`** — token from the wrong app. The Skirmshop *MCP* app does not have `instagram_business_manage_messages`; tokens must come from the Skirmshop *marketing manager* app. See [README.md](./README.md) and the project memory.

**MCP SSE disconnects in Claude** — check `MCP_SSE_AUTH_TOKEN` matches the Bearer token in the client config (see [MCP.md](./MCP.md)).

**Embedding dim mismatch (`expected 1024, got 256`)** — OpenAI SDK is sending base64 to a non-OpenAI server. Force `encoding_format: 'float'` on every `embeddings.create()` call.
