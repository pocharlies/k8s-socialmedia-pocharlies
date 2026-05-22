import { connect, NatsConnection, JSONCodec, Codec, Subscription, ConnectionOptions } from 'nats';
import {
  MessageReceivedEvent,
  MessageUpdatedEvent,
  ChatUpdatedEvent,
  WhatsAppEvent,
  EventType,
} from '@mcp-socialmedia/shared';
import { MessageIngestionService } from '../../application/message-ingestion.service';
import {
  InstagramIngestionService,
  InstagramEvent,
} from '../../application/instagram-ingestion.service';
import pino from 'pino';
import * as fs from 'fs';

const jsonCodec: Codec<WhatsAppEvent> = JSONCodec();
const rawJsonCodec = JSONCodec<unknown>();

export class EventConsumers {
  private nc: NatsConnection | null = null;
  private subscriptions: Subscription[] = [];
  private logger: pino.Logger;
  private caCertPath?: string;
  private instagramService?: InstagramIngestionService;

  constructor(
    private natsUrl: string,
    private ingestionService: MessageIngestionService,
    caCertPath?: string,
    instagramService?: InstagramIngestionService
  ) {
    this.caCertPath = caCertPath;
    this.instagramService = instagramService;
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

      // Configure TLS if using tls:// protocol and CA cert is provided
      if (this.natsUrl.startsWith('tls://') && this.caCertPath) {
        const ca = fs.readFileSync(this.caCertPath, 'utf-8');
        options.tls = {
          ca: ca,
        };
      }

      this.nc = await connect(options);
      this.logger.info(
        'Connected to NATS for consuming events' + (this.caCertPath ? ' with TLS' : '')
      );

      // Subscribe to message received events
      const messageSub = this.nc.subscribe(`whatsapp.${EventType.MESSAGE_RECEIVED}`, {
        callback: async (err, msg) => {
          if (err) {
            this.logger.error(`Error in message subscription: ${err?.message ?? String(err)}`);
            return;
          }

          try {
            const event = jsonCodec.decode(msg.data) as MessageReceivedEvent;
            await this.ingestionService.handleMessageReceived(event);
          } catch (error) {
            this.logger.error(`Error processing message received event: ${error}`);
          }
        },
      });
      this.subscriptions.push(messageSub);

      // Subscribe to message updated events
      const updateSub = this.nc.subscribe(`whatsapp.${EventType.MESSAGE_UPDATED}`, {
        callback: async (err, msg) => {
          if (err) {
            this.logger.error(
              `Error in message update subscription: ${err?.message ?? String(err)}`
            );
            return;
          }

          try {
            const event = jsonCodec.decode(msg.data) as MessageUpdatedEvent;
            await this.ingestionService.handleMessageUpdated(event);
          } catch (error) {
            this.logger.error(`Error processing message updated event: ${error}`);
          }
        },
      });
      this.subscriptions.push(updateSub);

      // Subscribe to chat updated events
      const chatSub = this.nc.subscribe(`whatsapp.${EventType.CHAT_UPDATED}`, {
        callback: async (err, msg) => {
          if (err) {
            this.logger.error(`Error in chat update subscription: ${err?.message ?? String(err)}`);
            return;
          }

          try {
            const event = jsonCodec.decode(msg.data) as ChatUpdatedEvent;
            await this.ingestionService.handleChatUpdated(event);
          } catch (error) {
            this.logger.error(`Error processing chat updated event: ${error}`);
          }
        },
      });
      this.subscriptions.push(chatSub);

      // Instagram — wildcard `instagram.>` covers all of:
      // instagram.{account}.{type}.received  →  e.g. instagram.skirmshop.dm.received
      // instagram.{account}.{type}.received  →  e.g. instagram.barbelpapis.comment.received
      if (this.instagramService) {
        const igSub = this.nc.subscribe('instagram.>', {
          callback: async (err, msg) => {
            if (err) {
              this.logger.error(`Error in instagram subscription: ${err?.message ?? String(err)}`);
              return;
            }
            try {
              const payload = rawJsonCodec.decode(msg.data) as InstagramEvent;
              if (!payload?.eventType) {
                this.logger.warn(`IG event missing eventType: subject=${msg.subject}`);
                return;
              }
              await this.instagramService!.handleEvent(payload);
            } catch (e) {
              this.logger.error(`Error processing IG event (${msg.subject}): ${e}`);
            }
          },
        });
        this.subscriptions.push(igSub);
        this.logger.info('Subscribed to instagram.> wildcard');
      }

      this.logger.info('Subscribed to all event types');
    } catch (error) {
      this.logger.error(`Failed to connect to NATS: ${error}`);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    for (const sub of this.subscriptions) {
      await sub.drain();
    }

    if (this.nc) {
      await this.nc.close();
      this.nc = null;
      this.logger.info('Disconnected from NATS');
    }
  }
}
