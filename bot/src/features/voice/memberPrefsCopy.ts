/**
 * What the creator channel editor and `/channelinfo` say about remembered room settings,
 * kept out of the panels and the service so each sentence is worded once and one render-time
 * test covers all of them.
 *
 * **Who reads these.** An admin, on the editor panel they opened for a creator channel. The
 * words are about what a member's room starts with, so they say "room" and "creator
 * channel". The setting itself is called "Remember user settings" (the owner's name for it,
 * 2026-10-04), so an admin reads it as a switch about members rather than about the channel.
 *
 * **What is promised.** Name, status, size and privacy, and nothing else (the status since the
 * owner's call of 2026-10-04). A name or status is only remembered when the member set it
 * themselves, so a room that was merely named by the creator channel's template never pins that
 * name to a member. Privacy is private or hidden, never public.
 */

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

/**
 * The editor's field about it: the current state, in a sentence an admin can act on.
 *
 * `paused` is whether remembering has been switched off for now (the `member_prefs.disabled`
 * lever). It only changes what "on" says, because an admin who sees "on" while nothing is saved
 * or restored would take it for a fault in their own setup, and "off" already says every new
 * room starts from the defaults.
 */
export function rememberedFieldValue(
  on: boolean,
  saved: number | undefined,
  paused = false,
): string {
  if (on && paused) {
    return (
      '**On, but switched off for now.** Nothing new is saved and every new room starts from this ' +
      "creator channel's defaults for now. What members already saved is " +
      `kept.${savedSentence(on, saved)}`
    );
  }
  return on
    ? '**On.** A member who comes back gets a room that starts with their own saved name, status, ' +
        `size and privacy, instead of this creator channel's defaults.${savedSentence(on, saved)}`
    : `**Off.** Every new room starts from this creator channel's defaults.${savedSentence(on, saved)}`;
}

/**
 * What turning it on says, which is where an admin learns what it does.
 *
 * It used to go on to say what is stored and that nothing is remembered until a member next
 * changes their room. The owner cut both as redundant (2026-10-04): the first sentence already
 * says what is kept, and the Privacy page covers the storage.
 */
export const REMEMBER_ON_NOTE =
  '💾 **Remember user settings** is on for this creator channel. A member who comes back gets a ' +
  'room that starts with the name, status, size and privacy they chose last time, instead of ' +
  "this creator channel's defaults. A name or status is only remembered when the member set it " +
  'themselves.';

/**
 * What is added to {@link REMEMBER_ON_NOTE} while remembering is switched off for now, because
 * the note above says members get their saved settings back and the field beside it says
 * "on, but switched off for now". Said in the words the field uses.
 */
export const REMEMBER_PAUSED_NOTE =
  'Remembering is switched off for now, so nothing is saved or restored yet.';

/** What turning it off says, including that what members saved is kept. */
export const REMEMBER_OFF_NOTE =
  '💾 **Remember user settings** is off for this creator channel. New rooms start from its defaults ' +
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
 * describe rows nothing uses. `paused` is as for {@link rememberedFieldValue}, and also drops the
 * count, since a count beside "switched off for now" would read as members being served.
 */
export function rememberedInfoLine(on: boolean, saved: number | undefined, paused = false): string {
  const head = 'Returning members get their own saved name, status, size and privacy';
  if (!on) return `${head}: off`;
  if (paused) return `${head}: on, but switched off for now`;
  if (saved === undefined) return `${head}: on`;
  if (saved === 0) return `${head}: on, nobody has saved settings yet`;
  return `${head}: on, ${members(saved)} ${saved === 1 ? 'has' : 'have'} saved settings`;
}
