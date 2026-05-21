import asyncio
from telethon import TelegramClient
from telethon.sessions import StringSession

async def main():
    api_id = 38377025
    api_hash = "5d9b75f8e002fc6200c0c51f8ddc088b"
    
    client = TelegramClient(StringSession(), api_id, api_hash)
    await client.start(phone="+34659695630")
    
    session_string = client.session.save()
    print(f"\n\nYour new Telethon session string:\n{session_string}\n")
    
    me = await client.get_me()
    print(f"Logged in as: {me.first_name} (id={me.id})")
    
    await client.disconnect()

asyncio.run(main())
