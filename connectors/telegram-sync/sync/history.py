"""History importer — full Telegram message history to PostgreSQL (pass 1)."""

import asyncio
import logging
from datetime import datetime, timezone

import asyncpg
from telethon import TelegramClient
from telethon.tl.types import (
    Channel, Chat, User, Message,
    MessageMediaDocument, MessageMediaPhoto,
)
from telethon.errors import FloodWaitError

from sync import db, media_download

logger = logging.getLogger(__name__)

BATCH_SIZE = 100
DELAY_BETWEEN_CHATS = 1  # seconds
CATCHUP_INTERVAL = 30 * 60  # 30 minutes


def _classify_message(msg: Message) -> tuple[str, bool]:
    """Return (message_type, needs_transcription)."""
    if not msg.media:
        return ("text", False)

    if isinstance(msg.media, MessageMediaPhoto):
        return ("photo", False)

    if isinstance(msg.media, MessageMediaDocument) and msg.media.document:
        doc = msg.media.document
        attrs = {type(a).__name__: a for a in (doc.attributes or [])}

        if "DocumentAttributeAudio" in attrs:
            audio = attrs["DocumentAttributeAudio"]
            msg_type = "voice" if audio.voice else "audio"
            return (msg_type, True)
        if "DocumentAttributeVideo" in attrs:
            video = attrs["DocumentAttributeVideo"]
            return ("video_note" if video.round_message else "video", False)
        if "DocumentAttributeSticker" in attrs:
            return ("sticker", False)
        return ("document", False)

    return ("other", False)


def _get_chat_info(entity) -> tuple[str | None, str]:
    """Return (chat_title, chat_type) from entity."""
    if isinstance(entity, User):
        name = " ".join(filter(None, [entity.first_name, entity.last_name]))
        return (name or str(entity.id), "private")
    if isinstance(entity, Channel):
        chat_type = "channel" if entity.broadcast else "supergroup"
        return (entity.title, chat_type)
    if isinstance(entity, Chat):
        return (entity.title, "group")
    return (None, "unknown")


def _get_sender_name(msg: Message) -> str | None:
    """Extract sender display name from message."""
    if msg.sender:
        if isinstance(msg.sender, User):
            return " ".join(filter(None, [msg.sender.first_name, msg.sender.last_name]))
        if hasattr(msg.sender, "title"):
            return msg.sender.title
    return None


async def _flush_batch(client: TelegramClient, pool: asyncpg.Pool, batch: list) -> None:
    """Insert each (msg, args) in the batch; for messages with media, download
    them to MinIO inline. Inline (not background) to avoid spawning hundreds of
    parallel telegram fetches that trigger FloodWait — at ~1s/file the historical
    pace is fine and matches the iter_messages cadence.
    """
    for msg, args in batch:
        message_id = await db.insert_message(pool, *args)
        if message_id is None:
            continue
        # args[7] is message_type (see batch.append signature)
        message_type = args[7]
        if msg.media and message_type and message_type.lower() in media_download.DOWNLOADABLE_TYPES:
            try:
                await media_download.download_and_store_media(
                    client, pool, msg, message_id, message_type
                )
            except Exception as e:
                logger.warning(f"media download error in batch (msg {message_id}): {e}")


async def import_chat(
    client: TelegramClient,
    pool: asyncpg.Pool,
    dialog,
    my_id: int,
):
    """Import all messages from a single chat."""
    entity = dialog.entity
    chat_id = dialog.id
    chat_title, chat_type = _get_chat_info(entity)

    # Check resume point
    state = await db.get_sync_state(pool, chat_id)
    min_id = state["last_message_id"] if state else 0

    # Snapshot max_id to set upper bound
    try:
        latest = await client.get_messages(entity, limit=1)
        max_id = latest[0].id if latest else 0
    except Exception as e:
        logger.warning(f"Could not get latest message for {chat_title}: {e}")
        return

    if min_id >= max_id:
        if state and not state.get("completed"):
            await db.mark_chat_completed(pool, chat_id)
        return  # Already fully imported

    logger.info(f"Importing {chat_title} (chat_id={chat_id}) from msg {min_id} to {max_id}")

    batch = []
    count = 0

    try:
        async for msg in client.iter_messages(
            entity, min_id=min_id, max_id=max_id + 1, reverse=True
        ):
            if not isinstance(msg, Message):
                continue

            message_type, needs_transcription = _classify_message(msg)
            direction = "outbound" if msg.sender_id == my_id else "inbound"
            sender_name = _get_sender_name(msg)

            # Service messages (user joined, etc.)
            if msg.action:
                message_type = "service"
                needs_transcription = False

            batch.append((msg, (
                msg.id, chat_id, chat_title, chat_type,
                msg.sender_id, sender_name,
                msg.text,  # None for media-only messages
                message_type, direction,
                msg.date,  # Already timezone-aware from Telethon
                bool(msg.forward), msg.reply_to.reply_to_msg_id if msg.reply_to else None,
                needs_transcription,
            )))

            if len(batch) >= BATCH_SIZE:
                await _flush_batch(client, pool, batch)
                last_id = batch[-1][1][0]
                await db.update_sync_state(pool, chat_id, chat_title, last_id, len(batch))
                count += len(batch)
                batch.clear()

    except FloodWaitError as e:
        logger.warning(f"FloodWait for {chat_title}: sleeping {e.seconds + 5}s")
        # Save progress before sleeping
        if batch:
            await _flush_batch(client, pool, batch)
            last_id = batch[-1][1][0]
            await db.update_sync_state(pool, chat_id, chat_title, last_id, len(batch))
            count += len(batch)
            batch.clear()
        await asyncio.sleep(e.seconds + 5)
        return  # Will be retried next cycle

    # Flush remaining
    if batch:
        await _flush_batch(client, pool, batch)
        last_id = batch[-1][1][0]
        await db.update_sync_state(pool, chat_id, chat_title, last_id, len(batch))
        count += len(batch)

    await db.mark_chat_completed(pool, chat_id)
    logger.info(f"Completed {chat_title}: {count} messages imported")


async def run(client: TelegramClient, pool: asyncpg.Pool):
    """Main entry point — import all history, then periodic catch-up."""
    me = await client.get_me()
    my_id = me.id
    consecutive_disconnect_failures = 0

    while True:
        try:
            if not client.is_connected():
                logger.error("Telegram client is not connected — exiting so restart policy can recover")
                raise SystemExit(1)

            dialogs = await client.get_dialogs()
            logger.info(f"Starting sync for {len(dialogs)} chats")

            for dialog in dialogs:
                try:
                    await import_chat(client, pool, dialog, my_id)
                except FloodWaitError as e:
                    logger.warning(f"FloodWait between chats: sleeping {e.seconds + 5}s")
                    await asyncio.sleep(e.seconds + 5)
                except Exception as e:
                    logger.error(f"Error importing chat {dialog.name}: {e}")
                await asyncio.sleep(DELAY_BETWEEN_CHATS)

            logger.info("Sync cycle complete. Next run in 30 minutes.")
            consecutive_disconnect_failures = 0

        except FloodWaitError as e:
            logger.warning(f"FloodWait on get_dialogs: sleeping {e.seconds + 5}s")
            await asyncio.sleep(e.seconds + 5)
            continue
        except Exception as e:
            err_str = str(e)
            logger.error(f"Sync cycle failed: {err_str}")
            if "disconnected" in err_str.lower() or "not connected" in err_str.lower():
                consecutive_disconnect_failures += 1
                if consecutive_disconnect_failures >= 2:
                    logger.error(
                        f"Disconnected for {consecutive_disconnect_failures} cycles — exiting for restart"
                    )
                    raise SystemExit(1)

        await asyncio.sleep(CATCHUP_INTERVAL)
