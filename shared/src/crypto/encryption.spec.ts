import { encryptString, decryptString, generateHMACSignature } from './encryption';

describe('Encryption', () => {
  const testKey = Buffer.from('test-key-12345678901234567890123456789012', 'utf-8');
  const testData = 'Hello, World!';

  it('should encrypt and decrypt a string', () => {
    const encrypted = encryptString(testData, testKey);
    expect(encrypted).not.toBe(testData);
    expect(encrypted.length).toBeGreaterThan(0);

    const decrypted = decryptString(encrypted, testKey);
    expect(decrypted).toBe(testData);
  });

  it('should generate different encrypted values for same input', () => {
    const encrypted1 = encryptString(testData, testKey);
    const encrypted2 = encryptString(testData, testKey);
    // Should be different due to random IV/salt
    expect(encrypted1).not.toBe(encrypted2);
  });

  it('should generate HMAC signature', () => {
    const body = { test: 'data' };
    const timestamp = 1234567890;
    const secret = 'test-secret';

    const signature = generateHMACSignature(body, timestamp, secret);
    expect(signature).toMatch(/^sha256=/);
    expect(signature.length).toBeGreaterThan(10);
  });
});
