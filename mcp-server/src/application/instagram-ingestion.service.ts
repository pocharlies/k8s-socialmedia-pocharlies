/**
 * Instagram event ingestion — writes webhook events from the instagram-connector
 * directly to the unified messages table with platform='instagram'.
 *
 * This service intentionally does NOT go through the WhatsApp-centric
 * MessageIngestionService — IG payload shape is too different (DMs / comments /
 * mentions / story_mentions vs the WA wa_message_id / @g.us model). When the
 * 5-MCP split happens, this code moves to mcps/instagram/ and shares a
 * `@mcp-socialmedia/core` repository with the others.
 */
import { Pool } from 'pg';
import pino from 'pino';

export interface InstagramEvent {
  platform: 'instagram';
  account: string; // 'skirmshop' | 'barbelpapis'
  eventType: 'dm' | 'comment' | 'mention' | 'story_mention' | 'unknown';
  senderId: string;
  senderUsername?: string;
  conversationId?: string;
  messageId?: string;
  text?: string;
  mediaId?: string;
  timestamp: string;
}

export class InstagramIngestionService {
  private dbClient: Pool;
  private logger: pino.Logger;

  constructor(dbClient: Pool) {
    this.dbClient = dbClient;
    this.logger = pino({
      transport: { target: 'pino-pretty', options: { colorize: true } },
    });
  }

  async handleEvent(event: InstagramEvent): Promise<void> {
    try {
      const account = routeInstagramAccount(event.account);
      // DM events have a real message id and conversation; comments/mentions are
      // attached to a media post and we synthesise a conversation key per post.
      const ts = new Date(event.timestamp || new Date().toISOString());

      let convId: string;
      let convName: string | null;
      let convType: 'INDIVIDUAL' | 'GROUP';
      let messageType: string;
      let waMessageId: string;
      let content = event.text || '';

      if (event.eventType === 'dm') {
        convId = `ig_${event.account}_thread_${event.conversationId || event.senderId}`;
        convName = event.senderUsername || event.senderId;
        convType = 'INDIVIDUAL';
        messageType = 'TEXT';
        waMessageId = event.messageId
          ? `ig_${event.account}_${event.messageId}`
          : `ig_${event.account}_${event.senderId}_${ts.getTime()}`;
      } else if (event.eventType === 'comment') {
        convId = `ig_${event.account}_post_${event.mediaId || 'unknown'}`;
        convName = `Post ${event.mediaId || ''}`.trim();
        convType = 'GROUP'; // comments stream — multiple users contribute
        messageType = 'COMMENT';
        waMessageId = event.messageId
          ? `ig_${event.account}_comment_${event.messageId}`
          : `ig_${event.account}_comment_${event.senderId}_${ts.getTime()}`;
      } else if (event.eventType === 'mention') {
        convId = `ig_${event.account}_mentions`;
        convName = 'Mentions';
        convType = 'GROUP';
        messageType = 'MENTION';
        waMessageId = `ig_${event.account}_mention_${event.mediaId || event.senderId}_${ts.getTime()}`;
        content = content || `mention by @${event.senderUsername || event.senderId}`;
      } else if (event.eventType === 'story_mention') {
        convId = `ig_${event.account}_story_mentions`;
        convName = 'Story mentions';
        convType = 'GROUP';
        messageType = 'STORY_MENTION';
        waMessageId = `ig_${event.account}_story_${event.mediaId || event.senderId}_${ts.getTime()}`;
        content = content || `story mention by @${event.senderUsername || event.senderId}`;
      } else {
        this.logger.debug(`Skipping unknown IG event type: ${event.eventType}`);
        return;
      }

      const senderWaId = `ig_${event.senderId}`;
      const isGroup = convType === 'GROUP';
      const senderName = event.senderUsername || null;

      const metadata = {
        instagram_account: event.account,
        instagram_event_type: event.eventType,
        instagram_media_id: event.mediaId || null,
        instagram_sender_id: event.senderId,
        instagram_sender_username: event.senderUsername || null,
      };

      await this.dbClient.query(
        `INSERT INTO conversations (id, name, is_group, type, wa_chat_id, last_message_at, account)
         VALUES ($1, $2, $3, $4, $1, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
           name = COALESCE(EXCLUDED.name, conversations.name),
           account = EXCLUDED.account,
           last_message_at = GREATEST(conversations.last_message_at, EXCLUDED.last_message_at),
           updated_at = now()`,
        [convId, convName, isGroup, convType, ts, account]
      );

      await this.dbClient.query(
        `INSERT INTO participants (id, name, push_name, last_seen, account)
         VALUES ($1, $2, $2, now(), $3)
         ON CONFLICT (id) DO UPDATE SET
           name = COALESCE(EXCLUDED.name, participants.name),
           account = EXCLUDED.account,
           last_seen = now()`,
        [senderWaId, senderName, account]
      );

      await this.dbClient.query(
        `INSERT INTO conversation_participants (conversation_id, participant_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [convId, senderWaId]
      );

      const result = await this.dbClient.query(
        `INSERT INTO messages (
           wa_message_id, conversation_id, sender_wa_id, wa_timestamp,
           direction, content, message_type, is_forwarded, platform, metadata, account
         ) VALUES ($1, $2, $3, $4, 'INBOUND', $5, $6, false, 'instagram', $7, $8)
         ON CONFLICT (wa_message_id) DO NOTHING`,
        [waMessageId, convId, senderWaId, ts, content, messageType, JSON.stringify(metadata), account]
      );

      if ((result.rowCount || 0) > 0) {
        this.logger.info(`IG ${event.eventType} stored: ${waMessageId} (${event.account})`);
      }
    } catch (error) {
      this.logger.error(`Failed to ingest IG event: ${error}`);
    }
  }
}

function routeInstagramAccount(instagramAccount: string): 'personal' | 'professional' {
  return instagramAccount === 'skirmshop' ? 'professional' : 'personal';
}
