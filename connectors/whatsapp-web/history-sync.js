/**
 * WhatsApp History Sync — pulls ALL old messages from all chats and stores in PostgreSQL.
 * Run inside the whatsapp-connector container.
 */
const { Client, LocalAuth } = require('whatsapp-web.js');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://whatsappmcp:whatsappmcp_dgx_2026@postgres:5432/whatsappmcp';
const SESSION_PATH = process.env.SESSION_PATH || '/app/session-data';
const MESSAGES_PER_CHAT = parseInt(process.env.MESSAGES_PER_CHAT || '500', 10);

const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });

async function ensureConversation(chat) {
  await pool.query(
    `INSERT INTO conversations (id, name, is_group, participant_count, last_message_at, updated_at)
     VALUES ($1, $2, $3, $4, now(), now())
     ON CONFLICT (id) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, conversations.name),
       participant_count = EXCLUDED.participant_count,
       updated_at = now()`,
    [chat.id._serialized, chat.name || chat.id._serialized, chat.isGroup, chat.isGroup ? (chat.participants?.length || 0) : 2]
  );
}

async function ensureParticipant(contact) {
  const id = contact.id?._serialized || contact.id || 'unknown';
  await pool.query(
    `INSERT INTO participants (id, phone, name, push_name, last_seen)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (id) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, participants.name),
       push_name = COALESCE(EXCLUDED.push_name, participants.push_name),
       last_seen = now()`,
    [id, contact.number || null, contact.name || null, contact.pushname || null]
  );
}

async function storeMessage(msg, chatId) {
  const msgId = msg.id._serialized;
  const senderId = msg.author || msg.from;
  const timestamp = new Date(msg.timestamp * 1000);
  const direction = msg.fromMe ? 'OUTBOUND' : 'INBOUND';

  let messageType = 'TEXT';
  if (msg.hasMedia) {
    if (msg.type === 'image') messageType = 'IMAGE';
    else if (msg.type === 'video') messageType = 'VIDEO';
    else if (msg.type === 'audio' || msg.type === 'ptt') messageType = 'AUDIO';
    else if (msg.type === 'document') messageType = 'DOCUMENT';
    else if (msg.type === 'sticker') messageType = 'STICKER';
    else messageType = (msg.type || 'UNKNOWN').toUpperCase();
  }

  try {
    const result = await pool.query(
      `INSERT INTO messages (wa_message_id, conversation_id, sender_wa_id, wa_timestamp, direction, content, message_type, is_forwarded, platform, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'whatsapp', $9)
       ON CONFLICT (wa_message_id) DO NOTHING
       RETURNING id`,
      [msgId, chatId, senderId, timestamp, direction, msg.body || null, messageType, msg.isForwarded || false, JSON.stringify({
        hasMedia: msg.hasMedia,
        isStarred: msg.isStarred,
        isStatus: msg.isStatus,
        type: msg.type,
      })]
    );

    if (result.rows[0] && msg.hasMedia) {
      try {
        const media = await msg.downloadMedia();
        if (media) {
          await pool.query(
            `INSERT INTO attachments (message_id, file_type, mime_type, file_name, caption)
             VALUES ($1, $2, $3, $4, $5)`,
            [result.rows[0].id, messageType, media.mimetype, media.filename || null, msg.body || null]
          );
        }
      } catch (e) {
        // Media download may fail for old messages
      }
    }

    return result.rows[0]?.id || null;
  } catch (e) {
    if (!e.message.includes('duplicate')) {
      console.error(`  Error storing message: ${e.message}`);
    }
    return null;
  }
}

async function main() {
  console.log('=== WhatsApp History Sync ===');
  console.log(`Database: ${DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`Messages per chat: ${MESSAGES_PER_CHAT}`);

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    },
  });

  await new Promise((resolve, reject) => {
    client.on('ready', resolve);
    client.on('auth_failure', reject);
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for ready')), 60000);
    client.on('ready', () => clearTimeout(timeout));
    console.log('Connecting to WhatsApp...');
    client.initialize();
  });

  console.log('Connected!\n');

  const chats = await client.getChats();
  console.log(`Found ${chats.length} chats\n`);

  let totalMessages = 0;
  let totalChats = 0;
  let totalParticipants = new Set();

  for (const chat of chats) {
    const chatName = chat.name || chat.id._serialized;

    // Skip status broadcast
    if (chat.id._serialized === 'status@broadcast') continue;

    try {
      await ensureConversation(chat);

      // Fetch messages
      const messages = await chat.fetchMessages({ limit: MESSAGES_PER_CHAT });
      if (messages.length === 0) continue;

      let stored = 0;
      for (const msg of messages) {
        // Ensure sender exists
        const senderId = msg.author || msg.from;
        if (senderId) {
          totalParticipants.add(senderId);
          try {
            const contact = await msg.getContact();
            await ensureParticipant(contact);
          } catch (e) {
            await pool.query(
              `INSERT INTO participants (id) VALUES ($1) ON CONFLICT DO NOTHING`,
              [senderId]
            );
          }
        }

        const id = await storeMessage(msg, chat.id._serialized);
        if (id) stored++;
      }

      if (stored > 0) {
        console.log(`  ${chatName}: ${stored}/${messages.length} messages stored`);
        totalMessages += stored;
        totalChats++;
      }
    } catch (e) {
      console.error(`  ${chatName}: ERROR - ${e.message}`);
    }
  }

  // Update conversation last_message_at
  await pool.query(
    `UPDATE conversations c SET last_message_at = (
       SELECT max(wa_timestamp) FROM messages m WHERE m.conversation_id = c.id
     )`
  );

  console.log(`\n=== DONE ===`);
  console.log(`Chats processed: ${totalChats}`);
  console.log(`Messages stored: ${totalMessages}`);
  console.log(`Participants: ${totalParticipants.size}`);

  // Print final stats
  const stats = await pool.query('SELECT count(*) as total FROM messages');
  console.log(`Total messages in DB: ${stats.rows[0].total}`);

  await pool.end();
  await client.destroy();
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
