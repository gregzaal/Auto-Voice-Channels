import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { decryptStream, encryptStream, isEncrypted, MAGIC, parseKey } from './encryption.js';

const KEY = randomBytes(32);

async function roundTrip(plain: Buffer, key = KEY, decryptKey = key): Promise<Buffer> {
  const enc = await buffer(Readable.from([plain]).pipe(encryptStream(key)));
  return buffer(Readable.from([enc]).pipe(decryptStream(decryptKey)));
}

describe('parseKey', () => {
  it('accepts 64 hex characters', () => {
    expect(parseKey(KEY.toString('hex'))).toEqual(KEY);
  });

  it('accepts base64 decoding to 32 bytes', () => {
    expect(parseKey(KEY.toString('base64'))).toEqual(KEY);
  });

  it('tolerates surrounding whitespace, which a copy-paste always brings', () => {
    expect(parseKey(`  ${KEY.toString('base64')}\n`)).toEqual(KEY);
  });

  /** A short key must fail at startup, not at restore. */
  it('rejects a key that is not 32 bytes', () => {
    expect(() => parseKey(randomBytes(16).toString('base64'))).toThrow(/must be 32 bytes/);
  });

  it('rejects nonsense rather than silently deriving something', () => {
    expect(() => parseKey('hunter2')).toThrow(/must be 32 bytes/);
  });
});

describe('encrypt/decrypt round trip', () => {
  it('recovers the exact bytes', async () => {
    const plain = randomBytes(64 * 1024);
    expect(await roundTrip(plain)).toEqual(plain);
  });

  /** A dump is streamed in many chunks; the tail-buffering must not corrupt it. */
  it('survives being written in many small chunks', async () => {
    const plain = randomBytes(50_000);
    const chunks: Buffer[] = [];
    for (let i = 0; i < plain.length; i += 997) chunks.push(plain.subarray(i, i + 997));
    const enc = await buffer(Readable.from(chunks).pipe(encryptStream(KEY)));
    expect(await buffer(Readable.from([enc]).pipe(decryptStream(KEY)))).toEqual(plain);
  });

  /** An empty dump must still be a valid object, not a zero-byte "success". */
  it('handles empty input', async () => {
    expect(await roundTrip(Buffer.alloc(0))).toEqual(Buffer.alloc(0));
  });

  it('writes the magic prefix so restore can detect the format', async () => {
    const enc = await buffer(Readable.from([Buffer.from('x')]).pipe(encryptStream(KEY)));
    expect(isEncrypted(enc)).toBe(true);
    expect(enc.subarray(0, MAGIC.length)).toEqual(MAGIC);
  });

  it('produces a different IV each run, so identical dumps differ on disk', async () => {
    const plain = Buffer.from('same input');
    const a = await buffer(Readable.from([plain]).pipe(encryptStream(KEY)));
    const b = await buffer(Readable.from([plain]).pipe(encryptStream(KEY)));
    expect(a.equals(b)).toBe(false);
  });
});

describe('decrypt refuses bad input rather than returning garbage', () => {
  it('rejects the wrong key', async () => {
    await expect(roundTrip(randomBytes(1024), KEY, randomBytes(32))).rejects.toThrow(
      /failed authentication/,
    );
  });

  /** One flipped bit anywhere must fail the whole object. That is why GCM. */
  it('rejects a single flipped bit in the ciphertext', async () => {
    const enc = await buffer(Readable.from([randomBytes(4096)]).pipe(encryptStream(KEY)));
    enc[MAGIC.length + 12 + 100] ^= 0x01;
    await expect(buffer(Readable.from([enc]).pipe(decryptStream(KEY)))).rejects.toThrow(
      /failed authentication/,
    );
  });

  it('rejects a truncated upload', async () => {
    const enc = await buffer(Readable.from([randomBytes(4096)]).pipe(encryptStream(KEY)));
    await expect(
      buffer(Readable.from([enc.subarray(0, enc.length - 8)]).pipe(decryptStream(KEY))),
    ).rejects.toThrow(/failed authentication|Truncated/);
  });

  /** A plain pg_dump left in the bucket from before encryption was enabled. */
  it('rejects an unencrypted object with a message that explains why', async () => {
    const plain = Buffer.from('PGDMP not encrypted at all, just a dump');
    await expect(buffer(Readable.from([plain]).pipe(decryptStream(KEY)))).rejects.toThrow(
      /not an AVC encrypted backup/,
    );
  });

  it('rejects an object that ends inside the header', async () => {
    await expect(
      buffer(Readable.from([MAGIC.subarray(0, 3)]).pipe(decryptStream(KEY))),
    ).rejects.toThrow(/Truncated/);
  });
});
