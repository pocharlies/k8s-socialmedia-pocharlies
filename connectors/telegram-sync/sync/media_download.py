"""Download Telegram media → upload to MinIO → INSERT attachment row.

Used by realtime.py (single-message), history.py (batch ingest), and the
30-day backfill script. Errors are caught & logged; the caller's flow never
breaks because of a media failure.
"""
from __future__ import annotations

import io
import logging
from typing import Optional

import asyncpg
from telethon import TelegramClient
from telethon.tl.types import (
    Message,
    MessageMediaDocument,
    MessageMediaPhoto,
    DocumentAttributeAudio,
    DocumentAttributeFilename,
    DocumentAttributeImageSize,
    DocumentAttributeVideo,
)

from sync import db, media_storage

logger = logging.getLogger(__name__)

# Telegram media types that we want to download. Sticker is included so the UI
# can render it as an image; service messages and plain text are skipped.
DOWNLOADABLE_TYPES = {"photo", "video", "audio", "voice", "video_note", "sticker", "document"}


def _extract_attrs(msg: Message) -> dict:
    """Pull mime_type, file_name, file_size, duration, width, height from a Telegram
    Message regardless of whether the media is a Photo or Document."""
    out: dict = {
        "mime_type": None,
        "file_name": None,
        "file_size": None,
        "duration": None,
        "width": None,
        "height": None,
    }
    if not msg.media:
        return out

    if isinstance(msg.media, MessageMediaPhoto) and msg.media.photo:
        out["mime_type"] = "image/jpeg"
        sizes = getattr(msg.media.photo, "sizes", None) or []
        # Pick the largest size (usually last)
        for s in reversed(sizes):
            w = getattr(s, "w", None)
            h = getattr(s, "h", None)
            if w and h:
                out["width"] = w
                out["height"] = h
                size = getattr(s, "size", None)
                if size:
                    out["file_size"] = size
                break
        return out

    if isinstance(msg.media, MessageMediaDocument) and msg.media.document:
        doc = msg.media.document
        out["mime_type"] = doc.mime_type
        out["file_size"] = doc.size
        for attr in doc.attributes or []:
            if isinstance(attr, DocumentAttributeFilename):
                out["file_name"] = attr.file_name
            elif isinstance(attr, DocumentAttributeVideo):
                out["duration"] = attr.duration
                out["width"] = attr.w
                out["height"] = attr.h
            elif isinstance(attr, DocumentAttributeAudio):
                out["duration"] = attr.duration
            elif isinstance(attr, DocumentAttributeImageSize):
                out["width"] = attr.w
                out["height"] = attr.h
        return out

    return out


async def download_and_store_media(
    client: TelegramClient,
    pool: asyncpg.Pool,
    msg: Message,
    message_id: int,
    message_type: str,
) -> bool:
    """Download msg's media to MinIO and INSERT an attachments row.
    Returns True on success, False otherwise. Skips silently if message_type
    isn't in DOWNLOADABLE_TYPES or msg has no media.
    """
    mt = (message_type or "").lower()
    if mt not in DOWNLOADABLE_TYPES:
        return False
    if not msg.media:
        return False

    # Skip if we already have an attachment for this message (idempotent on retry)
    try:
        if await db.attachment_exists_for_message(pool, message_id):
            return False
    except Exception:
        pass  # fall through and try the download anyway

    try:
        buf = io.BytesIO()
        await client.download_media(msg, file=buf)
        data = buf.getvalue()
        if not data:
            logger.warning(f"download_media returned 0 bytes for msg {message_id}")
            return False
    except Exception as e:
        logger.warning(f"download_media failed for msg {message_id}: {e}")
        return False

    attrs = _extract_attrs(msg)
    try:
        storage_key, size = media_storage.upload_media(
            message_id=message_id,
            data=data,
            mime_type=attrs["mime_type"],
            file_name=attrs["file_name"],
        )
    except Exception as e:
        logger.warning(f"MinIO upload failed for msg {message_id}: {e}")
        return False

    caption = msg.text or None
    try:
        await db.insert_attachment(
            pool,
            message_id=message_id,
            file_type=message_type.upper(),
            mime_type=attrs["mime_type"],
            file_name=attrs["file_name"],
            file_size=attrs["file_size"] or size,
            file_url=storage_key,
            duration_seconds=attrs["duration"],
            width=attrs["width"],
            height=attrs["height"],
            caption=caption,
        )
    except Exception as e:
        logger.error(f"insert_attachment failed for msg {message_id}: {e}")
        return False

    logger.info(f"Stored media {storage_key} ({size} bytes) for msg {message_id}")
    return True
