import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { SearchService } from '../application/search.service';
import { SummarizationService } from '../application/summarization.service';
import { DraftService } from '../application/draft.service';
import { DatabaseRepository } from '../infrastructure/database/repository';
import { ConversationType } from '../domain/entities/conversation.entity';
import { generateHMACSignature } from '@mcp-socialmedia/shared';
import { accountKey, normalizeAccount, stripAccount, type Account } from '../domain/account';
import { createHmac } from 'crypto';
import { t } from '../infrastructure/i18n/i18n';
import pino from 'pino';

const ACCOUNT_DESCRIPTION =
  "Account to route this call to. 'personal' (default) = WhatsApp web (Baileys, personal number) + Telegram paxanguero. " +
  "'professional' = WhatsApp web (Baileys, business number) + Telegram sauvageadminbot (skirmshop). " +
  'Choose based on the destination chat: skirmshop/business chats → professional; family/personal chats → personal. ' +
  'When the destination is ambiguous, prefer "professional" for Claude/Codex agents.';

const ACCOUNT_PROPERTY = {
  account: {
    type: 'string',
    enum: ['personal', 'professional'],
    description: ACCOUNT_DESCRIPTION,
    default: 'personal',
  },
} as const;

export class MCPServer {
  private server: Server;
  private searchService: SearchService;
  private summarizationService: SummarizationService;
  private draftService: DraftService;
  private repository: DatabaseRepository;
  private dbClient: Pool;
  private logger: pino.Logger;
  private connectorUrl: string;
  private telegramUrl: string;
  private telegramBridgeUrl: string;
  private telegramBridgeSecret: string;
  private instagramUrl: string;
  private connectorSecret: string;
  // Per-account connector routing (personal / professional).
  private waUrls!: Record<string, string>;
  private tgUrls!: Record<string, string>;
  private tgBridgeUrls!: Record<string, string>;

  constructor(
    dbClient: Pool,
    redisClient: Redis,
    openaiApiKey: string,
    encryptionKey: string,
    _connectorSharedSecret: string,
    _connectorUrl: string,
    llmBaseUrl?: string,
    llmModel?: string
  ) {
    this.server = new Server(
      {
        name: 'messaging-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.dbClient = dbClient;
    this.repository = new DatabaseRepository(dbClient);
    this.searchService = new SearchService(openaiApiKey, dbClient, encryptionKey, llmBaseUrl);
    this.summarizationService = new SummarizationService(
      openaiApiKey,
      dbClient,
      redisClient.options.host || 'localhost',
      encryptionKey,
      llmBaseUrl,
      llmModel
    );
    this.draftService = new DraftService(
      openaiApiKey,
      dbClient,
      encryptionKey,
      llmBaseUrl,
      llmModel
    );

    this.connectorUrl = _connectorUrl || 'http://whatsapp-connector:3001';
    this.telegramUrl = process.env.TELEGRAM_CONNECTOR_URL || 'http://telegram-connector:3002';
    this.telegramBridgeUrl = process.env.TELEGRAM_BRIDGE_URL || 'http://telegram-sync:3080';
    this.telegramBridgeSecret = process.env.TELEGRAM_BRIDGE_SECRET || 'telegram-bridge-secret-2026';
    this.instagramUrl = process.env.INSTAGRAM_CONNECTOR_URL || 'http://instagram-connector:3003';
    this.connectorSecret = _connectorSharedSecret;

    // Account routing. Both WhatsApp accounts are separate Baileys (WhatsApp
    // Web) connector instances, each linked to its own number/session.
    // Telegram: two separate connector instances too.
    this.waUrls = {
      personal: process.env.WHATSAPP_PERSONAL_URL || this.connectorUrl,
      professional:
        process.env.WHATSAPP_PROFESSIONAL_URL || 'http://whatsapp-connector-professional:3001',
    };
    this.tgUrls = {
      personal: process.env.TELEGRAM_PERSONAL_URL || this.telegramUrl,
      professional:
        process.env.TELEGRAM_PROFESSIONAL_URL || 'http://telegram-connector-professional:3002',
    };
    // Telethon bridge (live unread) is per-account, served by each telegram-sync instance.
    this.tgBridgeUrls = {
      personal: this.telegramBridgeUrl,
      professional:
        process.env.TELEGRAM_BRIDGE_PROFESSIONAL_URL || 'http://telegram-sync-professional:3080',
    };

    this.logger = pino({
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    });

    this.setupHandlers();
  }

  /** WhatsApp connector URL for an account (both are Baileys/WhatsApp Web). */
  private waUrl(account?: string): string {
    return this.waUrls[account === 'professional' ? 'professional' : 'personal'];
  }

  /** Telegram connector URL for an account (separate instance per account). */
  private tgUrl(account?: string): string {
    return this.tgUrls[account === 'professional' ? 'professional' : 'personal'];
  }

  /** Telegram-sync (Telethon) bridge URL for an account — used by live unread. */
  private tgBridgeUrl(account?: string): string {
    return this.tgBridgeUrls[account === 'professional' ? 'professional' : 'personal'];
  }

  private setupHandlers(): void {
    // List tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'search_messages',
            description:
              'Search messages by keyword or semantic query, scoped to the selected account.',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search query (keyword or semantic)' },
                chatId: { type: 'string', description: 'Optional: filter by conversation ID' },
                from: { type: 'string', format: 'date-time', description: 'Start date' },
                to: { type: 'string', format: 'date-time', description: 'End date' },
                sender: { type: 'string', description: 'Filter by sender WhatsApp ID' },
                limit: { type: 'integer', default: 20, maximum: 100 },
                ...ACCOUNT_PROPERTY,
              },
              required: ['query'],
            },
          },
          {
            name: 'get_chat',
            description: 'Get conversation details and recent messages.',
            inputSchema: {
              type: 'object',
              properties: {
                chatId: { type: 'string', description: 'Conversation ID' },
                ...ACCOUNT_PROPERTY,
              },
              required: ['chatId'],
            },
          },
          {
            name: 'whatsapp_get_messages',
            description:
              'Get paginated WhatsApp messages for a conversation, including old imported history',
            inputSchema: {
              type: 'object',
              properties: {
                chatId: { type: 'string', description: 'Conversation ID' },
                limit: { type: 'integer', default: 100, maximum: 500 },
                before: {
                  type: 'string',
                  description: 'Return messages before this ISO timestamp or message id',
                },
                after: {
                  type: 'string',
                  description: 'Return messages after this ISO timestamp or message id',
                },
                order: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
                includeMetadata: { type: 'boolean', default: false },
                includeAttachments: { type: 'boolean', default: true },
              },
              required: ['chatId'],
            },
          },
          {
            name: 'whatsapp_history_status',
            description: 'Show WhatsApp history import and Baileys backfill status',
            inputSchema: {
              type: 'object',
              properties: {
                chatId: { type: 'string', description: 'Optional conversation ID' },
                limit: { type: 'integer', default: 100, maximum: 500 },
              },
            },
          },
          {
            name: 'get_context',
            description: 'Get message context with surrounding messages',
            inputSchema: {
              type: 'object',
              properties: {
                chatId: { type: 'string' },
                messageId: { type: 'string' },
                windowBefore: { type: 'integer', default: 5 },
                windowAfter: { type: 'integer', default: 5 },
              },
              required: ['chatId', 'messageId'],
            },
          },
          {
            name: 'summarize_chat',
            description: 'Generate summary of a conversation',
            inputSchema: {
              type: 'object',
              properties: {
                chatId: { type: 'string' },
                range: {
                  type: 'object',
                  properties: {
                    from: { type: 'string', format: 'date-time' },
                    to: { type: 'string', format: 'date-time' },
                  },
                },
                style: { type: 'string', enum: ['brief', 'detailed', 'bullet'], default: 'brief' },
                language: { type: 'string', enum: ['en', 'es'], default: 'en' },
              },
              required: ['chatId'],
            },
          },
          {
            name: 'summarize_day',
            description: 'Summarize all conversations for a specific day',
            inputSchema: {
              type: 'object',
              properties: {
                date: { type: 'string', format: 'date' },
                scope: { type: 'string', enum: ['all', 'important'], default: 'all' },
                language: { type: 'string', enum: ['en', 'es'], default: 'en' },
              },
              required: ['date'],
            },
          },
          {
            name: 'summarize_week',
            description: 'Summarize all conversations for a week',
            inputSchema: {
              type: 'object',
              properties: {
                weekStartDate: { type: 'string', format: 'date' },
                scope: { type: 'string', enum: ['all', 'important'], default: 'all' },
                language: { type: 'string', enum: ['en', 'es'], default: 'en' },
              },
              required: ['weekStartDate'],
            },
          },
          {
            name: 'draft_reply',
            description: 'Draft a reply to a message or conversation',
            inputSchema: {
              type: 'object',
              properties: {
                chatId: { type: 'string' },
                messageId: { type: 'string', description: 'Reply to specific message' },
                lastN: { type: 'integer', description: 'Or reply to last N messages' },
                tone: {
                  type: 'string',
                  enum: ['professional', 'casual', 'friendly', 'formal'],
                  default: 'casual',
                },
                language: { type: 'string', enum: ['en', 'es'], default: 'en' },
                constraints: {
                  type: 'object',
                  properties: {
                    maxLength: { type: 'integer' },
                    requiredTopics: { type: 'array', items: { type: 'string' } },
                    avoidTopics: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
              required: ['chatId'],
            },
          },
          {
            name: 'list_drafts',
            description: 'List draft replies for a conversation',
            inputSchema: {
              type: 'object',
              properties: {
                chatId: { type: 'string' },
                status: {
                  type: 'string',
                  enum: ['DRAFT', 'APPROVED', 'SENT'],
                  description: 'Filter by status',
                },
              },
              required: ['chatId'],
            },
          },
          {
            name: 'approve_draft',
            description: 'Approve a draft reply and generate send token',
            inputSchema: {
              type: 'object',
              properties: {
                draftId: { type: 'string' },
              },
              required: ['draftId'],
            },
          },
          {
            name: 'send_approved_reply',
            description: 'Send an approved reply (requires feature flag)',
            inputSchema: {
              type: 'object',
              properties: {
                sendToken: { type: 'string' },
              },
              required: ['sendToken'],
            },
          },
          {
            name: 'whatsapp_send_message',
            description:
              'Send a WhatsApp message directly (no draft flow). Routes by `account`: personal = WhatsApp web (Baileys, personal number), professional = WhatsApp web (Baileys, skirmshop business number).',
            inputSchema: {
              type: 'object',
              properties: {
                chatId: { type: 'string', description: 'Chat/conversation ID' },
                text: { type: 'string', description: 'Message text to send' },
                ...ACCOUNT_PROPERTY,
              },
              required: ['chatId', 'text'],
            },
          },
          {
            name: 'renew_qr_code',
            description: 'Disconnect WhatsApp and generate a new QR code for re-authentication.',
            inputSchema: {
              type: 'object',
              properties: {
                confirmDisconnect: {
                  type: 'boolean',
                  description: 'Must be true to confirm disconnection',
                },
                ...ACCOUNT_PROPERTY,
              },
              required: ['confirmDisconnect'],
            },
          },
          {
            name: 'get_connection_status',
            description: 'Get WhatsApp connection status and QR code availability.',
            inputSchema: {
              type: 'object',
              properties: { ...ACCOUNT_PROPERTY },
            },
          },
          {
            name: 'search_users',
            description: 'Buscar usuarios de WhatsApp por nombre o teléfono.',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Nombre o número de teléfono a buscar' },
                limit: {
                  type: 'integer',
                  default: 20,
                  maximum: 100,
                  description: 'Número máximo de resultados',
                },
                ...ACCOUNT_PROPERTY,
              },
              required: ['query'],
            },
          },
          {
            name: 'list_conversations',
            description: 'Listar conversaciones con filtros opcionales.',
            inputSchema: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['INDIVIDUAL', 'GROUP'],
                  description: 'Filtrar por tipo de conversación',
                },
                query: {
                  type: 'string',
                  description: 'Buscar por nombre de conversación o participante',
                },
                limit: {
                  type: 'integer',
                  default: 20,
                  maximum: 100,
                  description: 'Número máximo de resultados',
                },
                includeParticipants: {
                  type: 'boolean',
                  default: true,
                  description: 'Incluir lista de participantes',
                },
                ...ACCOUNT_PROPERTY,
              },
            },
          },
          {
            name: 'get_user_messages',
            description: 'Obtener mensajes de un usuario específico.',
            inputSchema: {
              type: 'object',
              properties: {
                waUserId: {
                  type: 'string',
                  description: 'WhatsApp ID del usuario (ej: 34612345678@s.whatsapp.net)',
                },
                conversationId: {
                  type: 'string',
                  description: 'Filtrar por ID de conversación (opcional)',
                },
                from: {
                  type: 'string',
                  format: 'date-time',
                  description: 'Fecha de inicio (opcional)',
                },
                to: { type: 'string', format: 'date-time', description: 'Fecha de fin (opcional)' },
                limit: {
                  type: 'integer',
                  default: 50,
                  maximum: 200,
                  description: 'Número máximo de mensajes',
                },
                ...ACCOUNT_PROPERTY,
              },
              required: ['waUserId'],
            },
          },
          {
            name: 'download_media',
            description: 'Download media (photo/video/doc) from a WhatsApp message.',
            inputSchema: {
              type: 'object',
              properties: {
                chatId: { type: 'string', description: 'Chat/conversation ID' },
                messageId: { type: 'string', description: 'Message ID containing media' },
                ...ACCOUNT_PROPERTY,
              },
              required: ['chatId', 'messageId'],
            },
          },
          {
            name: 'send_file',
            description: 'Send a file/image/video via WhatsApp from a URL.',
            inputSchema: {
              type: 'object',
              properties: {
                conversationId: { type: 'string', description: 'Chat/conversation ID' },
                fileUrl: { type: 'string', description: 'URL of file to send' },
                caption: { type: 'string', description: 'Optional caption' },
                ...ACCOUNT_PROPERTY,
              },
              required: ['conversationId', 'fileUrl'],
            },
          },
          {
            name: 'forward_message',
            description: 'Forward a WhatsApp message to another chat.',
            inputSchema: {
              type: 'object',
              properties: {
                chatId: { type: 'string', description: 'Source chat ID' },
                messageId: { type: 'string', description: 'Message to forward' },
                toChatId: { type: 'string', description: 'Destination chat ID' },
                ...ACCOUNT_PROPERTY,
              },
              required: ['chatId', 'messageId', 'toChatId'],
            },
          },
          {
            name: 'delete_message',
            description: 'Delete a WhatsApp message (own messages only).',
            inputSchema: {
              type: 'object',
              properties: {
                chatId: { type: 'string', description: 'Chat ID' },
                messageId: { type: 'string', description: 'Message ID to delete' },
                ...ACCOUNT_PROPERTY,
              },
              required: ['chatId', 'messageId'],
            },
          },
          {
            name: 'get_me',
            description: 'Get authenticated WhatsApp account info.',
            inputSchema: { type: 'object', properties: { ...ACCOUNT_PROPERTY } },
          },
          {
            name: 'get_unread_chats',
            description: 'Get WhatsApp chats with unread messages.',
            inputSchema: { type: 'object', properties: { ...ACCOUNT_PROPERTY } },
          },
          {
            name: 'get_group_info',
            description: 'Get WhatsApp group details (name, description, participant count).',
            inputSchema: {
              type: 'object',
              properties: {
                groupId: { type: 'string', description: 'Group chat ID' },
                ...ACCOUNT_PROPERTY,
              },
              required: ['groupId'],
            },
          },
          {
            name: 'get_group_participants',
            description: 'Get WhatsApp group member list with admin status.',
            inputSchema: {
              type: 'object',
              properties: {
                groupId: { type: 'string', description: 'Group chat ID' },
                ...ACCOUNT_PROPERTY,
              },
              required: ['groupId'],
            },
          },
          {
            name: 'whatsapp_repair_group_session',
            description:
              'Refresh WhatsApp group metadata and Signal session state before sending to a group.',
            inputSchema: {
              type: 'object',
              properties: {
                groupId: { type: 'string', description: 'Group chat ID ending in @g.us' },
                ...ACCOUNT_PROPERTY,
              },
              required: ['groupId'],
            },
          },
          {
            name: 'mark_as_read',
            description:
              'Mark a WhatsApp chat as read by chatId (both accounts are Baileys/WhatsApp Web).',
            inputSchema: {
              type: 'object',
              properties: {
                chatId: { type: 'string', description: 'Chat ID to mark as read' },
                ...ACCOUNT_PROPERTY,
              },
              required: ['chatId'],
            },
          },
          {
            name: 'messaging_status',
            description:
              'Check health status of all messaging connectors (WhatsApp, Telegram, Instagram)',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'telegram_search',
            description:
              'Search Telegram messages globally or within a chat, scoped to the selected account.',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search query' },
                chatId: { type: 'string', description: 'Optional: restrict to specific chat' },
                limit: { type: 'integer', default: 20 },
                ...ACCOUNT_PROPERTY,
              },
              required: ['query'],
            },
          },
          {
            name: 'telegram_chat_info',
            description: 'Get Telegram chat/channel details.',
            inputSchema: {
              type: 'object',
              properties: {
                chatId: { type: 'string', description: 'Chat ID or @username' },
                ...ACCOUNT_PROPERTY,
              },
              required: ['chatId'],
            },
          },
          {
            name: 'telegram_participants',
            description: 'Get Telegram group/channel members.',
            inputSchema: {
              type: 'object',
              properties: {
                chatId: { type: 'string', description: 'Chat ID' },
                limit: { type: 'integer', default: 100 },
                ...ACCOUNT_PROPERTY,
              },
              required: ['chatId'],
            },
          },
          {
            name: 'telegram_send_message',
            description:
              'Send a text message in Telegram. Routes by `account`: personal = paxanguero session, professional = sauvageadminbot (skirmshop) session.',
            inputSchema: {
              type: 'object',
              properties: {
                chatId: { type: 'string', description: 'Telegram chat ID' },
                text: { type: 'string', description: 'Message text' },
                ...ACCOUNT_PROPERTY,
              },
              required: ['chatId', 'text'],
            },
          },
          {
            name: 'telegram_send_file',
            description: 'Send a file/photo/video in Telegram.',
            inputSchema: {
              type: 'object',
              properties: {
                chatId: { type: 'string', description: 'Telegram chat ID' },
                filePath: { type: 'string', description: 'URL or path of the file to send' },
                caption: { type: 'string', description: 'Optional caption' },
                voiceNote: { type: 'boolean', description: 'Send as voice note', default: false },
                ...ACCOUNT_PROPERTY,
              },
              required: ['chatId', 'filePath'],
            },
          },
          {
            name: 'telegram_get_messages',
            description: 'Get messages from a Telegram chat.',
            inputSchema: {
              type: 'object',
              properties: {
                chatId: { type: 'string', description: 'Telegram chat ID' },
                limit: { type: 'integer', default: 50, maximum: 200 },
                offsetId: { type: 'integer', description: 'Message ID to start from' },
                ...ACCOUNT_PROPERTY,
              },
              required: ['chatId'],
            },
          },
          {
            name: 'telegram_forward_message',
            description: 'Forward a Telegram message to another chat.',
            inputSchema: {
              type: 'object',
              properties: {
                fromChatId: { type: 'string', description: 'Source chat ID' },
                messageId: { type: 'string', description: 'Message ID to forward' },
                toChatId: { type: 'string', description: 'Destination chat ID' },
                ...ACCOUNT_PROPERTY,
              },
              required: ['fromChatId', 'messageId', 'toChatId'],
            },
          },
          {
            name: 'telegram_delete_message',
            description: 'Delete a Telegram message.',
            inputSchema: {
              type: 'object',
              properties: {
                chatId: { type: 'string', description: 'Chat ID' },
                messageId: { type: 'string', description: 'Message ID to delete' },
                ...ACCOUNT_PROPERTY,
              },
              required: ['chatId', 'messageId'],
            },
          },
          {
            name: 'telegram_mark_as_read',
            description: 'Mark a Telegram chat as read.',
            inputSchema: {
              type: 'object',
              properties: {
                chatId: { type: 'string', description: 'Chat ID to mark as read' },
                ...ACCOUNT_PROPERTY,
              },
              required: ['chatId'],
            },
          },
          {
            name: 'telegram_get_dialogs',
            description: 'List all Telegram chats/dialogs for the selected account.',
            inputSchema: {
              type: 'object',
              properties: { ...ACCOUNT_PROPERTY },
            },
          },
          {
            name: 'telegram_get_unread',
            description:
              'Get Telegram chats with unread messages (live state via Telethon bridge) for the selected account.',
            inputSchema: {
              type: 'object',
              properties: {
                limit: {
                  type: 'integer',
                  default: 200,
                  description: 'Max dialogs to scan (1-500)',
                },
                only_with_unread: {
                  type: 'boolean',
                  default: true,
                  description: 'If false, also return read dialogs (with unread_count=0)',
                },
                ...ACCOUNT_PROPERTY,
              },
            },
          },
          {
            name: 'telegram_download_media',
            description: 'Download media from a Telegram message.',
            inputSchema: {
              type: 'object',
              properties: {
                chatId: { type: 'string', description: 'Chat ID' },
                messageId: { type: 'string', description: 'Message ID containing media' },
                ...ACCOUNT_PROPERTY,
              },
              required: ['chatId', 'messageId'],
            },
          },
          {
            name: 'telegram_get_status',
            description: 'Get Telegram connection status for the selected account.',
            inputSchema: { type: 'object', properties: { ...ACCOUNT_PROPERTY } },
          },
          {
            name: 'telegram_get_me',
            description: 'Get authenticated Telegram account info for the selected account.',
            inputSchema: { type: 'object', properties: { ...ACCOUNT_PROPERTY } },
          },
          {
            name: 'instagram_get_profile',
            description:
              'Get Instagram account profile (followers, bio, media count). Available accounts: skirmshop, barbelpapis',
            inputSchema: {
              type: 'object',
              properties: {
                account: {
                  type: 'string',
                  description: 'Account name: skirmshop or barbelpapis',
                  enum: ['skirmshop', 'barbelpapis'],
                },
              },
              required: ['account'],
            },
          },
          {
            name: 'instagram_get_media',
            description: 'Get recent Instagram posts with likes and comments count',
            inputSchema: {
              type: 'object',
              properties: {
                account: { type: 'string', enum: ['skirmshop', 'barbelpapis'] },
                limit: { type: 'integer', default: 25, maximum: 100 },
              },
              required: ['account'],
            },
          },
          {
            name: 'instagram_get_comments',
            description: 'Get comments on a specific Instagram post',
            inputSchema: {
              type: 'object',
              properties: {
                account: { type: 'string', enum: ['skirmshop', 'barbelpapis'] },
                mediaId: { type: 'string', description: 'Media/post ID' },
              },
              required: ['account', 'mediaId'],
            },
          },
          {
            name: 'instagram_reply_comment',
            description: 'Reply to a comment on an Instagram post',
            inputSchema: {
              type: 'object',
              properties: {
                account: { type: 'string', enum: ['skirmshop', 'barbelpapis'] },
                commentId: { type: 'string', description: 'Comment ID to reply to' },
                message: { type: 'string', description: 'Reply text' },
              },
              required: ['account', 'commentId', 'message'],
            },
          },
          {
            name: 'instagram_get_conversations',
            description: 'Get Instagram DM conversations with recent messages',
            inputSchema: {
              type: 'object',
              properties: {
                account: { type: 'string', enum: ['skirmshop', 'barbelpapis'] },
                limit: { type: 'integer', default: 20 },
              },
              required: ['account'],
            },
          },
          {
            name: 'instagram_send_dm',
            description: 'Send a direct message on Instagram',
            inputSchema: {
              type: 'object',
              properties: {
                account: { type: 'string', enum: ['skirmshop', 'barbelpapis'] },
                recipientId: { type: 'string', description: 'Instagram user ID of the recipient' },
                message: { type: 'string', description: 'Message text' },
              },
              required: ['account', 'recipientId', 'message'],
            },
          },
          {
            name: 'instagram_get_stories',
            description: 'Get active Instagram stories',
            inputSchema: {
              type: 'object',
              properties: {
                account: { type: 'string', enum: ['skirmshop', 'barbelpapis'] },
              },
              required: ['account'],
            },
          },
          {
            name: 'instagram_publish',
            description: 'Publish an image or reel to Instagram',
            inputSchema: {
              type: 'object',
              properties: {
                account: { type: 'string', enum: ['skirmshop', 'barbelpapis'] },
                imageUrl: { type: 'string', description: 'Public URL of the image/video' },
                caption: { type: 'string', description: 'Post caption' },
                mediaType: { type: 'string', enum: ['IMAGE', 'VIDEO'], default: 'IMAGE' },
              },
              required: ['account', 'imageUrl', 'caption'],
            },
          },
          {
            name: 'instagram_media_insights',
            description:
              'Get insights/metrics for an Instagram post (impressions, reach, engagement)',
            inputSchema: {
              type: 'object',
              properties: {
                account: { type: 'string', enum: ['skirmshop', 'barbelpapis'] },
                mediaId: { type: 'string', description: 'Media/post ID' },
              },
              required: ['account', 'mediaId'],
            },
          },
          {
            name: 'instagram_publish_carousel',
            description: 'Publish an Instagram carousel post (2-10 images/videos)',
            inputSchema: {
              type: 'object',
              properties: {
                account: { type: 'string', enum: ['skirmshop', 'barbelpapis'] },
                items: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Public URLs of media (2-10). MP4/MOV detected as video.',
                },
                caption: { type: 'string' },
              },
              required: ['account', 'items'],
            },
          },
          {
            name: 'instagram_publish_reel',
            description: 'Publish an Instagram reel (vertical short video)',
            inputSchema: {
              type: 'object',
              properties: {
                account: { type: 'string', enum: ['skirmshop', 'barbelpapis'] },
                videoUrl: { type: 'string', description: 'Public URL of video (MP4)' },
                caption: { type: 'string' },
                shareToFeed: { type: 'boolean', default: true },
              },
              required: ['account', 'videoUrl'],
            },
          },
          {
            name: 'instagram_publish_story',
            description: 'Publish an Instagram story (image or video)',
            inputSchema: {
              type: 'object',
              properties: {
                account: { type: 'string', enum: ['skirmshop', 'barbelpapis'] },
                imageUrl: { type: 'string' },
                videoUrl: { type: 'string' },
              },
              required: ['account'],
            },
          },
          {
            name: 'instagram_post_comment',
            description: 'Post a top-level comment on an Instagram media',
            inputSchema: {
              type: 'object',
              properties: {
                account: { type: 'string', enum: ['skirmshop', 'barbelpapis'] },
                mediaId: { type: 'string' },
                message: { type: 'string' },
              },
              required: ['account', 'mediaId', 'message'],
            },
          },
          {
            name: 'instagram_hide_comment',
            description: 'Hide or unhide an Instagram comment',
            inputSchema: {
              type: 'object',
              properties: {
                account: { type: 'string', enum: ['skirmshop', 'barbelpapis'] },
                commentId: { type: 'string' },
                hide: { type: 'boolean', default: true },
              },
              required: ['account', 'commentId'],
            },
          },
          {
            name: 'instagram_delete_comment',
            description: 'Delete an Instagram comment',
            inputSchema: {
              type: 'object',
              properties: {
                account: { type: 'string', enum: ['skirmshop', 'barbelpapis'] },
                commentId: { type: 'string' },
              },
              required: ['account', 'commentId'],
            },
          },
          {
            name: 'instagram_get_account_insights',
            description:
              'Get account-level Instagram insights (reach, profile_views, website_clicks, etc.)',
            inputSchema: {
              type: 'object',
              properties: {
                account: { type: 'string', enum: ['skirmshop', 'barbelpapis'] },
                metrics: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Metric names; defaults to reach,profile_views,website_clicks',
                },
                period: { type: 'string', enum: ['day', 'week', 'days_28'], default: 'day' },
              },
              required: ['account'],
            },
          },
          {
            name: 'instagram_get_account_pages',
            description:
              'List Facebook pages with linked IG Business accounts (requires Facebook Login EAA token)',
            inputSchema: {
              type: 'object',
              properties: {
                account: { type: 'string', enum: ['skirmshop', 'barbelpapis'] },
              },
              required: ['account'],
            },
          },
          {
            name: 'instagram_get_content_publishing_limit',
            description: 'Check the current Instagram content publishing quota usage / limit',
            inputSchema: {
              type: 'object',
              properties: {
                account: { type: 'string', enum: ['skirmshop', 'barbelpapis'] },
              },
              required: ['account'],
            },
          },
          {
            name: 'instagram_get_hashtag_media',
            description:
              'Get top or recent media for an Instagram hashtag id (use instagram_search_hashtag first to resolve the id)',
            inputSchema: {
              type: 'object',
              properties: {
                account: { type: 'string', enum: ['skirmshop', 'barbelpapis'] },
                hashtagId: { type: 'string' },
                mediaType: { type: 'string', enum: ['top', 'recent'], default: 'top' },
                limit: { type: 'integer', default: 25 },
              },
              required: ['account', 'hashtagId'],
            },
          },
          {
            name: 'instagram_search_hashtag',
            description: 'Resolve an Instagram hashtag name (with or without #) to its id',
            inputSchema: {
              type: 'object',
              properties: {
                account: { type: 'string', enum: ['skirmshop', 'barbelpapis'] },
                hashtag: {
                  type: 'string',
                  description: 'Hashtag name e.g. "airsoft" or "#airsoft"',
                },
              },
              required: ['account', 'hashtag'],
            },
          },
          {
            name: 'instagram_business_discovery',
            description:
              'Look up public profile info for another IG business account by username (requires Facebook Login EAA token)',
            inputSchema: {
              type: 'object',
              properties: {
                account: { type: 'string', enum: ['skirmshop', 'barbelpapis'] },
                username: { type: 'string' },
              },
              required: ['account', 'username'],
            },
          },
          {
            name: 'instagram_get_mentions',
            description:
              'Get media where the configured Instagram account has been tagged/mentioned',
            inputSchema: {
              type: 'object',
              properties: {
                account: { type: 'string', enum: ['skirmshop', 'barbelpapis'] },
                limit: { type: 'integer', default: 25 },
              },
              required: ['account'],
            },
          },
          {
            name: 'instagram_validate_access_token',
            description: 'Verify whether the configured Instagram access token is still valid',
            inputSchema: {
              type: 'object',
              properties: {
                account: { type: 'string', enum: ['skirmshop', 'barbelpapis'] },
              },
              required: ['account'],
            },
          },
          {
            name: 'instagram_get_conversation_messages',
            description: 'List messages within an Instagram DM conversation',
            inputSchema: {
              type: 'object',
              properties: {
                account: { type: 'string', enum: ['skirmshop', 'barbelpapis'] },
                conversationId: { type: 'string' },
                limit: { type: 'integer', default: 25 },
              },
              required: ['account', 'conversationId'],
            },
          },
        ],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async request => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'search_messages':
            return await this.handleSearchMessages(args as any);
          case 'get_chat':
            return await this.handleGetChat(args as any);
          case 'whatsapp_get_messages':
            return await this.handleWhatsAppGetMessages(args as any);
          case 'whatsapp_history_status':
            return await this.handleWhatsAppHistoryStatus(args as any);
          case 'get_context':
            return await this.handleGetContext(args as any);
          case 'summarize_chat':
            return await this.handleSummarizeChat(args as any);
          case 'summarize_day':
            return await this.handleSummarizeDay(args as any);
          case 'summarize_week':
            return await this.handleSummarizeWeek(args as any);
          case 'draft_reply':
            return await this.handleDraftReply(args as any);
          case 'list_drafts':
            return await this.handleListDrafts(args as any);
          case 'approve_draft':
            return await this.handleApproveDraft(args as any);
          case 'send_approved_reply':
            return await this.handleSendApprovedReply(args as any);
          case 'whatsapp_send_message':
            return await this.handleSendMessage(args as any);
          case 'renew_qr_code':
            return await this.handleRenewQRCode(args as any);
          case 'get_connection_status':
            return await this.handleGetConnectionStatus(args as any);
          case 'search_users':
            return await this.handleSearchUsers(args as any);
          case 'list_conversations':
            return await this.handleListConversations(args as any);
          case 'get_user_messages':
            return await this.handleGetUserMessages(args as any);
          case 'download_media':
            return await this.handleDownloadMedia(args as any);
          case 'send_file':
            return await this.handleSendFile(args as any);
          case 'forward_message':
            return await this.handleForwardMessage(args as any);
          case 'delete_message':
            return await this.handleDeleteMessage(args as any);
          case 'get_me':
            return await this.handleGetMe(args as any);
          case 'get_unread_chats':
            return await this.handleGetUnreadChats(args as any);
          case 'get_group_info':
            return await this.handleGetGroupInfo(args as any);
          case 'get_group_participants':
            return await this.handleGetGroupParticipants(args as any);
          case 'whatsapp_repair_group_session':
            return await this.handleRepairGroupSession(args as any);
          case 'mark_as_read':
            return await this.handleMarkAsRead(args as any);
          case 'messaging_status':
            return await this.handleMessagingStatus();
          case 'telegram_search':
            return await this.handleTelegramSearch(args as any);
          case 'telegram_chat_info':
            return await this.handleTelegramChatInfo(args as any);
          case 'telegram_participants':
            return await this.handleTelegramParticipants(args as any);
          case 'telegram_send_message':
            return await this.handleTelegramSendMessage(args as any);
          case 'telegram_send_file':
            return await this.handleTelegramSendFile(args as any);
          case 'telegram_get_messages':
            return await this.handleTelegramGetMessages(args as any);
          case 'telegram_forward_message':
            return await this.handleTelegramForwardMessage(args as any);
          case 'telegram_delete_message':
            return await this.handleTelegramDeleteMessage(args as any);
          case 'telegram_mark_as_read':
            return await this.handleTelegramMarkAsRead(args as any);
          case 'telegram_get_dialogs':
            return await this.handleTelegramGetDialogs(args as any);
          case 'telegram_get_unread':
            return await this.handleTelegramGetUnread(args as any);
          case 'telegram_download_media':
            return await this.handleTelegramDownloadMedia(args as any);
          case 'telegram_get_status':
            return await this.handleTelegramGetStatus(args as any);
          case 'telegram_get_me':
            return await this.handleTelegramGetMe(args as any);
          case 'instagram_get_profile':
            return await this.handleInstagramGetProfile(args as any);
          case 'instagram_get_media':
            return await this.handleInstagramGetMedia(args as any);
          case 'instagram_get_comments':
            return await this.handleInstagramGetComments(args as any);
          case 'instagram_reply_comment':
            return await this.handleInstagramReplyComment(args as any);
          case 'instagram_get_conversations':
            return await this.handleInstagramGetConversations(args as any);
          case 'instagram_send_dm':
            return await this.handleInstagramSendDm(args as any);
          case 'instagram_get_stories':
            return await this.handleInstagramGetStories(args as any);
          case 'instagram_publish':
            return await this.handleInstagramPublish(args as any);
          case 'instagram_media_insights':
            return await this.handleInstagramMediaInsights(args as any);
          case 'instagram_publish_carousel':
            return await this.handleInstagramPublishCarousel(args as any);
          case 'instagram_publish_reel':
            return await this.handleInstagramPublishReel(args as any);
          case 'instagram_publish_story':
            return await this.handleInstagramPublishStory(args as any);
          case 'instagram_post_comment':
            return await this.handleInstagramPostComment(args as any);
          case 'instagram_hide_comment':
            return await this.handleInstagramHideComment(args as any);
          case 'instagram_delete_comment':
            return await this.handleInstagramDeleteComment(args as any);
          case 'instagram_get_account_insights':
            return await this.handleInstagramGetAccountInsights(args as any);
          case 'instagram_get_account_pages':
            return await this.handleInstagramGetAccountPages(args as any);
          case 'instagram_get_content_publishing_limit':
            return await this.handleInstagramGetContentPublishingLimit(args as any);
          case 'instagram_get_hashtag_media':
            return await this.handleInstagramGetHashtagMedia(args as any);
          case 'instagram_search_hashtag':
            return await this.handleInstagramSearchHashtag(args as any);
          case 'instagram_business_discovery':
            return await this.handleInstagramBusinessDiscovery(args as any);
          case 'instagram_get_mentions':
            return await this.handleInstagramGetMentions(args as any);
          case 'instagram_validate_access_token':
            return await this.handleInstagramValidateAccessToken(args as any);
          case 'instagram_get_conversation_messages':
            return await this.handleInstagramGetConversationMessages(args as any);
          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (error) {
        this.logger.error(`Error handling tool ${name}: ${error}`);
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Error executing tool: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  private async handleSearchMessages(args: {
    query: string;
    chatId?: string;
    from?: string;
    to?: string;
    sender?: string;
    limit?: number;
    account?: string;
  }) {
    const results = await this.searchService.search(args.query, {
      chatId: args.chatId,
      from: args.from ? new Date(args.from) : undefined,
      to: args.to ? new Date(args.to) : undefined,
      sender: args.sender,
      limit: args.limit || 20,
      account: args.account,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              results: results.map(r => ({
                messageId: r.messageId,
                conversationId: r.conversationId,
                content: r.content,
                sender: r.senderWaId,
                timestamp: r.waTimestamp.toISOString(),
                similarity: r.similarity,
                rank: r.rank,
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleGetChat(args: { chatId: string; account?: string }) {
    const account = normalizeAccount(args.account);
    const chatId = accountKey(account, args.chatId);
    // conversations.id IS the wa_chat_id
    const convResult = await this.dbClient.query(`SELECT * FROM conversations WHERE id = $1`, [
      chatId,
    ]);

    let conversation;
    if (convResult.rows.length > 0) {
      const row = convResult.rows[0];
      conversation = {
        id: row.id,
        waChatId: row.wa_chat_id || row.id,
        type: row.type || (row.is_group ? 'GROUP' : 'INDIVIDUAL'),
        name: row.name,
      };
    } else {
      // Create if not found
      const conv = await this.repository.findOrCreateConversation(
        chatId,
        args.chatId.includes('@g.us') ? ConversationType.GROUP : ConversationType.INDIVIDUAL,
        null,
        null,
        account,
        args.chatId
      );
      conversation = {
        id: conv.id,
        waChatId: conv.waChatId,
        type: conv.type,
        name: conv.name,
      };
    }

    const messages = await this.dbClient.query(
      `SELECT * FROM messages
       WHERE conversation_id = $1
       ORDER BY wa_timestamp DESC
       LIMIT 50`,
      [chatId]
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              conversation,
              messages: messages.rows.map(row => ({
                id: row.id,
                content: row.content || null,
                sender: row.sender_wa_id,
                timestamp: row.wa_timestamp,
                messageType: row.message_type,
                direction: row.direction,
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async resolveWhatsAppCursor(
    chatId: string,
    cursor?: string
  ): Promise<{ timestamp: Date; id?: string } | null> {
    if (!cursor) return null;
    const parsed = new Date(cursor);
    if (!Number.isNaN(parsed.getTime())) return { timestamp: parsed };

    const result = await this.dbClient.query(
      `SELECT id, wa_timestamp
       FROM messages
       WHERE conversation_id = $1
         AND platform = 'whatsapp'
         AND (wa_message_id = $2 OR id::text = $2)
       LIMIT 1`,
      [chatId, cursor]
    );
    if (!result.rows.length) {
      throw new McpError(ErrorCode.InvalidRequest, `Cursor message not found: ${cursor}`);
    }
    return { timestamp: result.rows[0].wa_timestamp, id: String(result.rows[0].id) };
  }

  private async handleWhatsAppGetMessages(args: {
    chatId: string;
    limit?: number;
    before?: string;
    after?: string;
    order?: 'asc' | 'desc';
    includeMetadata?: boolean;
    includeAttachments?: boolean;
    account?: string;
  }) {
    const limit = Math.max(1, Math.min(args.limit || 100, 500));
    const order = args.order === 'asc' ? 'ASC' : 'DESC';
    const chatId = accountKey(normalizeAccount(args.account), args.chatId);
    const before = await this.resolveWhatsAppCursor(chatId, args.before);
    const after = await this.resolveWhatsAppCursor(chatId, args.after);

    const where = [`conversation_id = $1`, `platform = 'whatsapp'`];
    const params: any[] = [chatId];

    if (before) {
      params.push(before.timestamp);
      const tsParam = `$${params.length}`;
      if (before.id) {
        params.push(before.id);
        where.push(`(wa_timestamp, id) < (${tsParam}, $${params.length}::bigint)`);
      } else {
        where.push(`wa_timestamp < ${tsParam}`);
      }
    }
    if (after) {
      params.push(after.timestamp);
      const tsParam = `$${params.length}`;
      if (after.id) {
        params.push(after.id);
        where.push(`(wa_timestamp, id) > (${tsParam}, $${params.length}::bigint)`);
      } else {
        where.push(`wa_timestamp > ${tsParam}`);
      }
    }
    params.push(limit);

    const messages = await this.dbClient.query(
      `SELECT id, wa_message_id, conversation_id, sender_wa_id, wa_timestamp,
              direction, content, message_type, is_forwarded, reply_to_message_id,
              platform, metadata
       FROM messages
       WHERE ${where.join(' AND ')}
       ORDER BY wa_timestamp ${order}, id ${order}
       LIMIT $${params.length}`,
      params
    );

    const attachmentMap = new Map<string, any[]>();
    if (args.includeAttachments !== false && messages.rows.length) {
      const ids = messages.rows.map(row => row.id);
      const attachments = await this.dbClient.query(
        `SELECT message_id, file_type, mime_type, file_name, file_size, file_url, caption
         FROM attachments
         WHERE message_id = ANY($1::bigint[])
         ORDER BY id ASC`,
        [ids]
      );
      for (const row of attachments.rows) {
        const key = String(row.message_id);
        const list = attachmentMap.get(key) || [];
        list.push({
          fileType: row.file_type,
          mimeType: row.mime_type,
          fileName: row.file_name,
          fileSize: row.file_size,
          fileUrl: row.file_url,
          caption: row.caption,
        });
        attachmentMap.set(key, list);
      }
    }

    const rows = messages.rows.map(row => ({
      id: row.id,
      waMessageId: row.wa_message_id,
      conversationId: row.conversation_id,
      sender: row.sender_wa_id,
      timestamp: row.wa_timestamp,
      direction: row.direction,
      content: row.content || null,
      messageType: row.message_type,
      isForwarded: row.is_forwarded,
      replyToWaId: row.reply_to_message_id,
      attachments: attachmentMap.get(String(row.id)) || [],
      ...(args.includeMetadata ? { metadata: row.metadata || {} } : {}),
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              chatId: args.chatId,
              order: args.order || 'desc',
              limit,
              count: rows.length,
              nextBefore: rows.length ? rows[rows.length - 1].waMessageId : null,
              nextAfter: rows.length ? rows[0].waMessageId : null,
              messages: rows,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleWhatsAppHistoryStatus(args: { chatId?: string; limit?: number }) {
    const limit = Math.max(1, Math.min(args.limit || 100, 500));
    const tableStatus = await this.dbClient.query(
      `SELECT
         to_regclass('public.whatsapp_sync_state') AS sync_table,
         to_regclass('public.whatsapp_message_keys') AS key_table`
    );
    const hasSyncState = !!tableStatus.rows[0]?.sync_table;
    const hasMessageKeys = !!tableStatus.rows[0]?.key_table;

    const stateSelect = hasSyncState
      ? `s.status AS sync_status,
         s.oldest_message_id,
         s.oldest_timestamp,
         s.newest_timestamp,
         s.total_imported,
         s.last_error,
         s.updated_at AS sync_updated_at`
      : `NULL::text AS sync_status,
         NULL::text AS oldest_message_id,
         NULL::timestamptz AS oldest_timestamp,
         NULL::timestamptz AS newest_timestamp,
         0::bigint AS total_imported,
         NULL::text AS last_error,
         NULL::timestamptz AS sync_updated_at`;
    const stateJoin = hasSyncState
      ? `LEFT JOIN whatsapp_sync_state s ON s.conversation_id = c.id`
      : '';
    const keySelect = hasMessageKeys
      ? `(SELECT count(*) FROM whatsapp_message_keys k WHERE k.conversation_id = c.id) AS persisted_keys`
      : `0::bigint AS persisted_keys`;

    const params: any[] = [];
    const filter = args.chatId ? `AND c.id = $1` : '';
    if (args.chatId) params.push(args.chatId);
    params.push(limit);

    const status = await this.dbClient.query(
      `SELECT
         c.id AS conversation_id,
         c.name,
         count(m.id) AS message_count,
         min(m.wa_timestamp) AS oldest_message_at,
         max(m.wa_timestamp) AS newest_message_at,
         count(*) FILTER (WHERE m.metadata->>'source' = 'ios_backup_import') AS ios_backup_messages,
         count(*) FILTER (WHERE m.metadata->>'source' = 'baileys_history_sync') AS baileys_history_messages,
         count(*) FILTER (WHERE m.metadata->>'source' = 'live' OR m.metadata->>'source' IS NULL) AS live_messages,
         ${keySelect},
         ${stateSelect}
       FROM conversations c
       JOIN messages m ON m.conversation_id = c.id AND m.platform = 'whatsapp'
       ${stateJoin}
       WHERE 1 = 1 ${filter}
       GROUP BY c.id, c.name${hasSyncState ? ', s.status, s.oldest_message_id, s.oldest_timestamp, s.newest_timestamp, s.total_imported, s.last_error, s.updated_at' : ''}
       ORDER BY max(m.wa_timestamp) DESC
       LIMIT $${params.length}`,
      params
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              historyTables: {
                syncState: hasSyncState,
                messageKeys: hasMessageKeys,
              },
              conversations: status.rows.map(row => ({
                conversationId: row.conversation_id,
                name: row.name,
                messageCount: Number(row.message_count || 0),
                oldestMessageAt: row.oldest_message_at,
                newestMessageAt: row.newest_message_at,
                sources: {
                  iosBackupImport: Number(row.ios_backup_messages || 0),
                  baileysHistorySync: Number(row.baileys_history_messages || 0),
                  live: Number(row.live_messages || 0),
                },
                persistedKeys: Number(row.persisted_keys || 0),
                sync: {
                  status: row.sync_status,
                  oldestMessageId: row.oldest_message_id,
                  oldestTimestamp: row.oldest_timestamp,
                  newestTimestamp: row.newest_timestamp,
                  totalImported: Number(row.total_imported || 0),
                  lastError: row.last_error,
                  updatedAt: row.sync_updated_at,
                },
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleGetContext(args: {
    chatId: string;
    messageId: string;
    windowBefore?: number;
    windowAfter?: number;
  }) {
    const windowBefore = args.windowBefore || 5;
    const windowAfter = args.windowAfter || 5;

    const message = await this.dbClient.query(`SELECT * FROM messages WHERE id = $1`, [
      args.messageId,
    ]);

    if (message.rows.length === 0) {
      throw new McpError(ErrorCode.InvalidRequest, t('errors.MESSAGE_NOT_FOUND'));
    }

    // conversations.id IS the chatId directly
    const context = await this.dbClient.query(
      `(SELECT * FROM messages
        WHERE conversation_id = $1
          AND wa_timestamp < (SELECT wa_timestamp FROM messages WHERE id = $2)
        ORDER BY wa_timestamp DESC
        LIMIT $3)
       UNION ALL
       (SELECT * FROM messages WHERE id = $2)
       UNION ALL
       (SELECT * FROM messages
        WHERE conversation_id = $1
          AND wa_timestamp > (SELECT wa_timestamp FROM messages WHERE id = $2)
        ORDER BY wa_timestamp ASC
        LIMIT $4)
       ORDER BY wa_timestamp ASC`,
      [args.chatId, args.messageId, windowBefore, windowAfter]
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              context: context.rows.map(row => ({
                id: row.id,
                content: row.content || null,
                sender: row.sender_wa_id,
                timestamp: row.wa_timestamp,
                messageType: row.message_type,
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleSummarizeChat(args: {
    chatId: string;
    range?: { from?: string; to?: string };
    style?: 'brief' | 'detailed' | 'bullet';
    language?: 'en' | 'es';
  }) {
    const summary = await this.summarizationService.summarizeChat(args.chatId, {
      style: args.style || 'brief',
      language: args.language || 'en',
      range: args.range
        ? {
            from: args.range.from ? new Date(args.range.from) : undefined,
            to: args.range.to ? new Date(args.range.to) : undefined,
          }
        : undefined,
    });

    return {
      content: [
        {
          type: 'text',
          text: summary,
        },
      ],
    };
  }

  private async handleSummarizeDay(args: {
    date: string;
    scope?: 'all' | 'important';
    language?: 'en' | 'es';
  }) {
    const summary = await this.summarizationService.summarizeDay(
      new Date(args.date),
      args.scope || 'all',
      args.language || 'en'
    );

    return {
      content: [
        {
          type: 'text',
          text: summary,
        },
      ],
    };
  }

  private async handleSummarizeWeek(args: {
    weekStartDate: string;
    scope?: 'all' | 'important';
    language?: 'es' | 'en';
  }) {
    const summary = await this.summarizationService.summarizeWeek(
      new Date(args.weekStartDate),
      args.scope || 'all',
      args.language || 'en'
    );

    return {
      content: [
        {
          type: 'text',
          text: summary,
        },
      ],
    };
  }

  private async handleDraftReply(args: {
    chatId: string;
    messageId?: string;
    lastN?: number;
    tone?: 'professional' | 'casual' | 'friendly' | 'formal';
    language?: 'en' | 'es';
    constraints?: {
      maxLength?: number;
      requiredTopics?: string[];
      avoidTopics?: string[];
    };
  }) {
    const draft = await this.draftService.createDraft(
      args.chatId,
      {
        tone: args.tone || 'casual',
        language: args.language || 'en',
        constraints: args.constraints,
      },
      args.messageId,
      args.lastN
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              draftId: draft.id,
              content: draft.content,
              status: draft.status,
              createdAt: draft.createdAt.toISOString(),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleListDrafts(args: { chatId: string; status?: 'DRAFT' | 'APPROVED' | 'SENT' }) {
    const drafts = await this.draftService.listDrafts(args.chatId, args.status);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              drafts: drafts.map(d => ({
                id: d.id,
                content: d.content,
                status: d.status,
                createdAt: d.createdAt.toISOString(),
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleApproveDraft(args: { draftId: string }) {
    const sendToken = await this.draftService.approveDraft(args.draftId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              sendToken,
              message: t('messages.draft_approved'),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleSendApprovedReply(args: { sendToken: string }) {
    if (process.env.ENABLE_SENDING !== 'true') {
      throw new McpError(ErrorCode.InvalidRequest, t('errors.SENDING_DISABLED'));
    }

    if (process.env.EMERGENCY_DISABLE_SENDING === 'true') {
      throw new McpError(ErrorCode.InvalidRequest, t('errors.SENDING_DISABLED'));
    }

    // Extract draft ID from send token (format: send-{id}-{timestamp})
    const parts = args.sendToken.split('-');
    const draftId = parts[1];

    const draft = await this.draftService.getDraftById(draftId);
    if (!draft) {
      throw new McpError(ErrorCode.InvalidRequest, t('errors.INVALID_SEND_TOKEN'));
    }

    if (draft.status !== 'APPROVED') {
      throw new McpError(ErrorCode.InvalidRequest, t('errors.DRAFT_NOT_FOUND'));
    }

    // conversations.id IS the wa_chat_id
    const conversationId = draft.conversationId;

    // Call connector API to send message
    const connectorUrl = process.env.CONNECTOR_URL || 'http://whatsapp-connector:3001';
    const sharedSecret = process.env.CONNECTOR_SHARED_SECRET || '';
    const timestamp = Math.floor(Date.now() / 1000);
    const body = {
      sendToken: args.sendToken,
      conversationId,
      content: draft.content,
    };

    const signature = generateHMACSignature(body, timestamp, sharedSecret);

    try {
      const response = await fetch(`${connectorUrl}/api/v1/messages/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Connector-Signature': signature,
          'X-Connector-Timestamp': timestamp.toString(),
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Failed to send message: ${response.statusText}`);
      }

      await this.draftService.markAsSent(draftId);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                message: t('messages.draft_sent'),
                sentAt: new Date().toISOString(),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      this.logger.error(`Error sending message: ${error}`);
      throw new McpError(ErrorCode.InternalError, `Failed to send message: ${error}`);
    }
  }

  private async handleSendMessage(args: { chatId: string; text: string; account?: string }) {
    if (process.env.ENABLE_SENDING !== 'true') {
      throw new McpError(ErrorCode.InvalidRequest, 'Sending is disabled (ENABLE_SENDING != true)');
    }
    if (process.env.EMERGENCY_DISABLE_SENDING === 'true') {
      throw new McpError(ErrorCode.InvalidRequest, 'Sending is emergency disabled');
    }

    const connectorUrl = this.waUrl(args.account);
    const sharedSecret = process.env.CONNECTOR_SHARED_SECRET || '';
    const timestamp = Math.floor(Date.now() / 1000);
    const body = {
      sendToken: `direct-${Date.now()}`,
      conversationId: args.chatId,
      content: args.text,
    };

    const signature = generateHMACSignature(body, timestamp, sharedSecret);

    try {
      const response = await fetch(`${connectorUrl}/api/v1/messages/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Connector-Signature': signature,
          'X-Connector-Timestamp': timestamp.toString(),
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorPayload = await this.readConnectorError(response);
        const failure = errorPayload.failureClass ? ` (${errorPayload.failureClass})` : '';
        const actionable = errorPayload.actionable ? ` - ${errorPayload.actionable}` : '';
        throw new Error(
          `Connector returned ${response.status}${failure}: ${errorPayload.error || response.statusText}${actionable}`
        );
      }

      const result = (await response.json()) as Record<string, unknown>;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                message: 'Message sent',
                messageId: result.messageId || null,
                sentAt: result.sentAt || new Date().toISOString(),
                chatId: args.chatId,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      this.logger.error(`Error sending message: ${error}`);
      throw new McpError(ErrorCode.InternalError, `Failed to send message: ${error}`);
    }
  }

  private async readConnectorError(response: Response): Promise<Record<string, any>> {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return { error: text || response.statusText };
    }
  }

  private async handleRenewQRCode(args: { confirmDisconnect?: boolean; account?: string }) {
    if (!args.confirmDisconnect) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'You must set confirmDisconnect to true to renew QR code. This will disconnect WhatsApp.'
      );
    }

    const connectorUrl = this.waUrl(args.account);
    const sharedSecret = process.env.CONNECTOR_SHARED_SECRET || '';

    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const body = { action: 'logout' };
      const signature = generateHMACSignature(body, timestamp, sharedSecret);

      const response = await fetch(`${connectorUrl}/api/v1/auth/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Connector-Signature': signature,
          'X-Connector-Timestamp': timestamp.toString(),
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Failed to logout: ${response.statusText}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                message:
                  'WhatsApp disconnected successfully. New QR code will be generated shortly.',
                instructions: `Visit https://whatsapp.e-dani.com/ to scan the new QR code.`,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      this.logger.error(`Error renewing QR code: ${error}`);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to renew QR code: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleGetConnectionStatus(args?: { account?: string }) {
    const connectorUrl = this.waUrl(args?.account);

    try {
      const response = await fetch(`${connectorUrl}/api/v1/health`);

      if (!response.ok) {
        throw new Error(`Failed to get status: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        status: string;
        connected: boolean;
        qrAvailable: boolean;
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: data.status,
                connected: data.connected,
                qrAvailable: data.qrAvailable,
                message: data.connected
                  ? 'WhatsApp is connected'
                  : data.qrAvailable
                    ? 'QR code is available for scanning'
                    : 'WhatsApp is disconnected. Use renew_qr_code to generate a new QR.',
                qrUrl: 'https://whatsapp.e-dani.com/',
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      this.logger.error(`Error getting connection status: ${error}`);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get connection status: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleSearchUsers(args: { query: string; limit?: number; account?: string }) {
    const results = await this.repository.searchParticipants(
      args.query,
      args.limit || 20,
      normalizeAccount(args.account)
    );

    const usersMap = new Map<
      string,
      {
        waUserId: string;
        displayName: string;
        conversations: { id: string; waChatId: string; type: string; name: string | null }[];
      }
    >();

    for (const result of results) {
      if (!usersMap.has(result.waUserId)) {
        usersMap.set(result.waUserId, {
          waUserId: result.waUserId,
          displayName: result.displayName,
          conversations: [],
        });
      }
      usersMap.get(result.waUserId)!.conversations.push({
        id: result.conversationId,
        waChatId: result.waChatId,
        type: result.conversationType,
        name: result.conversationName,
      });
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              query: args.query,
              totalResults: usersMap.size,
              users: Array.from(usersMap.values()),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleListConversations(args: {
    type?: 'INDIVIDUAL' | 'GROUP';
    query?: string;
    limit?: number;
    includeParticipants?: boolean;
    account?: string;
  }) {
    const conversations = await this.repository.listConversations({
      type: args.type,
      query: args.query,
      limit: args.limit || 20,
      includeParticipants: args.includeParticipants !== false,
      account: args.account,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              totalResults: conversations.length,
              filters: {
                type: args.type || 'all',
                query: args.query || null,
              },
              conversations: conversations.map(conv => ({
                id: conv.id,
                waChatId: conv.waChatId,
                type: conv.type,
                name: conv.name,
                lastMessageAt: conv.lastMessageAt?.toISOString() || null,
                messageCount: conv.messageCount,
                participants: conv.participants,
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleGetUserMessages(args: {
    waUserId: string;
    conversationId?: string;
    from?: string;
    to?: string;
    limit?: number;
    account?: string;
  }) {
    const account = normalizeAccount(args.account);
    const userInfo = await this.repository.getUserInfo(args.waUserId, account);

    const messages = await this.repository.getMessagesByUser(
      args.waUserId,
      {
        conversationId: args.conversationId,
        from: args.from ? new Date(args.from) : undefined,
        to: args.to ? new Date(args.to) : undefined,
        limit: args.limit || 50,
      },
      account
    );

    // No decryption needed - content is plaintext
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              user: userInfo
                ? {
                    waUserId: userInfo.waUserId,
                    names: userInfo.names,
                    conversationCount: userInfo.conversationCount,
                    totalMessageCount: userInfo.messageCount,
                    lastSeen: userInfo.lastSeen?.toISOString() || null,
                  }
                : {
                    waUserId: args.waUserId,
                    names: [],
                    conversationCount: 0,
                    totalMessageCount: 0,
                    lastSeen: null,
                  },
              filters: {
                conversationId: args.conversationId || null,
                from: args.from || null,
                to: args.to || null,
              },
              messagesReturned: messages.length,
              messages: messages.map(msg => ({
                id: msg.id,
                conversationId: msg.conversationId,
                waChatId: msg.waChatId,
                conversationName: msg.conversationName,
                waMessageId: msg.waMessageId,
                content: msg.content || null,
                messageType: msg.messageType,
                timestamp: msg.waTimestamp.toISOString(),
                isForwarded: msg.isForwarded,
                isEdited: msg.isEdited,
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleTelegramSendMessage(args: {
    chatId: string;
    text: string;
    account?: string;
  }) {
    const data = await this.connectorCall(
      this.tgUrl(args.account),
      'POST',
      `/api/v1/messages/${args.chatId}`,
      { text: args.text }
    );
    return this.jsonResponse(data);
  }

  private async handleTelegramSendFile(args: {
    chatId: string;
    filePath: string;
    caption?: string;
    voiceNote?: boolean;
    account?: string;
  }) {
    const data = await this.connectorCall(
      this.tgUrl(args.account),
      'POST',
      '/api/v1/messages/media/send',
      {
        chatId: args.chatId,
        filePath: args.filePath,
        caption: args.caption,
        voiceNote: args.voiceNote || false,
      }
    );
    return this.jsonResponse(data);
  }

  /**
   * Normalize a user-provided Telegram chat identifier to the DB form `tg_<id>`.
   * Accepts `tg_xxx` (returned as-is), bare numeric ids like `-1003749364241`
   * or `1629757854` (prefixed), or `@username` (resolved via DB metadata).
   */
  private async resolveTelegramChatId(
    chatId: string,
    account: Account = 'personal'
  ): Promise<string | null> {
    if (chatId.startsWith('tg_')) return accountKey(account, chatId);
    if (/^-?\d+$/.test(chatId)) return accountKey(account, `tg_${chatId}`);
    if (chatId.startsWith('@')) {
      const username = chatId.slice(1).toLowerCase();
      const r = await this.dbClient.query(
        `SELECT id FROM conversations WHERE id LIKE $2 AND lower(metadata->>'username') = $1 LIMIT 1`,
        [username, accountKey(account, 'tg_') + '%']
      );
      return r.rows[0]?.id ?? null;
    }
    return null;
  }

  private async handleTelegramGetMessages(args: {
    chatId: string;
    limit?: number;
    offsetId?: number;
    account?: string;
  }) {
    const id = await this.resolveTelegramChatId(args.chatId, normalizeAccount(args.account));
    if (!id)
      throw new McpError(
        ErrorCode.InvalidParams,
        `Could not resolve Telegram chatId '${args.chatId}'. Use 'tg_<numeric>' or numeric id.`
      );
    const limit = Math.min(args.limit ?? 50, 500);
    const params: any[] = [id, limit];
    let where = `conversation_id = $1`;
    if (args.offsetId) {
      params.push(args.offsetId);
      where += ` AND id < $3`;
    }
    const result = await this.dbClient.query(
      `SELECT id, conversation_id, sender_wa_id, direction, content, message_type,
              wa_timestamp, is_forwarded, is_edited, is_deleted, reply_to_message_id, metadata
         FROM messages
        WHERE ${where}
        ORDER BY wa_timestamp DESC
        LIMIT $2`,
      params
    );
    return this.jsonResponse({
      source: 'db',
      chatId: id,
      count: result.rows.length,
      messages: result.rows.map((m: any) => ({
        id: m.id,
        conversationId: m.conversation_id,
        senderId: m.sender_wa_id,
        direction: m.direction,
        content: m.content,
        type: m.message_type,
        timestamp: m.wa_timestamp,
        forwarded: m.is_forwarded,
        edited: m.is_edited,
        deleted: m.is_deleted,
        replyTo: m.reply_to_message_id,
        metadata: m.metadata,
      })),
    });
  }

  private async handleTelegramForwardMessage(args: {
    fromChatId: string;
    messageId: string;
    toChatId: string;
    account?: string;
  }) {
    const data = await this.connectorCall(
      this.tgUrl(args.account),
      'POST',
      '/api/v1/messages/forward',
      {
        fromChatId: args.fromChatId,
        messageId: args.messageId,
        toChatId: args.toChatId,
      }
    );
    return this.jsonResponse(data);
  }

  private async handleTelegramDeleteMessage(args: {
    chatId: string;
    messageId: string;
    account?: string;
  }) {
    const data = await this.connectorCall(
      this.tgUrl(args.account),
      'DELETE',
      `/api/v1/messages/${args.chatId}/${args.messageId}`
    );
    return this.jsonResponse(data);
  }

  private async handleTelegramMarkAsRead(args: { chatId: string; account?: string }) {
    const data = await this.connectorCall(
      this.tgUrl(args.account),
      'POST',
      `/api/v1/messages/read/${args.chatId}`
    );
    return this.jsonResponse(data);
  }

  private async handleTelegramGetDialogs(args?: { account?: string }) {
    const account = normalizeAccount(args?.account);
    const result = await this.dbClient.query(
      `SELECT c.id, c.name, c.type, c.is_group, c.last_message_at, c.metadata,
              (SELECT count(*)::int FROM messages WHERE conversation_id = c.id) AS message_count
         FROM conversations c
        WHERE c.id LIKE $1
        ORDER BY c.last_message_at DESC NULLS LAST
        LIMIT 1000`,
      [accountKey(account, 'tg_') + '%']
    );
    return this.jsonResponse({
      source: 'db',
      count: result.rows.length,
      dialogs: result.rows.map((c: any) => ({
        id: c.id,
        chatId: stripAccount(c.id).id.replace(/^tg_/, ''),
        name: c.name,
        type: c.is_group ? 'group' : 'private',
        lastMessageAt: c.last_message_at,
        messageCount: c.message_count,
        username: c.metadata?.username ?? null,
      })),
    });
  }

  private async handleTelegramGetUnread(args?: {
    limit?: number;
    only_with_unread?: boolean;
    account?: string;
  }) {
    // Live unread state — fetched via telegram-sync (Telethon) over its
    // HMAC-authenticated bridge. The Node connector (gramJS) cannot read this
    // against current Telegram MTProto.
    const payload = {
      limit: Math.min(args?.limit ?? 200, 500),
      only_with_unread: args?.only_with_unread ?? true,
    };
    const body = JSON.stringify(payload);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', this.telegramBridgeSecret)
      .update(`${ts}:${body}`)
      .digest('hex');
    const resp = await fetch(`${this.tgBridgeUrl(args?.account)}/unread`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Timestamp': ts,
        'X-Bridge-Signature': sig,
      },
      body,
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      throw new Error(`telegram-sync /unread error ${resp.status}: ${await resp.text()}`);
    }
    return this.jsonResponse(await resp.json());
  }

  private async handleTelegramDownloadMedia(args: {
    chatId: string;
    messageId: string;
    account?: string;
  }) {
    const data = await this.connectorCall(
      this.tgUrl(args.account),
      'GET',
      `/api/v1/messages/media/${args.chatId}/${args.messageId}`
    );
    return this.jsonResponse(data);
  }

  private async handleTelegramGetStatus(args?: { account?: string }) {
    const data = await this.connectorCall(this.tgUrl(args?.account), 'GET', '/api/v1/status');
    return this.jsonResponse(data);
  }

  private async handleTelegramGetMe(args?: { account?: string }) {
    const data = await this.connectorCall(this.tgUrl(args?.account), 'GET', '/api/v1/me');
    return this.jsonResponse(data);
  }

  private async connectorCall(
    baseUrl: string,
    method: string,
    path: string,
    body?: any,
    timeoutMs = 15000
  ): Promise<any> {
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = body || {};
    const signature = generateHMACSignature(payload, timestamp, this.connectorSecret);

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Connector-Signature': signature,
        'X-Connector-Timestamp': timestamp.toString(),
      },
      ...(method !== 'GET' && method !== 'DELETE' ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Connector error ${response.status}: ${await response.text()}`);
    }
    return response.json();
  }

  private jsonResponse(data: any) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  }

  private async handleDownloadMedia(args: { chatId: string; messageId: string; account?: string }) {
    const data = await this.connectorCall(
      this.waUrl(args.account),
      'GET',
      `/api/v1/messages/media/${args.chatId}/${args.messageId}`
    );
    return this.jsonResponse(data);
  }

  private async handleSendFile(args: {
    conversationId: string;
    fileUrl: string;
    caption?: string;
    account?: string;
  }) {
    if (process.env.ENABLE_SENDING !== 'true') {
      throw new McpError(ErrorCode.InvalidRequest, 'Sending disabled');
    }
    const { account, ...body } = args;
    const data = await this.connectorCall(
      this.waUrl(account),
      'POST',
      '/api/v1/messages/media/send',
      body
    );
    return this.jsonResponse(data);
  }

  private async handleForwardMessage(args: {
    chatId: string;
    messageId: string;
    toChatId: string;
    account?: string;
  }) {
    if (process.env.ENABLE_SENDING !== 'true') {
      throw new McpError(ErrorCode.InvalidRequest, 'Sending disabled');
    }
    const { account, ...body } = args;
    const data = await this.connectorCall(
      this.waUrl(account),
      'POST',
      '/api/v1/messages/forward',
      body
    );
    return this.jsonResponse(data);
  }

  private async handleDeleteMessage(args: { chatId: string; messageId: string; account?: string }) {
    const data = await this.connectorCall(
      this.waUrl(args.account),
      'DELETE',
      `/api/v1/messages/${args.chatId}/${args.messageId}`
    );
    return this.jsonResponse(data);
  }

  private async handleGetMe(args?: { account?: string }) {
    const data = await this.connectorCall(this.waUrl(args?.account), 'GET', '/api/v1/me');
    return this.jsonResponse(data);
  }

  private async handleGetUnreadChats(args?: { account?: string }) {
    // The whatsapp-web.js connector enumerates every chat to compute unread —
    // can be slow on accounts with hundreds of chats. Cap at 8s so we don't
    // hang the SSE client; surface a clear error if the connector is too slow
    // (the user can fall back to list_conversations / get_user_messages).
    try {
      const data = await this.connectorCall(
        this.waUrl(args?.account),
        'GET',
        '/api/v1/chats/unread',
        undefined,
        8000
      );
      return this.jsonResponse(data);
    } catch (e: any) {
      const reason = e?.name === 'TimeoutError' ? 'timeout after 8s' : e?.message || String(e);
      throw new McpError(
        ErrorCode.InternalError,
        `get_unread_chats failed (${reason}). The whatsapp connector enumerates every chat — try list_conversations(limit=20) or get_user_messages for specific contacts instead.`
      );
    }
  }

  private async handleGetGroupInfo(args: { groupId: string; account?: string }) {
    const data = await this.connectorCall(
      this.waUrl(args.account),
      'GET',
      `/api/v1/groups/${args.groupId}/info`
    );
    return this.jsonResponse(data);
  }

  private async handleGetGroupParticipants(args: { groupId: string; account?: string }) {
    const data = await this.connectorCall(
      this.waUrl(args.account),
      'GET',
      `/api/v1/groups/${args.groupId}/participants`
    );
    return this.jsonResponse(data);
  }

  private async handleRepairGroupSession(args: { groupId: string; account?: string }) {
    const data = await this.connectorCall(
      this.waUrl(args.account),
      'POST',
      `/api/v1/groups/${args.groupId}/session/repair`,
      {},
      120000
    );
    return this.jsonResponse(data);
  }

  private async handleMarkAsRead(args: { chatId?: string; messageId?: string; account?: string }) {
    const account = normalizeAccount(args.account);
    // Both accounts are Baileys (WhatsApp Web): mark the whole chat read by chatId.
    if (!args.chatId) {
      throw new McpError(ErrorCode.InvalidParams, 'mark_as_read requires a chatId.');
    }
    const data = await this.connectorCall(
      this.waUrl(account),
      'POST',
      `/api/v1/messages/read/${args.chatId}`
    );
    return this.jsonResponse(data);
  }

  private async handleMessagingStatus() {
    const targets = [
      ['whatsapp', this.connectorUrl, '/api/v1/health'],
      ['telegram', this.telegramUrl, '/health'],
      [
        'instagram',
        process.env.INSTAGRAM_CONNECTOR_URL || 'http://instagram-connector:3003',
        '/health',
      ],
    ] as const;
    const checks = await Promise.all(
      targets.map(async ([name, url, endpoint]) => {
        try {
          const resp = await fetch(`${url}${endpoint}`, { signal: AbortSignal.timeout(3000) });
          const body = await resp.json();
          return [name, body] as const;
        } catch (e: any) {
          const reason = e?.name === 'TimeoutError' ? 'timeout after 3s' : e?.message || String(e);
          return [name, { status: 'unreachable', error: reason }] as const;
        }
      })
    );
    const results: any = {};
    for (const [name, body] of checks) results[name] = body;
    return this.jsonResponse(results);
  }

  private async handleTelegramSearch(args: {
    query: string;
    chatId?: string;
    limit?: number;
    account?: string;
  }) {
    const account = normalizeAccount(args.account);
    const limit = Math.min(args.limit ?? 20, 200);
    const params: any[] = [`%${args.query}%`, limit, account];
    let where = `platform = 'telegram' AND account = $3 AND content ILIKE $1`;
    if (args.chatId) {
      const id = await this.resolveTelegramChatId(args.chatId, account);
      if (!id)
        throw new McpError(
          ErrorCode.InvalidParams,
          `Could not resolve Telegram chatId '${args.chatId}'`
        );
      params.push(id);
      where += ` AND conversation_id = $4`;
    }
    const result = await this.dbClient.query(
      `SELECT id, conversation_id, sender_wa_id, direction, content, wa_timestamp
         FROM messages WHERE ${where}
        ORDER BY wa_timestamp DESC LIMIT $2`,
      params
    );
    return this.jsonResponse({
      source: 'db',
      query: args.query,
      count: result.rows.length,
      messages: result.rows.map((m: any) => ({
        id: m.id,
        conversationId: m.conversation_id,
        senderId: m.sender_wa_id,
        direction: m.direction,
        content: m.content,
        timestamp: m.wa_timestamp,
      })),
    });
  }

  private async handleTelegramChatInfo(args: { chatId: string; account?: string }) {
    const id = await this.resolveTelegramChatId(args.chatId, normalizeAccount(args.account));
    if (!id)
      throw new McpError(
        ErrorCode.InvalidParams,
        `Could not resolve Telegram chatId '${args.chatId}'`
      );
    const result = await this.dbClient.query(
      `SELECT id, name, type, is_group, participant_count, last_message_at, metadata,
              (SELECT count(*)::int FROM messages WHERE conversation_id = c.id) AS message_count
         FROM conversations c WHERE id = $1`,
      [id]
    );
    if (!result.rows.length)
      throw new McpError(ErrorCode.InvalidParams, `Telegram chat '${id}' not found in DB`);
    const c = result.rows[0];
    return this.jsonResponse({
      source: 'db',
      id: c.id,
      chatId: stripAccount(c.id).id.replace(/^tg_/, ''),
      name: c.name,
      type: c.is_group ? 'group' : 'private',
      participantCount: c.participant_count,
      lastMessageAt: c.last_message_at,
      messageCount: c.message_count,
      metadata: c.metadata,
    });
  }

  private async handleTelegramParticipants(args: {
    chatId: string;
    limit?: number;
    account?: string;
  }) {
    const id = await this.resolveTelegramChatId(args.chatId, normalizeAccount(args.account));
    if (!id)
      throw new McpError(
        ErrorCode.InvalidParams,
        `Could not resolve Telegram chatId '${args.chatId}'`
      );
    const limit = Math.min(args.limit ?? 100, 500);
    const result = await this.dbClient.query(
      `SELECT cp.participant_id, cp.role, p.name, p.push_name, p.phone, p.metadata
         FROM conversation_participants cp
         LEFT JOIN participants p ON p.id = cp.participant_id
        WHERE cp.conversation_id = $1
        LIMIT $2`,
      [id, limit]
    );
    return this.jsonResponse({
      source: 'db',
      chatId: id,
      count: result.rows.length,
      participants: result.rows.map((r: any) => ({
        id: r.participant_id,
        name: r.name || r.push_name,
        phone: r.phone,
        role: r.role,
        metadata: r.metadata,
      })),
    });
  }

  // === Instagram handlers ===

  private async instagramCall(method: string, path: string, body?: any, timeoutMs = 30000) {
    const url = `${this.instagramUrl}${path}`;
    const options: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body) options.body = JSON.stringify(body);
    const resp = await fetch(url, options);
    if (!resp.ok) throw new Error(`Instagram API error (${resp.status}): ${await resp.text()}`);
    return resp.json();
  }

  private async handleInstagramGetProfile(args: { account: string }) {
    const data = await this.instagramCall('GET', `/api/v1/${args.account}/profile`);
    return this.jsonResponse(data);
  }

  private async handleInstagramGetMedia(args: { account: string; limit?: number }) {
    const data = await this.instagramCall(
      'GET',
      `/api/v1/${args.account}/media?limit=${args.limit || 25}`
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramGetComments(args: { account: string; mediaId: string }) {
    const data = await this.instagramCall(
      'GET',
      `/api/v1/${args.account}/media/${args.mediaId}/comments`
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramReplyComment(args: {
    account: string;
    commentId: string;
    message: string;
  }) {
    const data = await this.instagramCall(
      'POST',
      `/api/v1/${args.account}/comments/${args.commentId}/reply`,
      { message: args.message }
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramGetConversations(args: { account: string; limit?: number }) {
    const data = await this.instagramCall(
      'GET',
      `/api/v1/${args.account}/conversations?limit=${args.limit || 20}`
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramSendDm(args: {
    account: string;
    recipientId: string;
    message: string;
  }) {
    const data = await this.instagramCall('POST', `/api/v1/${args.account}/messages/send`, {
      recipient_id: args.recipientId,
      message: args.message,
    });
    return this.jsonResponse(data);
  }

  private async handleInstagramGetStories(args: { account: string }) {
    const data = await this.instagramCall('GET', `/api/v1/${args.account}/stories`);
    return this.jsonResponse(data);
  }

  private async handleInstagramPublish(args: {
    account: string;
    imageUrl: string;
    caption: string;
    mediaType?: string;
  }) {
    const data = await this.instagramCall('POST', `/api/v1/${args.account}/publish`, {
      image_url: args.imageUrl,
      caption: args.caption,
      media_type: args.mediaType || 'IMAGE',
    });
    return this.jsonResponse(data);
  }

  private async handleInstagramMediaInsights(args: { account: string; mediaId: string }) {
    const data = await this.instagramCall(
      'GET',
      `/api/v1/${args.account}/media/${args.mediaId}/insights`
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramPublishCarousel(args: {
    account: string;
    items: string[];
    caption?: string;
  }) {
    const data = await this.instagramCall(
      'POST',
      `/api/v1/${args.account}/publish/carousel`,
      { items: args.items, caption: args.caption },
      120000
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramPublishReel(args: {
    account: string;
    videoUrl: string;
    caption?: string;
    shareToFeed?: boolean;
  }) {
    const data = await this.instagramCall(
      'POST',
      `/api/v1/${args.account}/publish/reel`,
      { video_url: args.videoUrl, caption: args.caption, share_to_feed: args.shareToFeed ?? true },
      120000
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramPublishStory(args: {
    account: string;
    imageUrl?: string;
    videoUrl?: string;
  }) {
    const data = await this.instagramCall(
      'POST',
      `/api/v1/${args.account}/publish/story`,
      { image_url: args.imageUrl, video_url: args.videoUrl },
      120000
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramPostComment(args: {
    account: string;
    mediaId: string;
    message: string;
  }) {
    const data = await this.instagramCall(
      'POST',
      `/api/v1/${args.account}/media/${args.mediaId}/comments`,
      { message: args.message }
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramHideComment(args: {
    account: string;
    commentId: string;
    hide?: boolean;
  }) {
    const data = await this.instagramCall(
      'POST',
      `/api/v1/${args.account}/comments/${args.commentId}/hide`,
      { hide: args.hide ?? true }
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramDeleteComment(args: { account: string; commentId: string }) {
    const data = await this.instagramCall(
      'DELETE',
      `/api/v1/${args.account}/comments/${args.commentId}`
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramGetAccountInsights(args: {
    account: string;
    metrics?: string[];
    period?: string;
  }) {
    const params = new URLSearchParams();
    if (args.metrics?.length) params.set('metrics', args.metrics.join(','));
    if (args.period) params.set('period', args.period);
    const qs = params.toString();
    const data = await this.instagramCall(
      'GET',
      `/api/v1/${args.account}/insights${qs ? `?${qs}` : ''}`
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramGetAccountPages(args: { account: string }) {
    const data = await this.instagramCall('GET', `/api/v1/${args.account}/pages`);
    return this.jsonResponse(data);
  }

  private async handleInstagramGetContentPublishingLimit(args: { account: string }) {
    const data = await this.instagramCall('GET', `/api/v1/${args.account}/publishing-limit`);
    return this.jsonResponse(data);
  }

  private async handleInstagramGetHashtagMedia(args: {
    account: string;
    hashtagId: string;
    mediaType?: 'top' | 'recent';
    limit?: number;
  }) {
    const qs = new URLSearchParams({
      media_type: args.mediaType ?? 'top',
      limit: String(args.limit ?? 25),
    }).toString();
    const data = await this.instagramCall(
      'GET',
      `/api/v1/${args.account}/hashtag/${args.hashtagId}/media?${qs}`
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramSearchHashtag(args: { account: string; hashtag: string }) {
    const qs = new URLSearchParams({ q: args.hashtag.replace(/^#/, '') }).toString();
    const data = await this.instagramCall('GET', `/api/v1/${args.account}/hashtag/search?${qs}`);
    return this.jsonResponse(data);
  }

  private async handleInstagramBusinessDiscovery(args: { account: string; username: string }) {
    const qs = new URLSearchParams({ username: args.username }).toString();
    const data = await this.instagramCall(
      'GET',
      `/api/v1/${args.account}/business-discovery?${qs}`
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramGetMentions(args: { account: string; limit?: number }) {
    const data = await this.instagramCall(
      'GET',
      `/api/v1/${args.account}/mentions?limit=${args.limit ?? 25}`
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramValidateAccessToken(args: { account: string }) {
    const data = await this.instagramCall('GET', `/api/v1/${args.account}/token/validate`);
    return this.jsonResponse(data);
  }

  private async handleInstagramGetConversationMessages(args: {
    account: string;
    conversationId: string;
    limit?: number;
  }) {
    const data = await this.instagramCall(
      'GET',
      `/api/v1/${args.account}/conversations/${args.conversationId}/messages?limit=${args.limit ?? 25}`
    );
    return this.jsonResponse(data);
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.logger.info('MCP Server started (stdio)');
  }

  /** Returns the underlying MCP Server instance for SSE transport use */
  getServer(): Server {
    return this.server;
  }
}
