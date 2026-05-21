/**
 * Instagram Event Publisher — Multi-account.
 * NATS subjects include account name: instagram.{account}.{type}.received
 */

import { connect, NatsConnection, JSONCodec, ConnectionOptions } from 'nats';
import pino from 'pino';
import type { WebhookEvent } from './webhook';

const jsonCodec = JSONCodec();

const logger = pino({
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

export class InstagramEventPublisher {
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
      logger.warn(`NATS unavailable, running without event publishing: ${String(error)}`);
      this.connected = false;
    }
  }

  publish(account: string, event: WebhookEvent): void {
    if (!this.nc || !this.connected) {
      logger.debug('NATS not connected, skipping event');
      return;
    }

    const subject = `instagram.${account}.${event.type}.received`;
    try {
      this.nc.publish(subject, jsonCodec.encode({
        platform: 'instagram',
        account,
        eventType: event.type,
        senderId: event.senderId,
        senderUsername: event.senderUsername,
        conversationId: event.conversationId,
        messageId: event.messageId,
        text: event.text,
        mediaId: event.mediaId,
        timestamp: event.timestamp,
      }));
      logger.debug({ subject, account }, 'Event published to NATS');
    } catch (error) {
      logger.error(`Failed to publish to NATS: ${String(error)}`);
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
