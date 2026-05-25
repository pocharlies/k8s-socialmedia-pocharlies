import { Pool } from 'pg';
import OpenAI from 'openai';
import pino from 'pino';
import { accountKey, normalizeAccount } from '../domain/account';

export interface SearchResult {
  messageId: string;
  conversationId: string;
  content: string;
  senderWaId: string;
  waTimestamp: Date;
  similarity?: number;
  rank?: number;
}

export interface SearchOptions {
  chatId?: string;
  from?: Date;
  to?: Date;
  sender?: string;
  limit?: number;
  /** Account scope (personal|professional). Defaults to personal. */
  account?: string;
}

export class SearchService {
  private openai: OpenAI;
  private dbClient: Pool;
  private logger: pino.Logger;
  private readonly EMBEDDING_MODEL = 'text-embedding-3-small';

  constructor(openaiApiKey: string, dbClient: Pool, _encryptionKey: string, llmBaseUrl?: string) {
    this.openai = new OpenAI({
      apiKey: openaiApiKey || 'sk-placeholder',
      ...(llmBaseUrl && { baseURL: llmBaseUrl }),
    });
    this.dbClient = dbClient;
    this.logger = pino({
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    });
  }

  /**
   * Performs keyword search using PostgreSQL Full Text Search
   */
  async keywordSearch(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { chatId, from, to, sender, limit = 20 } = options;

    let sql = `
      SELECT 
        m.id as message_id,
        m.conversation_id,
        m.content,
        m.sender_wa_id,
        m.wa_timestamp,
        ts_rank(to_tsvector('english', m.content), plainto_tsquery('english', $1)) as rank
      FROM messages m
      WHERE to_tsvector('english', m.content) @@ plainto_tsquery('english', $1)
        AND (m.is_deleted IS NULL OR m.is_deleted = false)
    `;

    const params: unknown[] = [query];
    let paramIndex = 2;

    if (chatId) {
      // conversations.id IS the wa_chat_id
      sql += ` AND m.conversation_id = $${paramIndex}`;
      params.push(accountKey(normalizeAccount(options.account), chatId));
      paramIndex++;
    }

    if (from) {
      sql += ` AND m.wa_timestamp >= $${paramIndex}`;
      params.push(from);
      paramIndex++;
    }

    if (to) {
      sql += ` AND m.wa_timestamp <= $${paramIndex}`;
      params.push(to);
      paramIndex++;
    }

    if (sender) {
      sql += ` AND m.sender_wa_id = $${paramIndex}`;
      params.push(accountKey(normalizeAccount(options.account), sender));
      paramIndex++;
    }

    sql += ` AND m.account = $${paramIndex}`;
    params.push(normalizeAccount(options.account));
    paramIndex++;

    sql += ` ORDER BY rank DESC, m.wa_timestamp DESC LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await this.dbClient.query(sql, params);

    return result.rows.map(row => ({
      messageId: row.message_id,
      conversationId: row.conversation_id,
      content: row.content || '',
      senderWaId: row.sender_wa_id,
      waTimestamp: row.wa_timestamp,
      rank: parseFloat(row.rank),
    }));
  }

  /**
   * Performs semantic search using vector similarity
   */
  async semanticSearch(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { chatId, from, to, sender, limit = 20 } = options;

    // Generate embedding for query
    const response = await this.openai.embeddings.create({
      model: this.EMBEDDING_MODEL,
      input: query,
    });

    const queryEmbedding = response.data[0].embedding;
    const embeddingVector = `[${queryEmbedding.join(',')}]`;

    let sql = `
      SELECT 
        m.id as message_id,
        m.conversation_id,
        m.content,
        m.sender_wa_id,
        m.wa_timestamp,
        1 - (me.embedding <=> $1::vector) as similarity
      FROM messages m
      JOIN message_embeddings me ON m.id = me.message_id
      WHERE 1 - (me.embedding <=> $1::vector) > 0.7
        AND (m.is_deleted IS NULL OR m.is_deleted = false)
    `;

    const params: unknown[] = [embeddingVector];
    let paramIndex = 2;

    if (chatId) {
      sql += ` AND m.conversation_id = $${paramIndex}`;
      params.push(accountKey(normalizeAccount(options.account), chatId));
      paramIndex++;
    }

    if (from) {
      sql += ` AND m.wa_timestamp >= $${paramIndex}`;
      params.push(from);
      paramIndex++;
    }

    if (to) {
      sql += ` AND m.wa_timestamp <= $${paramIndex}`;
      params.push(to);
      paramIndex++;
    }

    if (sender) {
      sql += ` AND m.sender_wa_id = $${paramIndex}`;
      params.push(accountKey(normalizeAccount(options.account), sender));
      paramIndex++;
    }

    sql += ` AND m.account = $${paramIndex}`;
    params.push(normalizeAccount(options.account));
    paramIndex++;

    sql += ` ORDER BY similarity DESC, m.wa_timestamp DESC LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await this.dbClient.query(sql, params);

    return result.rows.map(row => ({
      messageId: row.message_id,
      conversationId: row.conversation_id,
      content: row.content || '',
      senderWaId: row.sender_wa_id,
      waTimestamp: row.wa_timestamp,
      similarity: parseFloat(row.similarity),
    }));
  }

  /**
   * Hybrid search: combines keyword and semantic search
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    // Try semantic search first, fallback to keyword search
    try {
      const semanticResults = await this.semanticSearch(query, options);
      if (semanticResults.length > 0) {
        return semanticResults;
      }
    } catch (error) {
      this.logger.warn(`Semantic search failed, falling back to keyword search: ${error}`);
    }

    // Fallback to keyword search
    return this.keywordSearch(query, options);
  }
}
