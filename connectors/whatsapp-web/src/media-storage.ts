/**
 * MinIO uploader for WhatsApp media. Bucket `socialmedia-media` is created
 * out-of-band; we just upload here. Object keys follow `attachments/{messageId}/{ts}.{ext}`.
 *
 * On startup the connector calls `ensureMediaBucket()` to make idempotent the bucket
 * existence check (cheap — single statObject call).
 */
import * as MinIO from 'minio';
import * as fs from 'fs';
import * as https from 'https';

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || 'minio:9000';
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || 'minioadmin';
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || 'minioadmin';
const MINIO_USE_SSL = (process.env.MINIO_USE_SSL || 'true').toLowerCase() === 'true';
const MINIO_CA_CERT = process.env.MINIO_CA_CERT;
const BUCKET = process.env.MINIO_BUCKET || 'socialmedia-media';

const [host, portStr] = MINIO_ENDPOINT.split(':');
const port = portStr ? parseInt(portStr, 10) : MINIO_USE_SSL ? 443 : 9000;

const opts: MinIO.ClientOptions = {
  endPoint: host,
  port,
  useSSL: MINIO_USE_SSL,
  accessKey: MINIO_ACCESS_KEY,
  secretKey: MINIO_SECRET_KEY,
};
if (MINIO_USE_SSL && MINIO_CA_CERT && fs.existsSync(MINIO_CA_CERT)) {
  const ca = fs.readFileSync(MINIO_CA_CERT, 'utf-8');
  opts.transportAgent = new https.Agent({ ca, rejectUnauthorized: true });
}

const client = new MinIO.Client(opts);

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
};

function pickExt(mimeType: string | undefined, fileName: string | undefined): string {
  if (fileName && fileName.includes('.')) {
    return fileName.split('.').pop()!.slice(0, 6);
  }
  if (mimeType && EXT_BY_MIME[mimeType]) return EXT_BY_MIME[mimeType];
  if (mimeType?.startsWith('image/')) return 'bin';
  return 'bin';
}

export async function ensureMediaBucket(): Promise<void> {
  const exists = await client.bucketExists(BUCKET).catch(() => false);
  if (!exists) {
    await client.makeBucket(BUCKET, 'us-east-1');
  }
}

export interface UploadedMedia {
  storageKey: string;
  fileSize: number;
}

export async function uploadMedia(
  messageId: bigint | number,
  data: Buffer,
  mimeType: string | undefined,
  fileName: string | undefined
): Promise<UploadedMedia> {
  const ts = Date.now();
  const ext = pickExt(mimeType, fileName);
  const storageKey = `attachments/${messageId}/${ts}.${ext}`;
  const meta: Record<string, string> = {};
  if (mimeType) meta['Content-Type'] = mimeType;
  if (fileName) meta['x-amz-meta-filename'] = fileName;
  await client.putObject(BUCKET, storageKey, data, data.length, meta);
  return { storageKey, fileSize: data.length };
}
