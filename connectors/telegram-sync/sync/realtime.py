"""Real-time handler — capture new/edited messages via Telethon events."""

import asyncio
import logging

import asyncpg
from telethon import TelegramClient, events
from telethon.tl.types import Message

from sync import db, media_download, avatar_sync
from sync.history import _classify_message, _get_chat_info, _get_sender_name

logger = logging.getLogger(__name__)


def register(client: TelegramClient, pool: asyncpg.Pool, my_id: int):
    """Register Telethon event handlers. Call once at startup."""

    @client.on(events.NewMessage)
    async def on_new_message(event):
        msg = event.message
        if not isinstance(msg, Message):
            return

        try:
            chat = await event.get_chat()
            chat_id = event.chat_id
            chat_title, chat_type = _get_chat_info(chat)

            message_type, needs_transcription = _classify_message(msg)
            direction = "outbound" if msg.sender_id == my_id else "inbound"
            sender_name = _get_sender_name(msg)

            if msg.action:
                message_type = "service"
                needs_transcription = False

            new_message_id = await db.insert_message(
                pool,
                telegram_message_id=msg.id,
                chat_id=chat_id,
                chat_title=chat_title,
                chat_type=chat_type,
                sender_id=msg.sender_id,
                sender_name=sender_name,
                content=msg.text,
                message_type=message_type,
                direction=direction,
                timestamp=msg.date,
                is_forwarded=bool(msg.forward),
                reply_to_message_id=msg.reply_to.reply_to_msg_id if msg.reply_to else None,
                needs_transcription=needs_transcription,
            )

            # Auto-download media in background (don't block the event loop on a slow file)
            if new_message_id and msg.media:
                asyncio.create_task(media_download.download_and_store_media(
                    client, pool, msg, new_message_id, message_type
                ))

            # Lazy avatar pulls — only fire if we don't yet have an avatar for
            # the chat OR the sender. Cheap when already populated (a single
            # SELECT). All errors are swallowed inside avatar_sync.
            asyncio.create_task(avatar_sync.ensure_conversation_avatar(client, pool, chat))
            try:
                sender = await event.get_sender()
                if sender is not None:
                    asyncio.create_task(avatar_sync.ensure_participant_avatar(client, pool, sender))
            except Exception:
                pass

            # Notify auto-reply webhook for inbound text messages
            logger.info(f"Message: dir={direction} type={message_type} text={bool(msg.text)} chat={chat_id}")
            if direction == "inbound" and message_type == "text" and msg.text:
                try:
                    from sync.bridge import notify_autoreply
                    asyncio.create_task(notify_autoreply(
                        chat_id=chat_id,
                        chat_title=chat_title,
                        sender_id=msg.sender_id,
                        sender_name=sender_name,
                        content=msg.text,
                        message_type=message_type,
                        telegram_message_id=msg.id,
                        timestamp=msg.date.isoformat(),
                    ))
                except Exception as e:
                    logger.error(f"Webhook notify failed: {e}")

        except Exception as e:
            logger.error(f"Error handling new message: {e}")

    @client.on(events.MessageEdited)
    async def on_message_edited(event):
        msg = event.message
        if not isinstance(msg, Message):
            return

        try:
            wa_msg_id = f"tg_{event.chat_id}_{msg.id}"
            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE messages SET content = $1, is_edited = true "
                    "WHERE wa_message_id = $2 "
                    "  AND (metadata->>'transcription_status') IS NULL",
                    msg.text, wa_msg_id,
                )
        except Exception as e:
            logger.error(f"Error handling edited message: {e}")

    logger.info("Real-time message handlers registered")
