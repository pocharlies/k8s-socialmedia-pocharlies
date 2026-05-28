import express, { Request, Response } from 'express';
import {
  BaileysClient,
  classifyWhatsAppSendFailure,
  WhatsAppSendFailureClass,
} from '../baileys-client';
import { QRHandler } from '../qr-handler';
import { createHMACAuth, AuthenticatedRequest } from './auth';

function statusForSendFailure(
  failureClass: WhatsAppSendFailureClass | 'disabled_sending' | 'invalid_request'
): number {
  if (failureClass === 'invalid_request') return 400;
  if (failureClass === 'disabled_sending') return 403;
  if (failureClass === 'disconnected') return 503;
  if (failureClass === 'timeout') return 504;
  if (failureClass === 'missing_session' || failureClass === 'group_metadata') return 424;
  if (failureClass === 'auth') return 401;
  return 500;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}

export function createRouter(
  client: BaileysClient,
  qrHandler: QRHandler,
  sharedSecret: string
): express.Router {
  const router = express.Router();
  const auth = createHMACAuth(sharedSecret);

  // Health check (no auth required)
  router.get('/health', (_req: Request, res: Response) => {
    const qr = qrHandler.getCurrentQR();
    const connected = client.isConnected();
    res.json({
      status: connected ? 'ok' : 'degraded',
      ...client.getStatus(),
      connected,
      qrAvailable: qr !== null,
    });
  });

  // Get QR code (no auth required for local dev)
  router.get('/auth/qr', (req: Request, res: Response) => {
    const qr = qrHandler.getCurrentQR();
    if (!qr) {
      res.status(404).json({ error: 'No QR code available' });
      return;
    }
    res.json({
      qrCode: qr.qrCode,
      expiresAt: qr.expiresAt.toISOString(),
    });
  });

  // Logout and clear session (requires auth)
  router.post('/auth/logout', auth, (req: AuthenticatedRequest, res: Response): void => {
    try {
      client.disconnect();
      qrHandler.clearQR();

      res.json({
        message: 'WhatsApp disconnected successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({ error: `Failed to logout: ${String(error)}` });
    }
  });

  // Send message (requires auth)
  router.post('/messages/send', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async (): Promise<void> => {
      try {
        const body = req.body as {
          sendToken?: string;
          conversationId?: string;
          content?: string;
          replyToMessageId?: string;
        };
        const { sendToken, conversationId, content, replyToMessageId } = body;

        if (!sendToken || !conversationId || !content) {
          console.warn(
            `WhatsApp send rejected failureClass=invalid_request conversationId=${conversationId || ''}`
          );
          res.status(statusForSendFailure('invalid_request')).json({
            error: 'Missing required fields',
            failureClass: 'invalid_request',
          });
          return;
        }

        // In production, validate sendToken here
        // For now, we'll just check if sending is enabled
        if (process.env.ENABLE_SENDING !== 'true') {
          console.warn(
            `WhatsApp send blocked failureClass=disabled_sending conversationId=${conversationId}`
          );
          res.status(statusForSendFailure('disabled_sending')).json({
            error: 'Sending is disabled',
            failureClass: 'disabled_sending',
          });
          return;
        }

        if (process.env.EMERGENCY_DISABLE_SENDING === 'true') {
          console.warn(
            `WhatsApp send blocked failureClass=disabled_sending reason=emergency_disable conversationId=${conversationId}`
          );
          res.status(statusForSendFailure('disabled_sending')).json({
            error: 'Sending is emergency disabled',
            failureClass: 'disabled_sending',
          });
          return;
        }

        if (!client.isConnected()) {
          console.warn(
            `WhatsApp send blocked failureClass=disconnected conversationId=${conversationId} state=${client.getCachedState() || 'unknown'}`
          );
          res.status(statusForSendFailure('disconnected')).json({
            error: `WhatsApp is not connected (state=${client.getCachedState() || 'unknown'})`,
            failureClass: 'disconnected',
            actionable: 'Reconnect WhatsApp or renew the QR code before sending.',
          });
          return;
        }

        const messageId = await client.sendMessage(conversationId, content, { replyToMessageId });
        console.info(
          `WhatsApp send ok conversationId=${conversationId} messageId=${messageId || ''}`
        );

        res.json({
          messageId,
          sentAt: new Date().toISOString(),
        });
      } catch (error) {
        const failureClass = classifyWhatsAppSendFailure(error);
        const details = (error as any)?.details || {};
        console.error(
          `WhatsApp send failed failureClass=${failureClass} conversationId=${details.normalizedJid || ''} rawJid=${details.rawJid || ''}${details.groupSubject ? ` groupSubject="${details.groupSubject}"` : ''}: ${errorMessage(error)}`
        );
        res.status(statusForSendFailure(failureClass)).json({
          error: `Failed to send message: ${errorMessage(error)}`,
          failureClass,
          actionable: details.actionable,
          details,
        });
      }
    })();
  });

  // Send a voice note (requires auth) — {conversationId, audioBase64, mimeType}
  router.post('/messages/audio', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async (): Promise<void> => {
      try {
        const body = req.body as {
          conversationId?: string;
          audioBase64?: string;
          mimeType?: string;
        };
        const { conversationId, audioBase64, mimeType } = body;

        if (!conversationId || !audioBase64) {
          res.status(400).json({ error: 'Missing conversationId or audioBase64' });
          return;
        }
        if (
          process.env.ENABLE_SENDING !== 'true' ||
          process.env.EMERGENCY_DISABLE_SENDING === 'true'
        ) {
          res.status(statusForSendFailure('disabled_sending')).json({
            error: 'Sending is disabled',
            failureClass: 'disabled_sending',
          });
          return;
        }
        if (!client.isConnected()) {
          res.status(statusForSendFailure('disconnected')).json({
            error: `WhatsApp is not connected (state=${client.getCachedState() || 'unknown'})`,
            failureClass: 'disconnected',
          });
          return;
        }

        const buf = Buffer.from(audioBase64, 'base64');
        const messageId = await client.sendVoice(
          conversationId,
          buf,
          mimeType || 'audio/ogg; codecs=opus'
        );
        console.info(
          `WhatsApp voice sent conversationId=${conversationId} messageId=${messageId || ''}`
        );
        res.json({ messageId, sentAt: new Date().toISOString() });
      } catch (error) {
        const failureClass = classifyWhatsAppSendFailure(error);
        res.status(statusForSendFailure(failureClass)).json({
          error: `Failed to send voice: ${errorMessage(error)}`,
          failureClass,
        });
      }
    })();
  });

  // React to a message (requires auth)
  router.post('/messages/react', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async (): Promise<void> => {
      try {
        const body = req.body as { conversationId?: string; messageId?: string; emoji?: string };
        const { conversationId, messageId, emoji } = body;

        if (!conversationId || !messageId || !emoji) {
          res.status(400).json({ error: 'Missing conversationId, messageId, or emoji' });
          return;
        }

        if (process.env.ENABLE_SENDING !== 'true') {
          res.status(403).json({ error: 'Sending is disabled' });
          return;
        }

        await client.reactToMessage(conversationId, messageId, emoji);

        res.json({
          reacted: true,
          emoji,
          messageId,
          reactedAt: new Date().toISOString(),
        });
      } catch (error) {
        res.status(500).json({ error: 'Failed to react: ' + String(error) });
      }
    })();
  });

  // History sync endpoint
  router.post('/history/sync', (req: Request, res: Response): void => {
    const limit = parseInt((req.query as any).limit || '500', 10);

    if (!client.isConnected()) {
      res.status(503).json({ error: 'WhatsApp not connected' });
      return;
    }

    res.json({ status: 'started', limit, message: 'Fetching chat history...' });

    void (async () => {
      try {
        const results = await (client as any).getAllChatsWithHistory(limit);
        console.log('History sync complete: ' + results.length + ' chats');
      } catch (e) {
        console.error('History sync error: ' + String(e));
      }
    })();
  });

  router.get('/history/status', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const limit = parseInt((req.query as any).limit || '200', 10);
        const status = await client.getHistorySyncStatus(limit);
        res.json({ status });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  // Get chat history
  router.get('/history/:chatId', (req: Request, res: Response): void => {
    const chatId = req.params.chatId;
    const limit = parseInt((req.query as any).limit || '100', 10);

    void (async () => {
      try {
        const messages = await (client as any).fetchChatHistory(chatId, limit);
        res.json({ chatId, count: messages.length, messages });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  // Request older Baileys history for chats where we have persisted message keys.
  router.post('/history/backfill', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const body = req.body as {
          chatId?: string;
          maxChats?: number;
          maxBatchesPerChat?: number;
          batchSize?: number;
          dryRun?: boolean;
        };
        const result = await client.backfillHistory(body || {});
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  // Get authenticated account info
  router.get('/me', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const me = await client.getMe();
        res.json(me);
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  // Get unread chats
  router.get('/chats/unread', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const chats = await client.getUnreadChats();
        res.json({ chats });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  // Force app-state resync → persists current unread/archived to the DB.
  router.post('/chats/resync-state', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const result = await client.resyncChatState('api');
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  // Get group info
  router.get('/groups/:id/info', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const info = await client.getGroupInfo(req.params.id);
        res.json(info);
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  // Get group participants
  router.get('/groups/:id/participants', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const participants = await client.getGroupParticipants(req.params.id);
        res.json({ participants });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  // Download a chat/contact's profile picture as base64 (mirrors telegram-connector shape).
  router.get('/chats/:jid/photo', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const bytes = await client.getProfilePictureBytes(req.params.jid);
        if (!bytes) {
          res.status(404).json({ error: 'No photo' });
          return;
        }
        res.json({
          data: bytes.toString('base64'),
          size: bytes.length,
          contentType: 'image/jpeg',
        });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  // Refresh group metadata and Signal sender-key/session state before a group send.
  router.post(
    '/groups/:id/session/repair',
    auth,
    (req: AuthenticatedRequest, res: Response): void => {
      void (async () => {
        try {
          const result = await client.refreshGroupSession(req.params.id, {
            reason: 'manual-api',
            warmSessions: true,
            forceSessions: true,
            clearSenderKeyMemory: true,
            failOnWarmupError: false,
            markFailedDevicesAsSenderKeySent: true,
          });
          res.json(result);
        } catch (e) {
          const failureClass = classifyWhatsAppSendFailure(e);
          res.status(statusForSendFailure(failureClass)).json({
            error: String(e),
            failureClass,
          });
        }
      })();
    }
  );

  // Download media from a message
  router.get(
    '/messages/media/:chatId/:msgId',
    auth,
    (req: AuthenticatedRequest, res: Response): void => {
      void (async () => {
        try {
          const media = await client.downloadMedia(req.params.chatId, req.params.msgId);
          if (!media) {
            res.status(404).json({ error: 'No media found' });
            return;
          }
          res.json(media);
        } catch (e) {
          res.status(500).json({ error: String(e) });
        }
      })();
    }
  );

  // Send file/media
  router.post('/messages/media/send', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        if (process.env.ENABLE_SENDING !== 'true') {
          res.status(403).json({ error: 'Sending disabled' });
          return;
        }
        const { conversationId, fileUrl, caption, asSticker, kind } = req.body;
        if (!conversationId || !fileUrl) {
          res.status(400).json({ error: 'Missing conversationId or fileUrl' });
          return;
        }
        await client.sendFile(conversationId, fileUrl, caption, {
          asSticker: !!asSticker || kind === 'sticker',
        });
        res.json({ sent: true, sentAt: new Date().toISOString() });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  // Forward message
  router.post('/messages/forward', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        if (process.env.ENABLE_SENDING !== 'true') {
          res.status(403).json({ error: 'Sending disabled' });
          return;
        }
        const { chatId, messageId, toChatId } = req.body;
        if (!chatId || !messageId || !toChatId) {
          res.status(400).json({ error: 'Missing chatId, messageId, or toChatId' });
          return;
        }
        await client.forwardMessage(chatId, messageId, toChatId);
        res.json({ forwarded: true });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  // Delete message
  router.delete(
    '/messages/:chatId/:msgId',
    auth,
    (req: AuthenticatedRequest, res: Response): void => {
      void (async () => {
        try {
          await client.deleteMessage(req.params.chatId, req.params.msgId);
          res.json({ deleted: true });
        } catch (e) {
          res.status(500).json({ error: String(e) });
        }
      })();
    }
  );

  // Mark chat as read
  router.post('/messages/read/:chatId', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        await client.markAsRead(req.params.chatId);
        res.json({ markedAsRead: true });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });
  return router;
}
