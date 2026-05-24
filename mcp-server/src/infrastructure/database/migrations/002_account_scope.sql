-- 002: account scoping for multi-account (personal / professional) support.
--
-- Strategy (see mcp-server/src/domain/account.ts): row ids for non-personal
-- accounts are namespaced as "<account>:<id>", so they remain globally unique
-- and the EXISTING PK / UNIQUE constraints stay valid. In particular we do NOT
-- drop messages_wa_message_id_key (it is referenced by the
-- whatsapp_message_keys.wa_message_id FK, so dropping it would fail).
--
-- The `account` column is a denormalized, indexed copy of the owning account,
-- used for fast read-side filtering. Existing rows default to 'personal' so no
-- backfill is required. Idempotent.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS account text NOT NULL DEFAULT 'personal';
ALTER TABLE participants  ADD COLUMN IF NOT EXISTS account text NOT NULL DEFAULT 'personal';
ALTER TABLE messages      ADD COLUMN IF NOT EXISTS account text NOT NULL DEFAULT 'personal';

CREATE INDEX IF NOT EXISTS idx_conversations_account ON conversations (account);
CREATE INDEX IF NOT EXISTS idx_messages_account      ON messages (account);
CREATE INDEX IF NOT EXISTS idx_participants_account  ON participants (account);
