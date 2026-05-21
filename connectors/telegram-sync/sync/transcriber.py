"""Transcription worker — faster-whisper audio transcription (pass 2)."""

import asyncio
import logging
import os
import shutil

import asyncpg
from telethon import TelegramClient
from telethon.errors import FloodWaitError

from sync import db

logger = logging.getLogger(__name__)

POLL_INTERVAL = 30  # seconds
DOWNLOADS_DIR = os.environ.get(
    "DOWNLOADS_DIR",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "downloads"),
)
os.makedirs(DOWNLOADS_DIR, exist_ok=True)
MIN_DISK_MB = 500

# Transient errors that should not burn retry attempts
TRANSIENT_ERRORS = (ConnectionError, OSError, TimeoutError, FloodWaitError, asyncpg.PostgresError)


def _load_model():
    """Load faster-whisper model (called once at startup)."""
    from faster_whisper import WhisperModel

    model_name = os.environ.get("WHISPER_MODEL", "small")
    device = os.environ.get("WHISPER_DEVICE", "cpu")
    compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")

    logger.info(f"Loading Whisper model: {model_name} (device={device}, compute={compute_type})")
    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    logger.info("Whisper model loaded")
    return model


def _check_disk_space() -> bool:
    """Return True if enough disk space available."""
    stat = shutil.disk_usage(DOWNLOADS_DIR)
    free_mb = stat.free / (1024 * 1024)
    return free_mb >= MIN_DISK_MB


def _transcribe(model, file_path: str) -> str:
    """Run transcription and return concatenated text."""
    segments, info = model.transcribe(file_path, language=None)
    texts = [seg.text.strip() for seg in segments if seg.text.strip()]
    full_text = " ".join(texts)
    logger.info(f"Transcribed {os.path.basename(file_path)}: {info.language} ({info.language_probability:.0%}), {len(full_text)} chars")
    return full_text


async def _download_audio(client: TelegramClient, chat_id: int, message_id: int) -> str | None:
    """Download audio file from Telegram. Returns file path or None."""
    try:
        entity = await client.get_entity(chat_id)
        msg = await client.get_messages(entity, ids=message_id)
    except FloodWaitError as e:
        logger.warning(f"FloodWait downloading audio: sleeping {e.seconds + 5}s")
        await asyncio.sleep(e.seconds + 5)
        raise  # Will be caught as transient
    except Exception as e:
        raise

    if msg is None:
        return None  # Message deleted

    os.makedirs(DOWNLOADS_DIR, exist_ok=True)
    path = await client.download_media(msg, file=DOWNLOADS_DIR)
    return path


async def run(client: TelegramClient, pool: asyncpg.Pool):
    """Main transcription loop — poll for pending audio, transcribe, save."""
    # Wait a bit for history import to start populating the queue
    await asyncio.sleep(10)

    model = await asyncio.get_event_loop().run_in_executor(None, _load_model)

    while True:
        try:
            row = await db.get_pending_transcription(pool)
            if row is None:
                await asyncio.sleep(POLL_INTERVAL)
                continue

            msg_id = row["id"]
            tg_msg_id = row["telegram_message_id"]
            chat_id = row["chat_id"]
            chat_title = row.get("chat_title", "unknown")

            logger.info(f"Transcribing msg {tg_msg_id} from {chat_title}")
            await db.mark_transcription_processing(pool, msg_id)

            # Check disk space
            if not _check_disk_space():
                logger.warning("Low disk space — pausing transcription")
                await db.fail_transcription(pool, msg_id, "low_disk_space", increment_attempts=False)
                await asyncio.sleep(POLL_INTERVAL * 10)
                continue

            # Download audio
            file_path = None
            try:
                file_path = await _download_audio(client, chat_id, tg_msg_id)
            except TRANSIENT_ERRORS as e:
                logger.warning(f"Transient download error for {tg_msg_id}: {e}")
                await db.fail_transcription(pool, msg_id, f"download:{e}", increment_attempts=False)
                continue

            if file_path is None:
                # Message was deleted
                await db.fail_transcription(pool, msg_id, "message_deleted", increment_attempts=True)
                continue

            # Transcribe (run in executor to not block event loop)
            try:
                text = await asyncio.get_event_loop().run_in_executor(
                    None, _transcribe, model, file_path
                )
                if text:
                    await db.complete_transcription(pool, msg_id, text)
                    logger.info(f"Transcription complete for {tg_msg_id}: {len(text)} chars")
                else:
                    await db.fail_transcription(pool, msg_id, "empty_transcription", increment_attempts=True)
            except Exception as e:
                logger.error(f"Transcription failed for {tg_msg_id}: {e}")
                await db.fail_transcription(pool, msg_id, str(e)[:500], increment_attempts=True)
            finally:
                # Clean up audio file
                if file_path and os.path.exists(file_path):
                    try:
                        os.remove(file_path)
                    except OSError:
                        pass

        except Exception as e:
            logger.error(f"Transcription worker error: {e}")
            await asyncio.sleep(POLL_INTERVAL)
