import OpenAI from 'openai';
import { Pool } from 'pg';
import pino from 'pino';

export interface DraftConstraints {
  maxLength?: number;
  requiredTopics?: string[];
  avoidTopics?: string[];
}

export interface DraftOptions {
  tone?: 'professional' | 'casual' | 'friendly' | 'formal';
  language?: 'en' | 'es';
  constraints?: DraftConstraints;
}

export interface DraftReplyData {
  id: string;
  conversationId: string;
  content: string;
  tone: string;
  status: string;
  approvedAt: Date | null;
  sentAt: Date | null;
  createdAt: Date;
}

export class DraftService {
  private openai: OpenAI;
  private dbClient: Pool;
  private logger: pino.Logger;
  private readonly MAX_DRAFTS_PER_HOUR = 10;
  private readonly MAX_MESSAGE_LENGTH = 4096;
  private llmModel: string;

  constructor(
    openaiApiKey: string,
    dbClient: Pool,
    _encryptionKey: string,
    llmBaseUrl?: string,
    llmModel?: string
  ) {
    this.openai = new OpenAI({
      apiKey: openaiApiKey || 'sk-placeholder',
      ...(llmBaseUrl && { baseURL: llmBaseUrl }),
    });
    this.llmModel = llmModel || 'gpt-4o-mini';
    this.dbClient = dbClient;
    this.logger = pino({
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    });
  }

  /**
   * Gets conversation context (last N messages) - plaintext, no decryption
   */
  private async getConversationContext(
    conversationId: string,
    lastN: number = 20
  ): Promise<Array<{ content: string; sender: string; timestamp: Date }>> {
    // conversations.id IS the wa_chat_id
    const result = await this.dbClient.query(
      `SELECT m.content, m.sender_wa_id, m.wa_timestamp
       FROM messages m
       WHERE m.conversation_id = $1
         AND (m.is_deleted IS NULL OR m.is_deleted = false)
       ORDER BY m.wa_timestamp DESC
       LIMIT $2`,
      [conversationId, lastN]
    );

    return result.rows.reverse().map(row => ({
      content: row.content || '',
      sender: row.sender_wa_id,
      timestamp: row.wa_timestamp,
    }));
  }

  /**
   * Checks rate limiting for drafts
   */
  private async checkRateLimit(conversationId: string): Promise<boolean> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const result = await this.dbClient.query(
      `SELECT COUNT(*) as count
       FROM draft_replies
       WHERE conversation_id = $1
         AND created_at >= $2`,
      [conversationId, oneHourAgo]
    );

    const count = parseInt(result.rows[0].count, 10);
    return count < this.MAX_DRAFTS_PER_HOUR;
  }

  /**
   * Validates draft content
   */
  private validateDraft(content: string, constraints?: DraftConstraints): void {
    if (content.length > this.MAX_MESSAGE_LENGTH) {
      throw new Error(`Draft exceeds maximum length of ${this.MAX_MESSAGE_LENGTH} characters`);
    }

    if (constraints?.maxLength && content.length > constraints.maxLength) {
      throw new Error(`Draft exceeds specified max length of ${constraints.maxLength} characters`);
    }

    const sensitivePatterns = [
      /password\s*[:=]\s*\w+/i,
      /api[_-]?key\s*[:=]\s*\w+/i,
      /secret\s*[:=]\s*\w+/i,
    ];

    for (const pattern of sensitivePatterns) {
      if (pattern.test(content)) {
        throw new Error('Draft contains potentially sensitive information');
      }
    }
  }

  /**
   * Creates a draft reply
   */
  async createDraft(
    chatId: string,
    options: DraftOptions = {},
    _replyToMessageId?: string,
    lastN?: number
  ): Promise<DraftReplyData> {
    const { tone = 'casual', language = 'en', constraints } = options;

    // Check rate limit
    const withinRateLimit = await this.checkRateLimit(chatId);
    if (!withinRateLimit) {
      throw new Error('Rate limit exceeded. Maximum 10 drafts per conversation per hour.');
    }

    // Get conversation context
    const context = await this.getConversationContext(chatId, lastN || 20);

    if (context.length === 0) {
      throw new Error('No messages found in conversation');
    }

    // Format context for prompt
    const contextText = context
      .map(msg => `[${msg.timestamp.toISOString()}] ${msg.sender}: ${msg.content}`)
      .join('\n');

    // Build prompt
    const languageInstruction = language === 'es' ? 'Responde en español.' : 'Respond in English.';
    const toneInstruction = `Use a ${tone} tone.`;
    const constraintsText = constraints ? `Constraints: ${JSON.stringify(constraints)}` : '';

    const prompt = `You are drafting a WhatsApp message reply. ${languageInstruction} ${toneInstruction}

${constraintsText}

Conversation context:
${contextText}

Generate a draft reply. Keep it concise and appropriate for WhatsApp messaging.`;

    try {
      // Generate draft using OpenAI
      const response = await this.openai.chat.completions.create(
        {
          model: this.llmModel,
          messages: [
            {
              role: 'system',
              content:
                language === 'es'
                  ? 'Eres un asistente que ayuda a redactar respuestas para WhatsApp de manera clara y apropiada.'
                  : 'You are an assistant that helps draft WhatsApp message replies clearly and appropriately.',
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature: 0.7,
          max_tokens: constraints?.maxLength ? Math.min(constraints.maxLength / 4, 500) : 200,
        },
        { timeout: 180_000 }
      );

      const draftContent = response.choices[0]?.message?.content || '';

      // Validate draft
      this.validateDraft(draftContent, constraints);

      // Save to database (draft_replies has: id(serial), conversation_id, content, tone, status, approved_at, sent_at, created_at)
      const insertResult = await this.dbClient.query(
        `INSERT INTO draft_replies (conversation_id, content, tone, status, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         RETURNING id, conversation_id, content, tone, status, approved_at, sent_at, created_at`,
        [chatId, draftContent, tone, 'DRAFT']
      );

      const row = insertResult.rows[0];
      return {
        id: row.id.toString(),
        conversationId: row.conversation_id,
        content: row.content,
        tone: row.tone,
        status: row.status,
        approvedAt: row.approved_at,
        sentAt: row.sent_at,
        createdAt: row.created_at,
      };
    } catch (error) {
      this.logger.error(`Error creating draft: ${error}`);
      throw error;
    }
  }

  /**
   * Lists drafts for a conversation
   */
  async listDrafts(chatId: string, status?: string): Promise<DraftReplyData[]> {
    let sql = `
      SELECT * FROM draft_replies
      WHERE conversation_id = $1
    `;
    const params: unknown[] = [chatId];

    if (status) {
      sql += ` AND status = $2`;
      params.push(status);
    }

    sql += ` ORDER BY created_at DESC`;

    const result = await this.dbClient.query(sql, params);

    return result.rows.map(row => ({
      id: row.id.toString(),
      conversationId: row.conversation_id,
      content: row.content,
      tone: row.tone,
      status: row.status,
      approvedAt: row.approved_at,
      sentAt: row.sent_at,
      createdAt: row.created_at,
    }));
  }

  /**
   * Approves a draft
   */
  async approveDraft(draftId: string): Promise<string> {
    const result = await this.dbClient.query(`SELECT * FROM draft_replies WHERE id = $1`, [
      draftId,
    ]);

    if (result.rows.length === 0) {
      throw new Error('Draft not found');
    }

    const row = result.rows[0];
    if (row.status !== 'DRAFT') {
      throw new Error('Draft is not in DRAFT status');
    }

    // Use the draft id as a simple send token
    const sendToken = `send-${draftId}-${Date.now()}`;

    await this.dbClient.query(
      `UPDATE draft_replies SET status = 'APPROVED', approved_at = NOW() WHERE id = $1`,
      [draftId]
    );

    return sendToken;
  }

  /**
   * Gets draft by ID
   */
  async getDraftById(draftId: string): Promise<DraftReplyData | null> {
    const result = await this.dbClient.query(`SELECT * FROM draft_replies WHERE id = $1`, [
      draftId,
    ]);

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      id: row.id.toString(),
      conversationId: row.conversation_id,
      content: row.content,
      tone: row.tone,
      status: row.status,
      approvedAt: row.approved_at,
      sentAt: row.sent_at,
      createdAt: row.created_at,
    };
  }

  /**
   * Marks draft as sent
   */
  async markAsSent(draftId: string): Promise<void> {
    await this.dbClient.query(
      `UPDATE draft_replies SET status = 'SENT', sent_at = NOW() WHERE id = $1`,
      [draftId]
    );
  }
}
