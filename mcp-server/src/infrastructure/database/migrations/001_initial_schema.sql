-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Conversations
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_chat_id VARCHAR(255) UNIQUE NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('INDIVIDUAL', 'GROUP')),
  name VARCHAR(500),
  avatar_url TEXT,
  last_message_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  metadata JSONB
);

CREATE INDEX idx_conversations_wa_chat_id ON conversations(wa_chat_id);
CREATE INDEX idx_conversations_last_message_at ON conversations(last_message_at DESC);

-- Participants
CREATE TABLE participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  wa_user_id VARCHAR(255) NOT NULL,
  name VARCHAR(500),
  is_admin BOOLEAN DEFAULT FALSE,
  joined_at TIMESTAMP DEFAULT NOW(),
  left_at TIMESTAMP,
  UNIQUE(conversation_id, wa_user_id)
);

CREATE INDEX idx_participants_conversation ON participants(conversation_id);
CREATE INDEX idx_participants_wa_user_id ON participants(wa_user_id);

-- Messages
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  wa_message_id VARCHAR(255) NOT NULL,
  wa_timestamp TIMESTAMP NOT NULL,
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  sender_id UUID REFERENCES participants(id),
  sender_wa_id VARCHAR(255) NOT NULL,
  content TEXT,  -- Encrypted at application level
  content_hash VARCHAR(64) NOT NULL,  -- SHA256
  message_type VARCHAR(20) NOT NULL,
  is_forwarded BOOLEAN DEFAULT FALSE,
  is_edited BOOLEAN DEFAULT FALSE,
  edited_at TIMESTAMP,
  is_deleted BOOLEAN DEFAULT FALSE,
  deleted_at TIMESTAMP,
  reply_to_message_id UUID REFERENCES messages(id),
  raw_payload BYTEA,  -- Encrypted
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(conversation_id, wa_message_id)
);

CREATE INDEX idx_messages_conversation_time ON messages(conversation_id, wa_timestamp DESC);
CREATE INDEX idx_messages_wa_message_id ON messages(wa_message_id);
CREATE INDEX idx_messages_content_hash ON messages(content_hash);
CREATE INDEX idx_messages_sender ON messages(sender_wa_id);
CREATE INDEX idx_messages_reply_to ON messages(reply_to_message_id);
CREATE INDEX idx_messages_fts ON messages USING gin(to_tsvector('english', content));

-- Attachments
CREATE TABLE attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL,
  mime_type VARCHAR(100),
  file_name VARCHAR(500),
  file_size BIGINT,
  storage_key VARCHAR(500) NOT NULL,
  thumbnail_key VARCHAR(500),
  duration INTEGER,
  width INTEGER,
  height INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_attachments_message ON attachments(message_id);
CREATE INDEX idx_attachments_storage_key ON attachments(storage_key);

-- Message Embeddings (pgvector)
CREATE TABLE message_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  embedding vector(1536) NOT NULL,
  model VARCHAR(100) NOT NULL,
  chunk_index INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_message_embeddings_vector ON message_embeddings 
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_message_embeddings_message ON message_embeddings(message_id);

-- Draft Replies
CREATE TABLE draft_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  reply_to_message_id UUID REFERENCES messages(id),
  content TEXT NOT NULL,
  tone VARCHAR(50),
  language VARCHAR(2) NOT NULL CHECK (language IN ('EN', 'ES')),
  constraints JSONB,
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'SENT', 'REJECTED')),
  send_token UUID UNIQUE,
  approved_at TIMESTAMP,
  sent_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  created_by VARCHAR(255)
);

CREATE INDEX idx_draft_replies_conversation ON draft_replies(conversation_id);
CREATE INDEX idx_draft_replies_status ON draft_replies(status);
CREATE INDEX idx_draft_replies_send_token ON draft_replies(send_token);
