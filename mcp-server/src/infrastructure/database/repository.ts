import { Pool } from 'pg';
import {
  Conversation,
  ConversationType,
  Participant,
  Message,
  Attachment,
} from '../../domain/entities';

export class DatabaseRepository {
  constructor(private client: Pool) {}

  async findOrCreateConversation(
    waChatId: string,
    type: ConversationType,
    name: string | null = null,
    avatarUrl: string | null = null
  ): Promise<Conversation> {
    // conversations.id IS the wa_chat_id in this schema
    const result = await this.client.query(`SELECT * FROM conversations WHERE id = $1`, [
      waChatId,
    ]);

    if (result.rows.length > 0) {
      const row = result.rows[0];
      return new Conversation(
        row.id,
        row.wa_chat_id || row.id,
        (row.type || (row.is_group ? 'GROUP' : 'INDIVIDUAL')) as ConversationType,
        row.name,
        row.avatar_url,
        row.last_message_at,
        row.created_at,
        row.updated_at,
        row.metadata
      );
    }

    const conversation = Conversation.create(waChatId, type, name, avatarUrl);
    // Use waChatId as the id (since id = wa_chat_id in this schema)
    await this.client.query(
      `INSERT INTO conversations (id, wa_chat_id, type, name, is_group, avatar_url, created_at, updated_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        waChatId,
        waChatId,
        type,
        name,
        type === ConversationType.GROUP,
        avatarUrl,
        new Date(),
        new Date(),
        conversation.metadata || {},
      ]
    );

    return new Conversation(
      waChatId,
      waChatId,
      type,
      name,
      avatarUrl,
      null,
      new Date(),
      new Date(),
      conversation.metadata
    );
  }

  async findOrCreateParticipant(
    conversationId: string,
    waUserId: string,
    name: string | null = null,
    _isAdmin: boolean = false
  ): Promise<Participant> {
    // Check if participant exists in participants table (id = waUserId)
    const result = await this.client.query(
      `SELECT p.*, cp.conversation_id, cp.role
       FROM participants p
       JOIN conversation_participants cp ON cp.participant_id = p.id
       WHERE cp.conversation_id = $1 AND p.id = $2`,
      [conversationId, waUserId]
    );

    if (result.rows.length > 0) {
      const row = result.rows[0];
      return new Participant(
        row.id,
        row.conversation_id,
        row.id, // wa_user_id = participant id
        row.name || row.push_name,
        row.role === 'admin',
        row.joined_at || row.first_seen,
        null // left_at
      );
    }

    // Insert into participants if not exists
    await this.client.query(
      `INSERT INTO participants (id, name, phone, first_seen, last_seen)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET last_seen = NOW(), name = COALESCE(EXCLUDED.name, participants.name)`,
      [waUserId, name, waUserId.replace('@c.us', '').replace('@s.whatsapp.net', '')]
    );

    // Insert into conversation_participants junction
    await this.client.query(
      `INSERT INTO conversation_participants (conversation_id, participant_id, joined_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (conversation_id, participant_id) DO NOTHING`,
      [conversationId, waUserId]
    );

    return new Participant(
      waUserId,
      conversationId,
      waUserId,
      name,
      false,
      new Date(),
      null
    );
  }

  async saveMessage(
    message: Message,
    _encryptedContent: string,
    _encryptedPayload: Buffer | null
  ): Promise<void> {
    // Use plaintext content directly (no encryption in this schema)
    await this.client.query(
      `INSERT INTO messages (
        conversation_id, wa_message_id, sender_wa_id, wa_timestamp, direction,
        content, message_type, is_forwarded, is_edited, is_deleted,
        reply_to_message_id, platform, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (wa_message_id) DO NOTHING`,
      [
        message.conversationId,
        message.waMessageId,
        message.senderWaId,
        message.waTimestamp,
        message.direction,
        message.content || '',
        message.messageType,
        message.isForwarded || false,
        message.isEdited || false,
        message.isDeleted || false,
        message.replyToMessageId,
        'whatsapp',
        {},
      ]
    );
  }

  async saveAttachment(attachment: Attachment): Promise<void> {
    await this.client.query(
      `INSERT INTO attachments (
        message_id, file_type, mime_type, file_name, file_size,
        file_url, thumbnail_url, duration_seconds, width, height, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        attachment.messageId,
        attachment.type,
        attachment.mimeType,
        attachment.fileName,
        attachment.fileSize,
        attachment.storageKey, // maps to file_url
        attachment.thumbnailKey, // maps to thumbnail_url
        attachment.duration,
        attachment.width,
        attachment.height,
        attachment.createdAt,
      ]
    );
  }

  async updateConversationLastMessage(conversationId: string, timestamp: Date): Promise<void> {
    await this.client.query(
      `UPDATE conversations SET last_message_at = $1, updated_at = $2 WHERE id = $3`,
      [timestamp, new Date(), conversationId]
    );
  }

  async searchParticipants(
    query: string,
    limit: number = 20
  ): Promise<
    {
      waUserId: string;
      displayName: string;
      conversationId: string;
      waChatId: string;
      conversationType: string;
      conversationName: string | null;
    }[]
  > {
    const searchPattern = `%${query}%`;
    const result = await this.client.query(
      `SELECT p.id as wa_user_id, COALESCE(p.name, p.push_name, p.id) as display_name,
              c.id as conversation_id, c.id as wa_chat_id,
              COALESCE(c.type, CASE WHEN c.is_group THEN 'GROUP' ELSE 'INDIVIDUAL' END) as conversation_type,
              c.name as conversation_name
       FROM participants p
       JOIN conversation_participants cp ON cp.participant_id = p.id
       JOIN conversations c ON cp.conversation_id = c.id
       WHERE (p.name ILIKE $1 OR p.push_name ILIKE $1 OR p.id ILIKE $1 OR p.phone ILIKE $1)
       ORDER BY c.last_message_at DESC NULLS LAST
       LIMIT $2`,
      [searchPattern, limit]
    );

    return result.rows.map(row => ({
      waUserId: row.wa_user_id,
      displayName: row.display_name,
      conversationId: row.conversation_id,
      waChatId: row.wa_chat_id,
      conversationType: row.conversation_type,
      conversationName: row.conversation_name,
    }));
  }

  async listConversations(options: {
    type?: string;
    query?: string;
    limit?: number;
    includeParticipants?: boolean;
  }): Promise<
    {
      id: string;
      waChatId: string;
      type: string;
      name: string | null;
      lastMessageAt: Date | null;
      messageCount: number;
      participants?: { waUserId: string; name: string | null; isAdmin: boolean }[];
    }[]
  > {
    const { type, query, limit = 20, includeParticipants = true } = options;
    const searchPattern = query ? `%${query}%` : null;

    const result = await this.client.query(
      `SELECT c.*,
              COALESCE(c.type, CASE WHEN c.is_group THEN 'GROUP' ELSE 'INDIVIDUAL' END) as conv_type,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count
       FROM conversations c
       WHERE ($1::VARCHAR IS NULL OR COALESCE(c.type, CASE WHEN c.is_group THEN 'GROUP' ELSE 'INDIVIDUAL' END) = $1)
         AND ($2::VARCHAR IS NULL OR c.name ILIKE $2
              OR EXISTS (SELECT 1 FROM conversation_participants cp
                         JOIN participants p ON p.id = cp.participant_id
                         WHERE cp.conversation_id = c.id
                         AND (p.name ILIKE $2 OR p.push_name ILIKE $2 OR p.id ILIKE $2)))
       ORDER BY c.last_message_at DESC NULLS LAST
       LIMIT $3`,
      [type || null, searchPattern, limit]
    );

    const conversations = await Promise.all(
      result.rows.map(async row => {
        const conv: {
          id: string;
          waChatId: string;
          type: string;
          name: string | null;
          lastMessageAt: Date | null;
          messageCount: number;
          participants?: { waUserId: string; name: string | null; isAdmin: boolean }[];
        } = {
          id: row.id,
          waChatId: row.wa_chat_id || row.id,
          type: row.conv_type,
          name: row.name,
          lastMessageAt: row.last_message_at,
          messageCount: parseInt(row.message_count, 10),
        };

        if (includeParticipants) {
          conv.participants = await this.getConversationParticipants(row.id);
        }

        return conv;
      })
    );

    return conversations;
  }

  async getConversationParticipants(conversationId: string): Promise<
    {
      waUserId: string;
      name: string | null;
      isAdmin: boolean;
    }[]
  > {
    const result = await this.client.query(
      `SELECT p.id as wa_user_id, COALESCE(p.name, p.push_name) as name, cp.role
       FROM participants p
       JOIN conversation_participants cp ON cp.participant_id = p.id
       WHERE cp.conversation_id = $1
       ORDER BY cp.role DESC, p.name ASC`,
      [conversationId]
    );

    return result.rows.map(row => ({
      waUserId: row.wa_user_id,
      name: row.name,
      isAdmin: row.role === 'admin',
    }));
  }

  async getMessagesByUser(
    waUserId: string,
    options: {
      conversationId?: string;
      from?: Date;
      to?: Date;
      limit?: number;
    }
  ): Promise<
    {
      id: string;
      conversationId: string;
      waChatId: string;
      conversationName: string | null;
      waMessageId: string;
      content: string;
      messageType: string;
      waTimestamp: Date;
      isForwarded: boolean;
      isEdited: boolean;
    }[]
  > {
    const { conversationId, from, to, limit = 50 } = options;

    const result = await this.client.query(
      `SELECT m.id, m.conversation_id, c.id as wa_chat_id, c.name as conversation_name,
              m.wa_message_id, m.content, m.message_type, m.wa_timestamp,
              m.is_forwarded, m.is_edited
       FROM messages m
       JOIN conversations c ON m.conversation_id = c.id
       WHERE m.sender_wa_id = $1
         AND (m.is_deleted IS NULL OR m.is_deleted = false)
         AND ($2::TEXT IS NULL OR m.conversation_id = $2)
         AND ($3::TIMESTAMP IS NULL OR m.wa_timestamp >= $3)
         AND ($4::TIMESTAMP IS NULL OR m.wa_timestamp <= $4)
       ORDER BY m.wa_timestamp DESC
       LIMIT $5`,
      [waUserId, conversationId || null, from || null, to || null, limit]
    );

    return result.rows.map(row => ({
      id: row.id,
      conversationId: row.conversation_id,
      waChatId: row.wa_chat_id,
      conversationName: row.conversation_name,
      waMessageId: row.wa_message_id,
      content: row.content,
      messageType: row.message_type,
      waTimestamp: row.wa_timestamp,
      isForwarded: row.is_forwarded,
      isEdited: row.is_edited,
    }));
  }

  async getUserInfo(waUserId: string): Promise<{
    waUserId: string;
    names: string[];
    conversationCount: number;
    messageCount: number;
    lastSeen: Date | null;
  } | null> {
    const participantResult = await this.client.query(
      `SELECT p.name, p.push_name,
              (SELECT COUNT(DISTINCT cp.conversation_id) FROM conversation_participants cp WHERE cp.participant_id = p.id) as conversation_count
       FROM participants p
       WHERE p.id = $1`,
      [waUserId]
    );

    if (participantResult.rows.length === 0) {
      return null;
    }

    const messageResult = await this.client.query(
      `SELECT COUNT(*) as message_count, MAX(wa_timestamp) as last_seen
       FROM messages
       WHERE sender_wa_id = $1 AND (is_deleted IS NULL OR is_deleted = false)`,
      [waUserId]
    );

    const row = participantResult.rows[0];
    const msgRow = messageResult.rows[0];
    const names = [row.name, row.push_name].filter(Boolean);

    return {
      waUserId,
      names: names.length > 0 ? names : [],
      conversationCount: parseInt(row.conversation_count, 10),
      messageCount: parseInt(msgRow.message_count, 10),
      lastSeen: msgRow.last_seen,
    };
  }
}
