/**
 * WhatsApp Cloud API Connector
 * Express server with webhook + NATS publisher + API proxy.
 * Compatible with the old Baileys connector API (send, react, health).
 */

import express from 'express';
import pino from 'pino';
import { WhatsAppCloudAPI } from './cloud-api';
import { createWebhookRouter } from './webhook';
import { WhatsAppCloudPublisher } from './publisher';
import { createHMACAuth, AuthenticatedRequest } from './auth';

const logger = pino({
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

const PORT = parseInt(process.env.PORT || '3004', 10);
const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222';
const NATS_CA_CERT = process.env.NATS_CA_CERT;
const WEBHOOK_VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'wa-cloud-verify';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const WHATSAPP_BUSINESS_ACCOUNT_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '';
const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET || '';
const CONNECTOR_SHARED_SECRET = process.env.CONNECTOR_SHARED_SECRET || 'dev-secret';

async function main(): Promise<void> {
  if (!WHATSAPP_ACCESS_TOKEN) {
    logger.error('WHATSAPP_ACCESS_TOKEN is required');
    process.exit(1);
  }
  if (!WHATSAPP_PHONE_NUMBER_ID) {
    logger.error('WHATSAPP_PHONE_NUMBER_ID is required');
    process.exit(1);
  }

  const api = new WhatsAppCloudAPI({
    accessToken: WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: WHATSAPP_PHONE_NUMBER_ID,
    businessAccountId: WHATSAPP_BUSINESS_ACCOUNT_ID,
  });

  const publisher = new WhatsAppCloudPublisher(
    NATS_URL,
    NATS_CA_CERT !== 'none' ? NATS_CA_CERT : undefined
  );
  await publisher.connect();

  const hmacAuth = createHMACAuth(CONNECTOR_SHARED_SECRET);
  const app = express();

  // Raw body for webhook signature validation
  app.use('/webhook', express.json({
    verify: (req: any, _res, buf) => { req.rawBody = buf.toString(); },
  }));
  app.use(express.json());

  // Webhook routes (verification + incoming messages)
  app.use('/', createWebhookRouter(
    WEBHOOK_VERIFY_TOKEN,
    FACEBOOK_APP_SECRET,
    (message) => {
      publisher.publishMessage(message);
    },
    (status) => {
      publisher.publishStatus(status);
    }
  ));

  // Health check
  app.get('/api/v1/health', async (_req, res) => {
    try {
      const info = await api.getPhoneNumberInfo();
      res.json({
        status: 'ok',
        platform: 'whatsapp',
        type: 'cloud_api',
        connected: true,
        phone_number: info.display_phone_number,
        verified_name: info.verified_name,
        quality_rating: info.quality_rating,
      });
    } catch (error) {
      res.json({
        status: 'degraded',
        platform: 'whatsapp',
        type: 'cloud_api',
        connected: false,
        error: String(error),
      });
    }
  });

  app.get('/status', async (_req, res) => {
    try {
      const info = await api.getPhoneNumberInfo();
      res.json({ connected: true, phone_number: info.display_phone_number });
    } catch {
      res.json({ connected: false });
    }
  });

  // Send message — compatible with old Baileys connector
  // POST /api/v1/messages/send {sendToken, conversationId, content}
  app.post('/api/v1/messages/send', hmacAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { conversationId, content } = req.body;
      if (!conversationId || !content) {
        res.status(400).json({ error: 'conversationId and content required' });
        return;
      }

      const result = await api.sendText(conversationId, content);
      const messageId = result.messages?.[0]?.id || '';

      res.json({
        messageId,
        sentAt: new Date().toISOString(),
      });
      logger.info({ to: conversationId, messageId }, 'Message sent');
    } catch (error) {
      logger.error({ error: String(error) }, 'Failed to send message');
      res.status(500).json({ error: String(error) });
    }
  });

  // React to message
  app.post('/api/v1/messages/react', hmacAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { conversationId, messageId, emoji } = req.body;
      await api.sendReaction(conversationId, messageId, emoji);
      res.json({
        reacted: true,
        emoji,
        messageId,
        reactedAt: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Mark as read
  app.post('/api/v1/messages/read', hmacAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { messageId } = req.body;
      await api.markAsRead(messageId);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Send template
  app.post('/api/v1/messages/template', hmacAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { conversationId, templateName, language } = req.body;
      const result = await api.sendTemplate(conversationId, templateName, language);
      res.json({ messageId: result.messages?.[0]?.id });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Send image
  app.post('/api/v1/messages/image', hmacAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { conversationId, imageUrl, caption } = req.body;
      const result = await api.sendImage(conversationId, imageUrl, caption);
      res.json({ messageId: result.messages?.[0]?.id });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.listen(PORT, () => {
    logger.info(`WhatsApp Cloud Connector listening on port ${PORT}`);
    logger.info(`Webhook: http://localhost:${PORT}/webhook`);
    logger.info(`Health: http://localhost:${PORT}/api/v1/health`);
  });

  process.on('SIGINT', () => {
    logger.info('Shutting down...');
    void publisher.disconnect();
    process.exit(0);
  });
}

main().catch(error => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
