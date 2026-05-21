/**
 * WhatsApp Cloud API Event Publisher — publishes webhook events to NATS.
 * Publishes to the SAME subjects as the old Baileys connector for compatibility.
 */

import { connect, NatsConnection, JSONCodec, ConnectionOptions } from 'nats';
import pino from 'pino';
import type { IncomingMessage, StatusUpdate } from './webhook';
import { EventType, MessageReceivedEvent } from '@mcp-socialmedia/shared';

const jsonCodec = JSONCodec();
const logger = pino({
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

export class WhatsAppCloudPublisher {
  private nc: NatsConnection | null = null;
  private connected = false;

  constructor(
    private natsUrl: string,
    private natsCaCert?: string
  ) {}

  async connect(): Promise<void> {
    try {
      const options: ConnectionOptions = { servers: this.natsUrl };
      if (this.natsUrl.startsWith('tls://') && this.natsCaCert && this.natsCaCert !== 'none') {
        const fs = await import('fs');
        const ca = fs.readFileSync(this.natsCaCert, 'utf-8');
        options.tls = { ca };
      }
      this.nc = await connect(options);
      this.connected = true;
      logger.info('Connected to NATS');
    } catch (error) {
      logger.warn(`NATS unavailable: ${String(error)}`);
      this.connected = false;
    }
  }

  publishMessage(message: IncomingMessage): void {
    if (!this.nc || !this.connected) return;

    // Publish as MessageReceivedEvent — same format as Baileys connector
    const event: MessageReceivedEvent = {
      eventType: EventType.MESSAGE_RECEIVED,
      conversationId: message.from,
      waMessageId: message.waMessageId,
      waTimestamp: message.timestamp,
      senderWaId: message.from,
      content: message.content,
      messageType: message.type,
      attachments: message.attachments,
      isForwarded: message.isForwarded,
      replyToWaId: message.replyToWaId,
    };

    try {
      this.nc.publish(`whatsapp.${EventType.MESSAGE_RECEIVED}`, jsonCodec.encode(event));
      logger.debug({ subject: `whatsapp.${EventType.MESSAGE_RECEIVED}` }, 'Message published');
    } catch (error) {
      logger.error(`Failed to publish: ${String(error)}`);
    }
  }

  publishStatus(status: StatusUpdate): void {
    if (!this.nc || !this.connected) return;
    try {
      this.nc.publish('whatsapp.cloud.status', jsonCodec.encode(status));
    } catch (error) {
      logger.error(`Failed to publish status: ${String(error)}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.nc) {
      await this.nc.close();
      this.nc = null;
      logger.info('Disconnected from NATS');
    }
  }
}
