import { DiscordAPIError, type GuildMemberEditMeOptions } from 'discord.js';
import { describeError } from '../ops/describeError.js';

/**
 * The bot's own profile in one server: `/botprofile`.
 *
 * Discord holds all of it, on the bot's guild member, and nothing here is
 * stored. Modify Current Member (`PATCH /guilds/{id}/members/@me`) takes all
 * four fields, and only this application's token can write them, so there is
 * no state of ours to reconcile and a retried write converges by itself.
 *
 * **The bio is write-only.** The member object Discord returns has `avatar`,
 * `banner` and `nick` and no `bio` at all, so the panel can report three of
 * the four and says where to look for the fourth.
 */

/** The four things `/botprofile` changes, in panel order. */
export const BOT_PROFILE_FIELDS = ['avatar', 'banner', 'name', 'bio'] as const;
export type BotProfileField = (typeof BOT_PROFILE_FIELDS)[number];

export function isBotProfileField(value: string): value is BotProfileField {
  return (BOT_PROFILE_FIELDS as readonly string[]).includes(value);
}

/** Whether the field is an uploaded image rather than typed text. */
export const isImageField = (field: BotProfileField): field is 'avatar' | 'banner' =>
  field === 'avatar' || field === 'banner';

/**
 * Discord's own limit, measured rather than documented: a 10,494,233-byte PNG
 * was refused with "File cannot be larger than 10240.0 kb" (2026-09-23), and
 * the API reference states no figure at all. Checked here from the
 * attachment's declared size so a file Discord would refuse is never
 * downloaded.
 */
export const PROFILE_IMAGE_MAX_BYTES = 10240 * 1024;

/** Discord's nickname limit. */
export const BOT_NAME_MAX = 32;

/**
 * Discord's guild bio limit, also measured: a longer one is refused with "Must
 * be 300 or fewer in length" (2026-09-23).
 */
export const BOT_BIO_MAX = 300;

/**
 * The hosts an uploaded file may be fetched from.
 *
 * Pinned for the reason `/import` pins its own: the URL is one we received, not
 * one we minted, and the health server binds all interfaces while Postgres and
 * every sibling Fly app sit on the same private network, so an unpinned fetch
 * on an admin-triggerable path is an SSRF primitive.
 */
const IMAGE_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

const FETCH_TIMEOUT_MS = 15_000;

/** The three formats Discord's image data accepts. */
export type ProfileImageType = 'image/png' | 'image/jpeg' | 'image/gif';

/**
 * The format, from the file's own first bytes.
 *
 * Not from the attachment's content type, which the uploading client supplies,
 * and not from its name. What Discord is handed is labelled with what the bytes
 * actually are.
 */
export function sniffImageType(bytes: Uint8Array): ProfileImageType | null {
  const starts = (sig: readonly number[]): boolean =>
    bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  // "GIF87a" or "GIF89a".
  if (
    starts([0x47, 0x49, 0x46, 0x38]) &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif';
  }
  return null;
}

export type ProfileImageResult = { ok: true; dataUri: string } | { ok: false; message: string };

const TOO_BIG = 'That file is too big. Discord takes images under 10 MB.';

/**
 * Downloads an uploaded file and turns it into the data URI Discord takes.
 *
 * Every refusal is a sentence for the admin rather than an exception, because
 * each one is something they can fix by uploading a different file.
 */
export async function loadProfileImage(
  attachment: { url: string; size: number },
  fetchImpl: typeof fetch = fetch,
): Promise<ProfileImageResult> {
  if (attachment.size > PROFILE_IMAGE_MAX_BYTES) return { ok: false, message: TOO_BIG };
  let url: URL;
  try {
    url = new URL(attachment.url);
  } catch {
    return { ok: false, message: 'That file could not be read. Try uploading it again.' };
  }
  if (url.protocol !== 'https:' || !IMAGE_HOSTS.has(url.hostname)) {
    return { ok: false, message: 'That file is not hosted by Discord, so it was not fetched.' };
  }
  let bytes: Uint8Array;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) {
      return {
        ok: false,
        message: 'Discord would not hand over that file. Try uploading it again.',
      };
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    return { ok: false, message: 'That file could not be downloaded. Try again.' };
  }
  // Belt and braces: the declared size was checked above, but these bytes are
  // what gets sent.
  if (bytes.length > PROFILE_IMAGE_MAX_BYTES) return { ok: false, message: TOO_BIG };
  const type = sniffImageType(bytes);
  if (!type) return { ok: false, message: 'That is not a PNG, JPG or GIF.' };
  return { ok: true, dataUri: `data:${type};base64,${Buffer.from(bytes).toString('base64')}` };
}

/**
 * The `editMe` body for one field, where `null` is the reset.
 *
 * discord.js drops an `undefined` key and sends `null` as `null`, which is what
 * lets one field change without touching the other three.
 */
export function profileEdit(
  field: BotProfileField,
  value: string | null,
  reason: string,
): GuildMemberEditMeOptions {
  switch (field) {
    case 'avatar':
      return { avatar: value, reason };
    case 'banner':
      return { banner: value, reason };
    case 'name':
      return { nick: value, reason };
    case 'bio':
      return { bio: value, reason };
  }
}

/**
 * What Discord's audit log says about the change.
 *
 * The bot is the member being edited, so without a reason the log names only
 * the bot. This names the admin who asked for it.
 */
export function profileAuditReason(user: { username: string; id: string }): string {
  return `/botprofile, by ${user.username} (${user.id})`.slice(0, 512);
}

/**
 * The first message in a Discord form-validation error, or null.
 *
 * Discord nests these by field (`{ avatar: { _errors: [{ message }] } }`), and
 * its own wording ("File cannot be larger than 10240.0 kb") is more exact than
 * anything written here could stay.
 */
function firstValidationMessage(errors: unknown): string | null {
  if (!errors || typeof errors !== 'object') return null;
  const own = (errors as { _errors?: unknown })._errors;
  if (Array.isArray(own)) {
    const message = (own[0] as { message?: unknown } | undefined)?.message;
    if (typeof message === 'string') return message;
  }
  for (const value of Object.values(errors)) {
    const found = firstValidationMessage(value);
    if (found) return found;
  }
  return null;
}

const MISSING_PERMISSIONS = 50013;
const INVALID_FORM_BODY = 50035;

/**
 * Why a profile change failed, told as what to do about it.
 *
 * Only the NAME needs a permission (Change Nickname). The invite does not ask
 * for it, because @everyone has it by default and the bot's role inherits it,
 * so the one server where this fails is one that took it away. That is the
 * admin's to give back, and the sentence says where.
 *
 * `expected` is true for the failures the admin caused and can fix, which are
 * not worth an operator's attention. Everything else is.
 */
export function profileFailure(
  err: unknown,
  field: BotProfileField,
): { message: string; expected: boolean } {
  if (err instanceof DiscordAPIError) {
    if (Number(err.code) === MISSING_PERMISSIONS && field === 'name') {
      return {
        message:
          "I can't rename myself here without the Change Nickname permission. Give it to my " +
          'role in Server Settings > Roles, then try again.',
        expected: true,
      };
    }
    if (Number(err.code) === INVALID_FORM_BODY) {
      const message = firstValidationMessage((err.rawError as { errors?: unknown }).errors);
      if (message) return { message: `Discord refused that: ${message}`, expected: true };
    }
  }
  return { message: `I couldn't save that: ${describeError(err)}.`, expected: false };
}
