/**
 * Direct DB writer for WhatsApp messages.
 * Writes incoming messages directly to PostgreSQL, bypassing NATS/MCP.
 */
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://whatsappmcp:whatsappmcp_dgx_2026@postgres:5432/whatsappmcp';

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
    pool.on('error', error => {
      console.error('PostgreSQL idle client error:', error);
    });
  }
  return pool;
}

export interface MessageData {
  waMessageId: string;
  conversationId: string;
  senderWaId: string;
  waTimestamp: Date;
  direction: string;
  content: string | null;
  messageType: string;
  isForwarded: boolean;
  replyToWaId?: string;
  platform?: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationData {
  id: string;
  name: string;
  isGroup: boolean;
  participantCount: number;
  avatarUrl?: string;
}

export interface ParticipantData {
  id: string;
  phone?: string;
  name?: string;
  pushName?: string;
  profilePicUrl?: string;
}

export interface MessageKeyData {
  waMessageId: string;
  conversationId: string;
  remoteJid: string;
  fromMe: boolean;
  participantJid?: string;
  messageTimestampMs: number;
}

export interface HistorySyncState {
  conversationId: string;
  oldestMessageId: string | null;
  oldestTimestamp: Date | null;
  newestTimestamp: Date | null;
  totalImported: number;
  status: string;
  lastError: string | null;
  updatedAt: Date;
}

export async function ensureHistoryTables(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_message_keys (
      wa_message_id text PRIMARY KEY REFERENCES messages(wa_message_id) ON DELETE CASCADE,
      conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      remote_jid text NOT NULL,
      from_me boolean NOT NULL,
      participant_jid text,
      message_timestamp_ms bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_whatsapp_message_keys_conversation_oldest
    ON whatsapp_message_keys (conversation_id, message_timestamp_ms ASC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_sync_state (
      conversation_id text PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      oldest_message_id text,
      oldest_timestamp timestamptz,
      newest_timestamp timestamptz,
      total_imported bigint NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'pending',
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_whatsapp_sync_state_status
    ON whatsapp_sync_state (status, updated_at DESC)
  `);
}

export async function ensureConversation(data: ConversationData): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO conversations (id, name, is_group, participant_count, avatar_url, last_message_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (id) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, conversations.name),
       participant_count = EXCLUDED.participant_count,
       avatar_url = COALESCE(EXCLUDED.avatar_url, conversations.avatar_url),
       last_message_at = now(),
       updated_at = now()`,
    [data.id, data.name, data.isGroup, data.participantCount, data.avatarUrl || null]
  );
}

export async function ensureParticipant(data: ParticipantData): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO participants (id, phone, name, push_name, profile_pic_url, last_seen)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (id) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, participants.name),
       push_name = COALESCE(EXCLUDED.push_name, participants.push_name),
       profile_pic_url = COALESCE(EXCLUDED.profile_pic_url, participants.profile_pic_url),
       last_seen = now()`,
    [data.id, data.phone, data.name, data.pushName, data.profilePicUrl || null]
  );
}

/**
 * Helper: persist a profile picture URL post-hoc. Use this when the avatar
 * is fetched async (after ensureConversation/ensureParticipant has already
 * inserted the row) so we don't block message ingest on the network call.
 */
export async function setConversationAvatar(id: string, avatarUrl: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE conversations SET avatar_url = $2, updated_at = now() WHERE id = $1`,
    [id, avatarUrl]
  );
}

export async function setParticipantAvatar(id: string, profilePicUrl: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE participants SET profile_pic_url = $2, last_seen = now() WHERE id = $1`,
    [id, profilePicUrl]
  );
}

export async function getConversationAvatar(id: string): Promise<string | null> {
  const pool = getPool();
  const r = await pool.query(`SELECT avatar_url FROM conversations WHERE id = $1`, [id]);
  return r.rows[0]?.avatar_url || null;
}

export async function getParticipantAvatar(id: string): Promise<string | null> {
  const pool = getPool();
  const r = await pool.query(`SELECT profile_pic_url FROM participants WHERE id = $1`, [id]);
  return r.rows[0]?.profile_pic_url || null;
}

export async function storeMessage(data: MessageData): Promise<bigint | null> {
  const pool = getPool();
  try {
    const result = await pool.query(
      `INSERT INTO messages (wa_message_id, conversation_id, sender_wa_id, wa_timestamp, direction, content, message_type, is_forwarded, reply_to_message_id, platform, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (wa_message_id) DO NOTHING
       RETURNING id`,
      [
        data.waMessageId,
        data.conversationId,
        data.senderWaId,
        data.waTimestamp,
        data.direction,
        data.content,
        data.messageType,
        data.isForwarded,
        data.replyToWaId || null,
        data.platform || 'whatsapp',
        JSON.stringify(data.metadata || {}),
      ]
    );
    return result.rows[0]?.id || null;
  } catch (e) {
    console.error('Failed to store message:', e);
    return null;
  }
}

export async function storeAttachment(
  messageId: bigint,
  attachment: {
    fileType: string;
    mimeType?: string;
    fileName?: string;
    fileSize?: number;
    fileUrl?: string;
    caption?: string;
  }
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO attachments (message_id, file_type, mime_type, file_name, file_size, file_url, caption)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      messageId,
      attachment.fileType,
      attachment.mimeType,
      attachment.fileName,
      attachment.fileSize,
      attachment.fileUrl,
      attachment.caption,
    ]
  );
}

export async function storeMessageKey(data: MessageKeyData): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO whatsapp_message_keys
       (wa_message_id, conversation_id, remote_jid, from_me, participant_jid, message_timestamp_ms)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (wa_message_id) DO UPDATE SET
       conversation_id = EXCLUDED.conversation_id,
       remote_jid = EXCLUDED.remote_jid,
       from_me = EXCLUDED.from_me,
       participant_jid = EXCLUDED.participant_jid,
       message_timestamp_ms = EXCLUDED.message_timestamp_ms,
       updated_at = now()`,
    [
      data.waMessageId,
      data.conversationId,
      data.remoteJid,
      data.fromMe,
      data.participantJid || null,
      data.messageTimestampMs,
    ]
  );
}

export async function recordHistorySyncProgress(data: {
  conversationId: string;
  oldestMessageId?: string | null;
  oldestTimestamp?: Date | null;
  newestTimestamp?: Date | null;
  insertedCount?: number;
  status?: string;
  lastError?: string | null;
}): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO whatsapp_sync_state
       (conversation_id, oldest_message_id, oldest_timestamp, newest_timestamp, total_imported, status, last_error)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'pending'), $7)
     ON CONFLICT (conversation_id) DO UPDATE SET
       oldest_message_id = COALESCE(EXCLUDED.oldest_message_id, whatsapp_sync_state.oldest_message_id),
       oldest_timestamp = CASE
         WHEN EXCLUDED.oldest_timestamp IS NULL THEN whatsapp_sync_state.oldest_timestamp
         WHEN whatsapp_sync_state.oldest_timestamp IS NULL THEN EXCLUDED.oldest_timestamp
         ELSE LEAST(whatsapp_sync_state.oldest_timestamp, EXCLUDED.oldest_timestamp)
       END,
       newest_timestamp = CASE
         WHEN EXCLUDED.newest_timestamp IS NULL THEN whatsapp_sync_state.newest_timestamp
         WHEN whatsapp_sync_state.newest_timestamp IS NULL THEN EXCLUDED.newest_timestamp
         ELSE GREATEST(whatsapp_sync_state.newest_timestamp, EXCLUDED.newest_timestamp)
       END,
       total_imported = whatsapp_sync_state.total_imported + EXCLUDED.total_imported,
       status = COALESCE(EXCLUDED.status, whatsapp_sync_state.status),
       last_error = EXCLUDED.last_error,
       updated_at = now()`,
    [
      data.conversationId,
      data.oldestMessageId || null,
      data.oldestTimestamp || null,
      data.newestTimestamp || null,
      data.insertedCount || 0,
      data.status || null,
      data.lastError || null,
    ]
  );
}

export async function getHistorySyncStatus(limit: number = 200): Promise<HistorySyncState[]> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT conversation_id, oldest_message_id, oldest_timestamp, newest_timestamp,
            total_imported, status, last_error, updated_at
     FROM whatsapp_sync_state
     ORDER BY updated_at DESC
     LIMIT $1`,
    [limit]
  );
  return r.rows.map(row => ({
    conversationId: row.conversation_id,
    oldestMessageId: row.oldest_message_id,
    oldestTimestamp: row.oldest_timestamp,
    newestTimestamp: row.newest_timestamp,
    totalImported: Number(row.total_imported || 0),
    status: row.status,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  }));
}

export async function linkParticipantToConversation(
  conversationId: string,
  participantId: string
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO conversation_participants (conversation_id, participant_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [conversationId, participantId]
  );
}
