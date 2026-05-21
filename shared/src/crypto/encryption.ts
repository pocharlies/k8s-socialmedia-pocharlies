import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync, createHmac } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;

/**
 * Derives an encryption key from a password and optional salt
 */
export function deriveKey(password: string, salt?: Buffer): { key: Buffer; salt: Buffer } {
  const saltBuffer = salt || randomBytes(SALT_LENGTH);
  const key = pbkdf2Sync(password, saltBuffer, ITERATIONS, KEY_LENGTH, 'sha256');
  return { key, salt: saltBuffer };
}

/**
 * Encrypts data using AES-256-GCM
 */
export function encrypt(
  data: string | Buffer,
  key: Buffer
): { encrypted: Buffer; iv: Buffer; salt: Buffer; tag: Buffer } {
  const dataBuffer = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  const iv = randomBytes(IV_LENGTH);
  const { key: derivedKey, salt } = deriveKey(key.toString('hex'));

  const cipher = createCipheriv(ALGORITHM, derivedKey, iv);
  const encrypted = Buffer.concat([cipher.update(dataBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();

  return { encrypted, iv, salt, tag };
}

/**
 * Decrypts data using AES-256-GCM
 */
export function decrypt(
  encrypted: Buffer,
  key: Buffer,
  iv: Buffer,
  salt: Buffer,
  tag: Buffer
): Buffer {
  const { key: derivedKey } = deriveKey(key.toString('hex'), salt);
  const decipher = createDecipheriv(ALGORITHM, derivedKey, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

/**
 * Encrypts a string and returns a base64-encoded result
 */
export function encryptString(data: string, key: Buffer): string {
  const { encrypted, iv, salt, tag } = encrypt(data, key);
  const combined = Buffer.concat([salt, iv, tag, encrypted]);
  return combined.toString('base64');
}

/**
 * Decrypts a base64-encoded string
 */
export function decryptString(encryptedData: string, key: Buffer): string {
  const combined = Buffer.from(encryptedData, 'base64');
  const salt = combined.subarray(0, SALT_LENGTH);
  const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const tag = combined.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const encrypted = combined.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

  const decrypted = decrypt(encrypted, key, iv, salt, tag);
  return decrypted.toString('utf-8');
}

/**
 * Generates HMAC-SHA256 signature for API authentication
 */
export function generateHMACSignature(
  body: unknown,
  timestamp: number,
  sharedSecret: string
): string {
  const message = `${timestamp}:${JSON.stringify(body)}`;
  const signature = createHmac('sha256', sharedSecret).update(message).digest('hex');
  return `sha256=${signature}`;
}
