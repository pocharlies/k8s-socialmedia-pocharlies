import { MinIOClient } from '../infrastructure/storage/minio-client';
import { Attachment, AttachmentType } from '../domain/entities/attachment.entity';
import { Pool } from 'pg';
import pino from 'pino';

export class MediaService {
  private minio: MinIOClient;
  private dbClient: Pool;
  private logger: pino.Logger;

  constructor(minio: MinIOClient, dbClient: Pool) {
    this.minio = minio;
    this.dbClient = dbClient;
    this.logger = pino({
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    });
  }

  /**
   * Generates a storage key for an attachment
   */
  private generateStorageKey(
    messageId: string,
    attachmentType: AttachmentType,
    fileName?: string
  ): string {
    const timestamp = Date.now();
    const extension = fileName
      ? fileName.split('.').pop()
      : this.getExtensionForType(attachmentType);
    return `attachments/${messageId}/${timestamp}.${extension}`;
  }

  /**
   * Gets file extension for attachment type
   */
  private getExtensionForType(type: AttachmentType): string {
    const extensions: Record<AttachmentType, string> = {
      [AttachmentType.IMAGE]: 'jpg',
      [AttachmentType.VIDEO]: 'mp4',
      [AttachmentType.AUDIO]: 'mp3',
      [AttachmentType.DOCUMENT]: 'bin',
      [AttachmentType.VOICE]: 'ogg',
    };
    return extensions[type] || 'bin';
  }

  /**
   * Uploads an attachment
   */
  async uploadAttachment(
    messageId: string,
    data: Buffer,
    attachmentType: AttachmentType,
    mimeType?: string,
    fileName?: string
  ): Promise<string> {
    const storageKey = this.generateStorageKey(messageId, attachmentType, fileName);
    await this.minio.uploadFile(storageKey, data, mimeType, {
      messageId,
      attachmentType,
      fileName: fileName || '',
    });

    this.logger.debug(`Uploaded attachment: ${storageKey}`);
    return storageKey;
  }

  /**
   * Downloads an attachment
   */
  async downloadAttachment(storageKey: string): Promise<Buffer> {
    return await this.minio.downloadFile(storageKey);
  }

  /**
   * Gets a presigned URL for an attachment
   */
  async getAttachmentUrl(storageKey: string, expiresInSeconds: number = 3600): Promise<string> {
    return await this.minio.getPresignedUrl(storageKey, expiresInSeconds);
  }

  /**
   * Generates a thumbnail for an image (simplified - would use image processing library)
   */
  async generateThumbnail(imageData: Buffer, messageId: string): Promise<string> {
    // In production, would use sharp or similar to generate thumbnail
    // For now, we'll just return a placeholder
    const thumbnailKey = `thumbnails/${messageId}/thumb.jpg`;

    // Would process image here
    // const thumbnail = await sharp(imageData).resize(200, 200).toBuffer();
    // await this.minio.uploadFile(thumbnailKey, thumbnail, 'image/jpeg');

    this.logger.debug(`Generated thumbnail: ${thumbnailKey}`);
    return thumbnailKey;
  }

  /**
   * Saves attachment metadata to database
   */
  async saveAttachmentMetadata(attachment: Attachment): Promise<void> {
    await this.dbClient.query(
      `INSERT INTO attachments (
        id, message_id, type, mime_type, file_name, file_size,
        storage_key, thumbnail_key, duration, width, height, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (id) DO UPDATE SET
        storage_key = EXCLUDED.storage_key,
        thumbnail_key = EXCLUDED.thumbnail_key`,
      [
        attachment.id,
        attachment.messageId,
        attachment.type,
        attachment.mimeType,
        attachment.fileName,
        attachment.fileSize,
        attachment.storageKey,
        attachment.thumbnailKey,
        attachment.duration,
        attachment.width,
        attachment.height,
        attachment.createdAt,
      ]
    );
  }

  /**
   * Deletes an attachment
   */
  async deleteAttachment(storageKey: string, thumbnailKey?: string): Promise<void> {
    await this.minio.deleteFile(storageKey);
    if (thumbnailKey) {
      await this.minio.deleteFile(thumbnailKey);
    }
    this.logger.debug(`Deleted attachment: ${storageKey}`);
  }
}
