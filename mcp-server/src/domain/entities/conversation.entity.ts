export enum ConversationType {
  INDIVIDUAL = 'INDIVIDUAL',
  GROUP = 'GROUP',
}

export class Conversation {
  constructor(
    public id: string,
    public waChatId: string,
    public type: ConversationType,
    public name: string | null,
    public avatarUrl: string | null,
    public lastMessageAt: Date | null,
    public createdAt: Date,
    public updatedAt: Date,
    public metadata: Record<string, unknown> | null
  ) {}

  static create(
    waChatId: string,
    type: ConversationType,
    name: string | null = null,
    avatarUrl: string | null = null
  ): Conversation {
    const now = new Date();
    return new Conversation(
      crypto.randomUUID(),
      waChatId,
      type,
      name,
      avatarUrl,
      null,
      now,
      now,
      null
    );
  }

  updateLastMessageAt(timestamp: Date): void {
    this.lastMessageAt = timestamp;
    this.updatedAt = new Date();
  }

  updateMetadata(metadata: Record<string, unknown>): void {
    this.metadata = { ...(this.metadata || {}), ...metadata };
    this.updatedAt = new Date();
  }
}
