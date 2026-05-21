import { connect, NatsConnection, StringCodec, TlsOptions } from 'nats';
import pino from 'pino';

export interface TelegramMessageReceivedEvent {
  eventType: 'TelegramMessageReceived';
  conversationId: string;
  telegramMessageId: string;
  telegramTimestamp: string;
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
  chatType: string;
  chatTitle?: string;
}

export interface TelegramChatUpdatedEvent {
  eventType: 'TelegramChatUpdated';
  telegramChatId: string;
  updateType: 'NAME_CHANGED' | 'MEMBER_JOINED' | 'MEMBER_LEFT';
  metadata: Record<string, unknown>;
}

export class TelegramEventPublisher {
  private nc: NatsConnection | null = null;
  private natsUrl: string;
  private caCertPath?: string;
  private sc = StringCodec();
  private logger: pino.Logger;

  constructor(natsUrl: string, caCertPath?: string) {
    this.natsUrl = natsUrl;
    this.caCertPath = caCertPath;
    this.logger = pino({
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    });
  }

  /**
   * Connect to NATS server
   */
  async connect(): Promise<void> {
    try {
      const options: { servers: string; tls?: TlsOptions } = {
        servers: this.natsUrl,
      };

      if (this.caCertPath && this.natsUrl.startsWith('tls://')) {
        options.tls = {
          caFile: this.caCertPath,
        };
      }

      this.nc = await connect(options);
      this.logger.info(`Connected to NATS at ${this.natsUrl}`);
    } catch (error) {
      this.logger.error(`Failed to connect to NATS: ${String(error)}`);
      throw error;
    }
  }

  /**
   * Publish a message received event
   */
  publishMessageReceived(event: TelegramMessageReceivedEvent): void {
    if (!this.nc) {
      throw new Error('Not connected to NATS');
    }

    try {
      const subject = 'telegram.MessageReceived';
      this.nc.publish(subject, this.sc.encode(JSON.stringify(event)));
      this.logger.debug(`Published event to ${subject}`);
    } catch (error) {
      this.logger.error(`Failed to publish message: ${String(error)}`);
      throw error;
    }
  }

  /**
   * Publish a chat updated event
   */
  publishChatUpdated(event: TelegramChatUpdatedEvent): void {
    if (!this.nc) {
      throw new Error('Not connected to NATS');
    }

    try {
      const subject = 'telegram.ChatUpdated';
      this.nc.publish(subject, this.sc.encode(JSON.stringify(event)));
      this.logger.debug(`Published event to ${subject}`);
    } catch (error) {
      this.logger.error(`Failed to publish chat update: ${String(error)}`);
      throw error;
    }
  }

  /**
   * Disconnect from NATS
   */
  async disconnect(): Promise<void> {
    if (this.nc) {
      await this.nc.drain();
      await this.nc.close();
      this.nc = null;
      this.logger.info('Disconnected from NATS');
    }
  }
}
