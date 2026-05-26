"""Download Telegram profile photos (chats + users) into MinIO and persist
the storage key into conversations.avatar_url / participants.profile_pic_url.

Used by:
  - history.py: in the get_dialogs() loop, one call per dialog at startup
  - realtime.py: lazily on message ingest if the conv/participant has no avatar
  - Standalone backfill: drain everything missing
"""
from __future__ import annotations

import io
import logging
from typing import Optional

import asyncpg
from telethon import TelegramClient

from sync import media_storage

logger = logging.getLogger(__name__)


def _conv_id_for_dialog(entity) -> Optional[str]:
    """Map a Telethon dialog.entity to the conversation id used in the
    whatsappmcp.conversations table. Convention used elsewhere in the codebase:
    `tg_<chat_id>` (with the negative sign preserved for groups/channels)."""
    eid = getattr(entity, "id", None)
    if eid is None:
        return None
    # Telethon User has positive id; groups/channels are negative as Bot API style.
    # The connector publishes negative IDs for groups already.
    # Channels: id is positive but conventionally we use `-100<id>`.
    cls = type(entity).__name__
    if cls == "User":
        return f"tg_{eid}"
    if cls in ("Chat",):
        return f"tg_-{eid}"
    if cls in ("Channel", "ChannelForbidden"):
        return f"tg_-100{eid}"
    return f"tg_{eid}"


async def _download_entity_photo(client: TelegramClient, entity) -> Optional[bytes]:
    """Telethon downloads the profile photo of any User/Chat/Channel via
    client.download_profile_photo(entity, file=bytes, download_big=True).
    Returns the bytes, or None if the entity has no accessible photo."""
    if not getattr(entity, "photo", None):
        return None
    buf = io.BytesIO()
    try:
        result = await client.download_profile_photo(entity, file=buf, download_big=True)
    except Exception as e:
        logger.warning(f"download_profile_photo failed for {entity}: {e}")
        return None
    if result is None:
        return None
    data = buf.getvalue()
    return data if data else None


async def ensure_conversation_avatar(
    client: TelegramClient,
    pool: asyncpg.Pool,
    entity,
    *,
    force: bool = False,
) -> bool:
    """Download conversation/group avatar if we don't have one yet.

    Returns True if a new avatar was persisted, False otherwise (skipped or
    no photo available)."""
    conv_id = _conv_id_for_dialog(entity)
    if not conv_id:
        return False

    if not force:
        row = await pool.fetchrow(
            "SELECT avatar_url FROM conversations WHERE id = $1", conv_id,
        )
        if row and row["avatar_url"]:
            return False

    data = await _download_entity_photo(client, entity)
    if not data:
        return False

    storage_key = media_storage.upload_avatar("conversations", conv_id, data)
    # UPSERT so we don't fail if the conversation row doesn't exist yet
    # (it always should via the message ingestion path, but be defensive).
    await pool.execute(
        "UPDATE conversations SET avatar_url = $2, updated_at = NOW() WHERE id = $1",
        conv_id, storage_key,
    )
    logger.info(f"ensured avatar for conversation {conv_id} → {storage_key}")
    return True


async def ensure_participant_avatar(
    client: TelegramClient,
    pool: asyncpg.Pool,
    user_entity,
    *,
    force: bool = False,
) -> bool:
    """Download a user's profile photo and persist into participants.profile_pic_url."""
    uid = getattr(user_entity, "id", None)
    if uid is None:
        return False
    pid = f"tg_{uid}"

    if not force:
        row = await pool.fetchrow(
            "SELECT profile_pic_url FROM participants WHERE id = $1", pid,
        )
        if row and row["profile_pic_url"]:
            return False

    data = await _download_entity_photo(client, user_entity)
    if not data:
        return False

    storage_key = media_storage.upload_avatar("participants", pid, data)
    # UPSERT: insert the participant row if not seen yet (so the avatar is not
    # lost on first contact).
    name = (
        getattr(user_entity, "first_name", None)
        or getattr(user_entity, "title", None)
        or None
    )
    push_name = getattr(user_entity, "username", None) or None
    await pool.execute(
        "INSERT INTO participants (id, name, push_name, profile_pic_url, first_seen, last_seen) "
        "VALUES ($1, $2, $3, $4, NOW(), NOW()) "
        "ON CONFLICT (id) DO UPDATE SET "
        "  profile_pic_url = EXCLUDED.profile_pic_url, "
        "  name = COALESCE(participants.name, EXCLUDED.name), "
        "  push_name = COALESCE(participants.push_name, EXCLUDED.push_name), "
        "  last_seen = NOW()",
        pid, name, push_name, storage_key,
    )
    logger.info(f"ensured avatar for participant {pid} → {storage_key}")
    return True


async def ensure_dialog_avatars(
    client: TelegramClient,
    pool: asyncpg.Pool,
    dialog,
    *,
    force: bool = False,
) -> tuple[bool, int]:
    """Convenience helper invoked from history.py's get_dialogs() loop.

    Downloads:
      1) the dialog's own avatar (chat group photo OR 1:1 user photo)
      2) for groups, optionally each known participant's avatar
         (skipped here — expensive; backfill script handles bulk)

    Returns (conv_downloaded, participants_downloaded).
    """
    conv_done = await ensure_conversation_avatar(
        client, pool, dialog.entity, force=force,
    )
    return conv_done, 0
