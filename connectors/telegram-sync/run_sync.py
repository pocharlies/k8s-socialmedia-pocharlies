#!/usr/bin/env python3
"""Telegram Sync Worker — history import + real-time capture + transcription + HTTP bridge."""
import asyncio
import logging
import os

from dotenv import load_dotenv
load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)

from telethon import TelegramClient
from telethon.sessions import StringSession


async def main():
    api_id = int(os.environ["TELEGRAM_API_ID"])
    api_hash = os.environ["TELEGRAM_API_HASH"]
    session_string = os.environ["TELEGRAM_SESSION_STRING"]

    client = TelegramClient(
        StringSession(session_string),
        api_id,
        api_hash,
    )

    # Use connect() instead of start() to avoid interactive auth prompts
    await client.connect()
    if not await client.is_user_authorized():
        logging.error("Session string is invalid or expired. Generate a new one.")
        return

    me = await client.get_me()
    logging.info(f"Telegram connected as {me.first_name} (id={me.id})")

    from sync import db, history, realtime, transcriber, bridge

    pool = await db.create_pool()
    await db.init_schema(pool)
    await db.recover_stuck_transcriptions(pool)

    # Wire up bridge with telegram client and db pool
    bridge.set_telegram_client(client)
    bridge.set_db_pool(pool)

    realtime.register(client, pool, me.id)

    # Start HTTP bridge server
    bridge_port = int(os.environ.get("BRIDGE_PORT", "3080"))

    import uvicorn
    config = uvicorn.Config(bridge.app, host="0.0.0.0", port=bridge_port, log_level="info")
    server = uvicorn.Server(config)
    bridge_task = asyncio.create_task(server.serve())
    logging.info(f"Bridge HTTP server starting on port {bridge_port}")

    history_task = asyncio.create_task(history.run(client, pool))

    try:
        import faster_whisper
        transcriber_task = asyncio.create_task(transcriber.run(client, pool))
        logging.info("Sync started: history + realtime + transcription + bridge")
        await asyncio.gather(history_task, transcriber_task, bridge_task)
    except ImportError:
        logging.info("faster-whisper not available, running without transcription")
        await asyncio.gather(history_task, bridge_task)


if __name__ == "__main__":
    asyncio.run(main())
