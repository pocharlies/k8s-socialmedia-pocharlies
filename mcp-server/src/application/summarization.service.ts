import OpenAI from 'openai';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { t } from '../infrastructure/i18n/i18n';
import pino from 'pino';

export type SummaryStyle = 'brief' | 'detailed' | 'bullet';
export type SummaryLanguage = 'en' | 'es';

export interface SummaryOptions {
  style?: SummaryStyle;
  language?: SummaryLanguage;
  range?: {
    from?: Date;
    to?: Date;
  };
}

export class SummarizationService {
  private openai: OpenAI;
  private dbClient: Pool;
  private redis: Redis;
  private logger: pino.Logger;
  private llmModel: string;

  constructor(openaiApiKey: string, dbClient: Pool, redisUrl: string, _encryptionKey: string, llmBaseUrl?: string, llmModel?: string) {
    this.openai = new OpenAI({ apiKey: openaiApiKey || "sk-placeholder", ...(llmBaseUrl && { baseURL: llmBaseUrl }) });
    this.llmModel = llmModel || "gpt-4o-mini";
    this.dbClient = dbClient;
    this.redis = new Redis(redisUrl);
    this.logger = pino({
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    });
  }

  /**
   * Gets the prompt template based on style and language
   */
  private getPromptTemplate(style: SummaryStyle, _language: SummaryLanguage): string {
    const key = `summaries.${style}_template`;
    return t(key);
  }

  /**
   * Retrieves messages for a conversation (plaintext, no decryption needed)
   */
  private async getConversationMessages(
    conversationId: string,
    options: SummaryOptions = {}
  ): Promise<Array<{ content: string; sender: string; timestamp: Date }>> {
    // conversations.id IS the wa_chat_id, so query directly
    let sql = `
      SELECT m.content, m.sender_wa_id, m.wa_timestamp
      FROM messages m
      WHERE m.conversation_id = $1
        AND (m.is_deleted IS NULL OR m.is_deleted = false)
    `;

    const params: unknown[] = [conversationId];

    if (options.range?.from) {
      sql += ` AND m.wa_timestamp >= $${params.length + 1}`;
      params.push(options.range.from);
    }

    if (options.range?.to) {
      sql += ` AND m.wa_timestamp <= $${params.length + 1}`;
      params.push(options.range.to);
    }

    sql += ` ORDER BY m.wa_timestamp ASC`;

    const result = await this.dbClient.query(sql, params);

    return result.rows.map(row => ({
      content: row.content || '',
      sender: row.sender_wa_id,
      timestamp: row.wa_timestamp,
    }));
  }

  /**
   * Generates a summary for a conversation
   */
  async summarizeChat(chatId: string, options: SummaryOptions = {}): Promise<string> {
    const { style = 'brief', language = 'en' } = options;

    // Check cache
    const cacheKey = `summary:${chatId}:${style}:${language}:${JSON.stringify(options.range)}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit for summary: ${cacheKey}`);
      return cached;
    }

    try {
      // Get messages
      const messages = await this.getConversationMessages(chatId, options);

      if (messages.length === 0) {
        return 'No messages found in this conversation.';
      }

      // Format messages for prompt
      const messagesText = messages
        .map(msg => `[${msg.timestamp.toISOString()}] ${msg.sender}: ${msg.content}`)
        .join('\n');

      // Get prompt template
      const promptTemplate = this.getPromptTemplate(style, language);
      const prompt = `${promptTemplate}\n\nConversation:\n${messagesText}`;

      // Generate summary using OpenAI
      const response = await this.openai.chat.completions.create({
        model: this.llmModel,
        messages: [
          {
            role: 'system',
            content:
              language === 'es'
                ? 'Eres un asistente que resume conversaciones de WhatsApp de manera clara y concisa.'
                : 'You are an assistant that summarizes WhatsApp conversations clearly and concisely.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.7,
        max_tokens: style === 'brief' ? 200 : 500,
      }, { timeout: 180_000 });

      const summary = response.choices[0]?.message?.content || 'Failed to generate summary';

      // Cache for 1 hour
      await this.redis.setex(cacheKey, 3600, summary);

      return summary;
    } catch (error) {
      this.logger.error(`Error generating summary: ${error}`);
      throw error;
    }
  }

  /**
   * Summarizes all conversations for a specific day
   */
  async summarizeDay(
    date: Date,
    _scope: 'all' | 'important' = 'all',
    language: SummaryLanguage = 'en'
  ): Promise<string> {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    // conversations.id IS the wa_chat_id
    const result = await this.dbClient.query(
      `SELECT DISTINCT c.id, c.name
       FROM conversations c
       JOIN messages m ON m.conversation_id = c.id
       WHERE m.wa_timestamp >= $1 AND m.wa_timestamp <= $2
       ORDER BY c.name`,
      [startOfDay, endOfDay]
    );

    if (result.rows.length === 0) {
      return language === 'es'
        ? 'No hay conversaciones con mensajes en este día.'
        : 'No conversations with messages on this day.';
    }

    const summaries: string[] = [];

    for (const row of result.rows) {
      try {
        const summary = await this.summarizeChat(row.id, {
          style: 'brief',
          language,
          range: {
            from: startOfDay,
            to: endOfDay,
          },
        });
        summaries.push(`**${row.name || row.id}**:\n${summary}`);
      } catch (error) {
        this.logger.error(`Error summarizing chat ${row.id}: ${error}`);
      }
    }

    return summaries.join('\n\n');
  }

  /**
   * Summarizes all conversations for a week
   */
  async summarizeWeek(
    weekStartDate: Date,
    _scope: 'all' | 'important' = 'all',
    language: SummaryLanguage = 'en'
  ): Promise<string> {
    const startOfWeek = new Date(weekStartDate);
    startOfWeek.setHours(0, 0, 0, 0);
    const endOfWeek = new Date(weekStartDate);
    endOfWeek.setDate(endOfWeek.getDate() + 7);
    endOfWeek.setHours(23, 59, 59, 999);

    const result = await this.dbClient.query(
      `SELECT DISTINCT c.id, c.name
       FROM conversations c
       JOIN messages m ON m.conversation_id = c.id
       WHERE m.wa_timestamp >= $1 AND m.wa_timestamp <= $2
       ORDER BY c.name`,
      [startOfWeek, endOfWeek]
    );

    if (result.rows.length === 0) {
      return language === 'es'
        ? 'No hay conversaciones con mensajes en esta semana.'
        : 'No conversations with messages in this week.';
    }

    const summaries: string[] = [];

    for (const row of result.rows) {
      try {
        const summary = await this.summarizeChat(row.id, {
          style: 'brief',
          language,
          range: {
            from: startOfWeek,
            to: endOfWeek,
          },
        });
        summaries.push(`**${row.name || row.id}**:\n${summary}`);
      } catch (error) {
        this.logger.error(`Error summarizing chat ${row.id}: ${error}`);
      }
    }

    return summaries.join('\n\n');
  }
}
