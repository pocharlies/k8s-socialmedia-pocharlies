// This file is for the background ingestion service
// The MCP server entry point is in src/mcp/index.ts

import { createServer } from 'node:http';
import { Pool } from 'pg';
import { EventConsumers } from './infrastructure/events/consumers';
import { MessageIngestionService } from './application/message-ingestion.service';
import { InstagramIngestionService } from './application/instagram-ingestion.service';
import { EmbeddingJob } from './infrastructure/jobs/embedding-job';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://whatsappmcp:whatsappmcp_dev@localhost:5432/whatsappmcp';
const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222';
const NATS_CA_CERT = process.env.NATS_CA_CERT;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'dev-encryption-key-change-in-production';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const PORT = parseInt(process.env.PORT || '3000', 10);

async function main() {
  const dbPool = new Pool({
    connectionString: DATABASE_URL,
    max: 30,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    application_name: 'mcp-server',
  } as any);
  await dbPool.query('SELECT 1');
  console.log('Connected to database (pool max=30, statement_timeout=10s)');

  // Create ingestion services
  const ingestionService = new MessageIngestionService(dbPool, ENCRYPTION_KEY);
  const instagramService = new InstagramIngestionService(dbPool);

  // Create event consumers with TLS support
  const consumers = new EventConsumers(NATS_URL, ingestionService, NATS_CA_CERT, instagramService);
  await consumers.connect();

  const healthServer = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'mcp-server-ingestion' }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });
  healthServer.listen(PORT, () => {
    console.log(`Ingestion health endpoint listening on port ${PORT}`);
  });

  // Start embedding job only if OPENAI_API_KEY is configured
  let embeddingJob: EmbeddingJob | null = null;
  if (OPENAI_API_KEY) {
    embeddingJob = new EmbeddingJob(NATS_URL, dbPool, OPENAI_API_KEY, ENCRYPTION_KEY, NATS_CA_CERT);
    await embeddingJob.start();
    console.log('Embedding pipeline started (OpenAI)');
  } else {
    console.log('OPENAI_API_KEY not set - embedding pipeline disabled');
  }

  console.log('MCP Server message ingestion pipeline started');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down...`);
    if (embeddingJob) await embeddingJob.stop();
    await consumers.disconnect();
    await dbPool.end();
    healthServer.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
