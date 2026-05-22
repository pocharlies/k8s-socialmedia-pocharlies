import { Pool } from 'pg';
import {
  ConversationType,
  Message,
  MessageDirection,
  MessageType,
  Attachment,
  AttachmentType,
} from '../domain/entities';
import { DatabaseRepository } from '../infrastructure/database/repository';
import {
  MessageReceivedEvent,
  MessageUpdatedEvent,
  ChatUpdatedEvent,
} from '@mcp-socialmedia/shared';
import pino from 'pino';

export class MessageIngestionService {
  private repository: DatabaseRepository;
  private logger: pino.Logger;

  constructor(dbClient: Pool, _encryptionKey: string) {
    this.repository = new DatabaseRepository(dbClient);
    this.logger = pino({
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    });
  }

  async handleMessageReceived(event: MessageReceivedEvent): Promise<void> {
    try {
      // Determine conversation type
      const conversationType = event.conversationId.includes('@g.us')
        ? ConversationType.GROUP
        : ConversationType.INDIVIDUAL;

      // Find or create conversation
      const conversation = await this.repository.findOrCreateConversation(
        event.conversationId,
        conversationType
      );

      // Find or create participant
      const participant = await this.repository.findOrCreateParticipant(
        conversation.id,
        event.senderWaId
      );

      // Map message type
      const messageType = this.mapMessageType(event.messageType);

      // Create message entity
      const message = Message.create(
        conversation.id,
        event.waMessageId,
        new Date(event.waTimestamp),
        MessageDirection.INBOUND,
        event.senderWaId,
        event.content,
        messageType,
        event.isForwarded,
        participant.id,
        undefined // replyToMessageId
      );

      // Save message with plaintext content (no encryption)
      await this.repository.saveMessage(message, event.content || '', null);

      // Save attachments if any
      if (event.attachments) {
        for (const att of event.attachments) {
          const attachmentType = this.mapAttachmentType(att.type);
          const attachment = Attachment.create(
            message.id,
            attachmentType,
            att.url,
            0,
            att.metadata.mimetype as string | null,
            att.metadata.fileName as string | null
          );
          await this.repository.saveAttachment(attachment);
        }
      }

      // Update conversation last message timestamp
      await this.repository.updateConversationLastMessage(
        conversation.id,
        new Date(event.waTimestamp)
      );

      this.logger.debug(`Ingested message ${event.waMessageId}`);
    } catch (error) {
      this.logger.error(`Error ingesting message: ${error}`);
      throw error;
    }
  }

  async handleMessageUpdated(event: MessageUpdatedEvent): Promise<void> {
    this.logger.debug(`Handling message update: ${event.waMessageId}`);
  }

  async handleChatUpdated(event: ChatUpdatedEvent): Promise<void> {
    this.logger.debug(`Handling chat update: ${event.waChatId}`);
  }

  private mapMessageType(type: string): MessageType {
    const mapping: Record<string, MessageType> = {
      TEXT: MessageType.TEXT,
      IMAGE: MessageType.IMAGE,
      VIDEO: MessageType.VIDEO,
      AUDIO: MessageType.AUDIO,
      DOCUMENT: MessageType.DOCUMENT,
      LOCATION: MessageType.LOCATION,
      CONTACT: MessageType.CONTACT,
      STICKER: MessageType.STICKER,
      SYSTEM: MessageType.SYSTEM,
    };
    return mapping[type] || MessageType.TEXT;
  }

  private mapAttachmentType(type: string): AttachmentType {
    const mapping: Record<string, AttachmentType> = {
      IMAGE: AttachmentType.IMAGE,
      VIDEO: AttachmentType.VIDEO,
      AUDIO: AttachmentType.AUDIO,
      DOCUMENT: AttachmentType.DOCUMENT,
      VOICE: AttachmentType.VOICE,
    };
    return mapping[type] || AttachmentType.DOCUMENT;
  }
}
