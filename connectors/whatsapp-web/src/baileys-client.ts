/**
 * WhatsApp connector client backed by @whiskeysockets/baileys.
 *
 * Replaces the previous whatsapp-web.js + Chromium implementation. Same public
 * surface (methods, events, payloads) so the HTTP controller, db-writer, NATS
 * publisher and the MCP server keep working unchanged.
 *
 * Baileys uses native WhatsApp JIDs (`@s.whatsapp.net` for users), but the
 * existing DB schema and downstream consumers expect `@c.us`. All JIDs are
 * normalised at the boundary so the rest of the system never sees Baileys
 * format.
 */
import {
  default as makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
  WASocket,
  WAMessage,
  WAMessageKey,
  proto,
  isJidGroup,
  jidEncode,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  AnyMessageContent,
  CacheStore,
  GroupMetadata,
  Browsers,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { EventEmitter } from 'events';
import { promises as fsp } from 'fs';
import { join } from 'path';
import QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import pino from 'pino';
import {
  storeMessage,
  ensureConversation,
  ensureParticipant,
  linkParticipantToConversation,
  storeAttachment,
  getPool,
  MessageData,
  ensureHistoryTables,
  storeMessageKey,
  recordHistorySyncProgress,
  getHistorySyncStatus,
  HistorySyncState,
  getConversationAvatar,
  getParticipantAvatar,
  setConversationAvatar,
  setParticipantAvatar,
  setConversationState,
  setMessageStatus,
} from './db-writer';
import { uploadMedia, ensureMediaBucket, fetchMedia, uploadAvatar } from './media-storage';

// WhatsApp Web message status enum → human/dashboard strings.
// proto.WebMessageInfo.Status: ERROR=0, PENDING=1, SERVER_ACK=2, DELIVERY_ACK=3, READ=4, PLAYED=5
function mapWaStatus(s: number): string | null {
  switch (s) {
    case 0:
      return 'failed';
    case 1:
      return 'pending';
    case 2:
      return 'sent';
    case 3:
      return 'delivered';
    case 4:
      return 'read';
    case 5:
      return 'read';
    default:
      return null;
  }
}

export interface WhatsAppMessage {
  waMessageId: string;
  waTimestamp: Date;
  conversationId: string;
  senderWaId: string;
  content: string | null;
  messageType: string;
  isForwarded: boolean;
  replyToWaId?: string;
  attachments?: Array<{
    type: string;
    url: string;
    metadata: Record<string, unknown>;
  }>;
}

interface CachedChat {
  id: string; // normalised JID
  rawJid: string; // original Baileys JID (used when calling sock APIs)
  name: string;
  isGroup: boolean;
  unreadCount: number;
  timestamp: number;
}

type IngestSource = 'live' | 'baileys_history_sync';

interface IngestOptions {
  source?: IngestSource;
  publishEvent?: boolean;
  syncType?: string;
  isLatest?: boolean;
}

interface IngestResult {
  inserted: boolean;
  waMessage?: WhatsAppMessage;
}

export type WhatsAppSendFailureClass =
  | 'timeout'
  | 'missing_session'
  | 'group_metadata'
  | 'disconnected'
  | 'auth'
  | 'unknown';

export interface GroupSessionRefreshResult {
  rawJid: string;
  normalizedJid: string;
  groupSubject: string;
  participantCount: number;
  lidParticipantCount: number;
  deviceCount: number;
  skippedSenderKeyDevices: number;
  sessionFetchAttempted: boolean;
  forceSessions: boolean;
  senderKeyMemoryCleared: boolean;
  warnings: string[];
}

interface GroupSessionRefreshOptions {
  reason?: string;
  warmSessions?: boolean;
  forceSessions?: boolean;
  clearSenderKeyMemory?: boolean;
  failOnWarmupError?: boolean;
  markFailedDevicesAsSenderKeySent?: boolean;
}

interface SendFailureDetails {
  failureClass: WhatsAppSendFailureClass;
  rawJid: string;
  normalizedJid: string;
  isGroup: boolean;
  groupSubject?: string;
  participantCount?: number;
  attempts: number;
  elapsedMs: number;
  causeMessage: string;
  actionable: string;
  repair?: GroupSessionRefreshResult;
}

class TtlCache implements CacheStore {
  private entries = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number
  ) {}

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T): void {
    if (this.entries.size >= this.maxEntries) {
      const firstKey = this.entries.keys().next().value;
      if (firstKey) this.entries.delete(firstKey);
    }
    this.entries.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  del(key: string): void {
    this.entries.delete(key);
  }

  flushAll(): void {
    this.entries.clear();
  }
}

export class WhatsAppSendError extends Error {
  failureClass: WhatsAppSendFailureClass;
  details: SendFailureDetails;
  cause?: unknown;

  constructor(message: string, details: SendFailureDetails, cause?: unknown) {
    super(message);
    this.name = 'WhatsAppSendError';
    this.failureClass = details.failureClass;
    this.details = details;
    this.cause = cause;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}

export function classifyWhatsAppSendFailure(error: unknown): WhatsAppSendFailureClass {
  const err = error as { name?: string; failureClass?: WhatsAppSendFailureClass };
  if (err?.failureClass) return err.failureClass;

  const name = String(err?.name || '').toLowerCase();
  const text = `${name} ${errorMessage(error)}`.toLowerCase();
  if (
    text.includes('sessionerror') ||
    text.includes('no sessions') ||
    text.includes('no open session') ||
    text.includes('no session record') ||
    text.includes('not-acceptable')
  ) {
    return 'missing_session';
  }
  if (text.includes('timeout') || text.includes('timed out')) return 'timeout';
  if (text.includes('not authenticated')) return 'auth';
  if (
    text.includes('not connected') ||
    text.includes('connection closed') ||
    text.includes('connection lost')
  )
    return 'disconnected';
  if (text.includes('group metadata') || text.includes('not a group jid')) return 'group_metadata';
  return 'unknown';
}

function actionableForFailure(failureClass: WhatsAppSendFailureClass, isGroup: boolean): string {
  if (failureClass === 'timeout') {
    return isGroup
      ? 'WhatsApp did not acknowledge the group send before the timeout. The connector refreshed group metadata, repaired group sender-key state, and retried once; if this persists, open the group on the linked phone or re-link WhatsApp.'
      : 'WhatsApp did not acknowledge the send before the timeout. Check connector connectivity and try again.';
  }
  if (failureClass === 'missing_session') {
    return 'Baileys has no usable Signal session for at least one group participant. The connector forced a session refresh and retried once; if this persists, open the group on the linked phone, wait for participant state to sync, or re-link WhatsApp.';
  }
  if (failureClass === 'group_metadata') {
    return 'The connector could not refresh group metadata. Confirm the linked WhatsApp account is still a member of the group and that the group JID is correct.';
  }
  if (failureClass === 'disconnected') {
    return 'WhatsApp is disconnected. Check get_connection_status and re-authenticate with the QR flow if needed.';
  }
  if (failureClass === 'auth') {
    return 'WhatsApp rejected the authenticated send path. Reconnect the WhatsApp session.';
  }
  return isGroup
    ? 'The group send failed after metadata/session repair. Check connector logs for the raw Baileys error and group participant sync state.'
    : 'The direct send failed. Check connector logs for the raw Baileys error.';
}

// LRU-ish cache mapping our exported waMessageId → full WAMessageKey (+ owning
// chat) so we can react/forward/delete/download without keeping every message
// in memory.
const KEY_CACHE_MAX = 2000;

export class BaileysClient extends EventEmitter {
  private sock: WASocket | null = null;
  private sessionPath: string;
  // kept for backward compat with the old constructor signature; unused.
  private encryptionKey: Buffer;
  private logger: pino.Logger;

  // State exposed via getStatus()/getCachedState()/isConnected()
  private ready = false;
  private lastState: string | null = null;
  private connecting = false;
  private intentionalDisconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private connectedAt: Date | null = null;
  private lastQrAt: Date | null = null;
  private lastDisconnectedAt: Date | null = null;
  private lastReconnectAt: Date | null = null;
  private initializeStartedAt: Date | null = null;
  private lastQrReminderAt = 0;
  private reconnectAttempts = 0;
  private readonly watchdogIntervalMs = parseInt(
    process.env.WA_WATCHDOG_INTERVAL_MS || '60000',
    10
  );
  private readonly initializeMaxMs = parseInt(process.env.WA_INITIALIZE_MAX_MS || '180000', 10);
  private readonly retryMessageCacheTtlMs = parseInt(
    process.env.WA_RETRY_MESSAGE_CACHE_TTL_MS || String(24 * 60 * 60 * 1000),
    10
  );
  private readonly retryMessageCacheMax = parseInt(
    process.env.WA_RETRY_MESSAGE_CACHE_MAX || '5000',
    10
  );
  // Off by default. For iPhone history, ChatStorage.sqlite remains the primary
  // import source; this flag lets Baileys fill whatever WhatsApp sends during
  // a fresh device link without treating those messages as live events.
  private readonly historySyncOnLogin = process.env.WA_HISTORY_SYNC_ON_LOGIN === 'true';

  // me — populated on `connection.update { connection: 'open' }`
  private meJid: string | null = null;
  private meName: string | null = null;

  // In-memory mirrors. Baileys removed makeInMemoryStore, so we keep the
  // minimum we need for the existing API contract.
  private chatStore = new Map<string, CachedChat>(); // by normalised JID
  private groupMetaCache = new Map<string, GroupMetadata>(); // by raw JID
  private keyCache = new Map<string, { key: WAMessageKey; chatJid: string }>(); // by waMessageId
  private retryMessageCache: CacheStore;
  private msgRetryCounterCache: CacheStore;
  private userDevicesCache: CacheStore;
  private placeholderResendCache: CacheStore;
  private historyBackfillRequestedUntil = 0;

  constructor(sessionPath: string, encryptionKey: string) {
    super();
    this.sessionPath = sessionPath;
    this.encryptionKey = Buffer.from(encryptionKey, 'utf-8');
    this.logger = pino({
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    });
    this.retryMessageCache = new TtlCache(this.retryMessageCacheTtlMs, this.retryMessageCacheMax);
    this.msgRetryCounterCache = new TtlCache(60 * 60 * 1000, 10000);
    this.userDevicesCache = new TtlCache(5 * 60 * 1000, 10000);
    this.placeholderResendCache = new TtlCache(60 * 60 * 1000, 10000);
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  async connect(): Promise<void> {
    if (this.connecting) {
      this.logger.warn('WhatsApp connect requested while another connect is already in progress');
      return;
    }

    this.connecting = true;
    this.ready = false;
    this.lastState = 'INITIALIZING';
    this.initializeStartedAt = new Date();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopWatchdog();

    try {
      await this.destroyCurrentSocket('before connect');

      try {
        await ensureMediaBucket();
      } catch (e: any) {
        this.logger.warn(
          `MinIO bucket check failed (auto-download may not work): ${e?.message || e}`
        );
      }
      await ensureHistoryTables();

      const authDir = this.authDir();
      await fsp.mkdir(authDir, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({
        version: [2, 3000, 1015901307] as [number, number, number],
        isLatest: false,
      }));
      this.logger.info(`Baileys WA version=${version.join('.')} latest=${isLatest}`);
      const baileysLogger = pino({ level: 'warn' }) as any;

      this.sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
        },
        printQRInTerminal: false,
        browser: this.historySyncOnLogin
          ? Browsers.macOS('Desktop')
          : ['mcp-socialmedia', 'Chrome', '1.0.0'],
        // Use a dedicated pino logger silencing inner noise; bumping to info
        // is too chatty.
        logger: baileysLogger,
        syncFullHistory: this.historySyncOnLogin,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        msgRetryCounterCache: this.msgRetryCounterCache,
        userDevicesCache: this.userDevicesCache,
        placeholderResendCache: this.placeholderResendCache,
        cachedGroupMetadata: async (jid: string) => this.groupMetaCache.get(this.toRawJid(jid)),
        getMessage: key => this.getMessageForRetry(key),
      });

      this.bindSocketEvents(saveCreds);
      this.startWatchdog();
    } finally {
      this.connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopWatchdog();
    await this.destroyCurrentSocket('manual disconnect');
    this.lastState = 'DISCONNECTED';
    this.lastDisconnectedAt = new Date();
    this.ready = false;
    this.intentionalDisconnect = false;
  }

  async renewQR(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }

  private authDir(): string {
    // Keep wwebjs `session/` untouched so we can revert by reverting the code.
    return join(this.sessionPath, 'baileys-auth');
  }

  private async destroyCurrentSocket(reason: string): Promise<void> {
    const sock = this.sock;
    this.sock = null;
    if (!sock) return;
    try {
      this.logger.info(`Closing WhatsApp socket (${reason})`);
      sock.end(undefined as any);
    } catch (e: any) {
      this.logger.warn(`Failed to close socket cleanly (${reason}): ${e?.message || e}`);
    }
  }

  private bindSocketEvents(saveCreds: () => Promise<void>): void {
    const sock = this.sock;
    if (!sock) return;

    sock.ev.on('creds.update', () => {
      void saveCreds();
    });

    sock.ev.on('connection.update', update => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.handleQR(qr);
      }

      if (connection === 'connecting') {
        this.lastState = 'CONNECTING';
        return;
      }

      if (connection === 'open') {
        this.meJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
        this.meName = sock.user?.name || null;
        this.markConnected('connection.update open');
        // Pull current unread/archived/pin state from WhatsApp app-state. This
        // emits chats.update events whose handler persists unread_count +
        // archived to the DB, so the dashboard shows the real badges without
        // waiting for new traffic. Fire-and-forget; safe if it fails.
        void this.resyncChatState('connection-open');
        return;
      }

      if (connection === 'close') {
        this.ready = false;
        this.lastDisconnectedAt = new Date();
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const reason = lastDisconnect?.error?.message || `close (${statusCode || 'unknown'})`;
        this.lastState = `CLOSED:${statusCode || 'unknown'}`;
        this.logger.warn(`WhatsApp socket closed: ${reason}`);
        this.emit('disconnected');

        if (this.intentionalDisconnect) {
          return;
        }

        // 401 / loggedOut → session is gone, no point retrying without rescan.
        if (statusCode === DisconnectReason.loggedOut) {
          this.lastState = 'LOGGED_OUT';
          this.logger.error('WhatsApp session was logged out — rescan QR required');
          // Wipe local creds so next connect() emits a fresh QR.
          void fsp.rm(this.authDir(), { recursive: true, force: true }).catch(() => {});
          this.scheduleReconnect('logged out');
          return;
        }

        this.scheduleReconnect(reason);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return;
      const isLive = type === 'notify';
      for (const msg of messages) {
        if (!msg.message) continue;
        try {
          await this.ingestMessage(msg, {
            source: isLive ? 'live' : 'baileys_history_sync',
            publishEvent: isLive,
          });
        } catch (e: any) {
          this.logger.error(`Error processing message ${msg.key?.id}: ${e?.message || e}`);
        }
      }
    });

    sock.ev.on('messaging-history.set', async ({ chats, messages, isLatest }) => {
      // chats: Chat[] (Baileys type). Refresh in-memory chat store.
      for (const c of chats) {
        if (!c.id) continue;
        const isGroup = !!isJidGroup(c.id);
        const norm = this.normalizeJid(c.id);
        this.chatStore.set(norm, {
          id: norm,
          rawJid: c.id,
          name: c.name || c.id,
          isGroup,
          unreadCount: c.unreadCount || 0,
          timestamp: Number(c.conversationTimestamp || 0),
        });
        // Persist real unread + archived from the history snapshot.
        void setConversationState(norm, c.unreadCount || 0, !!(c as any).archived).catch(() => {});
      }
      if (!this.historySyncOnLogin && Date.now() > this.historyBackfillRequestedUntil) return;
      this.logger.info(
        `history.set received chats=${chats.length} messages=${messages.length} isLatest=${isLatest}`
      );
      const byChat = new Map<
        string,
        { inserted: number; oldest?: WhatsAppMessage; newest?: WhatsAppMessage }
      >();
      for (const m of messages) {
        try {
          const result = await this.ingestMessage(m, {
            source: 'baileys_history_sync',
            publishEvent: false,
            isLatest,
          });
          if (!result.waMessage) continue;
          const entry = byChat.get(result.waMessage.conversationId) || { inserted: 0 };
          if (result.inserted) entry.inserted += 1;
          if (!entry.oldest || result.waMessage.waTimestamp < entry.oldest.waTimestamp)
            entry.oldest = result.waMessage;
          if (!entry.newest || result.waMessage.waTimestamp > entry.newest.waTimestamp)
            entry.newest = result.waMessage;
          byChat.set(result.waMessage.conversationId, entry);
        } catch (e: any) {
          this.logger.warn(`history ingest failed for ${m.key?.id}: ${e?.message || e}`);
        }
      }
      for (const [conversationId, state] of Array.from(byChat.entries())) {
        await recordHistorySyncProgress({
          conversationId,
          oldestMessageId: state.oldest?.waMessageId,
          oldestTimestamp: state.oldest?.waTimestamp,
          newestTimestamp: state.newest?.waTimestamp,
          insertedCount: state.inserted,
          status: state.inserted > 0 ? 'pending' : 'requested',
        }).catch(e =>
          this.logger.warn(`history state update failed for ${conversationId}: ${e?.message || e}`)
        );
      }
    });

    sock.ev.on('chats.update', updates => {
      for (const u of updates) {
        if (!u.id) continue;
        const norm = this.normalizeJid(u.id);
        const prev = this.chatStore.get(norm);
        if (prev) {
          if (typeof u.unreadCount === 'number') prev.unreadCount = u.unreadCount;
          if (u.conversationTimestamp) prev.timestamp = Number(u.conversationTimestamp);
          if ((u as any).name) prev.name = (u as any).name;
          this.emit('chat-update', {
            waChatId: prev.id,
            updateType: 'NAME_CHANGED',
            metadata: { name: prev.name },
          });
        }
        // chats.update may carry only a delta — persist whichever fields are present.
        const uc = typeof u.unreadCount === 'number' ? u.unreadCount : prev?.unreadCount || 0;
        const arch = typeof (u as any).archived === 'boolean' ? (u as any).archived : undefined;
        void setConversationState(norm, uc, arch).catch(() => {});
      }
    });

    sock.ev.on('chats.upsert', upserts => {
      for (const c of upserts) {
        if (!c.id) continue;
        const norm = this.normalizeJid(c.id);
        this.chatStore.set(norm, {
          id: norm,
          rawJid: c.id,
          name: c.name || c.id,
          isGroup: !!isJidGroup(c.id),
          unreadCount: c.unreadCount || 0,
          timestamp: Number(c.conversationTimestamp || 0),
        });
        // Persist real unread badge + archived flag (fire-and-forget).
        void setConversationState(norm, c.unreadCount || 0, !!(c as any).archived).catch(() => {});
      }
    });

    sock.ev.on('messages.update', updates => {
      for (const u of updates) {
        if (!u.key?.id) continue;
        const waMessageId = u.key.id;
        // Detect deletions
        const stub = u.update?.messageStubType;
        const isDeleted =
          stub === proto.WebMessageInfo.StubType.REVOKE || u.update?.message === null;
        if (isDeleted) {
          this.emit('message-update', { waMessageId, updateType: 'DELETED' });
          void setMessageStatus(waMessageId, 'deleted').catch(() => {});
        }
        // Track delivery state from WhatsApp servers (the green ticks).
        const st: number | undefined = (u.update as any)?.status;
        if (typeof st === 'number') {
          const mapped = mapWaStatus(st);
          if (mapped) void setMessageStatus(waMessageId, mapped).catch(() => {});
        }
      }
    });

    // Receipts from individual recipients (group "✓✓ for everyone" or read).
    sock.ev.on('message-receipt.update' as any, (updates: any[]) => {
      for (const u of updates || []) {
        const waMessageId = u?.key?.id;
        const t: 'read' | 'delivered' | null = u?.receipt?.readTimestamp
          ? 'read'
          : u?.receipt?.receiptTimestamp
            ? 'delivered'
            : null;
        if (waMessageId && t) {
          void setMessageStatus(waMessageId, t).catch(() => {});
        }
      }
    });

    sock.ev.on('group-participants.update', evt => {
      const { id, participants, action } = evt;
      const norm = this.normalizeJid(id);
      const updateType =
        action === 'add'
          ? 'PARTICIPANT_ADDED'
          : action === 'remove'
            ? 'PARTICIPANT_REMOVED'
            : 'NAME_CHANGED';
      this.emit('chat-update', {
        waChatId: norm,
        updateType,
        metadata: { participants: participants.map(p => this.normalizeJid(p)), action },
      });
      this.groupMetaCache.delete(id);
    });
  }

  private handleQR(qr: string): void {
    this.ready = false;
    this.lastState = 'QR';
    this.lastQrAt = new Date();
    qrcodeTerminal.generate(qr, { small: true });
    QRCode.toFile(join(this.sessionPath, 'qr.png'), qr, { width: 400 }).catch(() => {});
    this.logger.warn(
      `WhatsApp requires QR scan at ${process.env.WA_QR_PUBLIC_URL || 'https://whatsapp.e-dani.com/'}`
    );
    this.emit('qr', qr);
  }

  private markConnected(source: string): void {
    const wasReady = this.ready;
    this.ready = true;
    this.lastState = 'CONNECTED';
    this.connectedAt = this.connectedAt || new Date();
    this.initializeStartedAt = null;
    this.reconnectAttempts = 0;
    if (!wasReady) {
      this.logger.info(`WhatsApp marked connected via ${source}`);
      this.emit('connected');
    }
  }

  // ---------------------------------------------------------------------------
  // Watchdog / reconnect
  // ---------------------------------------------------------------------------

  private startWatchdog(): void {
    if (!this.watchdogIntervalMs || this.watchdogIntervalMs < 10000 || this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      void this.runWatchdog().catch(e =>
        this.logger.warn(`WhatsApp watchdog failed: ${e?.message || e}`)
      );
    }, this.watchdogIntervalMs);
    (this.watchdogTimer as any).unref?.();
  }

  private stopWatchdog(): void {
    if (!this.watchdogTimer) return;
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  private async runWatchdog(): Promise<void> {
    if (this.connecting) return;
    const now = Date.now();

    if (this.ready) return;

    if (
      this.lastState === 'QR' ||
      this.lastState === 'LOGGED_OUT' ||
      this.lastState?.startsWith('CLOSED:401')
    ) {
      if (now - this.lastQrReminderAt > 10 * 60 * 1000) {
        this.lastQrReminderAt = now;
        this.logger.warn(
          `WhatsApp is waiting for manual QR scan: ${process.env.WA_QR_PUBLIC_URL || 'https://whatsapp.e-dani.com/'}`
        );
      }
      return;
    }

    if (
      this.initializeStartedAt &&
      now - this.initializeStartedAt.getTime() > this.initializeMaxMs
    ) {
      this.logger.warn(`Watchdog restarting stuck WhatsApp socket state=${this.lastState}`);
      await this.reconnectNow(`stuck in ${this.lastState || 'unknown'}`);
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.reconnectTimer || this.connecting) return;
    const delayMs = Math.min(60000, 5000 * Math.max(1, this.reconnectAttempts + 1));
    this.logger.warn(`Scheduling WhatsApp reconnect in ${delayMs}ms (${reason})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectNow(reason).catch(e =>
        this.logger.error(`Reconnect failed: ${e?.message || e}`)
      );
    }, delayMs);
    (this.reconnectTimer as any).unref?.();
  }

  private async reconnectNow(reason: string): Promise<void> {
    if (this.connecting) return;
    this.reconnectAttempts += 1;
    this.lastReconnectAt = new Date();
    this.ready = false;
    this.lastState = 'RECONNECTING';
    await this.destroyCurrentSocket(reason);
    await this.connect();
  }

  // ---------------------------------------------------------------------------
  // Message ingest (live events + history-on-login)
  // ---------------------------------------------------------------------------

  private async ingestMessage(msg: WAMessage, options: IngestOptions = {}): Promise<IngestResult> {
    if (msg.key?.id && msg.message) {
      this.rememberMessageForRetry(msg.key, msg.message);
    }

    const waMessage = this.convertMessage(msg);
    if (!waMessage) return { inserted: false };

    this.rememberKey(waMessage.waMessageId, msg.key, msg.key.remoteJid || '');

    const rawChatJid = msg.key.remoteJid || '';
    const isGroup = !!isJidGroup(rawChatJid);

    const chatName = this.chatStore.get(waMessage.conversationId)?.name || waMessage.conversationId;
    let participantCount = 2;
    if (isGroup) {
      const meta = await this.fetchGroupMetadata(rawChatJid).catch(() => null);
      participantCount = meta?.participants?.length || 0;
    }

    await ensureConversation({
      id: waMessage.conversationId,
      name: chatName,
      isGroup,
      participantCount,
    });

    const senderRaw = msg.key.fromMe
      ? this.meJid || waMessage.senderWaId
      : msg.key.participant || rawChatJid;
    const pushName = msg.pushName || undefined;
    await ensureParticipant({
      id: waMessage.senderWaId,
      name: pushName,
      pushName,
      phone: this.phoneFromJid(senderRaw),
    });
    await linkParticipantToConversation(waMessage.conversationId, waMessage.senderWaId);

    // Lazy avatar pulls. Don't await — fire-and-forget so a slow profile
    // picture fetch never delays the message persist.
    void this.ensureConversationAvatarIfMissing(waMessage.conversationId, rawChatJid);
    void this.ensureParticipantAvatarIfMissing(waMessage.senderWaId, senderRaw);

    const data: MessageData = {
      waMessageId: waMessage.waMessageId,
      conversationId: waMessage.conversationId,
      senderWaId: waMessage.senderWaId,
      waTimestamp: waMessage.waTimestamp,
      direction: msg.key.fromMe ? 'OUTBOUND' : 'INBOUND',
      content: waMessage.content,
      messageType: waMessage.messageType,
      isForwarded: waMessage.isForwarded,
      replyToWaId: waMessage.replyToWaId,
      metadata: {
        source: options.source || 'live',
        history_source:
          options.source === 'baileys_history_sync' ? 'baileys_history_sync' : undefined,
        is_latest_history_sync: options.isLatest,
        sync_type: options.syncType,
      },
    };
    const msgId = await storeMessage(data);
    await storeMessageKey({
      waMessageId: waMessage.waMessageId,
      conversationId: waMessage.conversationId,
      remoteJid: rawChatJid,
      fromMe: !!msg.key.fromMe,
      participantJid: msg.key.participant || undefined,
      messageTimestampMs: waMessage.waTimestamp.getTime(),
    }).catch(e =>
      this.logger.warn(
        `message key persist failed for ${waMessage.waMessageId}: ${e?.message || e}`
      )
    );

    if (!msgId) return { inserted: false, waMessage };

    this.logger.info(`Stored message ${waMessage.waMessageId} from ${waMessage.senderWaId}`);

    if (
      (options.source || 'live') === 'live' &&
      waMessage.messageType !== 'TEXT' &&
      waMessage.messageType !== 'REACTION'
    ) {
      this.downloadAndStoreMedia(
        msg,
        msgId,
        waMessage.messageType,
        waMessage.content || undefined
      ).catch(err =>
        this.logger.warn(
          `Media download failed for ${waMessage.waMessageId}: ${err?.message || err}`
        )
      );
    }

    if (options.publishEvent !== false) {
      this.emit('message', waMessage);
    }
    return { inserted: true, waMessage };
  }

  private convertMessage(msg: WAMessage): WhatsAppMessage | null {
    if (!msg.key?.id || !msg.key.remoteJid) return null;

    const content = msg.message;
    if (!content) return null;

    // Determine type + body
    let messageType = 'TEXT';
    let body: string | null = null;
    let isForwarded = false;
    let replyToWaId: string | undefined;

    const text = content.conversation;
    const ext = content.extendedTextMessage;
    if (text) {
      body = text;
    } else if (ext) {
      body = ext.text || null;
      const ctx = ext.contextInfo;
      if (ctx) {
        isForwarded = !!ctx.isForwarded || (ctx.forwardingScore || 0) > 0;
        if (ctx.stanzaId) replyToWaId = ctx.stanzaId;
      }
    } else if (content.imageMessage) {
      messageType = 'IMAGE';
      body = content.imageMessage.caption || null;
    } else if (content.videoMessage) {
      messageType = 'VIDEO';
      body = content.videoMessage.caption || null;
    } else if (content.audioMessage) {
      messageType = content.audioMessage.ptt ? 'AUDIO' : 'AUDIO';
      body = null;
    } else if (content.documentMessage) {
      messageType = 'DOCUMENT';
      body = content.documentMessage.caption || content.documentMessage.fileName || null;
    } else if (content.stickerMessage) {
      messageType = 'STICKER';
    } else if (content.reactionMessage) {
      messageType = 'REACTION';
      body = content.reactionMessage.text || null;
      if (content.reactionMessage.key?.id) replyToWaId = content.reactionMessage.key.id;
    } else if (content.locationMessage) {
      messageType = 'LOCATION';
      const loc = content.locationMessage;
      body = `${loc.degreesLatitude},${loc.degreesLongitude}`;
    } else if (content.contactMessage) {
      messageType = 'CONTACT';
      body = content.contactMessage.displayName || null;
    } else if (content.contactsArrayMessage) {
      messageType = 'CONTACT';
      body = content.contactsArrayMessage.displayName || null;
    } else if (content.protocolMessage) {
      // ignore key updates etc.
      return null;
    } else {
      const k = Object.keys(content).find(k => !!(content as any)[k]);
      messageType = (k || 'UNKNOWN').toUpperCase();
    }

    const senderRaw = msg.key.fromMe
      ? this.meJid || msg.key.remoteJid
      : msg.key.participant || msg.key.remoteJid;

    return {
      waMessageId: msg.key.id,
      waTimestamp: new Date(Number(msg.messageTimestamp || 0) * 1000),
      conversationId: this.normalizeJid(msg.key.remoteJid),
      senderWaId: this.normalizeJid(senderRaw),
      content: body,
      messageType,
      isForwarded,
      replyToWaId,
    };
  }

  private async downloadAndStoreMedia(
    msg: WAMessage,
    messageId: bigint,
    messageType: string,
    caption?: string
  ): Promise<void> {
    const timeoutMs = parseInt(process.env.WA_MEDIA_DOWNLOAD_TIMEOUT_MS || '30000', 10);

    let buffer: Buffer;
    try {
      buffer = await Promise.race([
        downloadMediaMessage(
          msg,
          'buffer',
          {},
          { logger: this.logger as any, reuploadRequest: this.sock!.updateMediaMessage }
        ),
        new Promise<Buffer>((_, rej) =>
          setTimeout(() => rej(new Error('downloadMedia timeout')), timeoutMs)
        ),
      ]);
    } catch (e: any) {
      this.logger.warn(`downloadMedia failed for ${msg.key?.id}: ${e?.message || e}`);
      return;
    }
    if (!buffer || !buffer.length) {
      this.logger.warn(`downloadMedia returned empty for ${msg.key?.id}`);
      return;
    }

    const { mimeType, fileName } = this.mediaMetaFromMessage(msg);

    const { storageKey, fileSize } = await uploadMedia(messageId, buffer, mimeType, fileName);

    await storeAttachment(messageId, {
      fileType: messageType,
      mimeType,
      fileName,
      fileSize,
      fileUrl: storageKey,
      caption,
    });

    this.logger.info(`Stored media ${storageKey} (${fileSize} bytes) for msg ${messageId}`);
  }

  private mediaMetaFromMessage(msg: WAMessage): { mimeType?: string; fileName?: string } {
    const c = msg.message;
    if (!c) return {};
    if (c.imageMessage)
      return { mimeType: c.imageMessage.mimetype || 'image/jpeg', fileName: undefined };
    if (c.videoMessage)
      return { mimeType: c.videoMessage.mimetype || 'video/mp4', fileName: undefined };
    if (c.audioMessage)
      return { mimeType: c.audioMessage.mimetype || 'audio/ogg', fileName: undefined };
    if (c.documentMessage)
      return {
        mimeType: c.documentMessage.mimetype || undefined,
        fileName: c.documentMessage.fileName || undefined,
      };
    if (c.stickerMessage)
      return { mimeType: c.stickerMessage.mimetype || 'image/webp', fileName: undefined };
    return {};
  }

  // ---------------------------------------------------------------------------
  // Public surface used by the HTTP controller
  // ---------------------------------------------------------------------------

  /**
   * Build a baileys-compatible "quoted" message from a wa_message_id we've
   * seen before (cached at ingest time). Returns undefined if we don't have
   * the original — baileys will still send, just without the quote bubble.
   */
  private async buildQuotedFromId(
    replyToMessageId: string | undefined,
    chatJid: string
  ): Promise<proto.IWebMessageInfo | undefined> {
    if (!replyToMessageId) return undefined;
    const cachedKey = this.keyCache.get(replyToMessageId);
    const messageProto =
      this.retryMessageCache.get<proto.IMessage>(replyToMessageId) ||
      (cachedKey
        ? this.retryMessageCache.get<proto.IMessage>(
            this.retryMessageCacheKey(cachedKey.chatJid, replyToMessageId)
          )
        : undefined);
    if (!cachedKey || !messageProto) return undefined;
    return {
      key: { ...cachedKey.key, id: replyToMessageId, remoteJid: chatJid },
      message: messageProto,
    } as proto.IWebMessageInfo;
  }

  async sendMessage(
    chatId: string,
    content: string,
    options?: { replyToMessageId?: string }
  ): Promise<string | undefined> {
    if (!this.sock) throw new Error('Client not initialized');
    if (!this.isConnected())
      throw new Error(`Client not connected (state=${this.lastState || 'unknown'})`);

    const timeoutMs = parseInt(process.env.WA_SEND_TIMEOUT_MS || '45000', 10);
    const started = Date.now();
    const raw = this.toRawJid(chatId);
    const normalized = this.normalizeJid(raw);
    const isGroup = this.isGroupJid(raw);
    let groupRepair: GroupSessionRefreshResult | undefined;

    if (isGroup) {
      groupRepair = await this.refreshGroupSession(raw, {
        reason: 'send-preflight',
        warmSessions: process.env.WA_GROUP_SEND_PREFLIGHT_SESSIONS === 'true',
        forceSessions: false,
        clearSenderKeyMemory: false,
        failOnWarmupError: false,
      }).catch(e => {
        const failureClass =
          classifyWhatsAppSendFailure(e) === 'timeout' ? 'timeout' : 'group_metadata';
        throw this.buildSendError(failureClass, raw, normalized, true, started, 1, e);
      });
    }

    this.logger.info(
      `Sending WhatsApp message rawJid=${raw} normalizedJid=${normalized} type=${isGroup ? 'group' : 'direct'}${groupRepair?.groupSubject ? ` groupSubject="${groupRepair.groupSubject}" participants=${groupRepair.participantCount}` : ''}`
    );
    const quoted = await this.buildQuotedFromId(options?.replyToMessageId, raw);
    try {
      const sent = await this.sendTextWithTimeout(raw, content, timeoutMs, {
        useCachedGroupMetadata: isGroup ? false : undefined,
        quoted,
      });
      const messageId = sent?.key?.id;
      this.logger.info(
        `WhatsApp message sent rawJid=${raw} normalizedJid=${normalized} elapsedMs=${Date.now() - started}${messageId ? ` id=${messageId}` : ''}`
      );
      if (sent?.key) {
        this.rememberKey(messageId || '', sent.key, raw);
        this.rememberMessageForRetry(sent.key, sent.message);
      }
      return messageId || undefined;
    } catch (e: any) {
      const failureClass = classifyWhatsAppSendFailure(e);
      this.logger.warn(
        `WhatsApp send attempt failed failureClass=${failureClass} rawJid=${raw} normalizedJid=${normalized} attempt=1 elapsedMs=${Date.now() - started}${groupRepair?.groupSubject ? ` groupSubject="${groupRepair.groupSubject}"` : ''}: ${e?.message || e}`
      );

      if (isGroup && this.shouldRetryGroupSend(failureClass)) {
        let repair: GroupSessionRefreshResult | undefined;
        try {
          repair = await this.refreshGroupSession(raw, {
            reason: `send-retry-after-${failureClass}`,
            warmSessions: true,
            forceSessions: true,
            clearSenderKeyMemory: true,
            failOnWarmupError: false,
            markFailedDevicesAsSenderKeySent: true,
          });
          this.logger.info(
            `Retrying WhatsApp group send after repair rawJid=${raw} normalizedJid=${normalized} groupSubject="${repair.groupSubject}" participants=${repair.participantCount} devices=${repair.deviceCount}`
          );
          const retried = await this.sendTextWithTimeout(raw, content, timeoutMs, {
            useCachedGroupMetadata: false,
            quoted,
          });
          const messageId = retried?.key?.id;
          this.logger.info(
            `WhatsApp group message sent after repair rawJid=${raw} normalizedJid=${normalized} elapsedMs=${Date.now() - started}${messageId ? ` id=${messageId}` : ''}`
          );
          if (retried?.key) {
            this.rememberKey(messageId || '', retried.key, raw);
            this.rememberMessageForRetry(retried.key, retried.message);
          }
          return messageId || undefined;
        } catch (retryError: any) {
          const retryFailureClass = classifyWhatsAppSendFailure(retryError);
          this.logger.error(
            `WhatsApp group send failed after repair failureClass=${retryFailureClass} rawJid=${raw} normalizedJid=${normalized} attempt=2 elapsedMs=${Date.now() - started}${repair?.groupSubject ? ` groupSubject="${repair.groupSubject}"` : ''}: ${retryError?.message || retryError}`
          );
          throw this.buildSendError(
            retryFailureClass,
            raw,
            normalized,
            true,
            started,
            2,
            retryError,
            repair || groupRepair
          );
        }
      }

      this.logger.error(
        `Failed to send WhatsApp message failureClass=${failureClass} rawJid=${raw} normalizedJid=${normalized} elapsedMs=${Date.now() - started}: ${e?.message || e}`
      );
      throw this.buildSendError(failureClass, raw, normalized, isGroup, started, 1, e, groupRepair);
    }
  }

  async sendFile(
    chatId: string,
    fileUrl: string,
    caption?: string,
    options?: { asSticker?: boolean }
  ): Promise<void> {
    if (!this.sock) throw new Error('Client not initialized');
    const raw = this.toRawJid(chatId);
    const res = await fetch(fileUrl);
    if (!res.ok) throw new Error(`Failed to fetch file from ${fileUrl}: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') || '';
    const fileName = fileUrl.split('/').pop() || 'attachment';

    let payload: AnyMessageContent;
    // Stickers: WhatsApp expects webp; baileys handles conversion when the
    // payload is `{ sticker: buf }` and the bytes are a static webp/animated.
    if (options?.asSticker || contentType === 'image/webp') {
      payload = { sticker: buf };
    } else if (contentType.startsWith('image/')) payload = { image: buf, caption };
    else if (contentType.startsWith('video/')) payload = { video: buf, caption };
    else if (contentType.startsWith('audio/'))
      payload = { audio: buf, mimetype: contentType, ptt: false };
    else
      payload = {
        document: buf,
        fileName,
        mimetype: contentType || 'application/octet-stream',
        caption,
      };

    const sent = await this.sock.sendMessage(raw, payload);
    if (sent?.key?.id) {
      this.rememberKey(sent.key.id, sent.key, raw);
      this.rememberMessageForRetry(sent.key, sent.message);
    }
  }

  /** Send an Ogg/Opus clip as a WhatsApp voice note (PTT). */
  async sendVoice(
    chatId: string,
    audio: Buffer,
    mimetype = 'audio/ogg; codecs=opus'
  ): Promise<string | undefined> {
    if (!this.sock) throw new Error('Client not initialized');
    if (!this.isConnected())
      throw new Error(`Client not connected (state=${this.lastState || 'unknown'})`);
    const raw = this.toRawJid(chatId);
    const payload: AnyMessageContent = { audio, mimetype, ptt: true };
    const sent = await this.sock.sendMessage(raw, payload);
    const messageId = sent?.key?.id;
    if (sent?.key) {
      this.rememberKey(messageId || '', sent.key, raw);
      this.rememberMessageForRetry(sent.key, sent.message);
    }
    return messageId || undefined;
  }

  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.sock) throw new Error('Client not initialized');
    const cached = this.keyCache.get(messageId);
    let key: WAMessageKey | null = cached?.key || null;
    if (!key) {
      // Reconstruct from BD: we need fromMe / participant. Best effort.
      const fallback = await this.reconstructKeyFromDb(messageId, chatId).catch(() => null);
      if (!fallback) {
        this.logger.warn(`reactToMessage: message ${messageId} not found in key cache nor DB`);
        return;
      }
      key = fallback;
    }
    await this.sock.sendMessage(this.toRawJid(chatId), { react: { text: emoji, key } });
    this.logger.info(`Reacted with ${emoji} to ${messageId}`);
  }

  async forwardMessage(chatId: string, messageId: string, _toChatId: string): Promise<void> {
    if (!this.sock) throw new Error('Client not initialized');
    const cached = this.keyCache.get(messageId);
    if (!cached)
      throw new Error(`forwardMessage: message ${messageId} not available (key cache miss)`);
    // We need the original WAMessage to forward content; Baileys forward
    // signature is sendMessage(jid, { forward: WAMessage }).
    // We don't keep the full WAMessage, only the key — so we re-send the cached body if any.
    throw new Error(
      'forwardMessage: not supported without full WAMessage cache; ask Claude to plumb message store if you need this'
    );
  }

  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    if (!this.sock) throw new Error('Client not initialized');
    const cached = this.keyCache.get(messageId);
    let key: WAMessageKey | null = cached?.key || null;
    if (!key) {
      const fallback = await this.reconstructKeyFromDb(messageId, chatId).catch(() => null);
      if (!fallback) throw new Error(`deleteMessage: ${messageId} not found`);
      key = fallback;
    }
    await this.sock.sendMessage(this.toRawJid(chatId), { delete: key });
  }

  async markAsRead(chatId: string): Promise<void> {
    if (!this.sock) throw new Error('Client not initialized');
    const raw = this.toRawJid(chatId);
    // Read latest known key for that chat from the BD.
    const pool = getPool();
    const r = await pool.query(
      `SELECT wa_message_id FROM messages WHERE conversation_id = $1 ORDER BY wa_timestamp DESC LIMIT 1`,
      [chatId]
    );
    const lastId = r.rows[0]?.wa_message_id as string | undefined;
    if (!lastId) return;
    const cached = this.keyCache.get(lastId);
    const key: WAMessageKey = cached?.key || { remoteJid: raw, id: lastId, fromMe: false };
    await this.sock.readMessages([key]);
  }

  // ---------------------------------------------------------------------------
  // Chat / metadata
  // ---------------------------------------------------------------------------

  async getChats(): Promise<any[]> {
    // Mirror the wwebjs Chat[] shape just enough for the existing callers.
    return Array.from(this.chatStore.values()).map(c => ({
      id: { _serialized: c.id },
      name: c.name,
      isGroup: c.isGroup,
      unreadCount: c.unreadCount,
      timestamp: c.timestamp,
    }));
  }

  async getMe(): Promise<any> {
    if (!this.sock || !this.sock.user) throw new Error('Client not initialized');
    const id = this.normalizeJid(this.sock.user.id || '');
    return {
      id,
      name: this.sock.user.name || null,
      phone: this.phoneFromJid(this.sock.user.id || ''),
      platform: 'whatsapp',
    };
  }

  async getGroupInfo(groupId: string): Promise<any> {
    const raw = this.toRawJid(groupId);
    const meta = await this.fetchGroupMetadata(raw);
    return {
      id: this.normalizeJid(meta.id),
      name: meta.subject,
      description: meta.desc || '',
      participantCount: meta.participants.length,
      createdAt: meta.creation,
    };
  }

  async getGroupParticipants(groupId: string): Promise<any[]> {
    const raw = this.toRawJid(groupId);
    const meta = await this.fetchGroupMetadata(raw);
    return meta.participants.map(p => ({
      id: this.normalizeJid(p.id),
      isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
      isSuperAdmin: p.admin === 'superadmin',
    }));
  }

  /**
   * Lazy fetcher: if the conversation has no avatar_url yet, download from
   * WhatsApp and persist into MinIO + DB. Swallows all errors — never blocks.
   */
  private async ensureConversationAvatarIfMissing(
    conversationId: string,
    rawJid: string
  ): Promise<void> {
    try {
      const existing = await getConversationAvatar(conversationId);
      if (existing) return;
      const bytes = await this.getProfilePictureBytes(rawJid);
      if (!bytes) return;
      const key = await uploadAvatar('conversations', conversationId, bytes);
      await setConversationAvatar(conversationId, key);
    } catch (e) {
      // intentionally swallowed — avatar download must not break message ingest
    }
  }

  private async ensureParticipantAvatarIfMissing(
    participantId: string,
    rawJid: string
  ): Promise<void> {
    try {
      const existing = await getParticipantAvatar(participantId);
      if (existing) return;
      const bytes = await this.getProfilePictureBytes(rawJid);
      if (!bytes) return;
      const key = await uploadAvatar('participants', participantId, bytes);
      await setParticipantAvatar(participantId, key);
    } catch (e) {
      // swallow
    }
  }

  /**
   * Fetch a contact/group's profile picture as raw JPEG bytes.
   * Returns null if the JID has no picture or the lookup fails (privacy).
   */
  async getProfilePictureBytes(jid: string): Promise<Buffer | null> {
    if (!this.sock) return null;
    const raw = this.toRawJid(jid);
    let url: string | undefined;
    try {
      url = await this.sock.profilePictureUrl(raw, 'image');
    } catch (e) {
      // 'item-not-found' / 'forbidden' — not all JIDs have pics or are visible
      return null;
    }
    if (!url) return null;
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const ab = await r.arrayBuffer();
      return Buffer.from(ab);
    } catch (e) {
      return null;
    }
  }

  async refreshGroupSession(
    groupId: string,
    options: GroupSessionRefreshOptions = {}
  ): Promise<GroupSessionRefreshResult> {
    if (!this.sock) throw new Error('Client not initialized');
    if (!this.isConnected())
      throw new Error(`Client not connected (state=${this.lastState || 'unknown'})`);

    const raw = this.toRawJid(groupId);
    if (!this.isGroupJid(raw)) throw new Error(`Not a group JID: ${groupId}`);

    const normalized = this.normalizeJid(raw);
    const timeoutMs = parseInt(process.env.WA_GROUP_SESSION_REFRESH_TIMEOUT_MS || '45000', 10);
    const sessionTimeoutMs = parseInt(
      process.env.WA_GROUP_SESSION_ASSERT_TIMEOUT_MS || '12000',
      10
    );
    const batchSize = Math.max(
      1,
      Math.min(parseInt(process.env.WA_GROUP_SESSION_BATCH_SIZE || '25', 10), 100)
    );
    const sessionBatchSize = Math.max(
      1,
      Math.min(parseInt(process.env.WA_GROUP_SESSION_ASSERT_BATCH_SIZE || '1', 10), 25)
    );
    const warmSessions = options.warmSessions !== false;
    const warnings: string[] = [];

    this.logger.info(
      `Refreshing WhatsApp group session reason=${options.reason || 'manual'} rawJid=${raw} normalizedJid=${normalized} warmSessions=${warmSessions} forceSessions=${!!options.forceSessions} clearSenderKeyMemory=${!!options.clearSenderKeyMemory}`
    );

    const meta = await this.race(
      this.fetchGroupMetadata(raw, true),
      timeoutMs,
      `group metadata timeout after ${timeoutMs}ms`
    );
    this.cacheGroupMetadata(meta);

    let senderKeyMemoryCleared = false;
    if (options.clearSenderKeyMemory) {
      await this.sock.authState.keys.set({ 'sender-key-memory': { [raw]: null } });
      senderKeyMemoryCleared = true;
    }

    let deviceCount = 0;
    const skippedSenderKeyJids: string[] = [];
    let sessionFetchAttempted = false;
    if (warmSessions) {
      try {
        const participantJids = Array.from(
          new Set(meta.participants.map(p => p.id).filter(Boolean))
        );
        const devices = [];
        const participantBatches = this.chunk(participantJids, batchSize);
        for (let i = 0; i < participantBatches.length; i += 1) {
          const batch = participantBatches[i];
          const batchDevices = batch.length
            ? await this.race(
                this.sock.getUSyncDevices(batch, false, false),
                timeoutMs,
                `group device sync timeout after ${timeoutMs}ms batch=${i + 1}/${participantBatches.length}`
              )
            : [];
          devices.push(...batchDevices);
        }
        const deviceJids = Array.from(
          new Set(
            devices
              .filter(d => d.user !== undefined && d.user !== null)
              .map(d => jidEncode(d.user, 's.whatsapp.net', d.device))
          )
        );
        deviceCount = deviceJids.length;
        if (deviceJids.length) {
          sessionFetchAttempted = true;
          const sessionBatches = this.chunk(deviceJids, sessionBatchSize);
          for (let i = 0; i < sessionBatches.length; i += 1) {
            try {
              await this.race(
                this.sock.assertSessions(sessionBatches[i], !!options.forceSessions),
                sessionTimeoutMs,
                `group session refresh timeout after ${sessionTimeoutMs}ms batch=${i + 1}/${sessionBatches.length}`
              );
            } catch (e: any) {
              const warning = `session refresh batch ${i + 1}/${sessionBatches.length} failed for ${sessionBatches[i].join(',')}: ${e?.message || e}`;
              warnings.push(warning);
              if (options.markFailedDevicesAsSenderKeySent) {
                skippedSenderKeyJids.push(...sessionBatches[i]);
                continue;
              }
              if (options.failOnWarmupError) throw e;
            }
          }
        }
      } catch (e: any) {
        const warning = `session warm-up failed: ${e?.message || e}`;
        warnings.push(warning);
        if (options.failOnWarmupError) throw e;
        this.logger.warn(
          `WhatsApp group session warm-up warning rawJid=${raw} normalizedJid=${normalized}: ${warning}`
        );
      }
    }
    if (skippedSenderKeyJids.length) {
      await this.markSenderKeyDevicesAsSent(raw, skippedSenderKeyJids);
      this.logger.warn(
        `WhatsApp group repair marked failed sender-key devices as already sent rawJid=${raw} normalizedJid=${normalized} skippedDevices=${skippedSenderKeyJids.length}`
      );
    }

    const result: GroupSessionRefreshResult = {
      rawJid: raw,
      normalizedJid: normalized,
      groupSubject: meta.subject || raw,
      participantCount: meta.participants.length,
      lidParticipantCount: meta.participants.filter(p => p.id.endsWith('@lid')).length,
      deviceCount,
      skippedSenderKeyDevices: skippedSenderKeyJids.length,
      sessionFetchAttempted,
      forceSessions: !!options.forceSessions,
      senderKeyMemoryCleared,
      warnings,
    };
    this.logger.info(
      `WhatsApp group session refreshed rawJid=${raw} normalizedJid=${normalized} groupSubject="${result.groupSubject}" participants=${result.participantCount} lidParticipants=${result.lidParticipantCount} devices=${deviceCount} skippedSenderKeyDevices=${result.skippedSenderKeyDevices} warnings=${warnings.length}`
    );
    return result;
  }

  async getUnreadChats(): Promise<any[]> {
    return Array.from(this.chatStore.values())
      .filter(c => c.unreadCount > 0)
      .map(c => ({
        id: c.id,
        name: c.name,
        unreadCount: c.unreadCount,
        isGroup: c.isGroup,
        timestamp: c.timestamp,
      }));
  }

  /**
   * Force an app-state resync to pull current unread/archived/pin state from
   * WhatsApp. baileys emits chats.update events for each mutation, which the
   * chats.update handler persists to the DB. Returns once the sync completes.
   */
  async resyncChatState(reason = 'manual'): Promise<{ ok: boolean; error?: string }> {
    if (!this.sock) return { ok: false, error: 'not connected' };
    try {
      this.logger.info(`resyncAppState (${reason})`);
      await (this.sock as any).resyncAppState(
        ['critical_unblock_low', 'regular_high', 'regular_low', 'regular'],
        false
      );
      return { ok: true };
    } catch (e: any) {
      this.logger.warn(`resyncAppState failed: ${e?.message || e}`);
      return { ok: false, error: String(e?.message || e) };
    }
  }

  private async fetchGroupMetadata(rawJid: string, force = false): Promise<GroupMetadata> {
    const cached = this.groupMetaCache.get(rawJid);
    if (cached && !force) return cached;
    if (!this.sock) throw new Error('Client not initialized');
    const meta = await this.sock.groupMetadata(rawJid);
    this.cacheGroupMetadata(meta);
    return meta;
  }

  // ---------------------------------------------------------------------------
  // History endpoints (read-from-BD; live messages are written to BD anyway).
  // ---------------------------------------------------------------------------

  async fetchChatHistory(chatId: string, limit: number = 500): Promise<any[]> {
    const pool = getPool();
    const r = await pool.query(
      `SELECT wa_message_id, sender_wa_id, content, wa_timestamp, is_forwarded, message_type
       FROM messages
       WHERE conversation_id = $1 AND platform = 'whatsapp'
       ORDER BY wa_timestamp DESC LIMIT $2`,
      [chatId, limit]
    );
    return r.rows.map(row => ({
      id: row.wa_message_id,
      from: row.sender_wa_id,
      author: row.sender_wa_id,
      body: row.content,
      timestamp: Math.floor(new Date(row.wa_timestamp).getTime() / 1000),
      fromMe: false, // direction info not exposed cheap here
      hasMedia: row.message_type !== 'TEXT',
      type: row.message_type.toLowerCase(),
      isForwarded: row.is_forwarded,
      isStatus: false,
    }));
  }

  async getAllChatsWithHistory(
    messagesPerChat: number = 500
  ): Promise<{ chat: string; name: string; isGroup: boolean; messages: any[] }[]> {
    const chats = await this.getChats();
    const results = [];
    for (const c of chats) {
      const id = c.id._serialized;
      if (id === 'status@broadcast') continue;
      const messages = await this.fetchChatHistory(id, messagesPerChat);
      results.push({ chat: id, name: c.name, isGroup: c.isGroup, messages });
    }
    return results;
  }

  async backfillHistory(
    options: {
      chatId?: string;
      maxChats?: number;
      maxBatchesPerChat?: number;
      batchSize?: number;
      dryRun?: boolean;
    } = {}
  ): Promise<{
    requested: number;
    candidates: Array<{ chatId: string; oldestMessageId: string; oldestTimestamp: string }>;
  }> {
    if (!this.sock) throw new Error('Client not initialized');
    if (!this.isConnected())
      throw new Error(`Client not connected (state=${this.lastState || 'unknown'})`);
    await ensureHistoryTables();

    const maxChats = Math.max(1, Math.min(options.maxChats || 20, 200));
    const maxBatchesPerChat = Math.max(1, Math.min(options.maxBatchesPerChat || 1, 20));
    const batchSize = Math.max(1, Math.min(options.batchSize || 50, 50));
    const candidates: Array<{ chatId: string; oldestMessageId: string; oldestTimestamp: string }> =
      [];
    let requested = 0;

    const pool = getPool();
    const loadOldest = async () => {
      const params: any[] = [];
      const where = options.chatId ? 'WHERE k.conversation_id = $1' : '';
      if (options.chatId) params.push(options.chatId);
      params.push(maxChats);
      const limitParam = `$${params.length}`;
      return pool.query(
        `SELECT DISTINCT ON (k.conversation_id)
            k.conversation_id, k.wa_message_id, k.remote_jid, k.from_me,
            k.participant_jid, k.message_timestamp_ms
         FROM whatsapp_message_keys k
         ${where}
         ORDER BY k.conversation_id, k.message_timestamp_ms ASC
         LIMIT ${limitParam}`,
        params
      );
    };

    for (let batch = 0; batch < maxBatchesPerChat; batch++) {
      const rows = (await loadOldest()).rows;
      if (!rows.length) break;

      for (const row of rows) {
        const oldestTimestamp = new Date(Number(row.message_timestamp_ms));
        if (batch === 0) {
          candidates.push({
            chatId: row.conversation_id,
            oldestMessageId: row.wa_message_id,
            oldestTimestamp: oldestTimestamp.toISOString(),
          });
        }

        if (options.dryRun) continue;

        const key: WAMessageKey = {
          remoteJid: row.remote_jid,
          id: row.wa_message_id,
          fromMe: row.from_me,
          participant: row.participant_jid || undefined,
        };
        this.historyBackfillRequestedUntil = Date.now() + 5 * 60 * 1000;
        await (this.sock as any).fetchMessageHistory(
          batchSize,
          key,
          Math.floor(Number(row.message_timestamp_ms) / 1000)
        );
        requested += 1;
        await recordHistorySyncProgress({
          conversationId: row.conversation_id,
          oldestMessageId: row.wa_message_id,
          oldestTimestamp,
          insertedCount: 0,
          status: 'requested',
        });
      }

      if (options.dryRun || maxBatchesPerChat === 1) break;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    return { requested, candidates };
  }

  async getHistorySyncStatus(limit: number = 200): Promise<HistorySyncState[]> {
    await ensureHistoryTables();
    return getHistorySyncStatus(limit);
  }

  // ---------------------------------------------------------------------------
  // Media download
  // ---------------------------------------------------------------------------

  async downloadMedia(
    chatId: string,
    messageId: string
  ): Promise<{ data: string; mimetype: string; filename: string } | null> {
    // Incoming media is persisted to MinIO on receipt; map the wa_message_id to
    // its stored object (attachments.file_url) and stream it back as base64.
    try {
      const pool = getPool();
      const r = await pool.query(
        `SELECT a.file_url, a.mime_type, a.file_name
           FROM attachments a JOIN messages m ON m.id = a.message_id
          WHERE m.wa_message_id = $1
          ORDER BY a.id DESC LIMIT 1`,
        [messageId]
      );
      const row = r.rows[0];
      if (!row?.file_url) {
        this.logger.warn(`downloadMedia: no stored attachment for ${messageId}`);
        return null;
      }
      const buf = await fetchMedia(row.file_url as string);
      return {
        data: buf.toString('base64'),
        mimetype: (row.mime_type as string) || 'application/octet-stream',
        filename: (row.file_name as string) || 'media',
      };
    } catch (e: any) {
      this.logger.error(`downloadMedia failed for ${messageId}: ${e?.message || e}`);
      return null;
    }
  }

  async backfillRecentMedia(
    _daysBack: number = 7,
    _limit: number = 100
  ): Promise<{ ok: number; unavailable: number; total: number }> {
    // Live re-download by id isn't reliable with Baileys without keeping the
    // full WAMessage. The history-on-login sync already retrieves recent media
    // and pipes it through ingestMessage(). Surface a no-op so legacy callers
    // don't crash.
    this.logger.warn('backfillRecentMedia: noop (Baileys handles this via history-on-login)');
    return { ok: 0, unavailable: 0, total: 0 };
  }

  // ---------------------------------------------------------------------------
  // Public state helpers (unchanged surface)
  // ---------------------------------------------------------------------------

  getCachedState(): string | null {
    return this.lastState;
  }

  getStatus(): Record<string, unknown> {
    return {
      connected: this.ready,
      state: this.lastState,
      connectedAt: this.connectedAt?.toISOString() || null,
      lastQrAt: this.lastQrAt?.toISOString() || null,
      lastDisconnectedAt: this.lastDisconnectedAt?.toISOString() || null,
      lastReconnectAt: this.lastReconnectAt?.toISOString() || null,
      reconnectAttempts: this.reconnectAttempts,
      watchdogIntervalMs: this.watchdogIntervalMs,
      initializeMaxMs: this.initializeMaxMs,
      historySyncOnLogin: this.historySyncOnLogin,
      qrUrl: process.env.WA_QR_PUBLIC_URL || 'https://whatsapp.e-dani.com/',
      backend: 'baileys',
    };
  }

  async getState(_timeoutMs?: number): Promise<string | null> {
    // wwebjs exposed a network round-trip state; Baileys keeps everything in
    // memory via connection.update events, so we just surface our cached one.
    return this.lastState;
  }

  isConnected(): boolean {
    return this.ready;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Convert Baileys JID to the legacy `@c.us`/`@g.us` format used in DB. */
  private normalizeJid(jid: string): string {
    if (!jid) return jid;
    if (jid.endsWith('@s.whatsapp.net')) return jid.replace('@s.whatsapp.net', '@c.us');
    if (jid.endsWith('@lid')) return jid; // keep as-is; downstream code already tolerates
    return jid;
  }

  /** Convert our legacy `@c.us` JID back to Baileys' `@s.whatsapp.net`. */
  private toRawJid(jid: string): string {
    if (!jid) return jid;
    if (jid.endsWith('@c.us')) return jid.replace('@c.us', '@s.whatsapp.net');
    return jid; // groups stay `@g.us`, broadcasts stay `@broadcast`
  }

  private isGroupJid(jid: string): boolean {
    return !!isJidGroup(jid) || jid.endsWith('@g.us');
  }

  private cacheGroupMetadata(meta: GroupMetadata): void {
    const raw = meta.id;
    const normalized = this.normalizeJid(raw);
    this.groupMetaCache.set(raw, meta);
    const previous = this.chatStore.get(normalized);
    this.chatStore.set(normalized, {
      id: normalized,
      rawJid: raw,
      name: meta.subject || previous?.name || raw,
      isGroup: true,
      unreadCount: previous?.unreadCount || 0,
      timestamp: previous?.timestamp || Number(meta.creation || 0),
    });
  }

  private async markSenderKeyDevicesAsSent(rawJid: string, deviceJids: string[]): Promise<void> {
    if (!this.sock || !deviceJids.length) return;
    const current = await this.sock.authState.keys.get('sender-key-memory', [rawJid]);
    const senderKeyMap = { ...(current[rawJid] || {}) } as Record<string, boolean>;
    for (const jid of deviceJids) {
      senderKeyMap[jid] = true;
    }
    await this.sock.authState.keys.set({ 'sender-key-memory': { [rawJid]: senderKeyMap } });
  }

  private chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
      chunks.push(items.slice(i, i + size));
    }
    return chunks;
  }

  private phoneFromJid(jid: string): string | undefined {
    if (!jid) return undefined;
    const at = jid.indexOf('@');
    const user = at > 0 ? jid.slice(0, at) : jid;
    // strip any device suffix like ":1"
    const colon = user.indexOf(':');
    return colon > 0 ? user.slice(0, colon) : user;
  }

  private rememberKey(waMessageId: string, key: WAMessageKey, chatJid: string): void {
    if (!waMessageId) return;
    if (this.keyCache.size >= KEY_CACHE_MAX) {
      const firstKey = this.keyCache.keys().next().value;
      if (firstKey) this.keyCache.delete(firstKey);
    }
    this.keyCache.set(waMessageId, { key, chatJid });
  }

  private rememberMessageForRetry(
    key: WAMessageKey | undefined,
    message: proto.IMessage | null | undefined
  ): void {
    if (!key?.id || !message) return;
    this.retryMessageCache.set(key.id, message);
    if (key.remoteJid) {
      this.retryMessageCache.set(this.retryMessageCacheKey(key.remoteJid, key.id), message);
    }
  }

  private retryMessageCacheKey(remoteJid: string, messageId: string): string {
    return `${remoteJid}:${messageId}`;
  }

  private async getMessageForRetry(key: proto.IMessageKey): Promise<proto.IMessage | undefined> {
    const messageId = key.id || '';
    if (!messageId) return undefined;

    const remoteJid = key.remoteJid || '';
    const cached =
      (remoteJid
        ? this.retryMessageCache.get<proto.IMessage>(
            this.retryMessageCacheKey(remoteJid, messageId)
          )
        : undefined) || this.retryMessageCache.get<proto.IMessage>(messageId);
    if (cached) {
      this.logger.debug(
        `WhatsApp retry message cache hit remoteJid=${remoteJid || 'unknown'} messageId=${messageId}`
      );
      return cached;
    }

    const reconstructed = await this.reconstructMessageForRetryFromDb(messageId);
    if (reconstructed) {
      this.logger.debug(`WhatsApp retry message reconstructed from DB messageId=${messageId}`);
      this.retryMessageCache.set(messageId, reconstructed);
      if (remoteJid) {
        this.retryMessageCache.set(this.retryMessageCacheKey(remoteJid, messageId), reconstructed);
      }
      return reconstructed;
    }

    this.logger.warn(
      `WhatsApp retry requested but message content is unavailable remoteJid=${remoteJid || 'unknown'} messageId=${messageId}`
    );
    return undefined;
  }

  private async reconstructMessageForRetryFromDb(
    messageId: string
  ): Promise<proto.IMessage | undefined> {
    try {
      const pool = getPool();
      const r = await pool.query(
        `SELECT content, message_type
         FROM messages
         WHERE wa_message_id = $1 AND platform = 'whatsapp'
         LIMIT 1`,
        [messageId]
      );
      const row = r.rows[0] as { content: string | null; message_type: string | null } | undefined;
      if (!row || row.message_type !== 'TEXT' || !row.content) return undefined;
      return { conversation: row.content };
    } catch (e: any) {
      this.logger.warn(
        `WhatsApp retry DB lookup failed messageId=${messageId}: ${e?.message || e}`
      );
      return undefined;
    }
  }

  private async reconstructKeyFromDb(
    waMessageId: string,
    chatId: string
  ): Promise<WAMessageKey | null> {
    const pool = getPool();
    const r = await pool.query(
      `SELECT direction, sender_wa_id FROM messages WHERE wa_message_id = $1 LIMIT 1`,
      [waMessageId]
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    const fromMe = row.direction === 'OUTBOUND';
    const remoteJid = this.toRawJid(chatId);
    let participant: string | undefined;
    if (isJidGroup(remoteJid)) {
      participant = this.toRawJid(row.sender_wa_id);
    }
    return { id: waMessageId, remoteJid, fromMe, participant };
  }

  private shouldRetryGroupSend(failureClass: WhatsAppSendFailureClass): boolean {
    return (
      failureClass === 'missing_session' || failureClass === 'timeout' || failureClass === 'unknown'
    );
  }

  private async sendTextWithTimeout(
    rawJid: string,
    content: string,
    timeoutMs: number,
    options?: { useCachedGroupMetadata?: boolean; quoted?: proto.IWebMessageInfo }
  ): Promise<proto.WebMessageInfo | undefined> {
    if (!this.sock) throw new Error('Client not initialized');
    const sendOpts: any = {};
    if (options?.useCachedGroupMetadata !== undefined) {
      sendOpts.useCachedGroupMetadata = options.useCachedGroupMetadata;
    }
    if (options?.quoted) sendOpts.quoted = options.quoted;
    return this.race(
      this.sock.sendMessage(rawJid, { text: content }, sendOpts),
      timeoutMs,
      `sendMessage timeout after ${timeoutMs}ms`
    );
  }

  private buildSendError(
    failureClass: WhatsAppSendFailureClass,
    rawJid: string,
    normalizedJid: string,
    isGroup: boolean,
    started: number,
    attempts: number,
    cause: unknown,
    repair?: GroupSessionRefreshResult
  ): WhatsAppSendError {
    const causeMessage = errorMessage(cause);
    const details: SendFailureDetails = {
      failureClass,
      rawJid,
      normalizedJid,
      isGroup,
      groupSubject: repair?.groupSubject,
      participantCount: repair?.participantCount,
      attempts,
      elapsedMs: Date.now() - started,
      causeMessage,
      actionable: actionableForFailure(failureClass, isGroup),
      repair,
    };
    return new WhatsAppSendError(
      `WhatsApp send failed (${failureClass}): ${causeMessage}`,
      details,
      cause
    );
  }

  private race<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(msg)), ms);
      p.then(
        v => {
          clearTimeout(t);
          resolve(v);
        },
        e => {
          clearTimeout(t);
          reject(e);
        }
      );
    });
  }
}
