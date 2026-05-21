/**
 * WhatsApp Cloud API Webhook Handler
 * Handles Meta webhook verification and incoming WhatsApp messages.
 */

import { Router, Request, Response } from 'express';
import { createHmac } from 'crypto';
import pino from 'pino';

const logger = pino({
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

export interface IncomingMessage {
  waMessageId: string;
  from: string;          // phone number
  displayName?: string;  // push name
  timestamp: string;     // ISO
  type: string;          // text, image, video, audio, document, location, contacts, interactive
  content: string;
  attachments?: Array<{ type: string; url: string; metadata: Record<string, unknown> }>;
  isForwarded: boolean;
  replyToWaId?: string;
  context?: { from: string; id: string };
}

export interface StatusUpdate {
  waMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  recipientId: string;
  errors?: Array<{ code: number; title: string }>;
}

type MessageCallback = (message: IncomingMessage) => void;
type StatusCallback = (status: StatusUpdate) => void;

export function createWebhookRouter(
  verifyToken: string,
  appSecret: string,
  onMessage: MessageCallback,
  onStatus: StatusCallback
): Router {
  const router = Router();

  // Meta webhook verification (GET)
  router.get('/webhook', (req: Request, res: Response) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === verifyToken) {
      logger.info('Webhook verified successfully');
      res.status(200).send(challenge);
    } else {
      logger.warn('Webhook verification failed');
      res.sendStatus(403);
    }
  });

  // Incoming webhook events (POST)
  router.post('/webhook', (req: Request, res: Response) => {
    // Always respond 200 quickly
    res.sendStatus(200);

    const body = req.body;
    if (body.object !== 'whatsapp_business_account') {
      return;
    }

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value) continue;

        // Process incoming messages
        for (const msg of value.messages || []) {
          const contact = (value.contacts || []).find((c: any) => c.wa_id === msg.from);

          let content = '';
          const attachments: Array<{ type: string; url: string; metadata: Record<string, unknown> }> = [];

          switch (msg.type) {
            case 'text':
              content = msg.text?.body || '';
              break;
            case 'image':
              content = msg.image?.caption || '[image]';
              attachments.push({
                type: 'image',
                url: msg.image?.id || '',
                metadata: { mime_type: msg.image?.mime_type, sha256: msg.image?.sha256 },
              });
              break;
            case 'video':
              content = msg.video?.caption || '[video]';
              attachments.push({
                type: 'video',
                url: msg.video?.id || '',
                metadata: { mime_type: msg.video?.mime_type },
              });
              break;
            case 'audio':
              content = '[audio]';
              attachments.push({
                type: 'audio',
                url: msg.audio?.id || '',
                metadata: { mime_type: msg.audio?.mime_type, voice: msg.audio?.voice },
              });
              break;
            case 'document':
              content = msg.document?.caption || `[document: ${msg.document?.filename}]`;
              attachments.push({
                type: 'document',
                url: msg.document?.id || '',
                metadata: { mime_type: msg.document?.mime_type, filename: msg.document?.filename },
              });
              break;
            case 'location':
              content = `[location: ${msg.location?.latitude},${msg.location?.longitude}]`;
              break;
            case 'contacts':
              content = `[contact: ${msg.contacts?.[0]?.name?.formatted_name}]`;
              break;
            case 'interactive':
              content = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '[interactive]';
              break;
            case 'reaction':
              content = msg.reaction?.emoji || '';
              break;
            default:
              content = `[${msg.type}]`;
          }

          const incomingMessage: IncomingMessage = {
            waMessageId: msg.id,
            from: msg.from,
            displayName: contact?.profile?.name,
            timestamp: new Date(parseInt(msg.timestamp) * 1000).toISOString(),
            type: msg.type,
            content,
            attachments: attachments.length > 0 ? attachments : undefined,
            isForwarded: msg.context?.forwarded === true,
            replyToWaId: msg.context?.id,
            context: msg.context ? { from: msg.context.from, id: msg.context.id } : undefined,
          };

          logger.info(
            { from: incomingMessage.from, name: incomingMessage.displayName, type: msg.type, text: content.substring(0, 50) },
            'Message received'
          );
          onMessage(incomingMessage);
        }

        // Process status updates
        for (const status of value.statuses || []) {
          const statusUpdate: StatusUpdate = {
            waMessageId: status.id,
            status: status.status,
            timestamp: new Date(parseInt(status.timestamp) * 1000).toISOString(),
            recipientId: status.recipient_id,
            errors: status.errors,
          };
          onStatus(statusUpdate);
        }
      }
    }
  });

  return router;
}

/**
 * Validate Meta webhook signature
 */
export function validateSignature(rawBody: string, signature: string, appSecret: string): boolean {
  if (!signature) return false;
  const expectedSig = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const providedSig = signature.replace('sha256=', '');
  return expectedSig === providedSig;
}
