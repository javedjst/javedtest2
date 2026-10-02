import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Envelope encryption for OAuth tokens. Each secret gets its own random data key; the data key is
 * wrapped by the master key. In production the wrap/unwrap calls go to AWS KMS (see docs/SECURITY.md),
 * which means the API process never holds the master key. The interface below is the seam for that.
 */
export interface KeyWrapper {
  keyId: string;
  wrap(dataKey: Buffer): Buffer;
  unwrap(wrapped: Buffer): Buffer;
}

export function localKeyWrapper(masterKeyB64: string, keyId: string): KeyWrapper {
  const master = Buffer.from(masterKeyB64, 'base64');
  const key = master.length === 32 ? master : createHash('sha256').update(master).digest();
  const seal = (data: Buffer): Buffer => {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(data), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  };
  const open = (blob: Buffer): Buffer => {
    const d = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
    d.setAuthTag(blob.subarray(12, 28));
    return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
  };
  return { keyId, wrap: seal, unwrap: open };
}

/** Layout: [2 byte wrapped key length][wrapped data key][iv 12][tag 16][ciphertext]. */
export function encryptSecret(plain: string, wrapper: KeyWrapper, aad = ''): Buffer {
  const dataKey = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dataKey, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const wrapped = wrapper.wrap(dataKey);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(wrapped.length);
  return Buffer.concat([len, wrapped, iv, c.getAuthTag(), ct]);
}

/** aad binds the ciphertext to its owner (e.g. the integration id) so rows cannot be swapped. */
export function decryptSecret(blob: Buffer, wrapper: KeyWrapper, aad = ''): string {
  const wlen = blob.readUInt16BE(0);
  const wrapped = blob.subarray(2, 2 + wlen);
  const rest = blob.subarray(2 + wlen);
  const dataKey = wrapper.unwrap(wrapped);
  const d = createDecipheriv('aes-256-gcm', dataKey, rest.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(rest.subarray(12, 28));
  return Buffer.concat([d.update(rest.subarray(28)), d.final()]).toString('utf8');
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
