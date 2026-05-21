/**
 * One-shot script to log in interactively and print a mtcute-format session string.
 *
 * Usage (inside the workspace):
 *   pnpm --filter @mcp-socialmedia/telegram-connector generate-session
 *
 * Or directly:
 *   TELEGRAM_API_ID=... TELEGRAM_API_HASH=... tsx src/generate-session-mtcute.ts
 *
 * The script will prompt for phone, OTP, and 2FA password if applicable, then
 * print the session string to stdout. Copy that value into the `TELEGRAM_SESSION_STRING`
 * env var (e.g. in .env) and restart the connector.
 */
import { TelegramClient, MemoryStorage } from '@mtcute/node';

const apiId = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
const apiHash = process.env.TELEGRAM_API_HASH || '';

if (!apiId || !apiHash) {
  console.error('TELEGRAM_API_ID and TELEGRAM_API_HASH are required');
  console.error('Get them from https://my.telegram.org/apps');
  process.exit(1);
}

async function main(): Promise<void> {
  const tg = new TelegramClient({
    apiId,
    apiHash,
    storage: new MemoryStorage(),
  });

  try {
    const me = await tg.start({
      phone: () => tg.input('Phone (e.g. +34611234567): '),
      code: () => tg.input('OTP code from Telegram: '),
      password: () => tg.input('2FA password (leave blank if none): '),
    });

    const session = await tg.exportSession();

    console.log('');
    console.log('=================================================================');
    console.log(`Logged in as ${me.username ? '@' + me.username : me.firstName} (id=${me.id})`);
    console.log('=================================================================');
    console.log('');
    console.log('Copy the line below into TELEGRAM_SESSION_STRING in your .env:');
    console.log('');
    console.log(session);
    console.log('');
    console.log('Then: docker compose restart telegram-connector');
    console.log('=================================================================');
  } finally {
    await tg.destroy();
  }
}

main().catch((err) => {
  console.error('Login failed:', err);
  process.exit(1);
});
