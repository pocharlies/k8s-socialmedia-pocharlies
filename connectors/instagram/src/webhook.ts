/**
 * Instagram Webhook Handler — Multi-account
 * Routes incoming events to the correct account based on recipient ID / business account ID.
 */

import { Router, Request, Response } from 'express';
import pino from 'pino';

const logger = pino({
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

export interface WebhookEvent {
  type: 'dm' | 'comment' | 'mention' | 'story_mention' | 'unknown';
  senderId: string;
  senderUsername?: string;
  conversationId?: string;
  messageId?: string;
  text?: string;
  mediaId?: string;
  timestamp: string;
  raw: unknown;
}

type EventCallback = (account: string, event: WebhookEvent) => void;

export function createWebhookRouter(
  verifyToken: string,
  bizIdToAccount: Map<string, string>,
  onEvent: EventCallback
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

  // Resolve which account an entry belongs to
  function resolveAccount(entry: any): string {
    // Try recipient ID from messaging events (legacy Messenger format)
    for (const messaging of entry.messaging || []) {
      const recipientId = messaging.recipient?.id;
      if (recipientId && bizIdToAccount.has(recipientId)) {
        return bizIdToAccount.get(recipientId)!;
      }
    }
    // Try recipient ID from changes events (Instagram Business Login format)
    for (const change of entry.changes || []) {
      const recipientId = change.value?.recipient?.id;
      if (recipientId && bizIdToAccount.has(recipientId)) {
        return bizIdToAccount.get(recipientId)!;
      }
    }
    // Try entry.id (page/account ID)
    if (entry.id && bizIdToAccount.has(entry.id)) {
      return bizIdToAccount.get(entry.id)!;
    }
    // Fallback: first account
    return bizIdToAccount.values().next().value ?? 'unknown';
  }

  // Incoming webhook events (POST)
  router.post('/webhook', (req: Request, res: Response) => {
    const body = req.body;

    // Always respond 200 quickly to Meta
    res.sendStatus(200);

    // TEMP: log everything to diagnose
    logger.info({ object: body.object, body: JSON.stringify(body).substring(0, 1500) }, 'Webhook POST received');

    if (body.object !== 'instagram') {
      logger.warn({ object: body.object }, 'Ignoring non-instagram webhook');
      return;
    }

    for (const entry of body.entry || []) {
      const account = resolveAccount(entry);
      logger.debug({ account, entryId: entry.id }, 'Routed webhook to account');

      // Instagram Messaging (DMs)
      for (const messaging of entry.messaging || []) {
        if (messaging.message) {
          const event: WebhookEvent = {
            type: 'dm',
            senderId: messaging.sender?.id || '',
            conversationId: `${messaging.sender?.id}-${messaging.recipient?.id}`,
            messageId: messaging.message.mid,
            text: messaging.message.text,
            timestamp: new Date(messaging.timestamp * 1000).toISOString(),
            raw: messaging,
          };

          if (messaging.message.attachments) {
            event.text = event.text || `[${messaging.message.attachments[0]?.type || 'attachment'}]`;
          }

          logger.info({ account, senderId: event.senderId, text: event.text?.substring(0, 50) }, 'DM received');
          onEvent(account, event);
        }
      }

      // Instagram Changes (DMs, comments, mentions) — Business Login format
      for (const change of entry.changes || []) {
        // DMs come through `changes` with field=messages in the Business Login API
        if (change.field === 'messages') {
          const value = change.value || {};
          const tsNum = typeof value.timestamp === 'string' ? parseInt(value.timestamp, 10) : value.timestamp;
          const event: WebhookEvent = {
            type: 'dm',
            senderId: value.sender?.id || '',
            conversationId: `${value.sender?.id}-${value.recipient?.id}`,
            messageId: value.message?.mid,
            text: value.message?.text,
            timestamp: new Date((tsNum || Date.now() / 1000) * 1000).toISOString(),
            raw: value,
          };
          if (value.message?.attachments) {
            event.text = event.text || `[${value.message.attachments[0]?.type || 'attachment'}]`;
          }
          logger.info({ account, senderId: event.senderId, text: event.text?.substring(0, 50) }, 'DM received (changes)');
          onEvent(account, event);
          continue;
        }

        if (change.field === 'comments') {
          const event: WebhookEvent = {
            type: 'comment',
            senderId: change.value?.from?.id || '',
            senderUsername: change.value?.from?.username,
            mediaId: change.value?.media?.id,
            messageId: change.value?.id,
            text: change.value?.text,
            timestamp: new Date().toISOString(),
            raw: change.value,
          };
          logger.info({ account, username: event.senderUsername, text: event.text?.substring(0, 50) }, 'Comment received');
          onEvent(account, event);
        }

        if (change.field === 'mentions') {
          const event: WebhookEvent = {
            type: 'mention',
            senderId: change.value?.from?.id || '',
            senderUsername: change.value?.from?.username,
            mediaId: change.value?.media_id,
            text: change.value?.comment_id ? 'comment mention' : 'caption mention',
            timestamp: new Date().toISOString(),
            raw: change.value,
          };
          logger.info({ account, username: event.senderUsername }, 'Mention received');
          onEvent(account, event);
        }

        if (change.field === 'story_insights' || change.field === 'story_mentions') {
          const event: WebhookEvent = {
            type: 'story_mention',
            senderId: change.value?.from?.id || '',
            senderUsername: change.value?.from?.username,
            mediaId: change.value?.media_id,
            text: 'story mention',
            timestamp: new Date().toISOString(),
            raw: change.value,
          };
          logger.info({ account, username: event.senderUsername }, 'Story mention received');
          onEvent(account, event);
        }
      }
    }
  });

  return router;
}
