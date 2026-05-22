import express from 'express';
import { TelegramClientWrapper, TelegramMessage } from './telegram-client';
import { TelegramEventPublisher, TelegramMessageReceivedEvent } from './events/publisher';
import { createRouter } from './api/controller';

const TELEGRAM_API_ID = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH || '';
const TELEGRAM_SESSION_STRING = process.env.TELEGRAM_SESSION_STRING || '';
const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222';
const NATS_CA_CERT = process.env.NATS_CA_CERT;
const PORT = parseInt(process.env.PORT || '3002', 10);
const CONNECTOR_SHARED_SECRET =
  process.env.CONNECTOR_SHARED_SECRET || 'dev-secret-change-in-production';

async function main() {
  // Validate required configuration
  if (!TELEGRAM_API_ID || !TELEGRAM_API_HASH) {
    console.error('TELEGRAM_API_ID and TELEGRAM_API_HASH are required');
    console.error('Get them from https://my.telegram.org/apps');
    process.exit(1);
  }

  if (!TELEGRAM_SESSION_STRING) {
    console.error('TELEGRAM_SESSION_STRING is required');
    console.error('Run "pnpm generate-session" to create one');
    process.exit(1);
  }

  const client = new TelegramClientWrapper({
    apiId: TELEGRAM_API_ID,
    apiHash: TELEGRAM_API_HASH,
    sessionString: TELEGRAM_SESSION_STRING,
  });

  const eventPublisher = new TelegramEventPublisher(NATS_URL, NATS_CA_CERT);

  // Setup Express API
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createRouter(client, CONNECTOR_SHARED_SECRET));

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      connected: client.isClientConnected(),
      platform: 'telegram',
    });
  });

  app.listen(PORT, () => {
    console.log(`Telegram Connector API listening on port ${PORT}`);
  });

  // Connect to NATS
  await eventPublisher.connect();

  // Handle connection
  client.on('connected', () => {
    console.log('Connected to Telegram');
  });

  // Handle messages
  client.on('message', async (message: TelegramMessage) => {
    const event: TelegramMessageReceivedEvent = {
      eventType: 'TelegramMessageReceived',
      conversationId: message.conversationId,
      telegramMessageId: message.telegramMessageId,
      telegramTimestamp: message.telegramTimestamp.toISOString(),
      senderTelegramId: message.senderTelegramId,
      senderUsername: message.senderUsername,
      senderFirstName: message.senderFirstName,
      content: message.content || '',
      messageType: message.messageType,
      attachments: message.attachments,
      isForwarded: message.isForwarded,
      replyToMessageId: message.replyToMessageId,
      isOutbound: message.isOutbound,
      chatType: message.chatType,
      chatTitle: message.chatTitle,
    };

    await eventPublisher.publishMessageReceived(event);
  });

  // Connect to Telegram

  // --- Public API endpoints (no auth, for brain/dashboard) ---
  app.get('/api/public/dialogs', async (_req, res) => {
    try {
      if (!client.isClientConnected()) {
        res.status(503).json({ error: 'Not connected' });
        return;
      }
      const dialogs = await client.getDialogs();
      res.json({ dialogs });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.get('/api/public/messages/:chatId', async (req, res) => {
    try {
      if (!client.isClientConnected()) {
        res.status(503).json({ error: 'Not connected' });
        return;
      }
      const limit = parseInt(req.query.limit as string) || 50;
      const messages = await client.getMessages(req.params.chatId, limit);
      res.json({ messages });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.post('/api/public/send/:chatId', async (req, res) => {
    try {
      if (!client.isClientConnected()) {
        res.status(503).json({ error: 'Not connected' });
        return;
      }
      const { text, topicId } = req.body;
      if (!text) {
        res.status(400).json({ error: 'Missing text' });
        return;
      }
      const tid = topicId !== undefined && topicId !== null ? Number(topicId) : undefined;
      if (tid !== undefined && (!Number.isInteger(tid) || tid <= 0)) {
        res.status(400).json({ error: 'topicId must be a positive integer' });
        return;
      }
      await client.sendMessage(req.params.chatId, text, tid);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  await client.connect();

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('Shutting down...');
    await client.disconnect();
    await eventPublisher.disconnect();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('Shutting down...');
    await client.disconnect();
    await eventPublisher.disconnect();
    process.exit(0);
  });
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
