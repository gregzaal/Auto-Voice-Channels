import { renderChannelName, type RenderContext } from '../voice/nameTemplate.js';
import type { VoiceMember } from '../voice/types.js';
import { maxLengthFor, type TemplateField } from './validate.js';

/**
 * Preview fixtures for the assistant (`plans/assisted_templates.md` §8, "what
 * sample members do we seed so the preview is representative?").
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
}

/** The scenarios every proposal is rendered against, in display order. */
export function previewScenarios(opts: ScenarioOptions): PreviewScenario[] {
  const { general, aliases, creatorName, standalone } = opts;
  const index = standalone ? -1 : 0;
  const base = { index, aliases, general, creatorName, seed: PREVIEW_SEED };

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
