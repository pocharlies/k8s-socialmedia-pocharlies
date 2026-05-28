/**
 * Brain ingestion job — pushes WhatsApp/Telegram messages from Postgres into
 * the SkirmBrain RAG (push-ingest), one brain instance per account.
 *
 * Mapping: account 'personal' -> instance 'personal'; 'professional' -> 'skirmshop'.
 * Idempotent: the brain dedups by source_id (delete+upsert), and we keep a
 * keyset cursor per account in `brain_ingest_cursor` so we only push new rows.
 *
 * Run as a CronJob (every 5 min) via tsx:
 *   cd mcp-server && tsx src/jobs/brain-ingest.ts
 *
 * Env:
 *   DATABASE_URL          Postgres (whatsappmcp)
 *   BRAIN_URL             brain base url (default in-cluster service)
 *   BRAIN_API_KEY         X-API-Key for push-ingest (brain dashboard_api_key)
 *   BRAIN_INGEST_BATCH    rows per batch (default 500)
 *   BRAIN_INGEST_BACKFILL 'true' => on first run (no cursor) start from epoch
 *                         instead of now() — used for the one-off history backfill.
 *   BRAIN_INGEST_SINCE    ISO timestamp; with BACKFILL, lower bound to start from.
 *   BRAIN_INGEST_DRY_RUN  'true' => count + log only, no push, no cursor advance.
 */
import { Pool } from 'pg';
import pino from 'pino';

const logger = pino({ transport: { target: 'pino-pretty', options: { colorize: true } } });

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://whatsappmcp:whatsappmcp_dev@localhost:5438/whatsappmcp';
const BRAIN_URL =
  process.env.BRAIN_URL || 'http://skirmshop-brain.skirmshop-brain-prod.svc.cluster.local';
const BRAIN_API_KEY = process.env.BRAIN_API_KEY || '';
const BATCH = parseInt(process.env.BRAIN_INGEST_BATCH || '500', 10);
const BACKFILL = process.env.BRAIN_INGEST_BACKFILL === 'true';
const SINCE = process.env.BRAIN_INGEST_SINCE || '1970-01-01T00:00:00Z';
const DRY_RUN = process.env.BRAIN_INGEST_DRY_RUN === 'true';

const ACCOUNTS = ['personal', 'professional'] as const;
type Account = (typeof ACCOUNTS)[number];

const INSTANCE_BY_ACCOUNT: Record<Account, string> = {
  personal: 'personal',
  professional: 'skirmshop',
};

interface Cursor {
  last_created_at: string;
  last_id: string | null;
}

interface Row {
  id: string;
  wa_message_id: string;
  content: string;
  platform: string; // 'whatsapp' | 'telegram'
  account: string;
  direction: string;
  message_type: string;
  wa_timestamp: Date;
  created_at: Date;
  sender_wa_id: string | null;
  conversation_id: string;
  conversation_name: string | null;
}

interface BrainDoc {
  source_id: string;
  content: string;
  metadata: Record<string, unknown>;
}

async function ensureCursorTable(pool: Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS brain_ingest_cursor (
       account          text PRIMARY KEY,
       last_created_at  timestamptz NOT NULL,
       last_id          uuid,
       updated_at       timestamptz NOT NULL DEFAULT now()
     )`
  );
}

async function getCursor(pool: Pool, account: Account): Promise<Cursor | null> {
  const r = await pool.query(
    `SELECT last_created_at, last_id FROM brain_ingest_cursor WHERE account = $1`,
    [account]
  );
  if (r.rows.length === 0) return null;
  return { last_created_at: r.rows[0].last_created_at, last_id: r.rows[0].last_id };
}

async function setCursor(
  pool: Pool,
  account: Account,
  createdAt: Date | string,
  id: string | null
): Promise<void> {
  await pool.query(
    `INSERT INTO brain_ingest_cursor (account, last_created_at, last_id, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (account) DO UPDATE
       SET last_created_at = EXCLUDED.last_created_at,
           last_id = EXCLUDED.last_id,
           updated_at = now()`,
    [account, createdAt, id]
  );
}

function sourceId(platform: string, waMessageId: string): string {
  return platform === 'telegram' ? `tg:${waMessageId}` : `wa:${waMessageId}`;
}

async function fetchBatch(pool: Pool, account: Account, cursor: Cursor): Promise<Row[]> {
  // Keyset pagination on (created_at, id) so duplicate created_at can't skip rows.
  const r = await pool.query(
    `SELECT m.id, m.wa_message_id, m.content, m.platform, m.account, m.direction,
            m.message_type, m.wa_timestamp, m.created_at, m.sender_wa_id,
            m.conversation_id, c.name AS conversation_name
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.account = $1
        AND m.is_deleted = false
        AND m.content IS NOT NULL AND btrim(m.content) <> ''
        AND (m.created_at, m.id) > ($2::timestamptz, COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid))
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT $4`,
    [account, cursor.last_created_at, cursor.last_id, BATCH]
  );
  return r.rows as Row[];
}

async function pushToBrain(
  instance: string,
  adapter: string,
  documents: BrainDoc[]
): Promise<number> {
  const url = `${BRAIN_URL}/instances/${instance}/push-ingest`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(BRAIN_API_KEY ? { 'X-API-Key': BRAIN_API_KEY } : {}),
    },
    body: JSON.stringify({ adapter, documents }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(
      `brain push-ingest ${instance}/${adapter} -> ${resp.status}: ${text.slice(0, 300)}`
    );
  }
  const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  return Number(body.chunks_ingested ?? 0);
}

function toDoc(row: Row): BrainDoc {
  return {
    source_id: sourceId(row.platform, row.wa_message_id),
    content: row.content,
    metadata: {
      type: 'message',
      platform: row.platform,
      account: row.account,
      direction: row.direction,
      message_type: row.message_type,
      conversation_id: row.conversation_id,
      conversation_name: row.conversation_name,
      sender_wa_id: row.sender_wa_id,
      wa_timestamp:
        row.wa_timestamp instanceof Date
          ? row.wa_timestamp.toISOString()
          : String(row.wa_timestamp),
    },
  };
}

async function ingestAccount(pool: Pool, account: Account): Promise<void> {
  const instance = INSTANCE_BY_ACCOUNT[account];
  let cursor = await getCursor(pool, account);

  if (!cursor) {
    // First run for this account.
    if (BACKFILL) {
      cursor = { last_created_at: SINCE, last_id: null };
      logger.info({ account, since: SINCE }, 'no cursor — starting BACKFILL from SINCE');
    } else {
      const now = new Date();
      if (!DRY_RUN) await setCursor(pool, account, now, null);
      logger.info(
        { account, at: now.toISOString() },
        'no cursor — initialized to now(), skipping history'
      );
      return;
    }
  }

  let totalRows = 0;
  let totalChunks = 0;

  for (;;) {
    const rows = await fetchBatch(pool, account, cursor);
    if (rows.length === 0) break;

    // Group by platform — push-ingest takes one adapter per call.
    const byPlatform = new Map<string, BrainDoc[]>();
    for (const row of rows) {
      const adapter = row.platform === 'telegram' ? 'telegram' : 'whatsapp';
      const arr = byPlatform.get(adapter) ?? [];
      arr.push(toDoc(row));
      byPlatform.set(adapter, arr);
    }

    if (DRY_RUN) {
      for (const [adapter, docs] of byPlatform) {
        logger.info({ account, instance, adapter, docs: docs.length }, 'DRY_RUN would push');
      }
    } else {
      for (const [adapter, docs] of byPlatform) {
        const chunks = await pushToBrain(instance, adapter, docs);
        totalChunks += chunks;
      }
    }

    totalRows += rows.length;
    const last = rows[rows.length - 1];
    cursor = { last_created_at: last.created_at.toISOString(), last_id: last.id };
    if (!DRY_RUN) await setCursor(pool, account, cursor.last_created_at, cursor.last_id);

    if (rows.length < BATCH) break;
  }

  logger.info(
    { account, instance, rows: totalRows, chunks: totalChunks, dryRun: DRY_RUN },
    'account ingest done'
  );
}

async function main(): Promise<void> {
  if (!BRAIN_API_KEY && !DRY_RUN) {
    logger.warn('BRAIN_API_KEY not set — pushes will be unauthenticated (brain may reject)');
  }
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  try {
    await ensureCursorTable(pool);
    for (const account of ACCOUNTS) {
      await ingestAccount(pool, account);
    }
  } finally {
    await pool.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    logger.error({ err: String(err) }, 'brain-ingest failed');
    process.exit(1);
  });
