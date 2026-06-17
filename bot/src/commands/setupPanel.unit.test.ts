import { PermissionFlagsBits } from 'discord.js';
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
  const base = { status: 'trial' as const, expiresAt: null, selfHosted: false, now: NOW };

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
  });

  it('flags an expired server with the signup link', () => {
    const line = formatPlan({ ...base, memberCount: 500, status: 'expired' });
    expect(line).toContain('ended');
    expect(line).toContain('avc.dotsbots.com/signup');
  });

  it('routes ≥1M servers to the dedicated-infra signup', () => {
    const line = formatPlan({ ...base, memberCount: 2_000_000 });
    expect(line).toContain('dedicated');
    expect(line).toContain('avc.dotsbots.com/signup');
  });

  it('acknowledges an active subscription', () => {
    expect(formatPlan({ ...base, memberCount: 5_000, status: 'active' })).toContain('Subscribed');
  });

  it('self-host bypasses the plan entirely', () => {
    expect(formatPlan({ ...base, memberCount: 5_000, selfHosted: true })).toContain('Self-hosted');
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
