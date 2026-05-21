import { connect, NatsConnection, JSONCodec, Codec, ConnectionOptions } from 'nats';
import {
  MessageReceivedEvent,
  MessageUpdatedEvent,
  ChatUpdatedEvent,
  WhatsAppEvent,
  EventType,
} from '@mcp-socialmedia/shared';
import pino from 'pino';
import * as fs from 'fs';

const jsonCodec: Codec<WhatsAppEvent> = JSONCodec();

export class EventPublisher {
  private nc: NatsConnection | null = null;
  private logger: pino.Logger;
  private caCertPath?: string;
  private connected = false;

  constructor(
    private natsUrl: string,
    caCertPath?: string
  ) {
    this.caCertPath = caCertPath;
    this.logger = pino({
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    });
  }

  async connect(): Promise<void> {
    try {
      const options: ConnectionOptions = { servers: this.natsUrl };
      if (this.natsUrl.startsWith('tls://') && this.caCertPath) {
        const ca = fs.readFileSync(this.caCertPath, 'utf-8');
        options.tls = { ca };
      }
      this.nc = await connect(options);
      this.connected = true;
      this.logger.info('Connected to NATS' + (this.caCertPath ? ' with TLS' : ''));
    } catch (error) {
      this.logger.warn(`NATS unavailable, running without event publishing: ${String(error)}`);
      this.connected = false;
      // Don't throw — NATS is optional
    }
  }

  publishMessageReceived(event: MessageReceivedEvent): void {
    if (!this.nc || !this.connected) {
      this.logger.debug('NATS not connected, skipping message event');
      return;
    }
    try {
      this.nc.publish(`whatsapp.${EventType.MESSAGE_RECEIVED}`, jsonCodec.encode(event));
    } catch (error) {
      this.logger.error(`Failed to publish: ${String(error)}`);
    }
  }

  publishMessageUpdated(event: MessageUpdatedEvent): void {
    if (!this.nc || !this.connected) return;
    try {
      this.nc.publish(`whatsapp.${EventType.MESSAGE_UPDATED}`, jsonCodec.encode(event));
    } catch (error) {
      this.logger.error(`Failed to publish: ${String(error)}`);
    }
  }

  publishChatUpdated(event: ChatUpdatedEvent): void {
    if (!this.nc || !this.connected) return;
    try {
      this.nc.publish(`whatsapp.${EventType.CHAT_UPDATED}`, jsonCodec.encode(event));
    } catch (error) {
      this.logger.error(`Failed to publish: ${String(error)}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.nc) {
      await this.nc.close();
      this.nc = null;
      this.logger.info('Disconnected from NATS');
    }
  }
}
