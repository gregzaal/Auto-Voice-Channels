import { SITE_URL } from '../billing/messages.js';

/**
 * What the creator channel editor and `/channelinfo` say about remembered room settings,
 * kept out of the panels and the service so each sentence is worded once and one render-time
 * test covers all of them.
 *
 * **Who reads these.** An admin, on the editor panel they opened for a creator channel. The
 * words are about what a member's room starts with, so they say "room" and "creator
 * channel", and the one thing they have to say plainly is what is stored about people: a
 * member's id and the names they chose, which the Privacy page covers.
 *
 * **What is promised.** Name, size and privacy, and nothing else. A name is only remembered
 * when the member set one themselves, so a room that was merely named by the creator
 * channel's template never pins that name to a member. Privacy is private or hidden, never
 * public.
 */

/** Where the Privacy page lives, for the sentence that says what is stored about members. */
const PRIVACY_URL = `${SITE_URL}/privacy`;

/** "1 member", "3 members". */
const members = (n: number): string => `${n} ${n === 1 ? 'member' : 'members'}`;

/**
 * How many members have something saved, as a sentence for the editor, or nothing when it
 * could not be counted. A count that failed is left out rather than shown as 0, which would
 * read as "nobody" about a table that was never read.
 */
function savedSentence(on: boolean, saved: number | undefined): string {
  if (saved === undefined) return '';
  if (saved === 0) return on ? ' Nobody has saved settings yet.' : '';
  return on
    ? ` ${members(saved)} ${saved === 1 ? 'has' : 'have'} saved settings.`
    : ` ${members(saved)} ${saved === 1 ? 'has' : 'have'} saved settings, which are kept and not used while this is off.`;
}

/** The editor's field about it: the current state, in a sentence an admin can act on. */
export function rememberedFieldValue(on: boolean, saved: number | undefined): string {
  return on
    ? '**On.** A member who comes back gets a room that starts with their own saved name, size and ' +
        `privacy, instead of the server defaults.${savedSentence(on, saved)}`
    : `**Off.** Every new room starts from this creator channel's defaults.${savedSentence(on, saved)}`;
}

/**
 * What turning it on says, which is where an admin learns what it does and what it keeps.
 *
 * The sentence about storage is not optional: this is the one place an admin chooses to have
 * member ids and typed names kept, and it has to be said where the choice is made.
 */
export const REMEMBER_ON_NOTE =
  '💾 Remembered settings are on for this creator channel. A member who comes back gets a room ' +
  'that starts with the name, size and privacy they chose last time, instead of the server ' +
  'defaults. A name is only remembered when the member set one themselves. To do this I store ' +
  `each member's id and the names they choose, which the [Privacy page](${PRIVACY_URL}) covers. ` +
  'Nothing is remembered until a member next changes their room.';

/** What turning it off says, including that what members saved is kept. */
export const REMEMBER_OFF_NOTE =
  '💾 Remembered settings are off for this creator channel. New rooms start from its defaults ' +
  'again. What members saved is kept and not used, and comes back if you turn this on again. ' +
  'Use "Clear saved settings" to remove it.';

/** What "Clear saved settings" says, which is how many members it removed. */
export function clearedNote(removed: number): string {
  return removed === 0
    ? '🧹 Nobody had saved settings for this creator channel, so there was nothing to clear.'
    : `🧹 Removed the saved settings of ${members(removed)}. Their next room starts from this ` +
        "creator channel's defaults.";
}

/**
 * The `/channelinfo` line for a creator channel, in the words the rest of that section uses.
 * The count rides only on the "on" line: it is read only then, and a count beside "off" would
 * describe rows nothing uses.
 */
export function rememberedInfoLine(on: boolean, saved: number | undefined): string {
  const head = 'Returning members get their own saved name, size and privacy';
  if (!on) return `${head}: off`;
  if (saved === undefined) return `${head}: on`;
  if (saved === 0) return `${head}: on, nobody has saved settings yet`;
  return `${head}: on, ${members(saved)} ${saved === 1 ? 'has' : 'have'} saved settings`;
}
