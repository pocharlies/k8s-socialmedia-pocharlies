import OpenAI from 'openai';
import { Pool } from 'pg';
import pino from 'pino';

export interface MessageChunk {
  messageId: string;
  chunkIndex: number;
  content: string;
  embedding?: number[];
}

export class EmbeddingService {
  private openai: OpenAI;
  private dbClient: Pool;
  private logger: pino.Logger;
  private readonly EMBEDDING_MODEL: string;
  private readonly EMBEDDING_DIMENSION: number;

  constructor(openaiApiKey: string, dbClient: Pool, _encryptionKey: string) {
    const baseURL = process.env.EMBEDDING_BASE_URL || undefined;
    this.EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
    this.EMBEDDING_DIMENSION = parseInt(process.env.EMBEDDING_DIMENSION || '1536', 10);
    this.openai = new OpenAI({
      apiKey: openaiApiKey || 'not-needed',
      baseURL,
    });
    this.dbClient = dbClient;
    this.logger = pino({
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    });
    this.logger.info(
      `EmbeddingService: model=${this.EMBEDDING_MODEL} dim=${this.EMBEDDING_DIMENSION} baseURL=${baseURL || 'openai-default'}`
    );
  }

  /**
   * Chunks a message based on its length
   */
  chunkMessage(messageId: string, content: string | null): MessageChunk[] {
    if (!content) {
      return [];
    }

    const chunks: MessageChunk[] = [];

    if (content.length < 500) {
      chunks.push({
        messageId,
        chunkIndex: 0,
        content,
      });
      return chunks;
    }

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
   * Generates embeddings for message chunks
   */
  async generateEmbeddings(chunks: MessageChunk[]): Promise<MessageChunk[]> {
    if (chunks.length === 0) {
      return [];
    }

    try {
      const batchSize = 100;
      const results: MessageChunk[] = [];

      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const texts = batch.map(chunk => chunk.content);

        const response = await this.openai.embeddings.create({
          model: this.EMBEDDING_MODEL,
          input: texts,
          encoding_format: 'float',
        });

        for (let j = 0; j < batch.length; j++) {
          results.push({
            ...batch[j],
            embedding: response.data[j].embedding,
          });
        }

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
   * Note: message_embeddings table has: id(serial), message_id(bigint), embedding(vector(384)), model(text), created_at
   */
  async storeEmbeddings(chunks: MessageChunk[]): Promise<void> {
    for (const chunk of chunks) {
      if (!chunk.embedding) {
        continue;
      }

      try {
        await this.dbClient.query(
          `INSERT INTO message_embeddings (message_id, embedding, model, created_at)
           VALUES ($1, $2::vector, $3, NOW())
           ON CONFLICT DO NOTHING`,
          [chunk.messageId, `[${chunk.embedding.join(',')}]`, this.EMBEDDING_MODEL]
        );
      } catch (error) {
        this.logger.error(`Error storing embedding for message ${chunk.messageId}: ${error}`);
      }
    }
  }

  /**
   * Processes a message: read plaintext content, chunk, generate embeddings, store
   */
  async processMessage(messageId: string): Promise<void> {
    try {
      const result = await this.dbClient.query(
        `SELECT id, content, conversation_id FROM messages WHERE id = $1`,
        [messageId]
      );

      if (result.rows.length === 0) {
        this.logger.warn(`Message ${messageId} not found`);
        return;
      }

      const row = result.rows[0];
      const content = row.content;

      if (!content) {
        this.logger.debug(`Message ${messageId} has no content to embed`);
        return;
      }

      // No decryption needed - content is stored as plaintext

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
      const chunks = this.chunkMessage(messageId, content);

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
}
