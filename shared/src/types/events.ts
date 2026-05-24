/**
 * Event types emitted by the WhatsApp and Telegram Connectors
 */

export enum EventType {
  MESSAGE_RECEIVED = 'MessageReceived',
  MESSAGE_UPDATED = 'MessageUpdated',
  CHAT_UPDATED = 'ChatUpdated',
  // Telegram-specific events
  TELEGRAM_MESSAGE_RECEIVED = 'TelegramMessageReceived',
  TELEGRAM_CHAT_UPDATED = 'TelegramChatUpdated',
}

export type Platform = 'whatsapp' | 'telegram';

export interface MessageReceivedEvent {
  eventType: EventType.MESSAGE_RECEIVED;
  conversationId: string;
  waMessageId: string;
  waTimestamp: string; // ISO timestamp
  senderWaId: string;
  content: string;
  messageType: string;
  attachments?: Array<{
    type: string;
    url: string;
    metadata: Record<string, unknown>;
  }>;
  isForwarded: boolean;
  replyToWaId?: string;
  /** Owning account: 'personal' | 'professional'. Defaults to 'personal'. */
  account?: string;
}

export interface MessageUpdatedEvent {
  eventType: EventType.MESSAGE_UPDATED;
  waMessageId: string;
  updateType: 'EDITED' | 'DELETED';
  newContent?: string;
  updatedAt: string; // ISO timestamp
}

export interface ChatUpdatedEvent {
  eventType: EventType.CHAT_UPDATED;
  waChatId: string;
  updateType: 'NAME_CHANGED' | 'PARTICIPANT_ADDED' | 'PARTICIPANT_REMOVED';
  metadata: Record<string, unknown>;
}

export type WhatsAppEvent = MessageReceivedEvent | MessageUpdatedEvent | ChatUpdatedEvent;

/**
 * Telegram-specific event types
 */

export interface TelegramMessageReceivedEvent {
  eventType: EventType.TELEGRAM_MESSAGE_RECEIVED;
  conversationId: string;
  telegramMessageId: string;
  telegramTimestamp: string; // ISO timestamp
  senderTelegramId: string;
  senderUsername?: string;
  senderFirstName?: string;
  content: string;
  messageType: string;
  attachments?: Array<{
    type: string;
    fileId: string;
    fileName?: string;
    mimeType?: string;
    size?: number;
  }>;
  isForwarded: boolean;
  replyToMessageId?: string;
  isOutbound: boolean;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  chatTitle?: string;
}

export interface TelegramChatUpdatedEvent {
  eventType: EventType.TELEGRAM_CHAT_UPDATED;
  telegramChatId: string;
  updateType: 'NAME_CHANGED' | 'MEMBER_JOINED' | 'MEMBER_LEFT';
  metadata: Record<string, unknown>;
}

export type TelegramEvent = TelegramMessageReceivedEvent | TelegramChatUpdatedEvent;

export type MessagingEvent = WhatsAppEvent | TelegramEvent;
