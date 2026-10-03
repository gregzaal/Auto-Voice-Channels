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
 */
export interface AccessBaseline {
  view?: OverwriteBit | undefined;
  connect?: OverwriteBit | undefined;
}

export interface NeutralisedRole {
  roleId: string;
  /** What the role's View bit was before it was flipped to deny. */
  view: OverwriteBit;
}

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
  /** The room's stored access record, or null when it has none. Only the fields named below are read. */
  record: RoomAccess | null;
  /** The room's current owner, or null for an ownerless room. Never blocked. */
  ownerId: string | null;
  /** Who is in the room now: the roster and the voice cache together, since the cache lags. */
  occupants: readonly string[];
  /** The original creator's saved trusted list. */
  trusted: readonly string[];
  /** Members admitted to this room only. */
  admitted: readonly string[];
  /** The original creator's saved blocked list, plus anyone voted out of a hidden room. */
  blocked: readonly string[];
  /** The moderator role that may SEE a hidden room (View only), or null. */
  viewerRoleId?: string | null | undefined;
  /**
   * A role whose overwrite is left exactly as it is and never counted against the
   * hide: the bot's own managed role, whose View the bot itself relies on.
   */
  leaveRoleId?: string | null | undefined;
  /**
   * Roles the caller knows the bot cannot edit (above its own top role). They are
   * left as they are, and a View allow on one is reported as defeating the hide:
   * writing it would fail the whole bulk request, so it is not attempted.
   */
  uneditableRoleIds?: readonly string[] | undefined;
}

/**
 * What to record in the room's access record for this plan.
 *
 * **Record what a plan adds BEFORE writing it, and what it takes back AFTER.** A PUT
 * is idempotent, so a replay converges, but only if the record already names every
 * baseline field, flipped role and moderator grant the channel depends on: a crash
 * between a flip and its record leaves a role denied that nothing will ever put back.
 * The same fields are what a restore READS, so clearing them before the restore has
 * landed leaves a replay with nothing to restore from.
 *
 * Only the fields this plan decides are here. A caller merges them into the stored
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
  /** Role overwrites whose View allow is now a deny because of the hide, to put back later. */
  neutralised: NeutralisedRole[];
  /** The moderator role this plan leaves holding View (written by us), or null. */
  viewerRoleId: string | null;
  /** Members whose saved-trusted, admitted and blocked overwrites we now hold on the room. */
  trusted: string[];
  admitted: string[];
  blocked: string[];
  /** Whether the room is really hidden: the mode is hidden and no role still defeats it. */
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
      facts: AccessFacts;
      /**
       * True only when, after neutralising, no role other than the bot's own and the
       * moderator role still allows View. The caller must not tell the owner the room
       * is hidden on any other basis.
       */
      effectiveHidden: boolean;
      /** Roles that still defeat the hide because they could not be neutralised. */
      defeatedBy: string[];
    }
  | {
      ok: false;
      reason: 'too_many_overwrites';
      /** How many overwrites the plan would have produced. */
      count: number;
      cap: number;
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
  locked: {
    owner: CONNECT,
    occupant: CONNECT,
    trusted: VIEW_AND_CONNECT,
    admitted: VIEW_AND_CONNECT,
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
  const blocked = new Set(input.blocked.filter((id) => id !== ownerId && id !== botId));
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

  // The moderator role sees a hidden room (View only: joining silently is more
  // than "can see"). Manage Channels alone does not reveal one.
  const priorViewer = record?.viewerRoleId ?? null;
  const targetViewer = mode === 'hidden' ? viewerRoleId : null;
  if (priorViewer && priorViewer !== targetViewer && priorViewer !== everyoneId) {
    const k = key(OVERWRITE_ROLE, priorViewer);
    const o = work.get(k);
    if (o) {
      touched.add(k);
      o.allow &= ~VIEW_CHANNEL;
    }
  }
  let viewerFact: string | null = null;
  if (targetViewer) {
    const existing = work.get(key(OVERWRITE_ROLE, targetViewer));
    if (existing && (existing.allow & VIEW_CHANNEL) !== 0n) {
      // Already allowed. It is ours only if we recorded writing it: an inherited
      // allow is somebody else's and must survive the setting changing.
      viewerFact = priorViewer === targetViewer ? targetViewer : null;
    } else {
      setBit(touch(OVERWRITE_ROLE, targetViewer), VIEW_CHANNEL, 'allow');
      viewerFact = targetViewer;
    }
  }

  /**
   * Roles. A role's View allow beats `@everyone`'s deny (measured 2026-10-03), so a
   * hide in a role-gated server is a no-op unless those allows are flipped. Each is
   * recorded with what it was, and put back when the room stops being hidden.
   */
  let neutralised: NeutralisedRole[] = [];
  const defeatedBy: string[] = [];
  const storedNeutralised = record?.neutralised ?? [];
  if (mode === 'hidden') {
    const spared = new Set([everyoneId, viewerRoleId, leaveRoleId].filter((id) => id !== null));
    // What an earlier plan flipped stays recorded while it is still a deny. One a
    // human has since changed is no longer ours to put back.
    for (const entry of storedNeutralised) {
      const o = work.get(key(OVERWRITE_ROLE, entry.roleId));
      if (o && (o.deny & VIEW_CHANNEL) !== 0n && !spared.has(entry.roleId)) neutralised.push(entry);
    }
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
  } else {
    // Put back only what is still the flip we made. A role overwrite a human has
    // deleted or changed since is left as they left it, never recreated.
    for (const entry of storedNeutralised) {
      const k = key(OVERWRITE_ROLE, entry.roleId);
      const o = work.get(k);
      if (!o || (o.deny & VIEW_CHANNEL) === 0n) continue;
      touched.add(k);
      setBit(o, VIEW_CHANNEL, entry.view);
    }
    neutralised = [];
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

  const effectiveHidden = mode === 'hidden' && defeatedBy.length === 0;
  const keptBaseline = Object.keys(baseline).length > 0 ? baseline : null;
  return {
    ok: true,
    desired,
    diff: diffOverwrites(input.current, desired, { botId, guildId }),
    facts: {
      baseline: mode === 'public' ? null : keptBaseline,
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
      blocked: sortedUnique(blocked),
      hidden: effectiveHidden,
    },
    effectiveHidden,
    defeatedBy: sortedUnique(defeatedBy),
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
