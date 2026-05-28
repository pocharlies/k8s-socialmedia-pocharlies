import { Router, Request, Response, NextFunction } from 'express';
import { TelegramClientWrapper } from '../telegram-client';
import { generateHMACSignature } from '@mcp-socialmedia/shared';
import pino from 'pino';

const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: { colorize: true },
  },
});

/**
 * Authentication middleware
 */
function authMiddleware(
  sharedSecret: string
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const signature = req.headers['x-connector-signature'] as string;
    const timestamp = req.headers['x-connector-timestamp'] as string;

    if (!signature || !timestamp) {
      res.status(401).json({ error: 'Missing authentication headers' });
      return;
    }

    const requestTime = parseInt(timestamp, 10);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(requestTime) || Math.abs(now - requestTime) > 300) {
      res.status(401).json({ error: 'Request expired' });
      return;
    }

    const expectedSignature = generateHMACSignature(req.body || {}, requestTime, sharedSecret);
    if (signature !== expectedSignature) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    next();
  };
}

export function createRouter(client: TelegramClientWrapper, sharedSecret: string): Router {
  const router = Router();

  // Apply auth middleware to all routes
  router.use(authMiddleware(sharedSecret));

  /**
   * GET /status - Get connection status
   */
  router.get('/status', (req: Request, res: Response) => {
    res.json({
      connected: client.isClientConnected(),
      platform: 'telegram',
    });
  });

  /**
   * GET /me - Get account info
   */
  router.get('/me', (req: Request, res: Response): void => {
    void (async () => {
      try {
        const me = await client.getMe();
        res.json(me);
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * GET /dialogs - Get all dialogs (chats)
   */
  router.get('/dialogs', (req: Request, res: Response): void => {
    void (async (): Promise<void> => {
      try {
        if (!client.isClientConnected()) {
          res.status(503).json({ error: 'Not connected to Telegram' });
          return;
        }

        const dialogs = await client.getDialogs();
        res.json({ dialogs });
      } catch (error) {
        logger.error(`Error getting dialogs: ${String(error)}`);
        res.status(500).json({ error: 'Failed to get dialogs' });
      }
    })();
  });

  /**
   * GET /chats/unread - Get chats with unread messages
   * NOTE: Must be registered BEFORE /chats/:id routes
   */
  router.get('/chats/unread', (req: Request, res: Response): void => {
    void (async () => {
      try {
        const chats = await client.getUnreadChats();
        res.json({ chats });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * GET /chats/:id/info - Get chat info
   */
  router.get('/chats/:id/info', (req: Request, res: Response): void => {
    void (async () => {
      try {
        const info = await client.getChatInfo(req.params.id);
        res.json(info);
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * GET /chats/:id/participants - Get chat participants
   */
  router.get('/chats/:id/participants', (req: Request, res: Response): void => {
    void (async () => {
      try {
        const limit = parseInt(req.query.limit as string) || 100;
        const participants = await client.getParticipants(req.params.id, limit);
        res.json({ participants });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * GET /messages/:chatId - Get messages for a chat
   */
  router.get('/messages/:chatId', (req: Request, res: Response): void => {
    void (async (): Promise<void> => {
      try {
        if (!client.isClientConnected()) {
          res.status(503).json({ error: 'Not connected to Telegram' });
          return;
        }

        const { chatId } = req.params;
        const limit = parseInt(req.query.limit as string) || 100;
        const offsetId = req.query.offsetId ? parseInt(req.query.offsetId as string) : undefined;

        const messages = await client.getMessages(chatId, limit, offsetId);
        res.json({ messages });
      } catch (error) {
        logger.error(`Error getting messages: ${String(error)}`);
        res.status(500).json({ error: 'Failed to get messages' });
      }
    })();
  });

  /**
   * POST /messages/search - Search messages
   * NOTE: Must be registered BEFORE /messages/:chatId POST route
   */
  router.post('/messages/search', (req: Request, res: Response): void => {
    void (async () => {
      try {
        const { query, chatId, limit } = req.body;
        if (!query) {
          res.status(400).json({ error: 'Missing query' });
          return;
        }
        const results = await client.searchMessages(query, chatId, limit || 20);
        res.json({ results });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * POST /messages/forward - Forward a message
   */
  router.post('/messages/forward', (req: Request, res: Response): void => {
    void (async () => {
      try {
        const { fromChatId, messageId, toChatId } = req.body;
        if (!fromChatId || !messageId || !toChatId) {
          res.status(400).json({ error: 'Missing fields' });
          return;
        }
        await client.forwardMessage(fromChatId, parseInt(messageId), toChatId);
        res.json({ forwarded: true });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * POST /messages/media/send - Send a file
   */
  router.post('/messages/media/send', (req: Request, res: Response): void => {
    void (async () => {
      try {
        const { chatId, filePath, caption, voiceNote, videoNote, sticker } = req.body;
        if (!chatId || !filePath) {
          res.status(400).json({ error: 'Missing chatId or filePath' });
          return;
        }
        await client.sendFile(chatId, filePath, { caption, voiceNote, videoNote, sticker });
        res.json({ sent: true });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * POST /messages/read/:chatId - Mark chat as read
   */
  router.post('/messages/read/:chatId', (req: Request, res: Response): void => {
    void (async () => {
      try {
        await client.markAsRead(req.params.chatId);
        res.json({ markedAsRead: true });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * GET /messages/media/:chatId/:msgId - Download media
   */
  router.get('/messages/media/:chatId/:msgId', (req: Request, res: Response): void => {
    void (async () => {
      try {
        const buffer = await client.downloadMedia(req.params.chatId, parseInt(req.params.msgId));
        if (!buffer) {
          res.status(404).json({ error: 'No media' });
          return;
        }
        res.json({ data: buffer.toString('base64'), size: buffer.length });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * GET /peers/:id/photo - Download a peer's profile photo (big size).
   * Returns {data: base64, size, contentType: 'image/jpeg'} or 404 if no photo.
   */
  router.get('/peers/:id/photo', (req: Request, res: Response): void => {
    void (async () => {
      try {
        if (!client.isClientConnected()) {
          res.status(503).json({ error: 'Not connected to Telegram' });
          return;
        }
        const buffer = await client.downloadPeerPhoto(req.params.id);
        if (!buffer) {
          res.status(404).json({ error: 'No photo' });
          return;
        }
        res.json({
          data: buffer.toString('base64'),
          size: buffer.length,
          contentType: 'image/jpeg',
        });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * POST /messages/:chatId - Send a message
   */
  router.post('/messages/:chatId', (req: Request, res: Response): void => {
    void (async (): Promise<void> => {
      try {
        if (!client.isClientConnected()) {
          res.status(503).json({ error: 'Not connected to Telegram' });
          return;
        }

        const { chatId } = req.params;
        const body = req.body as {
          text?: string;
          topicId?: number | string;
          replyTo?: number | string;
        };
        const text = body.text;

        if (!text) {
          res.status(400).json({ error: 'Missing text in request body' });
          return;
        }

        let tid: number | undefined;
        if (body.topicId !== undefined && body.topicId !== null) {
          tid = Number(body.topicId);
          if (!Number.isInteger(tid) || tid <= 0) {
            res.status(400).json({ error: 'topicId must be a positive integer' });
            return;
          }
        }

        let replyTo: number | undefined;
        if (body.replyTo !== undefined && body.replyTo !== null) {
          const n = Number(body.replyTo);
          if (Number.isInteger(n) && n > 0) replyTo = n;
        }

        const messageId = await client.sendMessage(chatId, text, tid, replyTo);
        res.json({ success: true, messageId });
      } catch (error) {
        logger.error(`Error sending message: ${String(error)}`);
        res.status(500).json({ error: 'Failed to send message' });
      }
    })();
  });

  /**
   * DELETE /messages/:chatId/:msgId - Delete a message
   */
  router.delete('/messages/:chatId/:msgId', (req: Request, res: Response): void => {
    void (async () => {
      try {
        await client.deleteMessage(req.params.chatId, parseInt(req.params.msgId));
        res.json({ deleted: true });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * GET /session - Get session string
   */
  router.get('/session', (req: Request, res: Response) => {
    try {
      const sessionString = client.getSessionString();
      res.json({ sessionString });
    } catch (error) {
      logger.error(`Error getting session: ${String(error)}`);
      res.status(500).json({ error: 'Failed to get session' });
    }
  });

  return router;
}
