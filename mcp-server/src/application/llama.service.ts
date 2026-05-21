import { Pool } from 'pg';
import Redis from 'ioredis';
import pino from 'pino';

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  embeddingModel?: string;
}

export interface LlamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlamaCompletionOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stream?: boolean;
}

export interface EmbeddingResult {
  embedding: number[];
}

/**
 * Service for interacting with local Llama models via Ollama
 * Provides embeddings, completions, and style analysis
 */
export class LlamaService {
  private baseUrl: string;
  private model: string;
  private embeddingModel: string;
  private dbClient: Pool;
  private redis: Redis;
  private encryptionKey: Buffer;
  private logger: pino.Logger;

  constructor(config: OllamaConfig, dbClient: Pool, redisUrl: string, encryptionKey: string) {
    this.baseUrl = config.baseUrl;
    this.model = config.model;
    this.embeddingModel = config.embeddingModel || 'nomic-embed-text';
    this.dbClient = dbClient;
    this.redis = new Redis(redisUrl);
    this.encryptionKey = Buffer.from(encryptionKey, 'utf-8');
    this.logger = pino({
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    });
  }

  /**
   * Generate embeddings using local Ollama model
   */
  async generateEmbedding(text: string): Promise<number[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.embeddingModel,
          prompt: text,
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama embedding error: ${response.statusText}`);
      }

      const data = (await response.json()) as { embedding: number[] };
      return data.embedding;
    } catch (error) {
      this.logger.error(`Error generating embedding: ${error}`);
      throw error;
    }
  }

  /**
   * Generate embeddings for multiple texts (batch)
   */
  async generateBatchEmbeddings(texts: string[]): Promise<number[][]> {
    const embeddings: number[][] = [];

    for (const text of texts) {
      const embedding = await this.generateEmbedding(text);
      embeddings.push(embedding);
      // Small delay to not overwhelm the server
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    return embeddings;
  }

  /**
   * Generate a chat completion
   */
  async generateCompletion(
    messages: LlamaMessage[],
    options: LlamaCompletionOptions = {}
  ): Promise<string> {
    const { temperature = 0.7, maxTokens = 2048, topP = 0.9, stream = false } = options;

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages,
          options: {
            temperature,
            num_predict: maxTokens,
            top_p: topP,
          },
          stream,
        }),
        signal: AbortSignal.timeout(180_000),
      });

      if (!response.ok) {
        throw new Error(`Ollama completion error: ${response.statusText}`);
      }

      const data = (await response.json()) as { message?: { content?: string } };
      return data.message?.content || '';
    } catch (error) {
      this.logger.error(`Error generating completion: ${error}`);
      throw error;
    }
  }

  /**
   * Generate a raw text completion (for style analysis)
   */
  async generateRawCompletion(
    prompt: string,
    options: LlamaCompletionOptions = {}
  ): Promise<string> {
    const { temperature = 0.7, maxTokens = 2048, topP = 0.9, stream = false } = options;

    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt,
          options: {
            temperature,
            num_predict: maxTokens,
            top_p: topP,
          },
          stream,
        }),
        signal: AbortSignal.timeout(180_000),
      });

      if (!response.ok) {
        throw new Error(`Ollama generate error: ${response.statusText}`);
      }

      const data = (await response.json()) as { response?: string };
      return data.response || '';
    } catch (error) {
      this.logger.error(`Error generating raw completion: ${error}`);
      throw error;
    }
  }

  /**
   * Check if Ollama server is healthy
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * List available models
   */
  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) {
        throw new Error(`Failed to list models: ${response.statusText}`);
      }
      const data = (await response.json()) as { models?: Array<{ name: string }> };
      return data.models?.map(m => m.name) || [];
    } catch (error) {
      this.logger.error(`Error listing models: ${error}`);
      throw error;
    }
  }

  /**
   * Pull a model if not present
   */
  async pullModel(modelName: string): Promise<void> {
    this.logger.info(`Pulling model: ${modelName}`);

    try {
      const response = await fetch(`${this.baseUrl}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName }),
      });

      if (!response.ok) {
        throw new Error(`Failed to pull model: ${response.statusText}`);
      }

      // Stream the response to track progress
      const reader = response.body?.getReader();
      if (reader) {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const text = new TextDecoder().decode(value);
          const lines = text.split('\n').filter(Boolean);

          for (const line of lines) {
            try {
              const data = JSON.parse(line);
              if (data.status) {
                this.logger.info(`Pull progress: ${data.status}`);
              }
            } catch {
              // Ignore JSON parse errors in stream
            }
          }
        }
      }

      this.logger.info(`Model ${modelName} pulled successfully`);
    } catch (error) {
      this.logger.error(`Error pulling model: ${error}`);
      throw error;
    }
  }
}
