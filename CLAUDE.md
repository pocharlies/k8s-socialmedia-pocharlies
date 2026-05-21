# whatsappmcp — Notas para Claude

## Qué es

Servidor MCP multi-plataforma (WhatsApp + Telegram + Instagram) que expone tools a Claude/LLMs por SSE. Almacena mensajes en Postgres+pgvector, usa Redis (cache), MinIO (ficheros) y NATS (event bus). LLM vía LiteLLM.

## Dónde corre

- **Producción actual: x86 `192.168.50.142`** (esta máquina)
- DGX `192.168.50.140` ya no se usa como producción (no alcanzable desde x86)
- Repo en GitHub privado: `pocharlies/whatsappmcp`
- Path local: `/home/dibanez/mcp-socialmedia/` (renombrado desde `/home/dibanez/whatsappmcp`)

## Estructura

Tras el refactor del 2026-05-07 (commit `6791fae`), todo bajo carpetas dedicadas:
- `connectors/{whatsapp-web,whatsapp-cloud,telegram,telegram-sync,instagram}/`
- `workers/auto-reply-worker/`
- `mcp-server/`, `shared/`

## Conectores (estado 2026-05-08)

| Conector | Puerto | Estado | Notas |
|----------|--------|--------|-------|
| WhatsApp Web personal | 3001 | ✅ connected | sesión persistente en `connectors/whatsapp-web/session-data/` |
| Telegram | 3002 | ✅ connected | gramjs (send + realtime) |
| Telegram-sync | 3080 | ✅ healthy | telethon, ingestion → Postgres |
| Instagram | 3003 | ✅ 2 cuentas | skirmshop (~7.135), barbelpapis (~14.949) |
| WhatsApp Cloud API | 3004 | ⛔ diferido | container up, `connected:false` (ver abajo) |
| MCP server (interno) | 3000 | ✅ healthy | |
| MCP SSE (público) | 3010 | ✅ healthy | Bearer token en `docker-compose.yml` L205 |
| Auto-reply worker | 3090 | ✅ 1 regla | |

## WhatsApp Cloud API — DIFERIDO

**No tocar hasta que tengamos el teléfono dedicado.**

Estado: container arranca pero `connected:false` porque no hay sesión/teléfono configurado. El `WHATSAPP_PHONE_NUMBER_ID=1005582045977097` en `.env` está, pero falta el dispositivo físico.

Retomar cuando se adquiera el teléfono dedicado para la Business API.

## Instagram — DMs bloqueados, resto OK

Estado del conector (puerto 3003, ambas cuentas conectadas):

| Capacidad | Estado | Nota |
|---|---|---|
| Profile / followers | ✅ | |
| Media / posts / reels read | ✅ | |
| Comments read + reply | ✅ | |
| Stories read | ✅ | |
| Publish image / carousel / reel / story | ✅ | Implementado en `instagram-api.ts` |
| Media insights | ✅ | impressions / reach / engagement / saved |
| **DMs (read + send)** | ❌ | Graph API devuelve `data:[]` por permisos |

**Causa del bloqueo de DMs:** los tokens actuales en `.env` (`INSTAGRAM_SKIRMSHOP_ACCESS_TOKEN`, `INSTAGRAM_BARBELPAPIS_ACCESS_TOKEN`) vienen de la app **Skirmshop conector MCP** (`1268684188569802`), que solo tiene `email`+`public_profile`. Sin `instagram_business_manage_messages` Meta no expone conversaciones.

**Solución:** migrar a la app **Skirmshop marketing manager** (`1431837657952463`, Instagram app ID `1869504556900523`), que ya tiene el producto Instagram + Instagram Login.

### Checklist para desbloquear DMs

1. **App Meta — Skirmshop marketing manager (`1431837657952463`)**
   - [ ] Configurar webhook en producto Instagram (URL: `https://<dominio>/api/v1/<account>/webhook`, verify token = `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` del `.env`)
   - [ ] Suscribirse a eventos: `messages`, `messaging_postbacks`, `comments`
2. **Permisos**
   - [ ] `instagram_business_manage_messages` (necesita Advanced Access)
   - [ ] `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_comments`
   - [ ] Añadir `skirmshopes` y `barbelpapis` como **roles → testers** durante App Review
3. **Tokens**
   - [ ] Generar long-lived user token (60d) vía Instagram Login para cada cuenta
   - [ ] Intercambiar por business token para `INSTAGRAM_<ACCOUNT>_ACCESS_TOKEN`
   - [ ] Actualizar `FACEBOOK_APP_ID` y `FACEBOOK_APP_SECRET` con los de la marketing manager
4. **Despliegue**
   - [ ] Actualizar `.env` (`/home/dibanez/mcp-socialmedia/.env`)
   - [ ] `docker compose restart instagram-connector`
   - [ ] Verificar: `curl http://localhost:3003/api/v1/skirmshop/conversations` ya no debería devolver `data:[]`
5. **App Review (producción real, no solo testers)**
   - [ ] Solicitar Advanced Access para `instagram_business_manage_messages`
   - [ ] Grabar screencast del flujo end-to-end
   - [ ] Pasar app de Development → Live

## LLM

Código migrado a **LiteLLM** (commit `07fa1db`). Ollama **eliminado del proyecto** (2026-04-19):
- Servicio, volumen, imagen, env vars y `config/ollama/` quitados
- Proxy LiteLLM local: container `litellm-router` en puerto 4000
- Env vars activos: `LLM_BASE_URL`, `LLM_CHAT_MODEL`

`README.md` y `DEPLOYMENT.md` reescritos el 2026-05-08 con la realidad actual.

## Comandos útiles

```bash
# Ver estado de todos los conectores
for p in 3002 3003 3010 3080 3090; do curl -s http://localhost:$p/health; echo; done
curl -s http://localhost:3001/status   # WhatsApp personal
curl -s http://localhost:3004/status   # WhatsApp Cloud (diferido)

# Contar mensajes por plataforma
docker exec whatsappmcp-postgres-1 psql -U whatsappmcp -d whatsappmcp \
  -c "select platform, count(*) from messages group by platform;"

# Logs en vivo
docker logs -f whatsappmcp-whatsapp-connector-1
docker logs -f telegram-sync
```

## Pendientes técnicos

- **App Instagram "Skirmshop marketing manager"** — desbloquear DMs (checklist arriba)
- **WhatsApp Cloud** — pendiente de teléfono físico
- **Limpiar `deploy/docker-compose.{lab,prod,base,ollama,whatsapp,telegram,mcp-server}.yml`** y `scripts/setup-ollama.sh` (legacy del modelo lab/prod, ya no se usan; el activo es `docker-compose.yml` + `docker-compose.override.yml`)
- **Quitar `version: '3.8'`** del `docker-compose.yml` si aparece (obsoleto en Compose v2)
