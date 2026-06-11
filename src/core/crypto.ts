import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for settings marked secret. The key is derived from the
 * SECRET_KEY env var, so database dumps never contain usable credentials.
 * Wire format: base64(iv).base64(tag).base64(ciphertext)
 */
export class SecretBox {
  private key: Buffer;

  constructor(secretKey: string) {
    if (!secretKey) throw new Error('SECRET_KEY is required (e.g. `openssl rand -hex 32`)');
    this.key = createHash('sha256').update(secretKey).digest();
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ciphertext.toString('base64')}`;
  }

  decrypt(payload: string): string {
    const [iv, tag, ciphertext] = payload.split('.');
    if (!iv || !tag || !ciphertext) throw new Error('malformed secret payload');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
  }
}

export function generateToken(): string {
  return randomBytes(24).toString('base64url');
}
