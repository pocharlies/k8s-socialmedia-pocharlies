import express from 'express';
import { BaileysClient, WhatsAppMessage } from './baileys-client';
import { QRHandler } from './qr-handler';
import { EventPublisher } from './events/publisher';
import { createRouter } from './api/controller';
import { join } from 'path';
import { MessageReceivedEvent, EventType } from '@mcp-socialmedia/shared';

const SESSION_PATH = process.env.SESSION_PATH || join(process.cwd(), 'session-data');
const ENCRYPTION_KEY =
  process.env.SESSION_ENCRYPTION_KEY || 'dev-encryption-key-change-in-production';
const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222';
const NATS_CA_CERT = process.env.NATS_CA_CERT;
const PORT = parseInt(process.env.PORT || '3001', 10);
const CONNECTOR_SHARED_SECRET =
  process.env.CONNECTOR_SHARED_SECRET || 'dev-secret-change-in-production';

async function main(): Promise<void> {
  const client = new BaileysClient(SESSION_PATH, ENCRYPTION_KEY);
  const qrHandler = new QRHandler();
  const eventPublisher = new EventPublisher(NATS_URL, NATS_CA_CERT);

  const app = express();
  app.use(express.json({ limit: '15mb' })); // large enough for base64 voice notes
  app.use('/api/v1', createRouter(client, qrHandler, CONNECTOR_SHARED_SECRET));

  app.get('/', (_req, res) => {
    res.redirect(302, '/qr/page');
  });

  // Live QR endpoint — serves QR as PNG image from memory
  app.get('/qr', (_req, res) => {
    const qrData = qrHandler.getCurrentQR();
    if (qrData) {
      const base64Data = qrData.qrCode.replace(/^data:image\/png;base64,/, '');
      const imgBuffer = Buffer.from(base64Data, 'base64');
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.send(imgBuffer);
    } else {
      res.status(404).json({
        status: 'no_qr',
        message: 'No QR available — already connected or waiting for generation',
      });
    }
  });

  // QR page — smart page that polls /status and stops on connection
  app.get('/qr/page', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html><head><title>WhatsApp QR</title>
<style>
body{display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#111;color:#fff;font-family:sans-serif;flex-direction:column}
img{width:400px;height:400px;border:4px solid #25D366;border-radius:8px}
.connected{color:#25D366;font-size:2em;padding:20px;border:3px solid #25D366;border-radius:12px}
.waiting{color:#666;font-size:1.2em}
</style>
<script>
async function checkStatus() {
  try {
    const res = await fetch('/status');
    const data = await res.json();
    if (data.connected) {
      document.getElementById('qr-section').style.display = 'none';
      document.getElementById('connected-section').style.display = 'block';
      return;
    }
  } catch(e) {}
  document.getElementById('qr-img').src = '/qr?' + Date.now();
  setTimeout(checkStatus, 3000);
}
window.onload = checkStatus;
</script>
</head><body>
<div id="qr-section">
  <h2>Scan with WhatsApp</h2>
  <img id="qr-img" src="/qr" onerror="this.style.opacity='0.3'" />
  <p class="waiting">Waiting for scan... (auto-refreshes every 3s)</p>
</div>
<div id="connected-section" style="display:none">
  <p class="connected">WhatsApp Connected!</p>
  <p>Session is saved. You can close this page.</p>
</div>
</body></html>`);
  });

  // Status endpoint
  app.get('/status', (_req, res) => {
    res.json({
      ...client.getStatus(),
      session_path: SESSION_PATH,
    });
  });

  app.listen(PORT, () => {
    console.log(`WhatsApp Connector API listening on port ${PORT}`);
    console.log(`QR page: http://localhost:${PORT}/qr/page`);
  });

  // NATS is optional
  await eventPublisher.connect();

  client.on('qr', (qr: string) => {
    console.log('QR code received — view at /qr/page');
    void qrHandler.generateQR(qr);
  });

  client.on('connected', () => {
    console.log('WhatsApp connected — session persisted to ' + SESSION_PATH);
    qrHandler.clearQR();
  });

  client.on('message', (message: WhatsAppMessage) => {
    const event: MessageReceivedEvent = {
      eventType: EventType.MESSAGE_RECEIVED,
      conversationId: message.conversationId,
      waMessageId: message.waMessageId,
      waTimestamp: message.waTimestamp.toISOString(),
      senderWaId: message.senderWaId,
      content: message.content || '',
      messageType: message.messageType,
      attachments: message.attachments,
      isForwarded: message.isForwarded,
      replyToWaId: message.replyToWaId,
    };
    eventPublisher.publishMessageReceived(event);
  });

  client.on('message-update', (update: { waMessageId: string; updateType: string }) => {
    eventPublisher.publishMessageUpdated({
      eventType: EventType.MESSAGE_UPDATED,
      waMessageId: update.waMessageId,
      updateType: update.updateType as 'EDITED' | 'DELETED',
      updatedAt: new Date().toISOString(),
    });
  });

  client.on(
    'chat-update',
    (update: { waChatId: string; updateType: string; metadata: Record<string, unknown> }) => {
      eventPublisher.publishChatUpdated({
        eventType: EventType.CHAT_UPDATED,
        waChatId: update.waChatId,
        updateType: update.updateType as
          | 'NAME_CHANGED'
          | 'PARTICIPANT_ADDED'
          | 'PARTICIPANT_REMOVED',
        metadata: update.metadata || {},
      });
    }
  );

  // --- Public history endpoints (for sync service) ---
  app.get('/api/public/chats', async (_req, res) => {
    try {
      const chats = await client.getChats();
      res.json({
        chats: chats.map((c: any) => ({
          id: c.id?._serialized || c.id,
          name: c.name,
          isGroup: c.isGroup,
          timestamp: c.timestamp,
        })),
      });
    } catch (e) {
      console.error('Error getting chats:', e);
      res.status(500).json({ error: String(e) });
    }
  });

  app.get('/api/public/history/:chatId', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 500;
      const messages = await client.fetchChatHistory(req.params.chatId, limit);
      res.json({ messages });
    } catch (e) {
      console.error('Error fetching history:', e);
      res.status(500).json({ error: String(e) });
    }
  });

  // Best-effort historical media backfill — wwebjs can usually only fetch the
  // last ~50 messages per chat, so older media will be marked unavailable.
  // Run via: curl -X POST 'http://localhost:3001/api/public/backfill-media?days=7&limit=200'
  app.post('/api/public/backfill-media', async (req, res) => {
    try {
      const days = parseInt(req.query.days as string) || 7;
      const limit = parseInt(req.query.limit as string) || 100;
      const result = await client.backfillRecentMedia(days, limit);
      res.json(result);
    } catch (e) {
      console.error('Backfill failed:', e);
      res.status(500).json({ error: String(e) });
    }
  });

  await client.connect();

  process.on('SIGINT', () => {
    console.log('Shutting down...');
    client.disconnect();
    void eventPublisher.disconnect();
    process.exit(0);
  });
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
