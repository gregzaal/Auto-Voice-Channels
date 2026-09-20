import { describe, expect, it } from 'vitest';
import {
  buildControlPanel,
  buildLimitModal,
  buildMemberPicker,
  buildRenameModal,
  controlPanelFingerprint,
  CONTROL_PANEL_PREFIX,
  controlPanelId,
  parseControlPanelId,
  type RoomPanelView,
} from './controlPanel.js';
import {
  CONTROL_PANEL_CONTROLS,
  CONTROL_PANEL_DEFAULTS,
  readControlPanel,
  type ControlPanelConfig,
} from './guildSettings.js';

const ROOM = '123456789012345678';
const OWNER = '223456789012345678';
const CREATOR = '323456789012345678';

/** The defaults, which is what an unconfigured guild reads as. */
const defaults = (): ControlPanelConfig => readControlPanel({});

/** Everything on, for the tests about layout rather than about defaults. */
function allOn(): ControlPanelConfig {
  const config = defaults();
  for (const c of CONTROL_PANEL_CONTROLS) config.controls[c] = true;
  return config;
}

const view = (over: Partial<RoomPanelView> = {}): RoomPanelView => ({
  ownerId: OWNER,
  primaryChannelId: CREATOR,
  isPrivate: false,
  userLimit: 0,
  ...over,
});

/** The custom ids on a built panel's buttons, in render order. */
function buttonIds(panel: ReturnType<typeof buildControlPanel>): string[] {
  return (panel?.components ?? []).flatMap((row) =>
    (row.toJSON().components as { custom_id: string }[]).map((c) => c.custom_id),
  );
}

/** The embed's fields, as name/value pairs. */
function fieldsOf(panel: ReturnType<typeof buildControlPanel>): { name: string; value: string }[] {
  return (panel?.embeds[0]?.fields ?? []).map((f) => ({ name: f.name, value: f.value }));
}

describe('control panel custom ids', () => {
  it('builds and round-trips', () => {
    const id = controlPanelId('lock', ROOM);
    expect(id).toBe(`${CONTROL_PANEL_PREFIX}lock:${ROOM}`);
    expect(parseControlPanelId(id)).toEqual({ action: 'lock', roomId: ROOM });
  });

  it('rejects foreign and malformed ids', () => {
    expect(parseControlPanelId('avc:kick:room-1')).toBeNull();
    expect(parseControlPanelId('avc:info:summary:room-1')).toBeNull();
    expect(parseControlPanelId(`${CONTROL_PANEL_PREFIX}bogus:room-1`)).toBeNull();
    expect(parseControlPanelId(`${CONTROL_PANEL_PREFIX}lock:`)).toBeNull();
    expect(parseControlPanelId(`${CONTROL_PANEL_PREFIX}:room-1`)).toBeNull();
  });

  /**
   * `privacy` is the settings key, never a custom id: the button carries the
   * transition it currently offers, so a stale panel cannot ask for the one the
   * room has already made.
   */
  it('is never the privacy control id itself', () => {
    expect(parseControlPanelId(`${CONTROL_PANEL_PREFIX}privacy:${ROOM}`)).toBeNull();
  });
});

describe('buildControlPanel', () => {
  it('shows the defaults, which leave Claim and Transfer out', () => {
    const ids = buttonIds(buildControlPanel(ROOM, defaults(), view()));
    expect(ids).toContain(controlPanelId('lock', ROOM));
    expect(ids).toContain(controlPanelId('limit', ROOM));
    expect(ids).toContain(controlPanelId('kick', ROOM));
    expect(ids).not.toContain(controlPanelId('claim', ROOM));
    expect(ids).not.toContain(controlPanelId('transfer', ROOM));
    expect(CONTROL_PANEL_DEFAULTS.claim).toBe(false);
    expect(CONTROL_PANEL_DEFAULTS.transfer).toBe(false);
  });

  /**
   * The whole point of a panel that follows the room: one privacy button, and
   * it is the action that is actually available.
   */
  it('offers Private on an open room and Public on a locked one, never both', () => {
    const open = buildControlPanel(ROOM, defaults(), view({ isPrivate: false }));
    expect(buttonIds(open)).toContain(controlPanelId('lock', ROOM));
    expect(buttonIds(open)).not.toContain(controlPanelId('unlock', ROOM));
    expect(fieldsOf(open)[0]!.name).toBe('🔒 Private');

    const locked = buildControlPanel(ROOM, defaults(), view({ isPrivate: true }));
    expect(buttonIds(locked)).toContain(controlPanelId('unlock', ROOM));
    expect(buttonIds(locked)).not.toContain(controlPanelId('lock', ROOM));
    expect(fieldsOf(locked)[0]!.name).toBe('🔓 Public');
  });

  it('names the owner and the creator channel, as mentions', () => {
    const panel = buildControlPanel(ROOM, defaults(), view());
    expect(panel!.embeds[0]!.description).toBe(
      `This room belongs to <@${OWNER}>.
Make your own with <#${CREATOR}>`,
    );
  });

  /** A broken mention would be worse than saying it plainly, and Claim's case. */
  it('says so plainly when the room has no owner', () => {
    const panel = buildControlPanel(ROOM, defaults(), view({ ownerId: null }));
    expect(panel!.embeds[0]!.description).toContain('no owner right now');
    expect(panel!.embeds[0]!.description).not.toContain('<@null>');
  });

  it('carries the title and the footer, and no thumbnail', () => {
    const embed = buildControlPanel(ROOM, defaults(), view())!.embeds[0]!;
    expect(embed.title).toBe('Control your room');
    // The footer icon is the only place the mark appears: a thumbnail repeated
    // it a few lines above, which is decoration rather than information.
    expect(embed.thumbnail).toBeUndefined();
    expect(embed.footer?.text).toBe(
      'auto-voice.io  ·  Free and open source, dynamic voice channels.',
    );
    expect(embed.footer?.icon_url).toBe('https://auto-voice.io/logo-64.png');
  });

  it('describes every shown button in an inline field', () => {
    const panel = buildControlPanel(ROOM, allOn(), view());
    const fields = panel!.embeds[0]!.fields!;
    expect(fields).toHaveLength(buttonIds(panel).length);
    expect(fields.every((f) => f.inline === true)).toBe(true);
    expect(fieldsOf(panel)).toContainEqual({
      name: '👥 Size',
      value: 'Set a limit on the room size',
    });
    expect(fieldsOf(panel)).toContainEqual({
      name: '✏️ Name',
      value: 'Rename your room, supports [templates](https://auto-voice.io/docs/name-templates)',
    });
  });

  it('shows the current size only once one is set', () => {
    expect(fieldsOf(buildControlPanel(ROOM, defaults(), view({ userLimit: 0 })))).toContainEqual({
      name: '👥 Size',
      value: 'Set a limit on the room size',
    });
    expect(fieldsOf(buildControlPanel(ROOM, defaults(), view({ userLimit: 4 })))).toContainEqual({
      name: '👥 Size',
      value: 'Set a limit on the room size (now 4)',
    });
  });

  it('leaves a switched-off control out entirely rather than disabling it', () => {
    const config = defaults();
    config.controls.kick = false;
    const panel = buildControlPanel(ROOM, config, view());
    expect(buttonIds(panel)).not.toContain(controlPanelId('kick', ROOM));
    expect(JSON.stringify(panel)).not.toContain('"disabled":true');
  });

  it('is nothing at all when the panel is off, or every button is', () => {
    expect(buildControlPanel(ROOM, { ...defaults(), enabled: false }, view())).toBeNull();
    const none = defaults();
    for (const c of CONTROL_PANEL_CONTROLS) none.controls[c] = false;
    expect(buildControlPanel(ROOM, none, view())).toBeNull();
  });

  it('never exceeds five buttons in a row', () => {
    const rows = buildControlPanel(ROOM, allOn(), view())!.components;
    for (const row of rows) {
      expect((row.toJSON().components as unknown[]).length).toBeLessThanOrEqual(5);
    }
    expect(rows.length).toBeLessThanOrEqual(5);
  });

  /**
   * `/setup`'s rule (rewrite.md decision 11) at its limit: peer actions of
   * which none is the thing to press, so no Success, Primary or Danger.
   */
  it('uses only Secondary buttons', () => {
    const json = JSON.stringify(buildControlPanel(ROOM, allOn(), view()));
    expect(json).not.toMatch(/"style":(1|3|4)/);
    expect(json).toMatch(/"style":2/);
  });
});

/**
 * The fingerprint is what makes a re-render free, so what matters is that it
 * moves for every input the panel draws and only for those.
 */
describe('controlPanelFingerprint', () => {
  it('is stable for an unchanged panel', () => {
    const a = controlPanelFingerprint(buildControlPanel(ROOM, defaults(), view()));
    const b = controlPanelFingerprint(buildControlPanel(ROOM, defaults(), view()));
    expect(a).toBe(b);
  });

  it.each([
    ['privacy', view({ isPrivate: true })],
    ['owner', view({ ownerId: '999999999999999999' })],
    ['size', view({ userLimit: 7 })],
  ])('moves when the %s changes', (_what, changed) => {
    const before = controlPanelFingerprint(buildControlPanel(ROOM, defaults(), view()));
    expect(controlPanelFingerprint(buildControlPanel(ROOM, defaults(), changed))).not.toBe(before);
  });

  it('moves when a control is switched off', () => {
    const before = controlPanelFingerprint(buildControlPanel(ROOM, defaults(), view()));
    const config = defaults();
    config.controls.kick = false;
    expect(controlPanelFingerprint(buildControlPanel(ROOM, config, view()))).not.toBe(before);
  });

  it('has its own value for no panel at all', () => {
    expect(controlPanelFingerprint(null)).toBe('none');
    expect(controlPanelFingerprint(buildControlPanel(ROOM, defaults(), view()))).not.toBe('none');
  });
});

describe('control panel modals and pickers', () => {
  it('prefills the size modal only with a real limit', () => {
    expect(JSON.stringify(buildLimitModal(ROOM, 4).toJSON())).toContain('"value":"4"');
    // Zero is "no limit", so it prefills an empty box rather than a literal 0
    // the member would have to clear before typing.
    expect(JSON.stringify(buildLimitModal(ROOM, 0).toJSON())).not.toContain('"value":"');
    expect(JSON.stringify(buildLimitModal(ROOM).toJSON())).not.toContain('"value":"');
  });

  /**
   * The rename modal PROMISES that a blank submit resets the name, and Discord
   * refuses to submit a required field left blank, so marking it required would
   * make the placeholder a lie and strand the only way a member has of clearing
   * an override from the panel.
   */
  it('lets the name modal be submitted blank, which is how a reset is done', () => {
    const json = buildRenameModal(ROOM, 'den').toJSON();
    const input = (json.components as [{ components: [{ required?: boolean }] }])[0].components[0];
    expect(input.required ?? true).toBe(false);
    expect(JSON.stringify(json)).toContain('Leave blank');
  });

  it('carries the room in each modal id', () => {
    expect(buildLimitModal(ROOM).toJSON().custom_id).toBe(controlPanelId('limitset', ROOM));
    expect(buildRenameModal(ROOM).toJSON().custom_id).toBe(controlPanelId('renameset', ROOM));
  });

  it('offers the members it was given, capped at the 25 Discord allows', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `u${i}`,
      displayName: `Member ${i}`,
    }));
    const row = buildMemberPicker('kickpick', ROOM, many).toJSON();
    const select = (row.components as [{ custom_id: string; options: { value: string }[] }])[0];
    expect(select.custom_id).toBe(controlPanelId('kickpick', ROOM));
    expect(select.options).toHaveLength(25);
    expect(select.options[0]!.value).toBe('u0');
  });

  it('survives a nickname longer than Discord allows in an option label', () => {
    const row = buildMemberPicker('transferpick', ROOM, [
      { id: 'u1', displayName: 'x'.repeat(300) },
    ]).toJSON();
    const select = (row.components as [{ options: { label: string }[] }])[0];
    expect(select.options[0]!.label.length).toBeLessThanOrEqual(100);
  });
});

/**
 * AGENTS.md's copy rules, over everything this module renders. Sentence case
 * and the creator-channel/room vocabulary are review-only, but the punctuation
 * rules are mechanical and nothing else checks the strings a member reads here.
 */
describe('copy rules', () => {
  const rendered = (): string =>
    JSON.stringify([
      buildControlPanel(ROOM, allOn(), view()),
      buildControlPanel(ROOM, allOn(), view({ isPrivate: true, userLimit: 5, ownerId: null })),
      buildLimitModal(ROOM, 3).toJSON(),
      buildRenameModal(ROOM, 'den').toJSON(),
      buildMemberPicker('kickpick', ROOM, [{ id: 'u1', displayName: 'Ana' }]).toJSON(),
      buildMemberPicker('transferpick', ROOM, [{ id: 'u1', displayName: 'Ana' }]).toJSON(),
    ]);

  it('uses no em or en dashes, curly quotes, or prose semicolons', () => {
    const text = rendered();
    expect(text).not.toMatch(/[—–]/);
    expect(text).not.toMatch(/[‘’“”]/);
    expect(text).not.toMatch(/;/);
  });

  it('never says primary or secondary to a member', () => {
    const text = rendered().toLowerCase();
    expect(text).not.toContain('secondary');
    expect(text).not.toContain('primary');
  });
});
