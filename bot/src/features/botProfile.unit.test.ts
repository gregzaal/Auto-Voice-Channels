import { DiscordAPIError } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
  BOT_PROFILE_FIELDS,
  loadProfileImage,
  PROFILE_IMAGE_MAX_BYTES,
  profileAuditReason,
  profileEdit,
  profileFailure,
  sniffImageType,
} from './botProfile.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const GIF89 = Uint8Array.from(Buffer.from('GIF89a\x01\x00', 'latin1'));
const GIF87 = Uint8Array.from(Buffer.from('GIF87a\x01\x00', 'latin1'));

function apiError(code: number, rawError: object): DiscordAPIError {
  return new DiscordAPIError(
    { code, message: 'x', ...rawError } as never,
    code,
    400,
    'PATCH',
    'https://discord.test',
    {} as never,
  );
}

/** A fetch that answers with `body`, recording that it was called. */
function fetchReturning(body: Uint8Array, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    arrayBuffer: () =>
      Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)),
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const DISCORD_URL = 'https://cdn.discordapp.com/ephemeral-attachments/1/2/a.png';

describe('sniffImageType', () => {
  it('names the three formats Discord takes from their first bytes', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(GIF89)).toBe('image/gif');
    expect(sniffImageType(GIF87)).toBe('image/gif');
  });

  it('refuses anything else, including a truncated header', () => {
    expect(sniffImageType(Uint8Array.from(Buffer.from('RIFF....WEBP', 'latin1')))).toBeNull();
    expect(sniffImageType(Uint8Array.from(Buffer.from('GIF8', 'latin1')))).toBeNull();
    expect(sniffImageType(PNG.slice(0, 4))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});

describe('loadProfileImage', () => {
  /**
   * Labelled with what the bytes are, not with the name or the uploader's
   * content type, which are both client input.
   */
  it('turns a Discord-hosted image into a data URI typed by its bytes', async () => {
    const fetchImpl = fetchReturning(GIF89);
    const result = await loadProfileImage({ url: DISCORD_URL, size: GIF89.length }, fetchImpl);
    expect(result).toEqual({
      ok: true,
      dataUri: `data:image/gif;base64,${Buffer.from(GIF89).toString('base64')}`,
    });
  });

  it('refuses a file over the limit without downloading it', async () => {
    const fetchImpl = fetchReturning(PNG);
    const result = await loadProfileImage(
      { url: DISCORD_URL, size: PROFILE_IMAGE_MAX_BYTES + 1 },
      fetchImpl,
    );
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('under 10 MB') });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /** An unpinned fetch on an admin-triggerable path is an SSRF primitive. */
  it('never fetches from a host that is not Discord', async () => {
    const fetchImpl = fetchReturning(PNG);
    for (const url of [
      'https://evil.example/a.png',
      'http://cdn.discordapp.com/a.png',
      'https://[fdaa::3]:5432/',
      'not a url',
    ]) {
      const result = await loadProfileImage({ url, size: 10 }, fetchImpl);
      expect(result.ok, url).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a body larger than the limit even when the declared size was small', async () => {
    const huge = new Uint8Array(PROFILE_IMAGE_MAX_BYTES + 1);
    huge.set(PNG);
    const result = await loadProfileImage({ url: DISCORD_URL, size: 10 }, fetchReturning(huge));
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('under 10 MB') });
  });

  it('refuses a file that is not a PNG, JPG or GIF', async () => {
    const webp = Uint8Array.from(Buffer.from('RIFF....WEBPVP8 ', 'latin1'));
    const result = await loadProfileImage({ url: DISCORD_URL, size: 16 }, fetchReturning(webp));
    expect(result).toEqual({ ok: false, message: 'That is not a PNG, JPG or GIF.' });
  });

  it('answers a failed or thrown download with a sentence, not an exception', async () => {
    expect(
      (await loadProfileImage({ url: DISCORD_URL, size: 1 }, fetchReturning(PNG, false))).ok,
    ).toBe(false);
    const throwing = vi.fn().mockRejectedValue(new Error('timeout')) as unknown as typeof fetch;
    expect(await loadProfileImage({ url: DISCORD_URL, size: 1 }, throwing)).toMatchObject({
      ok: false,
    });
  });
});

describe('profileEdit', () => {
  it('writes exactly one field, under the key Discord uses for it', () => {
    expect(profileEdit('avatar', 'data:x', 'r')).toEqual({ avatar: 'data:x', reason: 'r' });
    expect(profileEdit('banner', 'data:x', 'r')).toEqual({ banner: 'data:x', reason: 'r' });
    expect(profileEdit('name', 'Bob', 'r')).toEqual({ nick: 'Bob', reason: 'r' });
    expect(profileEdit('bio', 'Hi', 'r')).toEqual({ bio: 'Hi', reason: 'r' });
  });

  /** `null`, not `undefined`: discord.js drops an undefined key from the body. */
  it('resets with null for every field', () => {
    for (const field of BOT_PROFILE_FIELDS) {
      expect(Object.values(profileEdit(field, null, 'r'))).toContain(null);
    }
  });
});

describe('profileAuditReason', () => {
  it('names the admin, since the audit log otherwise names only the bot', () => {
    expect(profileAuditReason({ username: 'kay', id: '42' })).toBe('/botprofile, by kay (42)');
  });

  it("fits Discord's 512-character reason limit", () => {
    expect(profileAuditReason({ username: 'k'.repeat(600), id: '42' }).length).toBe(512);
  });
});

describe('profileFailure', () => {
  it('tells the admin where to grant Change Nickname when the name is refused', () => {
    const failure = profileFailure(apiError(50013, {}), 'name');
    expect(failure.expected).toBe(true);
    expect(failure.message).toContain('Change Nickname');
    expect(failure.message).toContain('Server Settings > Roles');
  });

  /** Only the name needs a permission, so anywhere else a 50013 is a surprise. */
  it('does not blame Change Nickname for a refused image', () => {
    const failure = profileFailure(apiError(50013, {}), 'avatar');
    expect(failure.expected).toBe(false);
    expect(failure.message).not.toContain('Change Nickname');
  });

  it("passes Discord's own validation message through", () => {
    const err = apiError(50035, {
      errors: {
        avatar: {
          _errors: [
            { code: 'BINARY_TYPE_MAX_SIZE', message: 'File cannot be larger than 10240.0 kb.' },
          ],
        },
      },
    });
    expect(profileFailure(err, 'avatar')).toEqual({
      message: 'Discord refused that: File cannot be larger than 10240.0 kb.',
      expected: true,
    });
  });

  it('reports anything else as unexpected', () => {
    expect(profileFailure(new Error('socket hang up'), 'bio')).toEqual({
      message: "I couldn't save that: socket hang up.",
      expected: false,
    });
  });
});
