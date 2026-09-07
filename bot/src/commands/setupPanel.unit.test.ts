import { PermissionFlagsBits } from 'discord.js';
import type { AuthStatus } from '@avc/core';
import { describe, expect, it } from 'vitest';
import {
  buildChannelPickerMessage,
  buildSetupPanel,
  formatPlan,
  missingBotPermissions,
  parseSetupPick,
  setupId,
  SETUP_SETTINGS_ID,
  setupState,
} from './setupPanel.js';

const NOW = new Date('2026-06-17T00:00:00.000Z');

describe('formatPlan', () => {
  const GUILD = '462606582367125509';
  const LINK = `https://auto-voice.io/dashboard?guild=${GUILD}`;
  const base = {
    guildId: GUILD,
    status: 'trial' as const,
    expiresAt: null,
    selfHosted: false,
    now: NOW,
  };

  it('shows free-forever under 100 members', () => {
    expect(formatPlan({ ...base, memberCount: 50 })).toContain('Free forever');
  });

  it('shows the trial days remaining for a mid-size server', () => {
    const expiresAt = new Date('2026-06-27T00:00:00.000Z'); // 10 days out
    const line = formatPlan({ ...base, memberCount: 500, expiresAt });
    expect(line).toContain('Free trial');
    expect(line).toContain('10 days');
    expect(line).toContain('Uncommon tier');
    expect(line).toContain('$1.50 a month, billed yearly ($18)');
    expect(line).toContain(LINK);
  });

  it('flags an expired server and deep-links to its dashboard card', () => {
    const line = formatPlan({ ...base, memberCount: 500, status: 'expired' });
    expect(line).toContain('ended');
    expect(line).toContain(LINK);
  });

  it('routes servers above the self-serve ceiling to a conversation', () => {
    const line = formatPlan({ ...base, memberCount: 400_000 });
    expect(line).toContain('self-serve');
    expect(line).toContain('auto-voice.io');
    // Owner decision 5 defers dedicated infrastructure, so nothing may promise it.
    expect(line).not.toContain('dedicated');
  });

  it('acknowledges an active subscription', () => {
    expect(formatPlan({ ...base, memberCount: 5_000, status: 'active' })).toContain('Subscribed');
  });

  it('self-host bypasses the plan entirely', () => {
    expect(formatPlan({ ...base, memberCount: 5_000, selfHosted: true })).toContain('Self-hosted');
  });

  describe('a subscription covering several servers (member-based-pricing.md §7.4)', () => {
    // Regression for the critical false alarm: a 200-member server on a
    // shared subscription must never quote a price derived from its OWN size.
    it('quotes the billed tier, not one derived from this server alone', () => {
      const line = formatPlan({
        ...base,
        memberCount: 200,
        status: 'active',
        billedTier: 'legendary',
        shared: true,
      });
      expect(line).toContain('Legendary tier');
      expect(line).toContain('$15 a month, billed yearly ($180)');
      expect(line).not.toContain('Uncommon tier');
      expect(line).not.toContain('($18)');
    });

    it('says the subscription also covers other servers, without saying "pool"', () => {
      const line = formatPlan({
        ...base,
        memberCount: 200,
        status: 'active',
        billedTier: 'm',
        shared: true,
      });
      expect(line).toContain('other');
      expect(line).toContain(LINK.replace(`?guild=${GUILD}`, ''));
      // "pool" is an internal word. It reached four user-visible strings here.
      expect(line).not.toMatch(/pool/i);
    });

    it('names the grace days left for a shared subscription too', () => {
      const graceUntil = new Date('2026-06-22T00:00:00.000Z'); // 5 days out
      const line = formatPlan({
        ...base,
        memberCount: 200,
        status: 'grace',
        graceUntil,
        billedTier: 'm',
        shared: true,
      });
      expect(line).toContain('5 days');
      expect(line).not.toMatch(/pool/i);
    });

    /**
     * The free-forever promise must survive being on someone's subscription.
     * `guilds.tier` is stamped at add time, but the reconciler leaves free
     * guilds out of the fan-out, so this used to read "L tier ($399/yr)".
     */
    it('never quotes a paid tier for a server under 100 members', () => {
      const line = formatPlan({
        ...base,
        memberCount: 40,
        status: 'trial',
        billedTier: 'l',
        shared: true,
      });
      expect(line).toContain('Free forever');
      expect(line).not.toContain('$399');
    });

    /**
     * Reachable between the webhook writing `pool_id` and the next hourly pass
     * fanning entitlement out (§6.4), so a customer who has just paid can open
     * `/setup` here. It must not announce a trial or quote a second price.
     */
    it('does not offer a trial to a server a subscription already covers', () => {
      const line = formatPlan({
        ...base,
        memberCount: 6_605,
        status: 'trial',
        expiresAt: new Date('2027-06-17T00:00:00.000Z'),
        billedTier: 'm',
        shared: true,
      });
      expect(line).not.toContain('trial');
      expect(line).toContain('covered by a subscription');
    });
  });

  /**
   * The other half of the §5.1 separation, on a surface that had it backwards:
   * a guild that grew since paying was quoted the tier its size now REQUIRES
   * rather than the one it is billed for, so an S subscriber at 1,500 members
   * read "Subscribed, M tier ($59/yr)" while paying $19.
   */
  it('quotes the billed tier for a subscriber who has outgrown it', () => {
    const line = formatPlan({ ...base, memberCount: 1_500, status: 'active', billedTier: 's' });
    expect(line).toContain('Uncommon tier');
    expect(line).toContain('$1.50 a month, billed yearly ($18)');
    expect(line).not.toContain('$59/yr');
  });

  /**
   * Grace has two causes wanting opposite numbers. Over-limit grace must name
   * what they now need, not what they already have and which would not fix it.
   */
  it('names the higher of billed and required tier in grace', () => {
    const overLimit = formatPlan({
      ...base,
      memberCount: 1_500,
      status: 'grace',
      graceUntil: new Date('2026-06-22T00:00:00.000Z'),
      billedTier: 's',
    });
    expect(overLimit).toContain('Rare tier');
    const lapsed = formatPlan({
      ...base,
      memberCount: 200,
      status: 'grace',
      graceUntil: new Date('2026-06-22T00:00:00.000Z'),
      billedTier: 'legendary',
    });
    expect(lapsed).toContain('Legendary tier');
  });

  /**
   * `/signup` has never existed on the site and returns 404. These assertions
   * previously REQUIRED that URL, so the tests were pinning a dead link into
   * the most-used admin surface in the bot.
   */
  it('never points at the non-existent /signup page', () => {
    const lines = [
      formatPlan({ ...base, memberCount: 50 }),
      formatPlan({ ...base, memberCount: 500 }),
      formatPlan({ ...base, memberCount: 500, status: 'expired' }),
      formatPlan({ ...base, memberCount: 500, expiresAt: new Date('2026-06-27T00:00:00.000Z') }),
      formatPlan({ ...base, memberCount: 5_000, status: 'active' }),
      formatPlan({ ...base, memberCount: 2_000_000 }),
      formatPlan({ ...base, memberCount: 5_000, selfHosted: true }),
    ];
    for (const line of lines) {
      expect(line).not.toContain('/signup');
      expect(line).not.toMatch(/[—–]/);
    }
  });
});

describe('missingBotPermissions', () => {
  it('returns the labels of permissions the bot lacks', () => {
    // Has everything except Move Members.
    const has = (flag: bigint) => flag !== PermissionFlagsBits.MoveMembers;
    expect(missingBotPermissions(has)).toEqual(['Move Members']);
    expect(missingBotPermissions(() => true)).toEqual([]);
  });
});

describe('buildSetupPanel', () => {
  const baseInput = {
    enabled: true,
    plan: '🆓 Free forever' as string | null,
    guildId: '462606582367125509',
    missingPermissions: [] as string[],
    primaries: [{ channelId: 'p1' }],
    managed: [] as { channelId: string }[],
  };

  /** How many Success (green) buttons the payload carries. */
  const successCount = (json: string): number => (json.match(/"style":3/g) ?? []).length;

  it('shows admin action buttons (toggle/create/manage/logging) for admins', () => {
    const json = JSON.stringify(buildSetupPanel({ ...baseInput, isAdmin: true }));
    expect(json).toContain(setupId('toggle'));
    expect(json).toContain(setupId('create'));
    expect(json).toContain(setupId('manage'));
    expect(json).toContain(setupId('logging'));
    expect(json).toContain('Permissions look good');
    expect(json).toContain('<#p1>'); // creator channel listed
  });

  // Hidden rather than shown-and-broken: with no model endpoint configured
  // (the self-host default) the command is not even registered.
  it('shows the assistant button only when the assistant is available', () => {
    expect(JSON.stringify(buildSetupPanel({ ...baseInput, isAdmin: true }))).not.toContain(
      setupId('assistant'),
    );
    const withAssistant = JSON.stringify(
      buildSetupPanel({ ...baseInput, isAdmin: true, assistant: true }),
    );
    expect(withAssistant).toContain(setupId('assistant'));
    expect(withAssistant).toContain('Write a name template for me');
  });

  it('never offers the assistant to a non-admin', () => {
    expect(
      JSON.stringify(buildSetupPanel({ ...baseInput, isAdmin: false, assistant: true })),
    ).not.toContain(setupId('assistant'));
  });

  it('hides admin actions from non-admins but keeps the support links', () => {
    const json = JSON.stringify(buildSetupPanel({ ...baseInput, isAdmin: false }));
    expect(json).not.toContain(setupId('toggle'));
    expect(json).not.toContain(setupId('manage'));
    expect(json).toContain('discord.gg'); // community support link still shown
  });

  it('surfaces missing permissions as a warning', () => {
    const json = JSON.stringify(
      buildSetupPanel({ ...baseInput, isAdmin: true, missingPermissions: ['Manage Channels'] }),
    );
    expect(json).toContain('Missing');
    expect(json).toContain('Manage Channels');
  });

  it('surfaces channels the bot lost access to', () => {
    const json = JSON.stringify(
      buildSetupPanel({ ...baseInput, isAdmin: true, problems: [{ channelId: 'x9' }] }),
    );
    expect(json).toContain('Needs attention');
    expect(json).toContain('<#x9>');
  });

  /**
   * Creating and losing access are both Discord 50013 and have nothing in
   * common as fixes. Reporting a create failure as "I lost access" sent an
   * admin to check four permissions the bot already held (2026-08-19).
   */
  it('tells a create failure apart from a lost-access one', () => {
    const created = JSON.stringify(
      buildSetupPanel({
        ...baseInput,
        isAdmin: true,
        problems: [{ channelId: 'x9', operation: 'create' }],
      }),
    );
    expect(created).toContain('could not create rooms');
    expect(created).not.toContain('lost access');

    const lost = JSON.stringify(
      buildSetupPanel({
        ...baseInput,
        isAdmin: true,
        problems: [{ channelId: 'x9', operation: 'delete' }],
      }),
    );
    expect(lost).toContain('lost access');
    expect(lost).not.toContain('could not create rooms');
  });

  /**
   * A move failure is a third thing, not a flavour of either.
   *
   * It records against the CREATOR channel, which has just successfully made a
   * room, so "could not create" and "lost access and stopped managing it" are
   * both false, and the fix is a permission neither of them names.
   */
  it('gives a move failure its own advice', () => {
    const moved = JSON.stringify(
      buildSetupPanel({
        ...baseInput,
        isAdmin: true,
        problems: [{ channelId: 'x9', operation: 'move' }],
      }),
    );
    expect(moved).toContain('Move Members');
    expect(moved).not.toContain('lost access');
    expect(moved).not.toContain('could not create rooms');
  });

  /** Both kinds at once must report both, not pick one. */
  it('reports create and access problems together', () => {
    const json = JSON.stringify(
      buildSetupPanel({
        ...baseInput,
        isAdmin: true,
        problems: [
          { channelId: 'a1', operation: 'create' },
          { channelId: 'b2', operation: 'delete' },
        ],
      }),
    );
    expect(json).toContain('could not create rooms');
    expect(json).toContain('lost access');
    expect(json).toContain('Needs attention (2)');
  });

  it('omits the needs-attention field when there are no problems', () => {
    const json = JSON.stringify(buildSetupPanel({ ...baseInput, isAdmin: true, problems: [] }));
    expect(json).not.toContain('Needs attention');
  });

  /**
   * Pausing is a setting; turning a paused server back on is THE action. So the
   * two directions live in different places, which is the whole shape of the
   * panel in one assertion.
   */
  it('offers pause as a setting, and turning back on as the recommended action', () => {
    const on = JSON.stringify(buildSetupPanel({ ...baseInput, isAdmin: true, enabled: true }));
    expect(on).toContain('Pause on this server');
    expect(on).not.toContain('Turn back on');

    const off = JSON.stringify(buildSetupPanel({ ...baseInput, isAdmin: true, enabled: false }));
    expect(off).toContain('Turn back on');
    expect(off).not.toContain('Pause on this server');
  });

  /**
   * The rule the old panel broke: five Primary blues, a green and a greyed-out
   * placeholder meant nothing read as the thing to press. Asserted across every
   * state because it is the one property a future edit is most likely to
   * violate by adding "just one more" button.
   */
  it('renders at most one green button, and never a disabled one', () => {
    const states = [
      { ...baseInput, isAdmin: true },
      { ...baseInput, isAdmin: true, enabled: false },
      { ...baseInput, isAdmin: true, primaries: [] },
      { ...baseInput, isAdmin: true, problems: [{ channelId: 'x9' }] },
      { ...baseInput, isAdmin: true, entitlement: 'grace' as const },
      { ...baseInput, isAdmin: true, assistant: true },
    ];
    for (const input of states) {
      const json = JSON.stringify(buildSetupPanel(input));
      expect(successCount(json)).toBe(1);
      expect(json).not.toContain('"disabled":true');
    }
  });

  /**
   * Where the fix is a link, a green button beside it would compete with the
   * only thing that actually helps.
   */
  it('renders no green button when the fix is a link', () => {
    const expired = JSON.stringify(
      buildSetupPanel({ ...baseInput, isAdmin: true, entitlement: 'expired' }),
    );
    expect(successCount(expired)).toBe(0);
    const perms = JSON.stringify(
      buildSetupPanel({
        ...baseInput,
        isAdmin: true,
        missingPermissions: ['Manage Channels'],
        inviteUrl: 'https://discord.com/oauth2/authorize?client_id=1',
      }),
    );
    expect(successCount(perms)).toBe(0);
  });

  it('drops the language placeholder entirely', () => {
    const json = JSON.stringify(buildSetupPanel({ ...baseInput, isAdmin: true }));
    expect(json).not.toContain(setupId('lang'));
    expect(json).not.toContain('soon');
  });

  /**
   * The first-run panel offers exactly one thing. Nothing in the settings select
   * applies before a creator channel exists, and the empty channel lists used to
   * advertise adopting an existing channel to every server that opened the panel.
   */
  it('offers only the one action on first run', () => {
    const json = JSON.stringify(
      buildSetupPanel({ ...baseInput, isAdmin: true, primaries: [], assistant: true }),
    );
    expect(json).toContain(setupId('create'));
    expect(json).not.toContain(SETUP_SETTINGS_ID);
    expect(json).not.toContain(setupId('manage'));
    expect(json).not.toContain('Creator channels');
    expect(json).not.toContain('Managed channels');
    expect(json).toContain('Start by making one');
  });

  /**
   * There is no slash command for the "no game" label, so the select is its only
   * entry point. A guild with adopted channels and no creator channel still
   * renders `firstRun`, and hiding the select there made a setting those
   * channels' templates depend on unreachable from anywhere in the product.
   */
  it('keeps the settings reachable on first run when channels are already managed', () => {
    const json = JSON.stringify(
      buildSetupPanel({
        ...baseInput,
        isAdmin: true,
        primaries: [],
        managed: [{ channelId: 'm1' }],
      }),
    );
    expect(json).toContain(SETUP_SETTINGS_ID);
    expect(json).toContain(setupId('general'));
    expect(json).toContain('Managed channels (1)');
  });

  /**
   * The option toggles on selection rather than opening a modal, so its
   * description is the only place it can report the current value and say what
   * selecting it will do.
   */
  it('reports the current tied-games mode in the settings select', () => {
    const shared = JSON.stringify(buildSetupPanel({ ...baseInput, isAdmin: true }));
    expect(shared).toContain(setupId('gamemode'));
    expect(shared).toContain('A two-way tie shows both games');

    const top = JSON.stringify(
      buildSetupPanel({ ...baseInput, isAdmin: true, gameNameMode: 'top' }),
    );
    expect(top).toContain('Room names pick one game when several are tied');
  });

  /**
   * Exempt while expired, like every other setting on this select and unlike
   * the assistant. `allowedWhileExpired` refuses only the assistant, and the
   * panel must not offer an action it is about to refuse -- nor hide one it
   * will accept.
   */
  it('keeps the tied-games setting reachable in an expired guild', () => {
    const json = JSON.stringify(
      buildSetupPanel({ ...baseInput, isAdmin: true, entitlement: 'expired' }),
    );
    expect(json).toContain(setupId('gamemode'));
    expect(json).not.toContain(setupId('assistant'));
  });

  it('omits an empty channel list rather than explaining it', () => {
    const json = JSON.stringify(buildSetupPanel({ ...baseInput, isAdmin: true }));
    expect(json).toContain('Creator channels (1)');
    expect(json).not.toContain('Managed channels');
    const withManaged = JSON.stringify(
      buildSetupPanel({ ...baseInput, isAdmin: true, managed: [{ channelId: 'm1' }] }),
    );
    expect(withManaged).toContain('Managed channels (1)');
  });

  /** Self-host has no billing, so it gets no billing line. */
  it('renders no plan line when there is no plan', () => {
    const json = JSON.stringify(buildSetupPanel({ ...baseInput, isAdmin: true, plan: null }));
    expect(json).not.toContain('Free forever');
    expect(json).toContain('Permissions look good');
  });

  /**
   * An expired guild is shown the one thing that works and nothing that does
   * not. The route gate refuses these anyway; the panel not offering them is
   * what stops it advertising an action it is about to refuse.
   */
  it('offers only reactivation when expired', () => {
    const json = JSON.stringify(
      buildSetupPanel({
        ...baseInput,
        isAdmin: true,
        assistant: true,
        entitlement: 'expired',
        plan: 'Your AVC trial or subscription has ended.',
      }),
    );
    expect(json).toContain('Reactivate');
    expect(json).toContain(`dashboard?guild=${baseInput.guildId}`);
    expect(json).not.toContain(setupId('create'));
    expect(json).not.toContain(setupId('manage'));
    expect(json).not.toContain(setupId('assistant'));
    expect(json).not.toContain('Pause on this server');
    // Logging and the label still work, and are the reason the panel is exempt
    // from the hard gate at all.
    expect(json).toContain(setupId('logging'));
  });

  it('offers the re-invite link only when permissions are missing', () => {
    const url = 'https://discord.com/oauth2/authorize?client_id=1';
    const missing = JSON.stringify(
      buildSetupPanel({
        ...baseInput,
        isAdmin: true,
        missingPermissions: ['Manage Channels'],
        inviteUrl: url,
      }),
    );
    expect(missing).toContain('Fix permissions');
    expect(missing).toContain(url);
    const healthy = JSON.stringify(
      buildSetupPanel({ ...baseInput, isAdmin: true, inviteUrl: url }),
    );
    expect(healthy).not.toContain('Fix permissions');
  });

  /** "Permissions look good" over a list of failures reads as a contradiction. */
  it('does not claim things look good while reporting problems', () => {
    const json = JSON.stringify(
      buildSetupPanel({ ...baseInput, isAdmin: true, problems: [{ channelId: 'x9' }] }),
    );
    expect(json).toContain('Needs attention');
    expect(json).not.toContain('Permissions look good');
  });

  it('carries the result of the action that refreshed it', () => {
    const json = JSON.stringify(
      buildSetupPanel({ ...baseInput, isAdmin: true, note: 'Created <#new1>.' }),
    );
    expect(json).toContain('Created <#new1>.');
  });

  it('colours the embed by state', () => {
    const colorOf = (input: Parameters<typeof buildSetupPanel>[0]): number | undefined =>
      (buildSetupPanel(input).embeds?.[0] as { color?: number } | undefined)?.color;
    expect(colorOf({ ...baseInput, isAdmin: true })).toBe(0x4caf50);
    expect(colorOf({ ...baseInput, isAdmin: true, enabled: false })).toBe(0x9e9e9e);
    expect(colorOf({ ...baseInput, isAdmin: true, primaries: [] })).toBe(0x5865f2);
    expect(colorOf({ ...baseInput, isAdmin: true, entitlement: 'expired' })).toBe(0xed4245);
    expect(colorOf({ ...baseInput, isAdmin: true, missingPermissions: ['Connect'] })).toBe(
      0xed4245,
    );
    expect(colorOf({ ...baseInput, isAdmin: true, problems: [{ channelId: 'x' }] })).toBe(0xfaa61a);
    expect(colorOf({ ...baseInput, isAdmin: true, entitlement: 'grace' })).toBe(0xfaa61a);
  });

  /** A non-admin sees the state and nothing they cannot act on, in every state. */
  it('gives a non-admin the links and nothing else, even when something is wrong', () => {
    const json = JSON.stringify(
      buildSetupPanel({
        ...baseInput,
        isAdmin: false,
        missingPermissions: ['Manage Channels'],
        inviteUrl: 'https://discord.com/oauth2/authorize?client_id=1',
      }),
    );
    expect(json).not.toContain(SETUP_SETTINGS_ID);
    expect(json).not.toContain('Fix permissions');
    expect(json).toContain('discord.gg');
    expect(json).toContain('Missing');
  });
});

/**
 * Ordering is the whole contract: every difference the panel renders is derived
 * from this one value, so a state that wins when it should not changes six
 * things at once.
 */
describe('setupState', () => {
  const base = {
    enabled: true,
    isAdmin: true,
    plan: null,
    guildId: 'g1',
    missingPermissions: [] as string[],
    primaries: [{ channelId: 'p1' }],
    managed: [] as { channelId: string }[],
  };

  it('ranks expired above everything, since nothing else would work', () => {
    expect(
      setupState({ ...base, entitlement: 'expired', enabled: false, missingPermissions: ['x'] }),
    ).toBe('expired');
  });

  it('ranks missing permissions above a pause, which would change nothing', () => {
    expect(setupState({ ...base, missingPermissions: ['Manage Channels'], enabled: false })).toBe(
      'permissions',
    );
  });

  it('ranks problems above first run, since a failure names channels either way', () => {
    expect(setupState({ ...base, primaries: [], problems: [{ channelId: 'x' }] })).toBe('problems');
  });

  it('falls through to first run and healthy', () => {
    expect(setupState({ ...base, primaries: [] })).toBe('firstRun');
    expect(setupState(base)).toBe('healthy');
    expect(setupState({ ...base, enabled: false })).toBe('paused');
    expect(setupState({ ...base, entitlement: 'grace' })).toBe('grace');
  });
});

describe('channel picker', () => {
  it('round-trips the picker command in its custom id', () => {
    const msg = buildChannelPickerMessage('manage', 'pick one');
    const json = JSON.stringify(msg);
    expect(json).toContain(setupId('pick:manage'));
    expect(parseSetupPick(setupId('pick:manage'))).toBe('manage');
    expect(parseSetupPick(setupId('toggle'))).toBeNull();
    expect(parseSetupPick('avc:tpl:edit:primary:name:1')).toBeNull();
    // The settings select is not a picker, and must never parse as one.
    expect(parseSetupPick(SETUP_SETTINGS_ID)).toBeNull();
  });

  /**
   * Only the picker that REPLACED a panel gets a way back. Opened from a slash
   * command there is no panel behind it, so the button would be a lie.
   */
  it('offers a way back only when it replaced a panel', () => {
    expect(
      JSON.stringify(buildChannelPickerMessage('manage', 'pick one', { back: true })),
    ).toContain(setupId('open'));
    expect(JSON.stringify(buildChannelPickerMessage('manage', 'pick one'))).not.toContain(
      setupId('open'),
    );
  });
});

/**
 * Every plan line, checked against every auth status.
 *
 * Both bugs this pins down were the same shape: a message chosen from ONE
 * dimension (member count, or the presence of a trial window) while ignoring
 * the guild's actual auth status. A paying subscriber was told their free
 * trial had just started, and a lapsed subscriber was told their free trial
 * had lapsed. A matrix is the only thing that keeps catching that.
 */
describe('formatPlan across every auth status', () => {
  const G = '462606582367125509';
  const DAY = 86_400_000;
  const STATUSES: AuthStatus[] = ['trial', 'active', 'grace', 'expired', 'blocked'];
  const SIZES = [50, 500, 50_000, 2_000_000];

  const build = (status: AuthStatus, memberCount: number) =>
    formatPlan({
      guildId: G,
      memberCount,
      status,
      expiresAt: new Date(NOW.getTime() + 30 * DAY),
      graceUntil: new Date(NOW.getTime() + 30 * DAY),
      selfHosted: false,
      now: NOW,
    });

  it('never calls a paid, grace, expired or blocked server a free trial', () => {
    for (const status of ['active', 'grace', 'expired', 'blocked'] as AuthStatus[]) {
      for (const size of SIZES) {
        expect(build(status, size), `${status} @ ${size}`).not.toMatch(/free trial/i);
      }
    }
  });

  it('never tells a blocked server it is free forever or subscribed', () => {
    for (const size of SIZES) {
      const line = build('blocked', size);
      expect(line, `blocked @ ${size}`).toContain('blocked');
      expect(line, `blocked @ ${size}`).not.toMatch(/free forever|subscribed/i);
    }
  });

  it('says "free forever" only for a small server actually on trial', () => {
    expect(build('trial', 50)).toContain('Free forever');
    for (const status of ['active', 'grace', 'expired', 'blocked'] as AuthStatus[]) {
      expect(build(status, 50), status).not.toContain('Free forever');
    }
  });

  it('names the grace period instead of borrowing trial wording', () => {
    for (const size of [500, 50_000]) {
      const line = build('grace', size);
      expect(line).toContain('Grace period');
      expect(line).toContain('30 days left');
    }
  });

  it('renders one clean line per state, with no placeholder leakage', () => {
    for (const status of STATUSES) {
      for (const size of SIZES) {
        const line = build(status, size);
        expect(line.length).toBeGreaterThan(20);
        expect(line).not.toContain('undefined');
        expect(line).not.toContain('NaN');
        expect(line).not.toMatch(/[—–]/);
      }
    }
  });

  it('self-host short-circuits every status', () => {
    for (const status of STATUSES) {
      expect(
        formatPlan({
          guildId: G,
          memberCount: 5_000,
          status,
          expiresAt: null,
          graceUntil: null,
          selfHosted: true,
          now: NOW,
        }),
      ).toContain('Self-hosted');
    }
  });
});
