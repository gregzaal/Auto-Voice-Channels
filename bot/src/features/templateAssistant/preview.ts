import { renderChannelName, type GameNameMode, type RenderContext } from '../voice/nameTemplate.js';
import type { VoiceMember } from '../voice/types.js';
import { maxLengthFor, type TemplateField } from './validate.js';

/**
 * Representative preview fixtures for the assistant.
 *
 * The live channel is previewed too, but the live channel is exactly one state
 * — usually "a couple of people, maybe playing something". The states that
 * actually bite are the ones an admin cannot see while testing: nobody playing,
 * the owner going live, a game that reports party info. A template whose
 * conditional has no `// else` looks perfect right up until the condition goes
 * false, so the proposal shows these deliberately.
 */

/** A stable seed, so `[[a/b]]` and `@@random_emoji@@` never wobble between renders. */
const PREVIEW_SEED = 4;

/**
 * A fixed instant for the date and time tokens: Friday 4 September 2026, 19:30
 * UTC.
 *
 * Fixed, not `new Date()`, for the same reason the seed is fixed: a preview that
 * wobbled between two renders of the same template would make the propose loop
 * non-deterministic and the fixtures untestable. A Friday evening because that
 * is the one instant where `{{WEEKEND}}` and `{{@@hour@@>=18}}`, the two conditions
 * an admin actually reaches for, disagree, so a template testing either shows
 * something in ONE scenario instead of needing a second one.
 *
 * Rendered in the GUILD's zone, not in UTC, so what the admin is shown is what
 * their server would show. A guild in Tokyo therefore previews the following
 * Saturday morning, which is correct for them.
 */
const PREVIEW_NOW = new Date('2026-09-04T19:30:00Z');

function member(
  id: string,
  displayName: string,
  overrides: Partial<VoiceMember> = {},
): VoiceMember {
  return { id, displayName, bot: false, playing: [], ...overrides };
}

export interface PreviewScenario {
  key: string;
  /** Shown beside the rendered result, so the admin knows what they're looking at. */
  label: string;
  ctx: RenderContext;
}

export interface ScenarioOptions {
  /** The guild's "no game" label, so `@@game_name@@` previews honestly. */
  general: string;
  aliases: Record<string, string>;
  /** The admin's own display name reads better in a preview than "Unknown". */
  creatorName: string;
  /**
   * Standalone (adopted) channels have no sibling number, so the numbering
   * tokens render `?` — previewing them as `#1` would be a lie.
   */
  standalone: boolean;
  /** The guild's named `[[list:name]]` pools, so a proposal using one previews. */
  lists?: Record<string, string[]>;
  /**
   * The guild's IANA zone. Absent previews in UTC, which is exactly what an
   * unconfigured guild would render, so the preview is honest either way.
   */
  timezone?: string | undefined;
  /**
   * How the guild resolves a tie for most-played game, so a scenario with two
   * games previews the way that guild will actually render it. Absent is
   * `shared`, the default.
   */
  gameNameMode?: GameNameMode | undefined;
  /**
   * The identity of a REAL channel these scenarios describe, when there is one.
   *
   * `/channelinfo` previews an existing room's template against these states, so
   * the previews must differ from that room only in the SITUATION. Left unset by
   * the assistant, which is proposing a template for rooms that do not exist yet
   * and wants the stable fixture identity instead.
   */
  identity?: {
    index?: number | undefined;
    seed?: number | undefined;
    numberOffset?: number | undefined;
  };
}

/** The scenarios every proposal is rendered against, in display order. */
export function previewScenarios(opts: ScenarioOptions): PreviewScenario[] {
  const { general, aliases, creatorName, standalone, identity, lists, timezone } = opts;
  const { gameNameMode } = opts;
  const index = identity?.index ?? (standalone ? -1 : 0);
  const base = {
    index,
    aliases,
    general,
    creatorName,
    seed: identity?.seed ?? PREVIEW_SEED,
    now: PREVIEW_NOW,
    // Never the host's zone: the engine's own default is UTC, which is what an
    // unset guild renders, so the fixture cannot depend on where this runs.
    timezone: timezone ?? 'UTC',
    ...(gameNameMode ? { gameNameMode } : {}),
    ...(lists ? { lists } : {}),
    ...(identity?.numberOffset !== undefined ? { numberOffset: identity.numberOffset } : {}),
  };

  const owner = member('owner', creatorName);
  const playingOwner = member('owner', creatorName, {
    playing: ['Halo'],
    activities: [{ kind: 'playing', name: 'Halo' }],
  });
  const liveOwner = member('owner', creatorName, {
    playing: ['Deep Rock Galactic'],
    activities: [
      { kind: 'playing', name: 'Deep Rock Galactic' },
      { kind: 'streaming', name: 'Hazard 5 all the way' },
    ],
  });
  const partyOwner = member('owner', creatorName, {
    playing: ['Deep Rock Galactic'],
    activities: [
      {
        kind: 'playing',
        name: 'Deep Rock Galactic',
        state: 'Hazard 5',
        details: 'Salvage',
        party: { id: 'p1', size: [3, 4] },
      },
    ],
  });

  const scenarios: PreviewScenario[] = [
    {
      key: 'idle',
      label: 'one person, nothing playing',
      ctx: { ...base, members: [owner], creator: owner },
    },
    {
      key: 'playing',
      label: 'three people in a game',
      ctx: {
        ...base,
        members: [
          playingOwner,
          member('m2', 'Robin', {
            playing: ['Halo'],
            activities: [{ kind: 'playing', name: 'Halo' }],
          }),
          member('m3', 'Sam', {
            playing: ['Halo'],
            activities: [{ kind: 'playing', name: 'Halo' }],
          }),
        ],
        creator: playingOwner,
      },
    },
    /**
     * Two games on one member each, which is the only situation where
     * `gameNameMode` changes anything.
     *
     * Without it the whole tie behaviour is invisible to the grader: a `shared`
     * guild renders `Halo, Doom` here and a `top` guild renders one of them,
     * and a proposal comparing `{{GAME=...}}` grades differently in each.
     */
    {
      key: 'tied',
      label: 'two games, tied',
      ctx: {
        ...base,
        members: [
          playingOwner,
          member('m2', 'Robin', {
            playing: ['Deep Rock Galactic'],
            activities: [{ kind: 'playing', name: 'Deep Rock Galactic' }],
          }),
        ],
        creator: playingOwner,
      },
    },
    {
      key: 'streaming',
      label: 'the owner is streaming',
      ctx: { ...base, members: [liveOwner, member('m2', 'Robin')], creator: liveOwner },
    },
    {
      key: 'party',
      label: 'a game reporting party info',
      ctx: { ...base, members: [partyOwner, member('m2', 'Robin')], creator: partyOwner },
    },
  ];

  /**
   * A room with a limit, one place from full.
   *
   * Without it `@@limit@@` previews as `0`, `@@slots@@` as blank and
   * `{{FULL}}` as false in every other scenario, so the grader cannot grade any
   * of them and the admin sees a preview that reads like the tokens are broken.
   * One short of full rather than full, because
   * a nearly-full room exercises both branches of the usual conditional.
   */
  scenarios.push({
    key: 'filling',
    label: 'a room with a limit, nearly full',
    ctx: {
      ...base,
      members: [owner, member('m2', 'Robin'), member('m3', 'Sam')],
      creator: owner,
      userLimit: 4,
    },
  });

  // A locked room, so `{{PRIVATE}}` has a state to show. Standalone channels
  // have no privacy model, so this is meaningless there.
  if (!standalone) {
    scenarios.push({
      key: 'private',
      label: 'the room is locked',
      ctx: { ...base, members: [owner, member('m2', 'Robin')], creator: owner, isPrivate: true },
    });
  }

  // Only meaningful for an adopted standalone channel, which is the one kind
  // that exists while empty (a secondary is deleted the moment it empties).
  if (standalone) {
    scenarios.push({ key: 'empty', label: 'nobody in the channel', ctx: { ...base, members: [] } });
  }
  return scenarios;
}

export interface RenderPair {
  /** What the channel would actually show (clamped, `-` fallback applied). */
  rendered: string;
  /** The same render with the length clamp lifted, to detect silent truncation. */
  unclamped: string;
}

/** Renders one template in one scenario, both clamped and unclamped. */
export function renderPair(template: string, field: TemplateField, ctx: RenderContext): RenderPair {
  return {
    rendered: renderChannelName(template, ctx, {
      maxLength: maxLengthFor(field),
      allowEmpty: field === 'status',
    }),
    unclamped: renderChannelName(template, ctx, {
      maxLength: Number.MAX_SAFE_INTEGER,
      allowEmpty: true,
    }),
  };
}
