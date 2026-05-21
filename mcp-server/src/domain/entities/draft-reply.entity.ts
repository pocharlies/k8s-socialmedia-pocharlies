export enum DraftStatus {
  DRAFT = 'DRAFT',
  APPROVED = 'APPROVED',
  SENT = 'SENT',
  REJECTED = 'REJECTED',
}

export enum DraftLanguage {
  EN = 'EN',
  ES = 'ES',
}

export class DraftReply {
  constructor(
    public id: string,
    public conversationId: string,
    public replyToMessageId: string | null,
    public content: string,
    public tone: string | null,
    public language: DraftLanguage,
    public constraints: Record<string, unknown> | null,
    public status: DraftStatus,
    public sendToken: string | null,
    public approvedAt: Date | null,
    public sentAt: Date | null,
    public createdAt: Date,
    public createdBy: string | null
  ) {}

  static create(
    conversationId: string,
    content: string,
    language: DraftLanguage,
    replyToMessageId: string | null = null,
    tone: string | null = null,
    constraints: Record<string, unknown> | null = null,
    createdBy: string | null = null
  ): DraftReply {
    return new DraftReply(
      crypto.randomUUID(),
      conversationId,
      replyToMessageId,
      content,
      tone,
      language,
      constraints,
      DraftStatus.DRAFT,
      null,
      null,
      null,
      new Date(),
      createdBy
    );
  }

  approve(): string {
    if (this.status !== DraftStatus.DRAFT) {
      throw new Error('Only DRAFT status can be approved');
    }
    this.status = DraftStatus.APPROVED;
    this.sendToken = crypto.randomUUID();
    this.approvedAt = new Date();
    return this.sendToken;
  }

  markAsSent(): void {
    if (this.status !== DraftStatus.APPROVED) {
      throw new Error('Only APPROVED drafts can be sent');
    }
    this.status = DraftStatus.SENT;
    this.sentAt = new Date();
  }

  reject(): void {
    this.status = DraftStatus.REJECTED;
  }
}
