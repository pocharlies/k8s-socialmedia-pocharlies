import { Pool } from 'pg';
import pino from 'pino';
import { EmbeddingService } from '../../application/embedding.service';

const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: { colorize: true },
  },
});

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://whatsappmcp:whatsappmcp_dev@localhost:5438/whatsappmcp';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'not-used';
const BATCH_SIZE = parseInt(process.env.BACKFILL_EMBEDDINGS_BATCH_SIZE || '100', 10);
const MAX_MESSAGES = parseInt(process.env.BACKFILL_EMBEDDINGS_MAX_MESSAGES || '0', 10);

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  const embeddingService = new EmbeddingService(OPENAI_API_KEY, pool, ENCRYPTION_KEY);
  let processed = 0;

  try {
    for (;;) {
      const remainingLimit = MAX_MESSAGES > 0 ? Math.max(0, MAX_MESSAGES - processed) : BATCH_SIZE;
      if (MAX_MESSAGES > 0 && remainingLimit === 0) break;
      const limit = Math.min(BATCH_SIZE, remainingLimit);

      const result = await pool.query(
        `SELECT m.id
         FROM messages m
         LEFT JOIN message_embeddings me ON me.message_id = m.id
         WHERE m.platform = 'whatsapp'
           AND m.content IS NOT NULL
           AND btrim(m.content) <> ''
           AND me.message_id IS NULL
         ORDER BY m.wa_timestamp ASC, m.id ASC
         LIMIT $1`,
        [limit]
      );

      if (!result.rows.length) break;

      for (const row of result.rows) {
        await embeddingService.processMessage(String(row.id));
        processed++;
      }

      logger.info(`Backfilled embeddings for ${processed} WhatsApp messages so far`);
    }

    logger.info(`Embedding backfill complete. processed=${processed}`);
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  logger.error(`Embedding backfill failed: ${error?.stack || error}`);
  process.exit(1);
});
