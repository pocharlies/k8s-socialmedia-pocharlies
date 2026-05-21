-- Unified Telegram Messages Migration
-- Moves data from telegram_messages -> messages/conversations/participants
BEGIN;

-- 1. Create conversations for each Telegram chat
INSERT INTO conversations (id, name, is_group, type, wa_chat_id, created_at, updated_at, last_message_at)
SELECT
  'tg_' || chat_id::text,
  chat_title,
  chat_type IN ('group', 'supergroup'),
  chat_type,
  'tg_' || chat_id::text,
  MIN(timestamp),
  MAX(timestamp),
  MAX(timestamp)
FROM telegram_messages
GROUP BY chat_id, chat_title, chat_type
ON CONFLICT (id) DO NOTHING;

-- 2. Create participants for each Telegram sender
INSERT INTO participants (id, name, first_seen, last_seen)
SELECT
  'tg_' || sender_id::text,
  MAX(sender_name),
  MIN(timestamp),
  MAX(timestamp)
FROM telegram_messages
WHERE sender_id IS NOT NULL
GROUP BY sender_id
ON CONFLICT (id) DO NOTHING;

-- 3. Link participants to conversations
INSERT INTO conversation_participants (conversation_id, participant_id)
SELECT DISTINCT
  'tg_' || chat_id::text,
  'tg_' || sender_id::text
FROM telegram_messages
WHERE sender_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- 4. Migrate all messages
INSERT INTO messages (
  wa_message_id, conversation_id, sender_wa_id, wa_timestamp,
  direction, content, message_type, is_forwarded,
  reply_to_message_id, platform, metadata, created_at
)
SELECT
  'tg_' || chat_id::text || '_' || telegram_message_id::text,
  'tg_' || chat_id::text,
  CASE WHEN sender_id IS NOT NULL THEN 'tg_' || sender_id::text ELSE NULL END,
  timestamp,
  UPPER(direction),
  content,
  UPPER(message_type),
  COALESCE(is_forwarded, false),
  CASE WHEN reply_to_message_id IS NOT NULL
       THEN 'tg_' || chat_id::text || '_' || reply_to_message_id::text
       ELSE NULL END,
  'telegram',
  jsonb_build_object(
    'telegram_chat_id', chat_id,
    'telegram_message_id', telegram_message_id,
    'chat_type', chat_type,
    'sender_name', sender_name,
    'media_file_path', media_file_path,
    'needs_transcription', COALESCE(needs_transcription, false),
    'transcription_status', transcription_status,
    'transcription_attempts', COALESCE(transcription_attempts, 0),
    'transcription_error', transcription_error
  ),
  created_at
FROM telegram_messages
ON CONFLICT (wa_message_id) DO NOTHING;

-- 5. Index for transcription worker queries
CREATE INDEX IF NOT EXISTS idx_messages_tg_transcription
ON messages ((metadata->>'transcription_status'))
WHERE platform = 'telegram'
  AND (metadata->>'needs_transcription')::text = 'true';

-- 6. Backup old table (don't drop yet)
ALTER TABLE telegram_messages RENAME TO telegram_messages_backup;

COMMIT;
