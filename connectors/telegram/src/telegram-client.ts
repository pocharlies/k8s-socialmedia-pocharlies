import { TelegramClient, MemoryStorage, InputMedia, Message, Peer, User, Chat } from '@mtcute/node';
import { EventEmitter } from 'events';
import pino from 'pino';

export interface TelegramMessage {
  conversationId: string;
  telegramMessageId: string;
  telegramTimestamp: Date;
  senderTelegramId: string;
  senderUsername?: string;
  senderFirstName?: string;
  content: string | null;
  messageType:
    | 'TEXT'
    | 'PHOTO'
    | 'VIDEO'
    | 'AUDIO'
    | 'DOCUMENT'
    | 'STICKER'
    | 'VOICE'
    | 'VIDEO_NOTE'
    | 'LOCATION'
    | 'CONTACT';
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

export interface TelegramClientConfig {
  apiId: number;
  apiHash: string;
  sessionString?: string;
}

/**
 * Coerce a chatId received as string (HTTP path param) to the right type for mtcute.
 * mtcute resolves strings as usernames, so numeric IDs must be passed as `number`.
 * Negative supergroup IDs (e.g. `-1003749364241`) fit safely in JS Number.
 */
function toMtcutePeer(chatId: string): string | number {
  if (chatId === 'me' || chatId === 'self') return chatId;
  if (/^-?\d+$/.test(chatId)) return Number(chatId);
  return chatId;
}

function mapChatType(peer: Peer | undefined | null): TelegramMessage['chatType'] {
  if (!peer) return 'private';
  if (peer.type === 'user') return 'private';
  // Chat with chatType: 'group' | 'supergroup' | 'channel' | 'gigagroup' | 'monoforum'
  const ct = (peer as Chat).chatType;
  if (ct === 'group') return 'group';
  if (ct === 'channel') return 'channel';
  // supergroup, gigagroup, monoforum, forum all map to 'supergroup'
  return 'supergroup';
}

function chatTitleOf(peer: Peer | undefined | null): string | undefined {
  if (!peer) return undefined;
  if (peer.type === 'chat') return (peer as Chat).title || undefined;
  const u = peer as User;
  return u.displayName || u.firstName || u.username || undefined;
}

export class TelegramClientWrapper extends EventEmitter {
  private client: TelegramClient;
  private sessionString: string;
  private logger: pino.Logger;
  private connected: boolean = false;
  private selfId?: string;

  constructor(config: TelegramClientConfig) {
    super();
    this.sessionString = config.sessionString || '';
    this.logger = pino({
      transport: { target: 'pino-pretty', options: { colorize: true } },
    });

    this.client = new TelegramClient({
      apiId: config.apiId,
      apiHash: config.apiHash,
      storage: new MemoryStorage(),
      // Dispatch outgoing messages we send to the event handler too. mtcute
      // defaults to no-dispatch on self-sent messages; we want them on NATS
      // for parity with the previous gramjs behavior (incoming + outgoing).
      updates: { disableNoDispatch: true },
    });
  }

  async connect(): Promise<void> {
    if (!this.sessionString) {
      throw new Error('TELEGRAM_SESSION_STRING required — run pnpm generate-session');
    }

    // start() consumes the session string and signs in
    await this.client.start({ session: this.sessionString });

    const me = await this.client.getMe();
    this.selfId = me.id.toString();
    this.connected = true;
    this.logger.info(`Connected to Telegram as ${me.username || me.firstName} (id=${this.selfId})`);
    this.emit('connected');

    // Register the message event handler — fires for incoming + outgoing
    this.client.onNewMessage.add(async (message: Message) => {
      try {
        const parsed = await this.parseMessage(message);
        if (parsed) this.emit('message', parsed);
      } catch (e) {
        this.logger.error(`Error processing message: ${e}`);
      }
    });
    this.logger.info('NewMessage event handler registered (incoming + outgoing)');
  }

  private async parseMessage(message: Message): Promise<TelegramMessage | null> {
    try {
      const chat = message.chat;
      const sender = message.sender;
      const media = message.media;

      let messageType: TelegramMessage['messageType'] = 'TEXT';
      const attachments: TelegramMessage['attachments'] = [];

      if (media) {
        switch (media.type) {
          case 'photo':
            messageType = 'PHOTO';
            attachments.push({ type: 'photo', fileId: media.fileId });
            break;
          case 'video':
            // Round (video note) vs regular video
            if ((media as any).isRound) {
              messageType = 'VIDEO_NOTE';
            } else {
              messageType = 'VIDEO';
            }
            attachments.push({
              type: 'video',
              fileId: media.fileId,
              mimeType: media.mimeType || undefined,
              size: media.fileSize ? Number(media.fileSize) : undefined,
            });
            break;
          case 'voice':
            messageType = 'VOICE';
            attachments.push({
              type: 'voice',
              fileId: media.fileId,
              mimeType: media.mimeType || undefined,
            });
            break;
          case 'audio':
            messageType = 'AUDIO';
            attachments.push({
              type: 'audio',
              fileId: media.fileId,
              mimeType: media.mimeType || undefined,
            });
            break;
          case 'document':
            messageType = 'DOCUMENT';
            attachments.push({
              type: 'document',
              fileId: media.fileId,
              fileName: media.fileName || undefined,
              mimeType: media.mimeType || undefined,
              size: media.fileSize ? Number(media.fileSize) : undefined,
            });
            break;
          case 'sticker':
            messageType = 'STICKER';
            attachments.push({ type: 'sticker', fileId: media.fileId });
            break;
          case 'location':
          case 'live_location':
            messageType = 'LOCATION';
            break;
          case 'contact':
            messageType = 'CONTACT';
            break;
        }
      }

      const senderId = sender ? sender.id.toString() : '';
      const isOutbound = message.isOutgoing;
      const senderUser = sender && sender.type === 'user' ? (sender as User) : undefined;

      return {
        conversationId: chat.id.toString(),
        telegramMessageId: message.id.toString(),
        telegramTimestamp: message.date,
        senderTelegramId: senderId,
        senderUsername: senderUser?.username || undefined,
        senderFirstName: senderUser?.firstName || undefined,
        content: message.text || null,
        messageType,
        attachments: attachments.length > 0 ? attachments : undefined,
        isForwarded: !!message.forward,
        replyToMessageId: message.replyToMessage?.id?.toString(),
        isOutbound,
        chatType: mapChatType(chat),
        chatTitle: chatTitleOf(chat),
      };
    } catch (e) {
      this.logger.error(`Error parsing message: ${e}`);
      return null;
    }
  }

  /**
   * Send a text message. For forum supergroups, pass topicId to thread into that topic.
   */
  async sendMessage(
    chatId: string,
    text: string,
    topicId?: number,
    replyTo?: number
  ): Promise<string | null> {
    if (!this.connected) throw new Error('Not connected to Telegram');
    try {
      // mtcute: replyTo is the id of the message we quote. For forum topics
      // the topic root id IS a reply-to too (replyTo = topicId). When both
      // are present we prefer replyTo (explicit quote) and pass topicId via
      // topMsgId so the message still lands in the right forum thread.
      const opts: any = {};
      if (replyTo) {
        opts.replyTo = replyTo;
        if (topicId) opts.topMsgId = topicId;
      } else if (topicId) {
        opts.replyTo = topicId;
      }
      const sent = await this.client.sendText(
        toMtcutePeer(chatId),
        text,
        Object.keys(opts).length ? opts : undefined
      );
      this.logger.info(
        `Message sent to ${chatId}${topicId ? ` (topic ${topicId})` : ''}${replyTo ? ` (reply to ${replyTo})` : ''}`
      );
      return sent && (sent as any).id ? String((sent as any).id) : null;
    } catch (e) {
      this.logger.error(`Failed to send message: ${e}`);
      throw e;
    }
  }

  /**
   * Get all dialogs (chats)
   */
  async getDialogs(): Promise<
    Array<{
      id: string;
      name: string;
      type: 'private' | 'group' | 'supergroup' | 'channel';
      unreadCount: number;
    }>
  > {
    if (!this.connected) throw new Error('Not connected to Telegram');
    const result: Array<{
      id: string;
      name: string;
      type: TelegramMessage['chatType'];
      unreadCount: number;
    }> = [];
    for await (const dialog of this.client.iterDialogs({})) {
      const peer = dialog.peer;
      result.push({
        id: peer.id.toString(),
        name: chatTitleOf(peer) || 'Unknown',
        type: mapChatType(peer),
        unreadCount: dialog.unreadCount,
      });
    }
    return result;
  }

  /**
   * Get message history for a chat
   */
  async getMessages(
    chatId: string,
    limit: number = 100,
    offsetId?: number
  ): Promise<TelegramMessage[]> {
    if (!this.connected) throw new Error('Not connected to Telegram');
    const params: { limit: number; offset?: { id: number; date: number } } = { limit };
    if (offsetId) params.offset = { id: offsetId, date: 0 };

    const messages = await this.client.getHistory(toMtcutePeer(chatId), params);
    const out: TelegramMessage[] = [];
    for (const m of messages) {
      const p = await this.parseMessage(m);
      if (p) out.push(p);
    }
    return out;
  }

  /**
   * Get session string for persistence
   */
  getSessionString(): string {
    return this.sessionString;
  }

  /**
   * Disconnect from Telegram
   */
  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.destroy();
      this.connected = false;
      this.logger.info('Disconnected from Telegram');
    }
  }

  isClientConnected(): boolean {
    return this.connected;
  }

  /**
   * Current user info
   */
  async getMe(): Promise<any> {
    if (!this.connected) throw new Error('Not connected');
    const me = await this.client.getMe();
    return {
      id: me.id.toString(),
      username: me.username || null,
      firstName: me.firstName,
      lastName: me.lastName || null,
      phone: me.phoneNumber || null,
    };
  }

  /**
   * Chat info by ID
   */
  async getChatInfo(chatId: string): Promise<any> {
    if (!this.connected) throw new Error('Not connected');
    const peer = await this.client.getPeer(toMtcutePeer(chatId));
    if (peer.type === 'user') {
      const u = peer as User;
      return {
        id: u.id.toString(),
        type: 'private',
        firstName: u.firstName,
        lastName: u.lastName || null,
        username: u.username || null,
        phone: u.phoneNumber || null,
      };
    }
    const c = peer as Chat;
    return {
      id: c.id.toString(),
      type: mapChatType(c),
      title: c.title,
      username: c.username || null,
      participantsCount: c.membersCount || null,
    };
  }

  /**
   * Chat participants
   */
  async getParticipants(chatId: string, limit: number = 100): Promise<any[]> {
    if (!this.connected) throw new Error('Not connected');
    const members = await this.client.getChatMembers(toMtcutePeer(chatId), { limit });
    return members.map(m => {
      const u = m.user;
      return {
        id: u.id.toString(),
        firstName: u.firstName,
        lastName: u.lastName || null,
        username: u.username || null,
        isBot: u.isBot,
      };
    });
  }

  /**
   * Chats with unread messages
   */
  async getUnreadChats(): Promise<any[]> {
    if (!this.connected) throw new Error('Not connected');
    const out: any[] = [];
    for await (const d of this.client.iterDialogs({})) {
      if (d.unreadCount > 0) {
        out.push({
          id: d.peer.id.toString(),
          name: chatTitleOf(d.peer) || 'Unknown',
          type: mapChatType(d.peer),
          unreadCount: d.unreadCount,
        });
      }
    }
    return out;
  }

  /**
   * Search messages globally or within a chat
   */
  async searchMessages(query: string, chatId?: string, limit: number = 20): Promise<any[]> {
    if (!this.connected) throw new Error('Not connected');
    if (!chatId) {
      const result = await this.client.searchGlobal({ query, limit });
      return result.map(m => ({
        id: m.id.toString(),
        chatId: m.chat.id.toString(),
        text: m.text || '',
        date: m.date.toISOString(),
      }));
    }
    const result = await this.client.searchMessages({ chatId: toMtcutePeer(chatId), query, limit });
    return result.map(m => ({
      id: m.id.toString(),
      chatId,
      text: m.text || '',
      date: m.date.toISOString(),
    }));
  }

  /**
   * Forward a message between chats
   */
  async forwardMessage(fromChatId: string, messageId: number, toChatId: string): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    await this.client.forwardMessagesById({
      toChatId: toMtcutePeer(toChatId),
      fromChatId: toMtcutePeer(fromChatId),
      messages: [messageId],
    });
  }

  /**
   * Delete a message
   */
  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    await this.client.deleteMessagesById(chatId, [messageId], { revoke: true });
  }

  /**
   * Download media from a message
   */
  async downloadMedia(chatId: string, messageId: number): Promise<Buffer | null> {
    if (!this.connected) throw new Error('Not connected');
    const messages = await this.client.getMessages(toMtcutePeer(chatId), [messageId]);
    const msg = messages[0];
    if (!msg || !msg.media) return null;
    const media: any = msg.media;
    if (typeof media.fileId !== 'string') return null;
    const u8 = await this.client.downloadAsBuffer(media.fileId);
    return Buffer.from(u8);
  }

  /**
   * Download the profile photo (big size) of a peer (user OR chat).
   * Returns null if the peer has no photo or it's not accessible (privacy).
   */
  async downloadPeerPhoto(peerId: string): Promise<Buffer | null> {
    if (!this.connected) throw new Error('Not connected');
    let peer: any;
    try {
      peer = await this.client.getPeer(toMtcutePeer(peerId));
    } catch (e) {
      return null;
    }
    const photo: any = (peer as any).photo;
    if (!photo) return null;
    // mtcute exposes a downloadable file id under photo.big (full) or photo.small (thumb).
    // Different mtcute builds use slightly different shapes — try a few.
    const candidates: any[] = [photo.big, photo.small, photo, photo.fileId];
    for (const c of candidates) {
      if (!c) continue;
      try {
        const u8 = await this.client.downloadAsBuffer(c);
        if (u8 && u8.length > 0) return Buffer.from(u8);
      } catch (e) {
        // try next candidate
      }
    }
    return null;
  }

  /**
   * Send a file to a chat
   */
  async sendFile(
    chatId: string,
    filePath: string,
    options?: {
      caption?: string;
      voiceNote?: boolean;
      videoNote?: boolean;
      sticker?: boolean;
    }
  ): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    // Fetch remote http(s) URLs connector-side and upload the bytes. Passing a URL
    // straight to InputMedia makes Telegram fetch it from the public internet, which
    // fails for cluster-internal URLs (WEBPAGE_MEDIA_EMPTY).
    let source: string | Buffer = filePath;
    if (typeof filePath === 'string' && /^https?:\/\//i.test(filePath)) {
      const resp = await fetch(filePath);
      if (!resp.ok) throw new Error(`fetch media failed: ${resp.status} ${filePath}`);
      source = Buffer.from(await resp.arrayBuffer());
    }
    let media;
    if (options?.sticker) {
      // mtcute: stickers go as documents with the sticker MIME so Telegram renders
      // them inline (.webp / .tgs / .webm).
      media = InputMedia.document(source, {
        fileName: 'sticker.webp',
        fileMime: 'image/webp',
      });
    } else if (options?.voiceNote) {
      media = InputMedia.voice(source, {
        fileName: 'voice.ogg',
        ...(options.caption ? { caption: options.caption } : {}),
      });
    } else if (options?.videoNote) {
      media = InputMedia.video(source, {
        isRound: true,
        ...(options.caption ? { caption: options.caption } : {}),
      });
    } else {
      media = InputMedia.document(
        source,
        options?.caption ? { caption: options.caption } : undefined
      );
    }
    await this.client.sendMedia(toMtcutePeer(chatId), media);
  }

  /**
   * Mark a chat as read
   */
  async markAsRead(chatId: string): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    await this.client.readHistory(toMtcutePeer(chatId));
  }
}
