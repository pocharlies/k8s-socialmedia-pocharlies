/**
 * Instagram Connector — Multi-account Express server with webhook + NATS publisher + API proxy.
 * Part of the mcpservers-lab monorepo.
 *
 * Accounts are configured via env vars:
 *   INSTAGRAM_ACCOUNTS=skirmshop,barbelpapis
 *   INSTAGRAM_SKIRMSHOP_ACCESS_TOKEN=...
 *   INSTAGRAM_SKIRMSHOP_BUSINESS_ACCOUNT_ID=...
 *   INSTAGRAM_BARBELPAPIS_ACCESS_TOKEN=...
 *   INSTAGRAM_BARBELPAPIS_BUSINESS_ACCOUNT_ID=...
 *
 * Backwards-compatible: if INSTAGRAM_ACCOUNTS is not set, falls back to
 * single-account mode using INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_BUSINESS_ACCOUNT_ID.
 */

import express from 'express';
import pino from 'pino';
import { InstagramAPI, InstagramConfig } from './instagram-api';
import { createWebhookRouter } from './webhook';
import { InstagramEventPublisher } from './publisher';

const logger = pino({
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

const PORT = parseInt(process.env.PORT || '3003', 10);
const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222';
const NATS_CA_CERT = process.env.NATS_CA_CERT;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'instagram-verify-token';
const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID || '';
const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET || '';

export interface AccountEntry {
  name: string;
  api: InstagramAPI;
  config: InstagramConfig;
}

function loadAccounts(): Map<string, AccountEntry> {
  const accounts = new Map<string, AccountEntry>();
  const accountList = process.env.INSTAGRAM_ACCOUNTS;

  if (accountList) {
    // Multi-account mode
    for (const raw of accountList.split(',')) {
      const name = raw.trim().toLowerCase();
      const prefix = `INSTAGRAM_${name.toUpperCase()}_`;
      const accessToken = process.env[`${prefix}ACCESS_TOKEN`] || '';
      const businessAccountId = process.env[`${prefix}BUSINESS_ACCOUNT_ID`] || '';

      if (!accessToken) {
        logger.warn({ account: name }, `Skipping account — no ${prefix}ACCESS_TOKEN`);
        continue;
      }

      const config: InstagramConfig = {
        accessToken,
        businessAccountId,
        appId: process.env[`${prefix}APP_ID`] || FACEBOOK_APP_ID,
        appSecret: process.env[`${prefix}APP_SECRET`] || FACEBOOK_APP_SECRET,
        fbAccessToken: process.env[`${prefix}FB_ACCESS_TOKEN`] || undefined,
      };
      accounts.set(name, { name, api: new InstagramAPI(config), config });
      logger.info({ account: name, businessAccountId, hasFbToken: !!config.fbAccessToken }, 'Loaded account');
    }
  } else {
    // Legacy single-account mode
    const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN || '';
    const businessAccountId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || '';
    if (!accessToken) {
      logger.error('No accounts configured. Set INSTAGRAM_ACCOUNTS or INSTAGRAM_ACCESS_TOKEN.');
      process.exit(1);
    }
    const config: InstagramConfig = {
      accessToken,
      businessAccountId,
      appId: FACEBOOK_APP_ID,
      appSecret: FACEBOOK_APP_SECRET,
      fbAccessToken: process.env.INSTAGRAM_FB_ACCESS_TOKEN || undefined,
    };
    accounts.set('default', { name: 'default', api: new InstagramAPI(config), config });
    logger.info({ businessAccountId, hasFbToken: !!config.fbAccessToken }, 'Loaded single account (legacy mode)');
  }

  if (accounts.size === 0) {
    logger.error('No valid accounts configured');
    process.exit(1);
  }

  return accounts;
}

async function main(): Promise<void> {
  const accounts = loadAccounts();

  // Build a reverse lookup: accountId → account name (for webhook routing)
  // We register BOTH id formats because Meta uses different IDs depending on API version:
  //   - businessAccountId (from .env, e.g. 25864160563286488) — legacy/Facebook Graph
  //   - IG User ID (e.g. 17841444094675941) — Instagram Business Login webhooks
  const bizIdToAccount = new Map<string, string>();
  for (const [name, entry] of accounts) {
    if (entry.config.businessAccountId) {
      bizIdToAccount.set(entry.config.businessAccountId, name);
    }
    // Fetch the Instagram User ID (user_id) from /me and register it too
    try {
      const meUrl = `https://graph.instagram.com/v21.0/me?fields=id,user_id&access_token=${entry.config.accessToken}`;
      const res = await fetch(meUrl);
      if (res.ok) {
        const data = (await res.json()) as { id?: string; user_id?: string };
        if (data.id) bizIdToAccount.set(data.id, name);
        if (data.user_id) bizIdToAccount.set(data.user_id, name);
        // Propagate the IG User ID into the API client — graph.facebook.com
        // endpoints (hashtag/business_discovery) require it instead of the
        // legacy `businessAccountId`.
        if (data.user_id) entry.api.setInstagramUserId(data.user_id);
        logger.info({ account: name, id: data.id, user_id: data.user_id }, 'Registered Instagram IDs for routing');
      } else {
        logger.warn({ account: name, status: res.status }, 'Failed to fetch IG IDs from /me');
      }
    } catch (err) {
      logger.warn({ account: name, err: String(err) }, 'Error fetching IG IDs');
    }
  }

  const publisher = new InstagramEventPublisher(NATS_URL, NATS_CA_CERT !== 'none' ? NATS_CA_CERT : undefined);
  await publisher.connect();

  const app = express();
  app.use(express.json());

  // Webhook routes — shared endpoint, routes by business account ID in payload
  app.use('/', createWebhookRouter(WEBHOOK_VERIFY_TOKEN, bizIdToAccount, (account, event) => {
    publisher.publish(account, event);
  }));

  // Health check — all accounts
  app.get('/health', async (_req, res) => {
    const results: Record<string, unknown> = {};
    for (const [name, entry] of accounts) {
      try {
        const profile = await entry.api.getProfile();
        results[name] = {
          status: 'ok',
          username: profile.username,
          followers: profile.followers_count,
        };
      } catch (error) {
        results[name] = { status: 'degraded', error: String(error) };
      }
    }
    res.json({ status: 'ok', platform: 'instagram', accounts: results });
  });

  // List available accounts
  app.get('/api/v1/accounts', (_req, res) => {
    const list = [...accounts.entries()].map(([name, entry]) => ({
      name,
      businessAccountId: entry.config.businessAccountId,
    }));
    res.json({ accounts: list });
  });

  // Helper to resolve account from route param
  function getAccount(name: string): AccountEntry | undefined {
    return accounts.get(name.toLowerCase()) || (accounts.size === 1 ? accounts.values().next().value : undefined);
  }

  // === Per-account API routes ===

  app.get('/api/v1/:account/profile', async (req, res) => {
    const entry = getAccount(req.params.account);
    if (!entry) return res.status(404).json({ error: `Account '${req.params.account}' not found` });
    try {
      res.json(await entry.api.getProfile());
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.get('/api/v1/:account/media', async (req, res) => {
    const entry = getAccount(req.params.account);
    if (!entry) return res.status(404).json({ error: `Account '${req.params.account}' not found` });
    try {
      const limit = parseInt(req.query.limit as string) || 25;
      res.json(await entry.api.getRecentMedia(limit));
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.get('/api/v1/:account/media/:mediaId/comments', async (req, res) => {
    const entry = getAccount(req.params.account);
    if (!entry) return res.status(404).json({ error: `Account '${req.params.account}' not found` });
    try {
      res.json(await entry.api.getMediaComments(req.params.mediaId));
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.post('/api/v1/:account/comments/:commentId/reply', async (req, res) => {
    const entry = getAccount(req.params.account);
    if (!entry) return res.status(404).json({ error: `Account '${req.params.account}' not found` });
    try {
      const { message } = req.body;
      res.json(await entry.api.replyToComment(req.params.commentId, message));
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.get('/api/v1/:account/conversations', async (req, res) => {
    const entry = getAccount(req.params.account);
    if (!entry) return res.status(404).json({ error: `Account '${req.params.account}' not found` });
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      res.json(await entry.api.getConversations(limit));
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.post('/api/v1/:account/messages/send', async (req, res) => {
    const entry = getAccount(req.params.account);
    if (!entry) return res.status(404).json({ error: `Account '${req.params.account}' not found` });
    try {
      const { recipient_id, message } = req.body;
      res.json(await entry.api.sendMessage(recipient_id, message));
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.get('/api/v1/:account/media/:mediaId/insights', async (req, res) => {
    const entry = getAccount(req.params.account);
    if (!entry) return res.status(404).json({ error: `Account '${req.params.account}' not found` });
    try {
      res.json(await entry.api.getMediaInsights(req.params.mediaId));
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.post('/api/v1/:account/publish', async (req, res) => {
    const entry = getAccount(req.params.account);
    if (!entry) return res.status(404).json({ error: `Account '${req.params.account}' not found` });
    try {
      const { image_url, caption, media_type } = req.body;
      const container = await entry.api.createMediaContainer(image_url, caption, media_type || 'IMAGE');
      const published = await entry.api.publishMedia(container.id);
      res.json({ container_id: container.id, media_id: published.id });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.get('/api/v1/:account/stories', async (req, res) => {
    const entry = getAccount(req.params.account);
    if (!entry) return res.status(404).json({ error: `Account '${req.params.account}' not found` });
    try {
      res.json(await entry.api.getStories());
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Publishing: carousel / reel / story
  app.post('/api/v1/:account/publish/carousel', async (req, res) => {
    const entry = getAccount(req.params.account);
    if (!entry) return res.status(404).json({ error: `Account '${req.params.account}' not found` });
    try {
      const { items, caption } = req.body as { items: string[]; caption?: string };
      if (!Array.isArray(items)) return res.status(400).json({ error: '`items` must be an array of URLs' });
      res.json(await entry.api.publishCarousel(items, caption));
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.post('/api/v1/:account/publish/reel', async (req, res) => {
    const entry = getAccount(req.params.account);
    if (!entry) return res.status(404).json({ error: `Account '${req.params.account}' not found` });
    try {
      const { video_url, caption, share_to_feed } = req.body as { video_url: string; caption?: string; share_to_feed?: boolean };
      if (!video_url) return res.status(400).json({ error: '`video_url` is required' });
      res.json(await entry.api.publishReel(video_url, caption, share_to_feed ?? true));
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.post('/api/v1/:account/publish/story', async (req, res) => {
    const entry = getAccount(req.params.account);
    if (!entry) return res.status(404).json({ error: `Account '${req.params.account}' not found` });
    try {
      const { image_url, video_url } = req.body as { image_url?: string; video_url?: string };
      if (!image_url && !video_url) return res.status(400).json({ error: 'Either `image_url` or `video_url` is required' });
      res.json(await entry.api.publishStory({ imageUrl: image_url, videoUrl: video_url }));
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Comments: post / hide / delete
  app.post('/api/v1/:account/media/:mediaId/comments', async (req, res) => {
    const entry = getAccount(req.params.account);
    if (!entry) return res.status(404).json({ error: `Account '${req.params.account}' not found` });
    try {
      const { message } = req.body as { message: string };
      if (!message) return res.status(400).json({ error: '`message` is required' });
      res.json(await entry.api.postComment(req.params.mediaId, message));
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.post('/api/v1/:account/comments/:commentId/hide', async (req, res) => {
    const entry = getAccount(req.params.account);
    if (!entry) return res.status(404).json({ error: `Account '${req.params.account}' not found` });
    try {
      const { hide } = req.body as { hide?: boolean };
      res.json(await entry.api.hideComment(req.params.commentId, hide ?? true));
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.delete('/api/v1/:account/comments/:commentId', async (req, res) => {
    const entry = getAccount(req.params.account);
    if (!entry) return res.status(404).json({ error: `Account '${req.params.account}' not found` });
    try {
      res.json(await entry.api.deleteComment(req.params.commentId));
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Account: insights / pages / publishing limit / token validation
  app.get('/api/v1/:account/insights', async (req, res) => {
    const entry = getAccount(req.params.account);
    if (!entry) return res.status(404).json({ error: `Account '${req.params.account}' not found` });
    try {
      const metrics = req.query.metrics ? String(req.query.metrics).split(',') : undefined;
      const period = (req.query.period as 'day' | 'week' | 'days_28') || 'day';
      res.json(await entry.api.getAccountInsights(metrics, period));
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.get('/api/v1/:account/pages', async (req, res) => {
    const entry = getAccount(req.params.account);
    if (!entry) return res.status(404).json({ error: `Account '${req.params.account}' not found` });
    try {
      res.json(await entry.api.getAccountPages());
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.get('/api/v1/:account/publishing-limit', async (req, res) => {
    const entry = getAccount(req.params.account);
    if (!entry) return res.status(404).json({ error: `Account '${req.params.account}' not found` });
    try {
      res.json(await entry.api.getContentPublishingLimit());
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.get('/api/v1/:account/token/validate', async (req, res) => {
    const entry = getAccount(req.params.account);
    if (!entry) return res.status(404).json({ error: `Account '${req.params.account}' not found` });
    try {
      res.json({ valid: await entry.api.validateAccessToken() });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Hashtags: search + media
  app.get('/api/v1/:account/hashtag/search', async (req, res) => {
    const entry = getAccount(req.params.account);
    if (!entry) return res.status(404).json({ error: `Account '${req.params.account}' not found` });
    try {
      const q = req.query.q as string;
      if (!q) return res.status(400).json({ error: '`q` query param is required' });
      res.json(await entry.api.searchHashtag(q));
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.get('/api/v1/:account/hashtag/:hashtagId/media', async (req, res) => {
    const entry = getAccount(req.params.account);
    if (!entry) return res.status(404).json({ error: `Account '${req.params.account}' not found` });
    try {
      const mediaType = (req.query.media_type as 'top' | 'recent') || 'top';
      const limit = parseInt(req.query.limit as string) || 25;
      res.json(await entry.api.getHashtagMedia(req.params.hashtagId, mediaType, limit));
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Mentions
  app.get('/api/v1/:account/mentions', async (req, res) => {
    const entry = getAccount(req.params.account);
    if (!entry) return res.status(404).json({ error: `Account '${req.params.account}' not found` });
    try {
      const limit = parseInt(req.query.limit as string) || 25;
      res.json(await entry.api.getMentions(limit));
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Business Discovery
  app.get('/api/v1/:account/business-discovery', async (req, res) => {
    const entry = getAccount(req.params.account);
    if (!entry) return res.status(404).json({ error: `Account '${req.params.account}' not found` });
    try {
      const username = req.query.username as string;
      if (!username) return res.status(400).json({ error: '`username` query param is required' });
      res.json(await entry.api.businessDiscovery(username));
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Conversation messages
  app.get('/api/v1/:account/conversations/:conversationId/messages', async (req, res) => {
    const entry = getAccount(req.params.account);
    if (!entry) return res.status(404).json({ error: `Account '${req.params.account}' not found` });
    try {
      const limit = parseInt(req.query.limit as string) || 25;
      res.json(await entry.api.getConversationMessages(req.params.conversationId, limit));
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.listen(PORT, () => {
    logger.info(`Instagram Connector listening on port ${PORT} — ${accounts.size} account(s)`);
    logger.info(`Accounts: ${[...accounts.keys()].join(', ')}`);
    logger.info(`Webhook: http://localhost:${PORT}/webhook`);
    logger.info(`Health: http://localhost:${PORT}/health`);
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
