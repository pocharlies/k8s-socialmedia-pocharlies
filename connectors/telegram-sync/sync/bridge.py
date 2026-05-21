"""HTTP Bridge — webhook notifier + send/history endpoints for auto-reply."""

import asyncio
import hashlib
import hmac
import json
import logging
import os
import time

import asyncpg
import httpx
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

logger = logging.getLogger(__name__)

BRIDGE_SECRET = os.environ.get("BRIDGE_SECRET", "telegram-bridge-secret-2026")
WEBHOOK_URL = os.environ.get("AUTOREPLY_WEBHOOK_URL", "")

_telegram_client = None
_db_pool: asyncpg.Pool | None = None
_http_client: httpx.AsyncClient | None = None


def set_telegram_client(client):
    global _telegram_client
    _telegram_client = client


def set_db_pool(pool: asyncpg.Pool):
    global _db_pool
    _db_pool = pool


def _sign(payload: str) -> tuple[str, str]:
    ts = str(int(time.time()))
    sig = hmac.new(BRIDGE_SECRET.encode(), f"{ts}:{payload}".encode(), hashlib.sha256).hexdigest()
    return ts, f"sha256={sig}"


def _verify(request: Request, body: bytes) -> bool:
    ts = request.headers.get("x-bridge-timestamp", "")
    sig = request.headers.get("x-bridge-signature", "")
    if not ts or not sig:
        return False
    try:
        now = int(time.time())
        if abs(now - int(ts)) > 300:
            return False
    except ValueError:
        return False
    expected = hmac.new(BRIDGE_SECRET.encode(), f"{ts}:{body.decode()}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig.replace("sha256=", ""), expected)


async def _get_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(timeout=10)
    return _http_client


async def notify_autoreply(chat_id: int, chat_title: str | None, sender_id: int,
                           sender_name: str | None, content: str, message_type: str,
                           telegram_message_id: int, timestamp: str):
    if not WEBHOOK_URL:
        return
    if message_type != "text":
        return

    payload = json.dumps({
        "conversationId": str(chat_id),
        "chatTitle": chat_title,
        "senderId": str(sender_id),
        "senderName": sender_name,
        "content": content,
        "messageType": "TEXT",
        "telegramMessageId": str(telegram_message_id),
        "timestamp": timestamp,
    })
    ts, sig = _sign(payload)
    try:
        client = await _get_http_client()
        resp = await client.post(WEBHOOK_URL, content=payload, headers={
            "Content-Type": "application/json",
            "X-Bridge-Timestamp": ts,
            "X-Bridge-Signature": sig,
        })
        if resp.status_code != 200:
            logger.warning(f"Webhook returned {resp.status_code}: {resp.text}")
        else:
            logger.info(f"Webhook notified for chat {chat_id}")
    except Exception as e:
        logger.warning(f"Webhook failed: {e}")


async def handle_send(request: Request) -> JSONResponse:
    body = await request.body()
    if not _verify(request, body):
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    data = json.loads(body)
    chat_id = data.get("chat_id")
    text = data.get("text")

    if not chat_id or not text:
        return JSONResponse({"error": "chat_id and text required"}, status_code=400)

    if _telegram_client is None:
        return JSONResponse({"error": "telegram client not ready"}, status_code=503)

    try:
        entity = await _telegram_client.get_entity(int(chat_id))
        msg = await _telegram_client.send_message(entity, text)
        return JSONResponse({"ok": True, "message_id": msg.id})
    except Exception as e:
        logger.error(f"Send failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


async def handle_history(request: Request) -> JSONResponse:
    body = await request.body()
    if not _verify(request, body):
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    data = json.loads(body)
    chat_id = data.get("chat_id")
    limit = data.get("limit", 20)

    if not chat_id:
        return JSONResponse({"error": "chat_id required"}, status_code=400)

    if _db_pool is None:
        return JSONResponse({"error": "database not ready"}, status_code=503)

    try:
        async with _db_pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT sender_id, sender_name, content, direction, timestamp "
                "FROM telegram_messages "
                "WHERE chat_id = $1 AND message_type = 'text' AND content IS NOT NULL "
                "ORDER BY timestamp DESC LIMIT $2",
                int(chat_id), limit
            )
        messages = [{
            "sender_id": str(r["sender_id"]),
            "sender_name": r["sender_name"],
            "content": r["content"],
            "direction": r["direction"],
            "timestamp": r["timestamp"].isoformat() if r["timestamp"] else None,
        } for r in reversed(rows)]
        return JSONResponse({"messages": messages})
    except Exception as e:
        logger.error(f"History query failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


async def handle_health(request: Request) -> JSONResponse:
    connected = _telegram_client is not None and _telegram_client.is_connected()
    db_ok = _db_pool is not None
    healthy = connected and db_ok
    return JSONResponse(
        {"status": "ok" if healthy else "unhealthy", "telegram": connected, "db": db_ok},
        status_code=200 if healthy else 503,
    )


async def handle_unread(request: Request) -> JSONResponse:
    """POST /unread — list Telegram dialogs with unread messages.

    Reads live state from the running Telethon session via get_dialogs().
    Used by mcp-server to back the telegram_get_unread tool — gramJS in
    the Node connector cannot serve this against current Telegram MTProto.
    """
    body = await request.body()
    if not _verify(request, body):
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    if _telegram_client is None:
        return JSONResponse({"error": "telegram client not ready"}, status_code=503)

    try:
        data = json.loads(body) if body else {}
        limit = int(data.get("limit", 200))
        only_with_unread = bool(data.get("only_with_unread", True))

        dialogs = await _telegram_client.get_dialogs(limit=limit)
        out = []
        total_unread = 0
        for d in dialogs:
            uc = int(getattr(d, "unread_count", 0) or 0)
            if only_with_unread and uc == 0:
                continue
            total_unread += uc
            entity = d.entity
            chat_id_int = int(getattr(entity, "id", 0) or 0)
            # Telethon returns positive ids for users; groups/channels are negative in bot-style id.
            # Match the DB convention used elsewhere (tg_<bot-style-id>).
            if hasattr(entity, "megagroup") or hasattr(entity, "broadcast"):
                bot_style = -1000000000000 - chat_id_int  # supergroup/channel form
            elif hasattr(entity, "title") and not hasattr(entity, "username"):
                bot_style = -chat_id_int  # legacy small group
            else:
                bot_style = chat_id_int
            out.append({
                "id": f"tg_{bot_style}",
                "chatId": str(bot_style),
                "name": d.name,
                "unread_count": uc,
                "unread_mentions_count": int(getattr(d, "unread_mentions_count", 0) or 0),
                "last_message_at": d.date.isoformat() if d.date else None,
                "is_user": hasattr(entity, "username") and not hasattr(entity, "title"),
                "is_group": bool(getattr(entity, "title", None) and not getattr(entity, "broadcast", False)),
                "is_channel": bool(getattr(entity, "broadcast", False)),
            })
        out.sort(key=lambda r: r["unread_count"], reverse=True)
        return JSONResponse({
            "source": "telethon",
            "total_unread": total_unread,
            "dialogs_with_unread": len(out),
            "dialogs": out,
        })
    except Exception as e:
        logger.error(f"Unread query failed: {e}", exc_info=True)
        return JSONResponse({"error": str(e)}, status_code=500)


app = Starlette(routes=[
    Route("/send", handle_send, methods=["POST"]),
    Route("/history", handle_history, methods=["POST"]),
    Route("/health", handle_health, methods=["GET"]),
    Route("/unread", handle_unread, methods=["POST"]),
])


# ─── Brain Context (Qdrant keyword search) ────────────────────────────────────

QDRANT_URL = os.environ.get("QDRANT_URL", "http://localhost:6333")
QDRANT_API_KEY = os.environ.get("QDRANT_API_KEY", "")
QDRANT_COLLECTION = os.environ.get("QDRANT_COLLECTION", "personal_documents")


async def handle_brain_chat(request: Request) -> JSONResponse:
    """POST /brain-chat — search personal knowledge base for context."""
    body = await request.body()
    if not _verify(request, body):
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    data = json.loads(body)
    query = data.get("query", "")
    limit = data.get("limit", 5)

    if not query:
        return JSONResponse({"context": "", "count": 0})

    # Extract keywords from query (words > 3 chars)
    keywords = [w for w in query.split() if len(w) > 3]
    if not keywords:
        keywords = query.split()[:3]

    context_parts = []
    try:
        client = await _get_http_client()
        headers = {}
        if QDRANT_API_KEY:
            headers["api-key"] = QDRANT_API_KEY

        # Search by each keyword in subject and content
        seen_ids = set()
        for kw in keywords[:3]:  # max 3 keywords
            resp = await client.post(
                f"{QDRANT_URL}/collections/{QDRANT_COLLECTION}/points/scroll",
                json={
                    "limit": limit,
                    "with_payload": {"include": ["subject", "content", "source", "from_address"]},
                    "with_vectors": False,
                    "filter": {
                        "should": [
                            {"key": "subject", "match": {"text": kw}},
                            {"key": "content", "match": {"text": kw}},
                        ]
                    }
                },
                headers=headers,
                timeout=10,
            )
            if resp.status_code == 200:
                for pt in resp.json().get("result", {}).get("points", []):
                    pid = pt.get("id")
                    if pid not in seen_ids:
                        seen_ids.add(pid)
                        payload = pt.get("payload", {})
                        subject = payload.get("subject", "")
                        content = (payload.get("content", "") or "")[:300]
                        if subject or content:
                            context_parts.append(f"[{payload.get('source','?')}] {subject}\n{content}")

        context = "\n---\n".join(context_parts[:limit])
        return JSONResponse({"context": context, "count": len(context_parts)})
    except Exception as e:
        logger.error(f"Brain search failed: {e}")
        return JSONResponse({"context": "", "count": 0})

# Register route
from starlette.routing import Route as _Route2
app.routes.append(_Route2("/brain-chat", handle_brain_chat, methods=["POST"]))
