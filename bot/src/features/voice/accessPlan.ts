import type { RoomAccess } from '@avc/core';

/**
 * The permission arithmetic of a room's access modes, as a pure function.
 *
 * Given what Discord holds on a channel now and what the room should be, this says
 * what the COMPLETE overwrite set should be, what differs, and what to record so a
 * later transition can take back exactly what this one did. It does no I/O and
 * imports nothing from discord.js, so every edge of the transition matrix is a row
 * in a table test instead of a Discord round trip. The adapter writes the result
 * (`applyOverwrites`), and `PrivacyService` decides when to ask.
 *
 * **Why the whole set and not a delta.** Measured on the dev application
 * (2026-10-03): overwrite writes are 10 per 10 seconds per channel, a channel PATCH
 * shares that bucket, and one bulk PATCH carrying the full `permission_overwrites`
 * array sets any number of overwrites in a single request. A transition touches an
 * owner, every occupant, the trusted list, a role or two and `@everyone`, which
 * serially is a 429. Planning the whole set is what makes the one-request write
 * possible, and what makes a replay converge.
 *
 * **Discord stores no author for an overwrite.** Everything here that is NOT one of
 * the rules below (a human's overwrite, a votekick deny, an approved knocker's
 * Connect, an inherited member grant) is kept exactly as it is. The only things
 * taken back are the bits recorded in the room's access record.
 */

/** One permission overwrite as Discord holds it, ids as strings and bits as bigints. */
export interface ResolvedOverwrite {
  id: string;
  /** Discord's `OverwriteType`: 0 for a role, 1 for a member. */
  type: number;
  allow: bigint;
  deny: bigint;
}

/**
 * Discord's `OverwriteType` and permission bits, spelled out so this file imports
 * nothing from discord.js. `accessPlan.unit.test.ts` pins every one against
 * `PermissionFlagsBits`, so a typo cannot hide here.
 */
export const OVERWRITE_ROLE = 0;
export const OVERWRITE_MEMBER = 1;
export const VIEW_CHANNEL = 1n << 10n;
export const CONNECT = 1n << 20n;
export const MANAGE_CHANNELS = 1n << 4n;
export const MOVE_MEMBERS = 1n << 24n;

/** What the bot must always hold on a room it manages, whatever else is denied. */
export const BOT_ACCESS = VIEW_CHANNEL | CONNECT | MANAGE_CHANNELS | MOVE_MEMBERS;

const VIEW_AND_CONNECT = VIEW_CHANNEL | CONNECT;

/**
 * Most overwrites a plan may produce.
 *
 * Discord allows 1000 per channel and answers 30060 past that. A typed refusal
 * short of the ceiling leaves room for what a human adds before the next plan,
 * and means an absurd input is turned away here rather than discovered as a
 * failed write.
 */
export const MAX_PLANNED_OVERWRITES = 900;

/**
 * At most this many changed overwrites are written one request each. More than
 * this is ONE bulk request, which is also the only way to write a transition
 * inside the 10-per-10-seconds bucket.
 */
export const SINGLE_WRITE_MAX = 2;

export type AccessMode = 'public' | 'locked' | 'hidden';

/** What a permission bit held before: an allow, a deny, or no explicit overwrite. */
export type OverwriteBit = 'allow' | 'deny' | 'none';

/**
 * `@everyone`'s View and Connect before the room left public. Every field is
 * optional and an absent one means UNKNOWN, which is not `none` (a known absence).
 *
 * A type alias and not an interface, because core's record schema is `passthrough`
 * and so carries an index signature, which an interface is not assignable to: the
 * facts could not be merged into the stored record without a cast.
 */
export type AccessBaseline = {
  view?: OverwriteBit | undefined;
  connect?: OverwriteBit | undefined;
};

export type NeutralisedRole = {
  roleId: string;
  /**
   * What the role's View bit was before this build changed it: an allow a hide
   * flipped to a deny, or a deny the moderator grant flipped to an allow.
   */
  view: OverwriteBit;
};

export interface AccessPlanInput {
  /** The guild id, which is also `@everyone`'s role id. */
  guildId: string;
  botId: string;
  /** The channel's overwrites as Discord holds them NOW (read fresh, never from a stale cache). */
  current: readonly ResolvedOverwrite[];
  /** The mode the room is moving to. */
  mode: AccessMode;
  /**
   * The mode it is leaving. The same as `mode` for a converge pass or for applying
   * a list to a room that is not changing mode.
   */
  previousMode: AccessMode;
  /**
   * The room's stored access record, or null when it has none. Only the fields
   * named below are read.
   *
   * **Null means the room has NO record, not that one could not be read.** A caller
   * holding `readRoomAccess(...) === { readable: false }` (a shape a newer build
   * wrote) must refuse to plan: with null this plans a hidden room as if its
   * baseline, flipped roles and grants were unknown, and the exit then clears
   * `@everyone` View instead of restoring it.
   */
  record: RoomAccess | null;
  /** The room's current owner, or null for an ownerless room. Never blocked. */
  ownerId: string | null;
  /** Who is in the room now: the roster and the voice cache together, since the cache lags. */
  occupants: readonly string[];
  /** The original creator's saved trusted list. */
  trusted: readonly string[];
  /** Members admitted to this room only. */
  admitted: readonly string[];
  /** The original creator's saved blocked list. */
  blocked: readonly string[];
  /**
   * Members a votekick removed from this room (`record.kicked`).
   *
   * Treated as blocked in every mode: View and Connect denied, ahead of any grant
   * for the same member (a trusted member who was voted out must stay out). They
   * are NOT part of the saved list, so they are never in `facts.blocked` and no
   * list edit, which only takes back what `record.blocked` names, can lift one.
   */
  kicked?: readonly string[] | undefined;
  /** The moderator role that may SEE a hidden room (View only), or null. */
  viewerRoleId?: string | null | undefined;
  /**
   * A role whose overwrite is left exactly as it is and never counted against the
   * hide: the bot's own managed role, whose View the bot itself relies on.
   */
  leaveRoleId?: string | null | undefined;
  /**
   * Roles the caller knows the bot cannot edit (above its own top role). Writing
   * an overwrite for one would fail the whole bulk request, so none is attempted:
   * a hide that one of them would defeat is refused (`role_defeats_hide`), and a
   * restore, a take-back or a grant that needs one is skipped and reported in
   * `skippedRoleIds`, leaving that role as it is.
   */
  uneditableRoleIds?: readonly string[] | undefined;
}

/**
 * What the room's access record should say.
 *
 * **A plan gives two of these, because a record has to be written twice.** A PUT is
 * idempotent, so a replay converges, but only if the record already names everything
 * the channel depends on: a crash between a flip and its record leaves a role denied
 * that nothing will ever put back, and a member whose take-back has not landed has to
 * stay named until it has, or nothing will ever take it back.
 *
 *  - `AccessPlan.factsBeforeWrite` is persisted BEFORE the write. It is the union of
 *    what the record already holds and what the plan adds.
 *  - `AccessPlan.facts` is persisted once the write has landed: the final state.
 *
 * Only the fields a plan decides are here. A caller merges them into the stored
 * record and does not replace it, so a field a newer build added survives the write.
 */
export interface AccessFacts {
  /**
   * The baseline in force: what was stored plus anything captured now. Null when
   * the room is public (the restore has used it up) or nothing was ever knowable.
   */
  baseline: AccessBaseline | null;
  /**
   * The fields captured by THIS plan, or null when it captured none. Captured only
   * on a transition out of public (and the View of a locked room that is being
   * hidden), set-if-absent per field, from the live `@everyone` overwrite. The
   * caller persists it BEFORE any write: a replay of a half-applied transition
   * would otherwise read its own `@everyone` deny back as the original.
   */
  baselineCaptured: AccessBaseline | null;
  /**
   * Role overwrites this build changed and has to put back: a View allow a hide
   * flipped to a deny, or a View deny the moderator grant flipped to an allow.
   */
  neutralised: NeutralisedRole[];
  /** The moderator role this plan leaves holding View (written by us), or null. */
  viewerRoleId: string | null;
  /** Members whose saved-trusted, admitted and blocked overwrites we now hold on the room. */
  trusted: string[];
  admitted: string[];
  blocked: string[];
  /** Whether the room is hidden. */
  hidden: boolean;
}

export interface OverwriteDiff {
  /** Overwrites to create or replace, in the order they should be written one by one. */
  upserts: ResolvedOverwrite[];
  /** Overwrites to remove. */
  deletes: { id: string; type: number }[];
}

export type AccessPlan =
  | {
      ok: true;
      /** The complete overwrite set the channel should hold. */
      desired: ResolvedOverwrite[];
      diff: OverwriteDiff;
      /** The record once the write has landed. */
      facts: AccessFacts;
      /**
       * The record to persist BEFORE writing: everything stored plus everything this
       * plan adds, so a write that fails or is cut short still leaves every member,
       * role and grant it was about to take back named, for the converge pass to take
       * back. Only the moderator role is single-valued: when it is being CHANGED the
       * old role is named until the write lands, because the leak that matters is a
       * role that can still see a hidden room.
       */
      factsBeforeWrite: AccessFacts;
      /**
       * Roles whose overwrite this plan would have changed, and did not, because the
       * caller says the bot cannot edit them. They stay as they are and the record
       * keeps naming them. A caller says so rather than reporting a clean result.
       */
      skippedRoleIds: string[];
    }
  | {
      ok: false;
      reason: 'too_many_overwrites';
      /** How many overwrites the plan would have produced. */
      count: number;
      cap: number;
    }
  | {
      /**
       * A hide that a role the bot cannot edit would defeat: its View allow beats the
       * `@everyone` deny, so the room would stay visible to everyone holding it.
       * Nothing is planned, so nothing is written and there is nothing to take back
       * (a hide that did half the work would leave `@everyone` View denied on a room
       * recorded as merely locked, and a later `/public` could not restore it).
       */
      ok: false;
      reason: 'role_defeats_hide';
      /** The roles that cannot be neutralised, sorted. */
      defeatedBy: string[];
    };

const key = (type: number, id: string): string => `${type}:${id}`;

/**
 * Length first, then code units: numeric order for snowflakes, which are decimal
 * strings without leading zeros, and stable for anything else a test invents.
 */
const compareIds = (a: string, b: string): number =>
  a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

const sortedUnique = (ids: Iterable<string>): string[] => [...new Set(ids)].sort(compareIds);

function bitState(o: { allow: bigint; deny: bigint } | undefined, bit: bigint): OverwriteBit {
  if (!o) return 'none';
  if ((o.allow & bit) !== 0n) return 'allow';
  if ((o.deny & bit) !== 0n) return 'deny';
  return 'none';
}

/** Puts one bit into the given state. `none` and an unknown value both clear it. */
function setBit(
  o: { allow: bigint; deny: bigint },
  bit: bigint,
  state: OverwriteBit | undefined,
): void {
  if (state === 'allow') {
    o.allow |= bit;
    o.deny &= ~bit;
  } else if (state === 'deny') {
    o.deny |= bit;
    o.allow &= ~bit;
  } else {
    o.allow &= ~bit;
    o.deny &= ~bit;
  }
}

/** Which bits each kind of member is given, by the mode the room is moving to. */
const GRANTS: Record<
  AccessMode,
  { owner: bigint; occupant: bigint; trusted: bigint; admitted: bigint }
> = {
  public: { owner: 0n, occupant: 0n, trusted: 0n, admitted: 0n },
  // Connect alone, for everyone: a lock never touches View, so what a member can
  // SEE is still the creator channel's own rule. Giving a trusted member View as
  // well would let an owner's friend see a room that a role-gated server hides
  // from them, which is the admin's rule to relax and not the owner's.
  locked: {
    owner: CONNECT,
    occupant: CONNECT,
    trusted: CONNECT,
    admitted: CONNECT,
  },
  // A hidden room needs View in the same overwrite: Connect alone leaves the
  // member connected but the room gone from their client (measured 2026-10-03).
  hidden: {
    owner: VIEW_AND_CONNECT,
    occupant: VIEW_AND_CONNECT,
    trusted: VIEW_AND_CONNECT,
    admitted: VIEW_AND_CONNECT,
  },
};

/**
 * Plans a room's overwrites for a move to `mode`. Never throws.
 *
 * Order-stable and deterministic: the channel's own overwrites keep the order they
 * arrived in, new ones follow in a fixed order (the bot, grants and blocks by id,
 * the moderator role, `@everyone`), and every list in the result is sorted. So
 * planning the result again, with the facts as the record, yields no diff.
 */
export function planAccess(input: AccessPlanInput): AccessPlan {
  const { guildId, botId, mode, previousMode } = input;
  const record = input.record ?? null;
  const everyoneId = guildId;
  const ownerId = input.ownerId;
  const leaveRoleId = input.leaveRoleId ?? null;
  const uneditable = new Set(input.uneditableRoleIds ?? []);
  const viewerRoleId =
    input.viewerRoleId && input.viewerRoleId !== everyoneId ? input.viewerRoleId : null;

  /** A working copy: nothing the caller passed in is ever mutated. */
  const work = new Map<string, ResolvedOverwrite>();
  for (const o of input.current) {
    const k = key(o.type, o.id);
    if (!work.has(k)) work.set(k, { ...o });
  }
  /** What this plan edited, so an overwrite it emptied is deleted and nothing else is. */
  const touched = new Set<string>();
  const touch = (type: number, id: string): ResolvedOverwrite => {
    const k = key(type, id);
    let o = work.get(k);
    if (!o) {
      o = { id, type, allow: 0n, deny: 0n };
      work.set(k, o);
    }
    touched.add(k);
    return o;
  };

  /**
   * Who the owner is and is not allowed to be.
   *
   * The owner and the bot are never blocked (a block on the owner would lock them
   * out of their own room, and one on the bot out of the room it manages), and a
   * block beats every other grant for the same member.
   */
  const notOwnerOrBot = (id: string): boolean => id !== ownerId && id !== botId;
  /** The saved list as it is applied, which is what the record's `blocked` names. */
  const savedBlocked = input.blocked.filter(notOwnerOrBot);
  const blocked = new Set([...savedBlocked, ...(input.kicked ?? []).filter(notOwnerOrBot)]);
  const eligible = (ids: readonly string[]): Set<string> =>
    new Set(ids.filter((id) => id !== botId && !blocked.has(id)));
  const occupants = eligible(input.occupants);
  const trusted = eligible(input.trusted);
  const admitted = eligible(input.admitted);

  // The baseline, captured from the live `@everyone` BEFORE anything below edits it.
  const storedBaseline: AccessBaseline = record?.baseline ?? {};
  const captured: AccessBaseline = {};
  const liveEveryone = work.get(key(OVERWRITE_ROLE, everyoneId));
  if (previousMode === 'public' && mode !== 'public') {
    if (storedBaseline.view === undefined) captured.view = bitState(liveEveryone, VIEW_CHANNEL);
    if (storedBaseline.connect === undefined) {
      captured.connect = bitState(liveEveryone, CONNECT);
    }
  } else if (previousMode === 'locked' && mode === 'hidden') {
    // A lock never writes `@everyone`'s View, so the live View of a locked room IS
    // the original, whoever locked it. Its Connect is the lock itself and is not
    // read: recording that would restore a lock as the original.
    if (storedBaseline.view === undefined) captured.view = bitState(liveEveryone, VIEW_CHANNEL);
  }
  const baseline: AccessBaseline = {
    ...(storedBaseline.view !== undefined ? { view: storedBaseline.view } : {}),
    ...(storedBaseline.connect !== undefined ? { connect: storedBaseline.connect } : {}),
    ...captured,
  };

  // The bot always holds what it needs to manage the room, written first.
  const bot = touch(OVERWRITE_MEMBER, botId);
  bot.allow |= BOT_ACCESS;
  bot.deny &= ~BOT_ACCESS;

  /**
   * Take back what an earlier plan wrote for members no longer wanted. Only the
   * bits we wrote (View and Connect), and only for a member who is not in the room
   * and not the owner: an occupant who is dropped from a list keeps their way back
   * in. Public keeps trusted and admitted overwrites, which are harmless there.
   */
  const wanted = new Set<string>([
    ...(ownerId ? [ownerId] : []),
    ...occupants,
    ...trusted,
    ...admitted,
  ]);
  if (mode !== 'public') {
    for (const id of sortedUnique([...(record?.trusted ?? []), ...(record?.admitted ?? [])])) {
      if (id === botId || wanted.has(id) || blocked.has(id)) continue;
      const k = key(OVERWRITE_MEMBER, id);
      const o = work.get(k);
      if (!o) continue;
      touched.add(k);
      o.allow &= ~VIEW_AND_CONNECT;
    }
  }
  for (const id of sortedUnique(record?.blocked ?? [])) {
    if (id === botId || blocked.has(id)) continue;
    const k = key(OVERWRITE_MEMBER, id);
    const o = work.get(k);
    if (!o) continue;
    touched.add(k);
    o.deny &= ~VIEW_AND_CONNECT;
  }

  // Grants. A member who is several things gets every bit of each.
  const grants = GRANTS[mode];
  const granted = new Map<string, bigint>();
  const grant = (ids: Iterable<string>, bits: bigint): void => {
    if (bits === 0n) return;
    for (const id of ids) granted.set(id, (granted.get(id) ?? 0n) | bits);
  };
  if (ownerId) grant([ownerId], grants.owner);
  grant(occupants, grants.occupant);
  grant(trusted, grants.trusted);
  grant(admitted, grants.admitted);
  for (const id of [...granted.keys()].sort(compareIds)) {
    setBit(touch(OVERWRITE_MEMBER, id), granted.get(id)!, 'allow');
  }

  // Blocks apply in every mode and beat every grant above.
  for (const id of sortedUnique(blocked)) {
    setBit(touch(OVERWRITE_MEMBER, id), VIEW_AND_CONNECT, 'deny');
  }

  /**
   * Role overwrites a PREVIOUS plan changed, and that are still how it left them.
   *
   * An entry is still ours while the role is denied View (the flip is still there)
   * or while it is the moderator role holding the allow it was given. One a human
   * has since changed or deleted is no longer ours to put back, and is never
   * recreated. Read from the channel as it is NOW, before anything below edits it.
   */
  const priorViewer = record?.viewerRoleId ?? null;
  const aliveEntries = new Map<string, NeutralisedRole>();
  for (const entry of record?.neutralised ?? []) {
    if (aliveEntries.has(entry.roleId)) continue;
    const o = work.get(key(OVERWRITE_ROLE, entry.roleId));
    if (!o) continue;
    const grantedView = entry.roleId === priorViewer && (o.allow & VIEW_CHANNEL) !== 0n;
    if ((o.deny & VIEW_CHANNEL) !== 0n || grantedView) aliveEntries.set(entry.roleId, entry);
  }
  /** Roles this plan would have changed but may not, because the bot cannot edit them. */
  const skipped = new Set<string>();

  // The moderator role sees a hidden room (View only: joining silently is more
  // than "can see"). Manage Channels alone does not reveal one.
  let targetViewer = mode === 'hidden' ? viewerRoleId : null;
  let viewerFact: string | null = null;
  if (priorViewer && priorViewer !== targetViewer && priorViewer !== everyoneId) {
    if (uneditable.has(priorViewer)) {
      // It cannot be taken back, so it stays named and nothing else takes its place
      // this round: a second viewer on a room would be one more role to forget.
      skipped.add(priorViewer);
      viewerFact = priorViewer;
      targetViewer = null;
    } else if (!aliveEntries.has(priorViewer)) {
      const k = key(OVERWRITE_ROLE, priorViewer);
      const o = work.get(k);
      if (o) {
        touched.add(k);
        o.allow &= ~VIEW_CHANNEL;
      }
    }
    // A role that was ALSO flipped by a hide is not simply cleared: the neutralised
    // handling below puts it back to what that hide left, or to the original.
  }
  /** A moderator role that held a View deny, which the grant is about to flip. */
  let viewerWasDenied: string | null = null;
  if (targetViewer) {
    if (uneditable.has(targetViewer)) {
      skipped.add(targetViewer);
      viewerFact = priorViewer === targetViewer ? targetViewer : null;
    } else {
      const existing = work.get(key(OVERWRITE_ROLE, targetViewer));
      if (existing && (existing.allow & VIEW_CHANNEL) !== 0n) {
        // Already allowed. It is ours only if we recorded writing it: an inherited
        // allow is somebody else's and must survive the setting changing.
        viewerFact = priorViewer === targetViewer ? targetViewer : null;
      } else {
        if (existing && (existing.deny & VIEW_CHANNEL) !== 0n && !aliveEntries.has(targetViewer)) {
          viewerWasDenied = targetViewer;
        }
        setBit(touch(OVERWRITE_ROLE, targetViewer), VIEW_CHANNEL, 'allow');
        viewerFact = targetViewer;
      }
    }
  }

  /**
   * Roles. A role's View allow beats `@everyone`'s deny (measured 2026-10-03), so a
   * hide in a role-gated server is a no-op unless those allows are flipped. Each is
   * recorded with what it was, and put back when the room stops being hidden.
   */
  const neutralised: NeutralisedRole[] = [];
  const defeatedBy: string[] = [];
  if (mode === 'hidden') {
    const spared = new Set([everyoneId, viewerRoleId, leaveRoleId].filter((id) => id !== null));
    // What an earlier plan changed stays recorded while it is still ours. A role
    // that was the moderator grant and no longer is goes back to the deny a hide
    // left it, so the room is still hidden from it.
    for (const entry of aliveEntries.values()) {
      if (entry.roleId === everyoneId || entry.roleId === leaveRoleId) continue;
      neutralised.push(entry);
      if (entry.roleId === viewerFact) continue;
      const k = key(OVERWRITE_ROLE, entry.roleId);
      const o = work.get(k)!;
      if ((o.deny & VIEW_CHANNEL) === 0n) {
        touched.add(k);
        setBit(o, VIEW_CHANNEL, 'deny');
      }
    }
    // The moderator grant flipped a deny nobody else had recorded: say what it was.
    if (viewerWasDenied) neutralised.push({ roleId: viewerWasDenied, view: 'deny' });
    for (const o of work.values()) {
      if (o.type !== OVERWRITE_ROLE || spared.has(o.id)) continue;
      if ((o.allow & VIEW_CHANNEL) === 0n) continue;
      if (uneditable.has(o.id)) {
        defeatedBy.push(o.id);
        continue;
      }
      neutralised.push({ roleId: o.id, view: 'allow' });
      touched.add(key(o.type, o.id));
      setBit(o, VIEW_CHANNEL, 'deny');
    }
    neutralised.sort((a, b) => compareIds(a.roleId, b.roleId));
    // Refused whole. A role the bot cannot edit still shows the room, so a hide
    // that went ahead would be a lock with `@everyone` View denied on top, which a
    // later unhide that believes it is leaving a lock would never restore.
    if (defeatedBy.length > 0) {
      return { ok: false, reason: 'role_defeats_hide', defeatedBy: sortedUnique(defeatedBy) };
    }
  } else {
    // Put back only what is still the flip we made, and only where the bot may.
    for (const entry of aliveEntries.values()) {
      if (uneditable.has(entry.roleId)) {
        skipped.add(entry.roleId);
        neutralised.push(entry);
        continue;
      }
      const k = key(OVERWRITE_ROLE, entry.roleId);
      touched.add(k);
      setBit(work.get(k)!, VIEW_CHANNEL, entry.view);
    }
    neutralised.sort((a, b) => compareIds(a.roleId, b.roleId));
  }

  /**
   * `@everyone`, last.
   *
   * Locked denies Connect. Hidden denies View and Connect. Leaving a mode puts back
   * what the baseline says, and an UNKNOWN baseline clears the bit (`null`), which is
   * what `/public` has always done for Connect. View is only restored by a plan that
   * is leaving hidden, because only a hide ever writes it: restoring it from a lock
   * would overwrite whatever a human did to a bit we never touched.
   */
  if (mode === 'locked') {
    const everyone = touch(OVERWRITE_ROLE, everyoneId);
    setBit(everyone, CONNECT, 'deny');
    if (previousMode === 'hidden') setBit(everyone, VIEW_CHANNEL, baseline.view);
  } else if (mode === 'hidden') {
    setBit(touch(OVERWRITE_ROLE, everyoneId), VIEW_AND_CONNECT, 'deny');
  } else if (previousMode !== 'public') {
    const everyone = touch(OVERWRITE_ROLE, everyoneId);
    setBit(everyone, CONNECT, baseline.connect);
    if (previousMode === 'hidden') setBit(everyone, VIEW_CHANNEL, baseline.view);
  }

  // An overwrite this plan emptied is deleted: an empty one still takes a slot.
  for (const k of touched) {
    const o = work.get(k);
    if (o && o.allow === 0n && o.deny === 0n) work.delete(k);
  }

  const desired = [...work.values()];
  if (desired.length > MAX_PLANNED_OVERWRITES) {
    return {
      ok: false,
      reason: 'too_many_overwrites',
      count: desired.length,
      cap: MAX_PLANNED_OVERWRITES,
    };
  }

  const keptBaseline = Object.keys(baseline).length > 0 ? baseline : null;
  const facts: AccessFacts = {
    // Used up only by the plan that restores it. A public room that holds one was left
    // by something other than an exit that landed: a failed entry, or a lock whose
    // `private` a stale whole-state write dropped, which reads as public while
    // `@everyone` is still denied. Dropping it there would let the next lock record
    // that deny as the original, and `/public` would restore it for good.
    baseline: mode === 'public' && previousMode !== 'public' ? null : keptBaseline,
    baselineCaptured: Object.keys(captured).length > 0 ? captured : null,
    neutralised,
    viewerRoleId: viewerFact,
    // Public leaves trusted and admitted overwrites on the room, so the record
    // keeps them too, but never a member who has since been blocked.
    trusted:
      mode === 'public'
        ? sortedUnique((record?.trusted ?? []).filter((id) => !blocked.has(id)))
        : sortedUnique(trusted),
    admitted:
      mode === 'public'
        ? sortedUnique((record?.admitted ?? []).filter((id) => !blocked.has(id)))
        : sortedUnique(admitted),
    // The saved list only: a kick is the room's and is recorded in `kicked`, where
    // no list diff can take it back.
    blocked: sortedUnique(savedBlocked),
    hidden: mode === 'hidden',
  };

  // What the record must say BEFORE the write: everything it held and everything
  // this plan adds. Whatever the plan takes back stays named until it has.
  const named = new Map<string, NeutralisedRole>();
  for (const entry of [...aliveEntries.values(), ...neutralised]) {
    if (!named.has(entry.roleId)) named.set(entry.roleId, entry);
  }
  const factsBeforeWrite: AccessFacts = {
    // Kept for a plan that goes public too: its restore reads it, and has not landed.
    baseline: keptBaseline,
    baselineCaptured: facts.baselineCaptured,
    neutralised: [...named.values()].sort((a, b) => compareIds(a.roleId, b.roleId)),
    // Single-valued, so a CHANGE of moderator role names the old one: a role that can
    // still see a hidden room is the leak, and one left holding a stray View on a room
    // that is no longer hidden is not.
    viewerRoleId: priorViewer && priorViewer !== everyoneId ? priorViewer : viewerFact,
    trusted: sortedUnique([...(record?.trusted ?? []), ...facts.trusted]),
    admitted: sortedUnique([...(record?.admitted ?? []), ...facts.admitted]),
    blocked: sortedUnique([...(record?.blocked ?? []), ...facts.blocked]),
    hidden: (record?.hidden ?? false) || facts.hidden,
  };

  return {
    ok: true,
    desired,
    diff: diffOverwrites(input.current, desired, { botId, guildId }),
    facts,
    factsBeforeWrite,
    skippedRoleIds: sortedUnique(skipped),
  };
}

/**
 * What differs between two overwrite sets, ordered for writing one by one.
 *
 * The bot first (denying `@everyone` also denies the bot, so its allow has to land
 * before anything that could lock it out), then grants, then anything that adds a
 * View or Connect deny, then `@everyone` last (a member must hold an explicit allow
 * before the deny that would hide the room from them, or it vanishes from their
 * client while they are still connected). Deletes follow. A bulk write ignores the
 * order, being atomic.
 */
export function diffOverwrites(
  previous: readonly ResolvedOverwrite[],
  desired: readonly ResolvedOverwrite[],
  who: { botId?: string; guildId?: string } = {},
): OverwriteDiff {
  const before = new Map(previous.map((o) => [key(o.type, o.id), o]));
  const after = new Set<string>();
  const changed: { overwrite: ResolvedOverwrite; rank: number; index: number }[] = [];

  desired.forEach((o, index) => {
    const k = key(o.type, o.id);
    after.add(k);
    const was = before.get(k);
    if (was && was.allow === o.allow && was.deny === o.deny) return;
    let rank = 1;
    if (o.type === OVERWRITE_MEMBER && o.id === who.botId) rank = 0;
    else if (o.type === OVERWRITE_ROLE && o.id === who.guildId) rank = 3;
    else if ((o.deny & ~(was?.deny ?? 0n) & VIEW_AND_CONNECT) !== 0n) rank = 2;
    changed.push({ overwrite: o, rank, index });
  });

  return {
    upserts: changed
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map(({ overwrite }) => ({ ...overwrite })),
    deletes: previous
      .filter((o) => !after.has(key(o.type, o.id)))
      .map(({ id, type }) => ({ id, type })),
  };
}

/**
 * `desired` without what it asks for the given members, who are not in the server.
 *
 * A member who already has an overwrite keeps exactly that one: the set is a full
 * replacement and an overwrite for somebody who has left is not ours to delete (a
 * block that outlives their membership still blocks them if they come back). A
 * member who has none gets none.
 */
export function leaveOutMembers(
  desired: readonly ResolvedOverwrite[],
  previous: readonly ResolvedOverwrite[],
  members: ReadonlySet<string>,
): ResolvedOverwrite[] {
  if (members.size === 0) return desired.map((o) => ({ ...o }));
  const before = new Map(previous.map((o) => [key(o.type, o.id), o]));
  return desired.flatMap((o) => {
    if (o.type !== OVERWRITE_MEMBER || !members.has(o.id)) return [{ ...o }];
    const was = before.get(key(o.type, o.id));
    return was ? [{ ...was }] : [];
  });
}

/**
 * The overwrites of a room's "⇩ Join" channel once the owner's blocked members are
 * denied Connect on it.
 *
 * Not a plan in the sense of {@link planAccess}: the Join channel is open on
 * purpose, so there is no mode, no baseline and no record to keep. It is created
 * with whatever its category gives it, and the only thing this adds is a Connect
 * deny for each blocked member (View is left alone: they can see an open channel,
 * they just cannot sit in it and knock) and the bot's own overwrite, which the
 * write seam insists on for every set it is handed. Everything already on the
 * channel is kept exactly as it is.
 */
export function joinChannelOverwrites(
  current: readonly ResolvedOverwrite[],
  botId: string,
  blockedIds: readonly string[],
): ResolvedOverwrite[] {
  const work = new Map<string, ResolvedOverwrite>();
  for (const o of current) {
    const k = key(o.type, o.id);
    if (!work.has(k)) work.set(k, { ...o });
  }
  const at = (id: string): ResolvedOverwrite => {
    const k = key(OVERWRITE_MEMBER, id);
    let o = work.get(k);
    if (!o) work.set(k, (o = { id, type: OVERWRITE_MEMBER, allow: 0n, deny: 0n }));
    return o;
  };
  const bot = at(botId);
  bot.allow |= BOT_ACCESS;
  bot.deny &= ~BOT_ACCESS;
  for (const id of sortedUnique(blockedIds)) {
    if (id === botId) continue;
    const o = at(id);
    o.deny |= CONNECT;
    o.allow &= ~CONNECT;
  }
  return [...work.values()];
}
