import * as MinIO from 'minio';
import { Readable } from 'stream';
import pino from 'pino';
import * as https from 'https';
import * as fs from 'fs';

export class MinIOClient {
  private client: MinIO.Client;
  private bucketName: string;
  private logger: pino.Logger;

  constructor(
    endpoint: string,
    accessKey: string,
    secretKey: string,
    bucketName: string = 'whatsapp-attachments',
    useSSL: boolean = false,
    caCertPath?: string
  ) {
    const [host, port] = endpoint.split(':');

    const clientOptions: MinIO.ClientOptions = {
      endPoint: host,
      port: port ? parseInt(port, 10) : useSSL ? 443 : 9000,
      useSSL,
      accessKey,
      secretKey,
    };

    // Add custom CA certificate for TLS verification if provided
    if (useSSL && caCertPath) {
      const ca = fs.readFileSync(caCertPath, 'utf-8');
      clientOptions.transportAgent = new https.Agent({
        ca: ca,
        rejectUnauthorized: true,
      });
    }

    this.client = new MinIO.Client(clientOptions);
    this.bucketName = bucketName;
    this.logger = pino({
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    });
  }

  /**
   * Ensures the bucket exists
   */
  async ensureBucket(): Promise<void> {
    const exists = await this.client.bucketExists(this.bucketName);
    if (!exists) {
      await this.client.makeBucket(this.bucketName, 'us-east-1');
      this.logger.info(`Created bucket: ${this.bucketName}`);
    }
  }

  /**
   * Uploads a file to MinIO
   */
  async uploadFile(
    objectName: string,
    data: Buffer | Readable,
    contentType?: string,
    metadata?: Record<string, string>
  ): Promise<string> {
    await this.ensureBucket();

    const metaData: Record<string, string> = {};
    if (contentType) {
      metaData['Content-Type'] = contentType;
    }
    if (metadata) {
      Object.assign(metaData, metadata);
    }

    await this.client.putObject(this.bucketName, objectName, data, undefined, metaData);
    this.logger.debug(`Uploaded file: ${objectName}`);

    return objectName;
  }

  /**
   * Downloads a file from MinIO
   */
  async downloadFile(objectName: string): Promise<Buffer> {
    const stream = await this.client.getObject(this.bucketName, objectName);
    const chunks: Buffer[] = [];

    return new Promise((resolve, reject) => {
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  /**
   * Gets a presigned URL for downloading (expires in 1 hour)
   */
  async getPresignedUrl(objectName: string, expiresInSeconds: number = 3600): Promise<string> {
    return await this.client.presignedGetObject(this.bucketName, objectName, expiresInSeconds);
  }

  /**
   * Deletes a file from MinIO
   */
  async deleteFile(objectName: string): Promise<void> {
    await this.client.removeObject(this.bucketName, objectName);
    this.logger.debug(`Deleted file: ${objectName}`);
  }

  /**
   * Checks if a file exists
   */
  async fileExists(objectName: string): Promise<boolean> {
    try {
      await this.client.statObject(this.bucketName, objectName);
      return true;
    } catch (error) {
      if ((error as any).code === 'NotFound') {
        return false;
      }
      throw error;
    }
  }
}
