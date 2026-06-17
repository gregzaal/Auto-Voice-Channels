import { DiscordAPIError } from 'discord.js';

/**
 * Human-readable hints for the Discord API error codes we hit most often, so the
 * common failures read plainly ("I'm missing permissions") instead of as a raw
 * code. The underlying technical detail is always appended (see {@link detail}),
 * so a user can paste the message into a bug report and we have something to act
 * on.
 *
 * @see https://discord.com/developers/docs/topics/opcodes-and-status-codes#json-json-error-codes
 */
const DISCORD_CODE_HINTS: Record<number, string> = {
  10003: 'that channel no longer exists',
  10007: 'that member is no longer in the server',
  10008: 'that message no longer exists',
  10013: 'that user no longer exists',
  30013: "this server has hit Discord's channel limit",
  50001: "I don't have access to that resource",
  50013: "I'm missing the permissions Discord needs for that",
  50035: 'Discord rejected the request as invalid',
};

/** Keep replies well under Discord's 2000-char limit even when an error is huge. */
const MAX_LEN = 500;

/**
 * Turns an unknown thrown value into a short description suitable for a
 * user-facing reply. It stays human-readable for the common cases (missing
 * permissions, a deleted channel) but always carries the underlying technical
 * detail — the Discord error code or the error message — so bug reports are
 * actionable instead of just "something went wrong".
 */
export function describeError(err: unknown): string {
  return truncate(detail(err));
}

function detail(err: unknown): string {
  if (err instanceof DiscordAPIError) {
    const hint = DISCORD_CODE_HINTS[Number(err.code)];
    const technical = `Discord error ${err.code}: ${err.message}`;
    return hint ? `${hint} (${technical})` : technical;
  }
  if (err instanceof Error) {
    return err.message || err.name || 'an unknown error';
  }
  if (typeof err === 'string' && err) return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function truncate(text: string): string {
  return text.length > MAX_LEN ? `${text.slice(0, MAX_LEN - 1)}…` : text;
}
