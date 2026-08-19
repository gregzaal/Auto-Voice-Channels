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
    expect(line).toContain('S tier');
    expect(line).toContain('$19/yr');
    expect(line).toContain(LINK);
  });

  it('flags an expired server and deep-links to its dashboard card', () => {
    const line = formatPlan({ ...base, memberCount: 500, status: 'expired' });
    expect(line).toContain('ended');
    expect(line).toContain(LINK);
  });

  it('routes ≥1M servers to the dedicated-infra conversation', () => {
    const line = formatPlan({ ...base, memberCount: 2_000_000 });
    expect(line).toContain('dedicated');
    expect(line).toContain('auto-voice.io');
  });

  it('acknowledges an active subscription', () => {
    expect(formatPlan({ ...base, memberCount: 5_000, status: 'active' })).toContain('Subscribed');
  });

  it('self-host bypasses the plan entirely', () => {
    expect(formatPlan({ ...base, memberCount: 5_000, selfHosted: true })).toContain('Self-hosted');
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
    plan: '🆓 Free forever',
    missingPermissions: [] as string[],
    primaries: [{ channelId: 'p1' }],
    managed: [] as { channelId: string }[],
  };

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
    expect(withAssistant).toContain('Name it for me');
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
        problems: [{ channelId: 'x9', operation: 'move' }],
      }),
    );
    expect(lost).toContain('lost access');
    expect(lost).not.toContain('could not create rooms');
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

  it('labels the toggle button by current state', () => {
    expect(
      JSON.stringify(buildSetupPanel({ ...baseInput, isAdmin: true, enabled: true })),
    ).toContain('Disable');
    expect(
      JSON.stringify(buildSetupPanel({ ...baseInput, isAdmin: true, enabled: false })),
    ).toContain('Enable');
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
