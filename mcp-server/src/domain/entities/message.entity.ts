import * as crypto from 'crypto';

export enum MessageDirection {
  INBOUND = 'INBOUND',
  OUTBOUND = 'OUTBOUND',
}

export enum MessageType {
  TEXT = 'TEXT',
  IMAGE = 'IMAGE',
  VIDEO = 'VIDEO',
  AUDIO = 'AUDIO',
  DOCUMENT = 'DOCUMENT',
  LOCATION = 'LOCATION',
  CONTACT = 'CONTACT',
  STICKER = 'STICKER',
  SYSTEM = 'SYSTEM',
}

export class Message {
  constructor(
    public id: string,
    public conversationId: string,
    public waMessageId: string,
    public waTimestamp: Date,
    public direction: MessageDirection,
    public senderId: string | null,
    public senderWaId: string,
    public content: string | null,
    public contentHash: string,
    public messageType: MessageType,
    public isForwarded: boolean,
    public isEdited: boolean,
    public editedAt: Date | null,
    public isDeleted: boolean,
    public deletedAt: Date | null,
    public replyToMessageId: string | null,
    public rawPayload: Buffer | null,
    public createdAt: Date,
    public updatedAt: Date
  ) {}

  static create(
    conversationId: string,
    waMessageId: string,
    waTimestamp: Date,
    direction: MessageDirection,
    senderWaId: string,
    content: string | null,
    messageType: MessageType,
    isForwarded: boolean = false,
    senderId: string | null = null,
    replyToMessageId: string | null = null
  ): Message {
    const now = new Date();
    const contentHash = this.hashContent(content || '');
    return new Message(
      crypto.randomUUID(),
      conversationId,
      waMessageId,
      waTimestamp,
      direction,
      senderId,
      senderWaId,
      content,
      contentHash,
      messageType,
      isForwarded,
      false,
      null,
      false,
      null,
      replyToMessageId,
      null,
      now,
      now
    );
  }

  private static hashContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  markAsEdited(newContent: string): void {
    this.content = newContent;
    this.contentHash = Message.hashContent(newContent);
    this.isEdited = true;
    this.editedAt = new Date();
    this.updatedAt = new Date();
  }

  markAsDeleted(): void {
    this.isDeleted = true;
    this.deletedAt = new Date();
    this.updatedAt = new Date();
  }

  setRawPayload(payload: Buffer): void {
    this.rawPayload = payload;
    this.updatedAt = new Date();
  }
}
