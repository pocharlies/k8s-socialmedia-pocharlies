import { Pool } from 'pg';
import Redis, { RedisOptions } from 'ioredis';
import * as fs from 'fs';
import { MCPServer } from './server';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://whatsappmcp:whatsappmcp_dev@localhost:5432/whatsappmcp';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const REDIS_TLS_CA = process.env.REDIS_TLS_CA;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const LLM_BASE_URL = process.env.LLM_BASE_URL || '';
const LLM_CHAT_MODEL = process.env.LLM_CHAT_MODEL || '';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'dev-encryption-key-change-in-production';
const CONNECTOR_SHARED_SECRET =
  process.env.CONNECTOR_SHARED_SECRET || 'dev-secret-change-in-production';
const CONNECTOR_URL = process.env.CONNECTOR_URL || 'http://whatsapp-connector:3001';

async function main() {
  try {
    const dbPool = new Pool({
      connectionString: DATABASE_URL,
      max: 30,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
      application_name: 'mcp-stdio',
    } as any);
    await dbPool.query('SELECT 1');
    console.log('Connected to database (pool max=30, statement_timeout=10s)');

    // Connect to Redis with TLS if configured
    let redisOptions: RedisOptions = {};

    if (REDIS_URL.startsWith('rediss://') && REDIS_TLS_CA) {
      const ca = fs.readFileSync(REDIS_TLS_CA, 'utf-8');
      redisOptions = {
        tls: {
          ca: ca,
          rejectUnauthorized: true,
        },
      };
    }

    const redisClient = new Redis(REDIS_URL, redisOptions);
    console.log('Connected to Redis' + (REDIS_TLS_CA ? ' with TLS' : ''));

    // Create MCP server
    const server = new MCPServer(
      dbPool,
      redisClient,
      OPENAI_API_KEY,
      ENCRYPTION_KEY,
      CONNECTOR_SHARED_SECRET,
      CONNECTOR_URL,
      LLM_BASE_URL || undefined,
      LLM_CHAT_MODEL || undefined
    );

    // Run server
    await server.run();

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      console.log(`${signal} received, shutting down MCP server...`);
      await dbPool.end();
      await redisClient.quit();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (error) {
    console.error('Failed to start MCP server:', error);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
