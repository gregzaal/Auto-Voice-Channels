import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

/**
 * Client-side AES-256-GCM for backup objects (`plans/backups.md` §7).
 *
 * Client-side because the threat being defended against is the storage
 * provider, not the network: a dump holds every guild setting, every
 * subscription row and the legacy payer roster. TLS and bucket-side SSE both
 * leave the provider able to read it.
 *
 * Streaming, because a dump is arbitrarily large and the scheduler runs
 * in-process inside the bot. Buffering one would put the whole database in the
 * heap of a process that is also serving Discord events.
 *
 * On-disk format, in order:
 *
 *   magic "AVCB1" (5 bytes) | iv (12) | ciphertext (n) | auth tag (16)
 *
 * The magic prefix is what lets `restore` tell an encrypted object from a plain
 * `pg_dump` without being told, so a bucket can hold both across a config
 * change and neither is silently mangled.
 */

/** File magic. Bump the digit if the format ever changes. */
export const MAGIC = Buffer.from('AVCB1', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Accepts the key as base64 or hex, because operators produce them both ways
 * (`openssl rand -base64 32` and `-hex 32`) and a key that silently parses to
 * the wrong bytes is the worst possible failure here.
 *
 * Hex is detected first and only when the string is exactly 64 hex characters,
 * which is unambiguous. Everything else is treated as base64 and must decode to
 * exactly 32 bytes. Anything else throws at startup rather than at restore.
 */
export function parseKey(raw: string): Buffer {
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');

  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== KEY_BYTES) {
    throw new Error(
      `BACKUP_ENCRYPTION_KEY must be 32 bytes: 64 hex characters, or base64 decoding to 32 bytes. ` +
        `Got ${value.length} characters decoding to ${decoded.length} bytes. ` +
        `Generate one with \`openssl rand -base64 32\`.`,
    );
  }
  return decoded;
}

/** True if this object was written by {@link encryptStream}. */
export function isEncrypted(head: Buffer): boolean {
  return head.subarray(0, MAGIC.length).equals(MAGIC);
}

/**
 * A Transform that prepends the header and appends the GCM auth tag.
 *
 * The tag is only available after `final()`, which is why this is a Transform
 * with a `_flush` rather than a plain pipe through the cipher.
 */
export function encryptStream(key: Buffer): Transform {
  const iv = randomBytes(IV_BYTES);
  const cipher: CipherGCM = createCipheriv('aes-256-gcm', key, iv);
  let headerWritten = false;

  return new Transform({
    transform(chunk: Buffer, _enc, done: TransformCallback) {
      try {
        if (!headerWritten) {
          this.push(Buffer.concat([MAGIC, iv]));
          headerWritten = true;
        }
        this.push(cipher.update(chunk));
        done();
      } catch (error) {
        done(error as Error);
      }
    },
    flush(done: TransformCallback) {
      try {
        // An empty input still has to produce a valid, decryptable object
        // rather than a zero-byte one that looks like a successful backup.
        if (!headerWritten) {
          this.push(Buffer.concat([MAGIC, iv]));
          headerWritten = true;
        }
        this.push(cipher.final());
        this.push(cipher.getAuthTag());
        done();
      } catch (error) {
        done(error as Error);
      }
    },
  });
}

/**
 * The inverse. Buffers a trailing {@link TAG_BYTES} window, because the tag is
 * the last 16 bytes of the stream and is not known to be the tag until the
 * stream ends.
 *
 * A wrong key, a truncated upload or a flipped bit all surface here as an
 * authentication failure from `final()`, which is the point of GCM over CTR:
 * a restore refuses to proceed rather than writing plausible garbage into
 * Postgres.
 */
export function decryptStream(key: Buffer): Transform {
  let header = Buffer.alloc(0);
  let decipher: DecipherGCM | null = null;
  let tail = Buffer.alloc(0);
  const headerBytes = MAGIC.length + IV_BYTES;

  return new Transform({
    transform(chunk: Buffer, _enc, done: TransformCallback) {
      try {
        let body = chunk;
        if (!decipher) {
          header = Buffer.concat([header, body]);
          if (header.length < headerBytes) return done();
          if (!isEncrypted(header)) {
            return done(
              new Error(
                'Object is not an AVC encrypted backup (bad magic). It may be a plain pg_dump ' +
                  'written before BACKUP_ENCRYPTION_KEY was set.',
              ),
            );
          }
          const iv = header.subarray(MAGIC.length, headerBytes);
          decipher = createDecipheriv('aes-256-gcm', key, iv);
          body = header.subarray(headerBytes);
          header = Buffer.alloc(0);
        }

        // Hold back the last TAG_BYTES: they may be the auth tag.
        const buffered = Buffer.concat([tail, body]);
        if (buffered.length <= TAG_BYTES) {
          tail = buffered;
          return done();
        }
        const cut = buffered.length - TAG_BYTES;
        tail = buffered.subarray(cut);
        this.push(decipher.update(buffered.subarray(0, cut)));
        done();
      } catch (error) {
        done(error as Error);
      }
    },
    flush(done: TransformCallback) {
      try {
        if (!decipher) {
          return done(new Error('Truncated backup object: ended before the header was complete.'));
        }
        if (tail.length !== TAG_BYTES) {
          return done(
            new Error(
              `Truncated backup object: expected a ${TAG_BYTES}-byte auth tag, got ${tail.length}.`,
            ),
          );
        }
        decipher.setAuthTag(tail);
        this.push(decipher.final());
        done();
      } catch (error) {
        done(
          new Error(
            `Backup failed authentication. The object is corrupt, truncated, or was encrypted ` +
              `with a different BACKUP_ENCRYPTION_KEY. Original: ${(error as Error).message}`,
          ),
        );
      }
    },
  });
}
