export enum AttachmentType {
  IMAGE = 'IMAGE',
  VIDEO = 'VIDEO',
  AUDIO = 'AUDIO',
  DOCUMENT = 'DOCUMENT',
  VOICE = 'VOICE',
}

export class Attachment {
  constructor(
    public id: string,
    public messageId: string,
    public type: AttachmentType,
    public mimeType: string | null,
    public fileName: string | null,
    public fileSize: number,
    public storageKey: string,
    public thumbnailKey: string | null,
    public duration: number | null,
    public width: number | null,
    public height: number | null,
    public createdAt: Date
  ) {}

  static create(
    messageId: string,
    type: AttachmentType,
    storageKey: string,
    fileSize: number,
    mimeType: string | null = null,
    fileName: string | null = null
  ): Attachment {
    return new Attachment(
      crypto.randomUUID(),
      messageId,
      type,
      mimeType,
      fileName,
      fileSize,
      storageKey,
      null,
      null,
      null,
      null,
      new Date()
    );
  }

  setThumbnail(thumbnailKey: string): void {
    this.thumbnailKey = thumbnailKey;
  }

  setDimensions(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  setDuration(duration: number): void {
    this.duration = duration;
  }
}
