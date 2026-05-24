"""Database module -- asyncpg pool, schema migration, CRUD helpers.
   Writes to unified messages/conversations/participants tables."""

import json
import logging
import os

import asyncpg

logger = logging.getLogger(__name__)

# This sync instance serves exactly one account ("personal" by default,
# "professional" for the second instance). Non-personal row ids are namespaced
# ("<account>:<id>") so two Telegram accounts never merge in the shared tables.
ACCOUNT = os.environ.get("CONNECTOR_ACCOUNT", "personal")


def account_key(raw_id: str) -> str:
    return raw_id if ACCOUNT == "personal" else f"{ACCOUNT}:{raw_id}"


# Only sync_state is owned by telegram-sync; messages/conversations/participants already exist
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS telegram_sync_state (
    chat_id BIGINT PRIMARY KEY,
    chat_title TEXT,
    last_message_id BIGINT DEFAULT 0,
    total_imported BIGINT DEFAULT 0,
    completed BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_tg_transcription
ON messages ((metadata->>'transcription_status'))
WHERE platform = 'telegram'
  AND (metadata->>'needs_transcription')::text = 'true';
"""

ENSURE_CONVERSATION_SQL = """
INSERT INTO conversations (id, name, is_group, type, wa_chat_id, created_at, updated_at, last_message_at, account)
VALUES ($1, $2, $3, $4, $6, NOW(), NOW(), $5, $7)
ON CONFLICT (id) DO UPDATE SET
  name = COALESCE(EXCLUDED.name, conversations.name),
  last_message_at = GREATEST(conversations.last_message_at, EXCLUDED.last_message_at),
  updated_at = NOW()
"""

ENSURE_PARTICIPANT_SQL = """
INSERT INTO participants (id, name, first_seen, last_seen, account)
VALUES ($1, $2, NOW(), NOW(), $3)
ON CONFLICT (id) DO UPDATE SET
  name = COALESCE(EXCLUDED.name, participants.name),
  last_seen = NOW()
"""

LINK_PARTICIPANT_SQL = """
INSERT INTO conversation_participants (conversation_id, participant_id)
VALUES ($1, $2)
ON CONFLICT DO NOTHING
"""

INSERT_MESSAGE_SQL = """
INSERT INTO messages (
    wa_message_id, conversation_id, sender_wa_id, wa_timestamp,
    direction, content, message_type, is_forwarded,
    reply_to_message_id, platform, metadata, account
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'telegram',$10,$11)
ON CONFLICT (wa_message_id) DO NOTHING
RETURNING id
"""

INSERT_ATTACHMENT_SQL = """
INSERT INTO attachments (
    message_id, file_type, mime_type, file_name, file_size,
    file_url, duration_seconds, width, height, caption
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
"""

GET_MESSAGE_ID_SQL = """
SELECT id FROM messages WHERE wa_message_id = $1
"""

_pool: asyncpg.Pool | None = None


async def create_pool() -> asyncpg.Pool:
    global _pool
    dsn = os.environ.get("DATABASE_URL", "postgresql://brain:brainpass@localhost:5437/brain")
    _pool = await asyncpg.create_pool(dsn, min_size=2, max_size=5)
    logger.info("Database pool created")
    return _pool


async def get_pool() -> asyncpg.Pool:
    if _pool is None:
        return await create_pool()
    return _pool


async def init_schema(pool: asyncpg.Pool):
    async with pool.acquire() as conn:
        await conn.execute(SCHEMA_SQL)
    logger.info("Database schema initialized")


async def recover_stuck_transcriptions(pool: asyncpg.Pool) -> int:
    async with pool.acquire() as conn:
        result = await conn.execute(
            "UPDATE messages SET metadata = jsonb_set(metadata, '{transcription_status}', '\"pending\"') "
            "WHERE platform = 'telegram' AND metadata->>'transcription_status' = 'processing'"
        )
    count = int(result.split()[-1]) if result else 0
    if count > 0:
        logger.info(f"Recovered {count} stuck transcriptions")
    return count


async def insert_message(
    pool: asyncpg.Pool,
    telegram_message_id: int,
    chat_id: int,
    chat_title: str | None,
    chat_type: str,
    sender_id: int | None,
    sender_name: str | None,
    content: str | None,
    message_type: str,
    direction: str,
    timestamp,
    is_forwarded: bool = False,
    reply_to_message_id: int | None = None,
    needs_transcription: bool = False,
) -> int | None:
    """Insert a message into unified table. Returns the bigint message_id if inserted,
    or the existing id if duplicate (lookup by wa_message_id)."""
    raw_conv_id = f"tg_{chat_id}"
    conv_id = account_key(raw_conv_id)
    wa_msg_id = account_key(f"tg_{chat_id}_{telegram_message_id}")
    sender_wa_id = account_key(f"tg_{sender_id}") if sender_id else None
    is_group = chat_type in ("group", "supergroup")
    reply_ref = account_key(f"tg_{chat_id}_{reply_to_message_id}") if reply_to_message_id else None

    metadata = {
        "telegram_chat_id": chat_id,
        "telegram_message_id": telegram_message_id,
        "chat_type": chat_type,
        "sender_name": sender_name,
    }
    if needs_transcription:
        metadata["needs_transcription"] = True
        metadata["transcription_status"] = "pending"
        metadata["transcription_attempts"] = 0

    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(ENSURE_CONVERSATION_SQL, conv_id, chat_title, is_group, chat_type, timestamp, raw_conv_id, ACCOUNT)
            if sender_id:
                await conn.execute(ENSURE_PARTICIPANT_SQL, sender_wa_id, sender_name, ACCOUNT)
                await conn.execute(LINK_PARTICIPANT_SQL, conv_id, sender_wa_id)
            new_id = await conn.fetchval(
                INSERT_MESSAGE_SQL,
                wa_msg_id, conv_id, sender_wa_id, timestamp,
                direction.upper(), content, message_type.upper(),
                is_forwarded, reply_ref, json.dumps(metadata), ACCOUNT,
            )
            if new_id is not None:
                return int(new_id)
            # ON CONFLICT — fetch existing id so callers (e.g. attachment writer) can still wire up
            existing = await conn.fetchval(GET_MESSAGE_ID_SQL, wa_msg_id)
            return int(existing) if existing is not None else None


async def insert_attachment(
    pool: asyncpg.Pool,
    message_id: int,
    file_type: str,
    mime_type: str | None,
    file_name: str | None,
    file_size: int | None,
    file_url: str | None,
    duration_seconds: int | None = None,
    width: int | None = None,
    height: int | None = None,
    caption: str | None = None,
) -> None:
    """Insert an attachment row pointing to a MinIO storage key (file_url)."""
    async with pool.acquire() as conn:
        await conn.execute(
            INSERT_ATTACHMENT_SQL,
            message_id, file_type, mime_type, file_name, file_size,
            file_url, duration_seconds, width, height, caption,
        )


async def attachment_exists_for_message(pool: asyncpg.Pool, message_id: int) -> bool:
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT 1 FROM attachments WHERE message_id = $1 LIMIT 1", message_id)
    return row is not None


# --- Transcription helpers ---------------------------------------------------

async def get_pending_transcription(pool: asyncpg.Pool) -> dict | None:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT m.id, "
            "  (m.metadata->>'telegram_message_id')::bigint as telegram_message_id, "
            "  (m.metadata->>'telegram_chat_id')::bigint as chat_id, "
            "  c.name as chat_title "
            "FROM messages m "
            "LEFT JOIN conversations c ON m.conversation_id = c.id "
            "WHERE m.platform = 'telegram' "
            "  AND (m.metadata->>'needs_transcription')::text = 'true' "
            "  AND m.metadata->>'transcription_status' = 'pending' "
            "  AND COALESCE((m.metadata->>'transcription_attempts')::int, 0) < 3 "
            "ORDER BY m.wa_timestamp ASC LIMIT 1"
        )
    return dict(row) if row else None


async def mark_transcription_processing(pool: asyncpg.Pool, msg_id: int):
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE messages SET metadata = jsonb_set(metadata, '{transcription_status}', '\"processing\"') "
            "WHERE id = $1", msg_id
        )


async def complete_transcription(pool: asyncpg.Pool, msg_id: int, text: str):
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE messages SET "
            "  content = $2, "
            "  metadata = metadata || '{\"transcription_status\": \"done\"}'::jsonb "
            "WHERE id = $1", msg_id, text
        )


async def fail_transcription(pool: asyncpg.Pool, msg_id: int, error: str, increment_attempts: bool = True):
    async with pool.acquire() as conn:
        if increment_attempts:
            await conn.execute(
                "UPDATE messages SET metadata = metadata || jsonb_build_object("
                "  'transcription_status', 'failed', "
                "  'transcription_error', $2, "
                "  'transcription_attempts', (COALESCE((metadata->>'transcription_attempts')::int, 0) + 1)"
                ") WHERE id = $1", msg_id, error
            )
        else:
            await conn.execute(
                "UPDATE messages SET metadata = metadata || jsonb_build_object("
                "  'transcription_status', 'pending', "
                "  'transcription_error', $2"
                ") WHERE id = $1", msg_id, error
            )


# --- Sync state (unchanged) --------------------------------------------------

async def get_sync_state(pool: asyncpg.Pool, chat_id: int) -> dict | None:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM telegram_sync_state WHERE chat_id = $1", chat_id
        )
    return dict(row) if row else None


async def update_sync_state(
    pool: asyncpg.Pool, chat_id: int, chat_title: str | None,
    last_message_id: int, batch_count: int
):
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO telegram_sync_state (chat_id, chat_title, last_message_id, total_imported, updated_at) "
            "VALUES ($1, $2, $3, $4, NOW()) "
            "ON CONFLICT (chat_id) DO UPDATE SET "
            "  chat_title = EXCLUDED.chat_title, "
            "  last_message_id = GREATEST(telegram_sync_state.last_message_id, EXCLUDED.last_message_id), "
            "  total_imported = telegram_sync_state.total_imported + EXCLUDED.total_imported, "
            "  updated_at = NOW()",
            chat_id, chat_title, last_message_id, batch_count
        )


async def mark_chat_completed(pool: asyncpg.Pool, chat_id: int):
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE telegram_sync_state SET completed = TRUE, updated_at = NOW() "
            "WHERE chat_id = $1", chat_id
        )
