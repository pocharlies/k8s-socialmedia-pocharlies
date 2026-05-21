import { Pool } from 'pg';
import { decryptString } from '@mcp-socialmedia/shared';
import { LlamaService } from './llama.service';
import pino from 'pino';

export interface MessageChunk {
  messageId: string;
  chunkIndex: number;
  content: string;
  embedding?: number[];
}

/**
 * Embedding service using local Llama/Ollama models
 * Drop-in replacement for the OpenAI-based EmbeddingService
 */
export class LlamaEmbeddingService {
  private llamaService: LlamaService;
  private dbClient: Pool;
  private encryptionKey: Buffer;
  private logger: pino.Logger;
  private readonly EMBEDDING_MODEL: string;
  private readonly EMBEDDING_DIMENSION = 768; // nomic-embed-text dimension

  constructor(
    llamaService: LlamaService,
    dbClient: Pool,
    encryptionKey: string,
    embeddingModel: string = 'nomic-embed-text'
  ) {
    this.llamaService = llamaService;
    this.dbClient = dbClient;
    this.encryptionKey = Buffer.from(encryptionKey, 'utf-8');
    this.EMBEDDING_MODEL = embeddingModel;
    this.logger = pino({
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    });
  }

  /**
   * Chunks a message based on its length
   */
  chunkMessage(messageId: string, content: string | null): MessageChunk[] {
    if (!content) {
      return [];
    }

    const chunks: MessageChunk[] = [];

    // Messages < 500 chars: single chunk
    if (content.length < 500) {
      chunks.push({
        messageId,
        chunkIndex: 0,
        content,
      });
      return chunks;
    }

    // Messages 500-2000 chars: split by sentences, max 500 chars per chunk
    if (content.length >= 500 && content.length <= 2000) {
      const sentences = content.split(/(?<=[.!?])\s+/);
      let currentChunk = '';
      let chunkIndex = 0;

      for (const sentence of sentences) {
        if (currentChunk.length + sentence.length > 500 && currentChunk) {
          chunks.push({
            messageId,
            chunkIndex,
            content: currentChunk.trim(),
          });
          currentChunk = sentence;
          chunkIndex++;
        } else {
          currentChunk += (currentChunk ? ' ' : '') + sentence;
        }
      }

      if (currentChunk) {
        chunks.push({
          messageId,
          chunkIndex,
          content: currentChunk.trim(),
        });
      }

      return chunks;
    }

    // Messages > 2000 chars: split by paragraphs, max 1000 chars per chunk
    const paragraphs = content.split(/\n\n+/);
    let currentChunk = '';
    let chunkIndex = 0;

    for (const paragraph of paragraphs) {
      if (currentChunk.length + paragraph.length > 1000 && currentChunk) {
        chunks.push({
          messageId,
          chunkIndex,
          content: currentChunk.trim(),
        });
        currentChunk = paragraph;
        chunkIndex++;
      } else {
        currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
      }
    }

    if (currentChunk) {
      chunks.push({
        messageId,
        chunkIndex,
        content: currentChunk.trim(),
      });
    }

    return chunks;
  }

  /**
   * Generates embeddings for message chunks using local Ollama
   */
  async generateEmbeddings(chunks: MessageChunk[]): Promise<MessageChunk[]> {
    if (chunks.length === 0) {
      return [];
    }

    try {
      const results: MessageChunk[] = [];

      // Process in smaller batches to avoid overwhelming the local server
      const batchSize = 10;

      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);

        for (const chunk of batch) {
          try {
            const embedding = await this.llamaService.generateEmbedding(chunk.content);
            results.push({
              ...chunk,
              embedding,
            });
          } catch (error) {
            this.logger.error(`Error generating embedding for chunk: ${error}`);
            // Continue with other chunks
          }
        }

        // Small delay between batches
        if (i + batchSize < chunks.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      return results;
    } catch (error) {
      this.logger.error(`Error generating embeddings: ${error}`);
      throw error;
    }
  }

  /**
   * Stores embeddings in the database
   */
  async storeEmbeddings(chunks: MessageChunk[]): Promise<void> {
    for (const chunk of chunks) {
      if (!chunk.embedding) {
        continue;
      }

      try {
        await this.dbClient.query(
          `INSERT INTO message_embeddings (id, message_id, embedding, model, chunk_index, created_at)
           VALUES (gen_random_uuid(), $1, $2::vector, $3, $4, NOW())
           ON CONFLICT DO NOTHING`,
          [
            chunk.messageId,
            `[${chunk.embedding.join(',')}]`, // Convert array to pgvector format
            this.EMBEDDING_MODEL,
            chunk.chunkIndex,
          ]
        );
      } catch (error) {
        this.logger.error(`Error storing embedding for message ${chunk.messageId}: ${error}`);
      }
    }
  }

  /**
   * Processes a message: decrypt, chunk, generate embeddings, store
   */
  async processMessage(messageId: string): Promise<void> {
    try {
      // Fetch message from database
      const result = await this.dbClient.query(
        `SELECT id, content, conversation_id FROM messages WHERE id = $1`,
        [messageId]
      );

      if (result.rows.length === 0) {
        this.logger.warn(`Message ${messageId} not found`);
        return;
      }

      const row = result.rows[0];
      const encryptedContent = row.content;

      if (!encryptedContent) {
        this.logger.debug(`Message ${messageId} has no content to embed`);
        return;
      }

      // Decrypt content
      const decryptedContent = decryptString(encryptedContent, this.encryptionKey);

      // Check if embedding already exists
      const existing = await this.dbClient.query(
        `SELECT id FROM message_embeddings WHERE message_id = $1 LIMIT 1`,
        [messageId]
      );

      if (existing.rows.length > 0) {
        this.logger.debug(`Embedding already exists for message ${messageId}`);
        return;
      }

      // Chunk message
      const chunks = this.chunkMessage(messageId, decryptedContent);

      if (chunks.length === 0) {
        return;
      }

      // Generate embeddings
      const chunksWithEmbeddings = await this.generateEmbeddings(chunks);

      // Store embeddings
      await this.storeEmbeddings(chunksWithEmbeddings);

      this.logger.debug(`Processed embeddings for message ${messageId}`);
    } catch (error) {
      this.logger.error(`Error processing message ${messageId}: ${error}`);
      throw error;
    }
  }

  /**
   * Generate embedding for a search query
   */
  async generateQueryEmbedding(query: string): Promise<number[]> {
    return this.llamaService.generateEmbedding(query);
  }

  /**
   * Semantic search using local embeddings
   */
  async semanticSearch(
    query: string,
    limit: number = 10,
    conversationId?: string
  ): Promise<Array<{ messageId: string; content: string; score: number }>> {
    try {
      // Generate embedding for the query
      const queryEmbedding = await this.generateQueryEmbedding(query);

      // Build SQL query
      let sql = `
        SELECT
          me.message_id,
          m.content,
          1 - (me.embedding <=> $1::vector) as score
        FROM message_embeddings me
        JOIN messages m ON me.message_id = m.id
        WHERE m.is_deleted = false
      `;

      const params: unknown[] = [`[${queryEmbedding.join(',')}]`];
      let paramIndex = 2;

      if (conversationId) {
        sql += ` AND m.conversation_id = (SELECT id FROM conversations WHERE wa_chat_id = $${paramIndex})`;
        params.push(conversationId);
        paramIndex++;
      }

      sql += ` ORDER BY me.embedding <=> $1::vector LIMIT $${paramIndex}`;
      params.push(limit);

      const result = await this.dbClient.query(sql, params);

      return result.rows.map(row => {
        let content = '';
        if (row.content) {
          try {
            content = decryptString(row.content, this.encryptionKey);
          } catch {
            content = '[Decryption failed]';
          }
        }

        return {
          messageId: row.message_id,
          content,
          score: row.score,
        };
      });
    } catch (error) {
      this.logger.error(`Error in semantic search: ${error}`);
      throw error;
    }
  }
}
