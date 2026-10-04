import { ButtonStyle } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { EditorState } from '../features/voice/index.js';
import {
  REMEMBER_OFF_NOTE,
  REMEMBER_ON_NOTE,
  clearedNote,
} from '../features/voice/memberPrefsCopy.js';
import {
  buildAdoptPrompt,
  buildEditorModal,
  editorId,
  parseAdoptId,
  parseEditorId,
  renderEditorPanel,
} from './templatePanel.js';

const state: EditorState = {
  found: true,
  scope: 'channel',
  name: { currentTemplate: 'My Room', effectiveTemplate: 'My Room', preview: 'My Room' },
  status: { effectiveTemplate: '{{PLAYING ?? Playing @@game_name@@}}', preview: 'Playing Halo' },
  ownerId: 'alice',
  primaryChannelId: 'p',
};

describe('templatePanel', () => {
  it('round-trips custom ids', () => {
    expect(parseEditorId(editorId('edit', 'channel', 'name', '123'))).toEqual({
      action: 'edit',
      scope: 'channel',
      field: 'name',
      channelId: '123',
    });
    expect(parseEditorId(editorId('save', 'primary', 'status', '9'))).toMatchObject({
      scope: 'primary',
      field: 'status',
    });
    expect(parseEditorId('something:else')).toBeNull();
    expect(parseEditorId('avc:tpl:save:bogus:name:123')).toBeNull(); // invalid scope
  });

  it('renders a panel with name + status sections, the docs link, and the buttons', () => {
    const panel = renderEditorPanel('channel', '123', state);
    expect(panel.ephemeral).toBe(true);
    const json = JSON.stringify(panel);
    expect(json).toContain('My Room'); // name current + preview
    expect(json).toContain('Playing Halo'); // status preview
    expect(json).toContain('https://auto-voice.io/docs/name-templates'); // docs link

    const labels = (panel.components as { components: { data: { label?: string } }[] }[]).flatMap(
      (row) => row.components.map((c) => c.data.label),
    );
    expect(labels).toEqual([
      'Edit name template',
      'Edit status template',
      'Reset name',
      'Reset status',
      'Close',
    ]);
  });

  it('prefills the edit modal from the current value (blank for an unset channel override)', () => {
    const nameModal = JSON.stringify(buildEditorModal('channel', 'name', '123', state).toJSON());
    expect(nameModal).toContain('My Room');

    // Status has no per-channel override → channel-scope modal starts blank.
    const statusModal = JSON.stringify(
      buildEditorModal('channel', 'status', '123', state).toJSON(),
    );
    expect(statusModal).not.toContain('PLAYING');

    // A primary-scope status modal falls back to the effective template.
    const primaryStatus = JSON.stringify(
      buildEditorModal('primary', 'status', '123', state).toJSON(),
    );
    expect(primaryStatus).toContain('PLAYING');
  });

  it('accepts the adopted scope and swaps "Reset name" for "Stop managing"', () => {
    expect(parseEditorId(editorId('stop', 'adopted', 'name', '42'))).toMatchObject({
      action: 'stop',
      scope: 'adopted',
    });
    const adoptedState: EditorState = {
      found: true,
      scope: 'adopted',
      name: {
        currentTemplate: "__General/@@creator@@'s room__",
        effectiveTemplate: "__General/@@creator@@'s room__",
        preview: 'General',
      },
      status: { effectiveTemplate: '', preview: '' },
      ownerId: null,
    };
    const labels = (
      renderEditorPanel('adopted', '42', adoptedState).components as {
        components: { data: { label?: string } }[];
      }[]
    ).flatMap((row) => row.components.map((c) => c.data.label));
    expect(labels).toEqual([
      'Edit name template',
      'Edit status template',
      'Stop managing',
      'Reset status',
      'Close',
    ]);
  });

  it('round-trips and validates adopt-prompt ids, and renders the confirm prompt', () => {
    expect(parseAdoptId('avc:adopt:confirm:99')).toEqual({ action: 'confirm', channelId: '99' });
    expect(parseAdoptId('avc:adopt:cancel:99')).toEqual({ action: 'cancel', channelId: '99' });
    expect(parseAdoptId('avc:adopt:bogus:99')).toBeNull();
    expect(parseAdoptId('avc:tpl:edit:channel:name:1')).toBeNull();

    const prompt = buildAdoptPrompt('99', 'Lobby');
    expect(prompt.ephemeral).toBe(true);
    const json = JSON.stringify(prompt);
    expect(json).toContain('Lobby'); // shows the resting (current) name
    expect(json).toContain('avc:adopt:confirm:99');
    expect(json).toContain('avc:adopt:cancel:99');
  });
});

/**
 * The variables block became fields (2026-09-20). Eleven variables separated by
 * middots read as one wall of punctuation; six fields read as six things.
 */
describe('templatePanel variables and branding', () => {
  const embedOf = (opts: Parameters<typeof renderEditorPanel>[3] = {}) =>
    renderEditorPanel('channel', '123', state, opts).embeds![0]! as {
      fields?: { name: string; value: string; inline?: boolean }[];
      footer?: { text: string; icon_url?: string };
    };

  it('gives each variable its own inline field', () => {
    const fields = embedOf().fields!;
    const names = fields.map((f) => f.name);
    for (const v of ['`@@game_name@@`', '`@@owner@@`', '`@@num@@`', '`##`', '`@@nato@@`']) {
      expect(names).toContain(v);
    }
    expect(fields.find((f) => f.name === '`@@game_name@@`')!.inline).toBe(true);
    // A handful, not all 25 Discord allows: the rest are one click away.
    expect(names).not.toContain('`@@slots@@`');
  });

  it('ends with the docs link and the review links, neither of them inline', () => {
    const fields = embedOf().fields!;
    const last = fields[fields.length - 1]!;
    const secondLast = fields[fields.length - 2]!;
    expect(secondLast.value).toContain('Full documentation');
    expect(secondLast.value).toContain('Plain text works too');
    expect(secondLast.inline).toBe(false);
    expect(last.value).toContain('top.gg');
    expect(last.value).toContain('support server');
    expect(last.inline).toBe(false);
  });

  /** Discord caps an embed at 25 fields and refuses the message past it. */
  it('stays inside the field cap with a note as well', () => {
    expect(embedOf({ note: 'saved' }).fields!.length).toBeLessThanOrEqual(25);
  });

  /**
   * The footer used to be spent entirely on "✅ Saved". Both now share it: the
   * render right after a save is the one an admin is definitely looking at, so
   * it is the wrong one to drop the branding from.
   */
  it('carries the brand footer, with the save confirmation in front of it', () => {
    expect(embedOf().footer!.text).toBe(
      'auto-voice.io  ·  Free and open source, dynamic voice channels.',
    );
    expect(embedOf().footer!.icon_url).toBe('https://auto-voice.io/logo-64.png');
    const saved = embedOf({ updated: true }).footer!.text;
    expect(saved).toContain('✅ Saved');
    expect(saved).toContain('auto-voice.io');
  });
});

/**
 * A creator channel's editor carries one more row: the switch for remembered room settings
 * and the button that clears what members saved. Only that scope has it.
 */
describe('templatePanel remembered settings', () => {
  const CHANNEL = '123456789012345678';
  const primaryState = (over: Partial<EditorState> = {}): EditorState => ({
    found: true,
    scope: 'primary',
    name: { effectiveTemplate: '## room', preview: '1 room' },
    status: { effectiveTemplate: '', preview: '' },
    ownerId: null,
    primaryChannelId: CHANNEL,
    ...over,
  });

  interface ButtonData {
    custom_id: string;
    label: string;
    style: number;
  }
  type Panel = ReturnType<typeof renderEditorPanel>;
  const rowsOf = (panel: Panel): ButtonData[][] =>
    (panel.components as unknown as { toJSON: () => { components: ButtonData[] } }[]).map(
      (row) => row.toJSON().components,
    );
  const fieldsOf = (panel: Panel) =>
    (panel.embeds![0]! as { fields: { name: string; value: string; inline?: boolean }[] }).fields;
  const FIELD = '💾 Remember user settings';

  it('adds a third row to a creator channel editor, after the template buttons', () => {
    const rows = rowsOf(renderEditorPanel('primary', CHANNEL, primaryState()));
    expect(rows.map((row) => row.map((b) => b.label))).toEqual([
      ['Edit name template', 'Edit status template'],
      ['Reset name', 'Reset status', 'Close'],
      ['Remember user settings: off', 'Clear saved settings'],
    ]);
  });

  it('adds nothing to a room editor or an adopted channel editor', () => {
    for (const scope of ['channel', 'adopted'] as const) {
      const panel = renderEditorPanel(scope, CHANNEL, { ...state, scope });
      expect(rowsOf(panel)).toHaveLength(2);
      expect(JSON.stringify(panel)).not.toContain('avc:tpl:remember');
      expect(JSON.stringify(panel)).not.toContain('avc:tpl:forget');
      expect(JSON.stringify(panel)).not.toContain('Remember user settings');
    }
  });

  /** A switch reads as its current state, and its button asks for the other one. */
  it('labels the switch with its current state and asks for the opposite', () => {
    const off = rowsOf(
      renderEditorPanel('primary', CHANNEL, primaryState({ rememberPrefs: false })),
    );
    expect(off[2]![0]).toMatchObject({
      custom_id: editorId('remember_on', 'primary', 'name', CHANNEL),
      label: 'Remember user settings: off',
      style: ButtonStyle.Secondary,
    });
    const on = rowsOf(renderEditorPanel('primary', CHANNEL, primaryState({ rememberPrefs: true })));
    expect(on[2]![0]).toMatchObject({
      custom_id: editorId('remember_off', 'primary', 'name', CHANNEL),
      label: 'Remember user settings: on',
      style: ButtonStyle.Success,
    });
  });

  it('treats a state with no flag as off, which is what a creator channel without one is', () => {
    const rows = rowsOf(renderEditorPanel('primary', CHANNEL, primaryState()));
    expect(rows[2]![0]!.custom_id).toBe(editorId('remember_on', 'primary', 'name', CHANNEL));
  });

  it('puts the clear button beside the switch, and routes it', () => {
    const rows = rowsOf(
      renderEditorPanel('primary', CHANNEL, primaryState({ rememberPrefs: true })),
    );
    expect(rows[2]![1]).toMatchObject({
      custom_id: editorId('forget', 'primary', 'name', CHANNEL),
      label: 'Clear saved settings',
    });
  });

  /**
   * It removes every member's saved settings at once and cannot be undone, so it is drawn as
   * the destructive button it is, like Stop managing, and not as one more neutral choice.
   */
  it('draws the clear button as a destructive one', () => {
    const rows = rowsOf(
      renderEditorPanel('primary', CHANNEL, primaryState({ rememberPrefs: true })),
    );
    expect(rows[2]![1]).toMatchObject({ style: ButtonStyle.Danger });
  });

  it('round trips the three ids, which name the creator channel and no field', () => {
    for (const action of ['remember_on', 'remember_off', 'forget']) {
      expect(parseEditorId(editorId(action, 'primary', 'name', CHANNEL))).toEqual({
        action,
        scope: 'primary',
        field: 'name',
        channelId: CHANNEL,
      });
    }
  });

  it('shows what it is doing in a field of its own, with the count', () => {
    const off = fieldsOf(renderEditorPanel('primary', CHANNEL, primaryState({ savedSettings: 3 })));
    const offField = off.find((f) => f.name === FIELD)!;
    expect(offField.value).toContain('**Off.**');
    expect(offField.value).toContain('3 members have saved settings, which are kept and not used');
    expect(offField.inline).toBeUndefined();

    const on = fieldsOf(
      renderEditorPanel(
        'primary',
        CHANNEL,
        primaryState({ rememberPrefs: true, savedSettings: 1 }),
      ),
    ).find((f) => f.name === FIELD)!;
    expect(on.value).toContain(
      '**On.** A member who comes back gets a room that starts with their own saved name, status, size and privacy',
    );
    expect(on.value).toContain('1 member has saved settings.');
  });

  it('shows no such field on a room editor', () => {
    expect(fieldsOf(renderEditorPanel('channel', CHANNEL, state)).map((f) => f.name)).not.toContain(
      FIELD,
    );
  });

  /**
   * `member_prefs.disabled` is on: an admin who read "On" while nothing is saved or restored
   * would take it for a fault in their own setup. The switch itself still reads and works as it
   * does, because the lever does not stop an admin turning remembering off or clearing.
   */
  describe('while remembering is switched off for now', () => {
    const paused = (extra: Partial<EditorState> = {}) =>
      renderEditorPanel(
        'primary',
        CHANNEL,
        primaryState({ rememberPrefs: true, rememberPaused: true, ...extra }),
      );

    it('says so in the field, in place of plain On, and keeps the count', () => {
      const field = fieldsOf(paused({ savedSettings: 2 })).find((f) => f.name === FIELD)!;
      expect(field.value).toMatch(/^\*\*On, but switched off for now\.\*\*/);
      expect(field.value).not.toContain('**On.**');
      expect(field.value).toContain('2 members have saved settings.');
    });

    it('leaves the switch and the clear button as they are', () => {
      const rows = rowsOf(paused());
      expect(rows[2]![0]).toMatchObject({
        custom_id: editorId('remember_off', 'primary', 'name', CHANNEL),
        label: 'Remember user settings: on',
      });
      expect(rows[2]![1]).toMatchObject({
        custom_id: editorId('forget', 'primary', 'name', CHANNEL),
      });
    });

    it('says nothing of it for a creator channel that is off, or when the lever is not on', () => {
      const off = fieldsOf(
        renderEditorPanel(
          'primary',
          CHANNEL,
          primaryState({ rememberPrefs: false, rememberPaused: true }),
        ),
      ).find((f) => f.name === FIELD)!;
      expect(off.value).toContain('**Off.**');
      expect(off.value).not.toContain('switched off for now');
      const normal = fieldsOf(
        renderEditorPanel('primary', CHANNEL, primaryState({ rememberPrefs: true })),
      ).find((f) => f.name === FIELD)!;
      expect(normal.value).not.toContain('switched off for now');
    });

    it('keeps to the copy rules and fits a field, with the largest count', () => {
      const value = fieldsOf(paused({ savedSettings: 12345 })).find((f) => f.name === FIELD)!.value;
      expect(value).not.toMatch(/[—–‘’“”;]/);
      expect(value.toLowerCase()).not.toMatch(/primary|secondary|\bai\b/);
      expect(value.length).toBeLessThanOrEqual(1024);
    });
  });

  /**
   * Discord allows five action rows of five buttons, an embed of 25 fields and a custom id of
   * 100 characters, and refuses the whole message past any of them.
   */
  describe("stays inside Discord's ceilings", () => {
    const panels = (): Panel[] =>
      [false, true].flatMap((rememberPrefs) =>
        [undefined, 0, 12345].map((savedSettings) =>
          renderEditorPanel(
            'primary',
            CHANNEL,
            primaryState({
              rememberPrefs,
              ...(savedSettings === undefined ? {} : { savedSettings }),
            }),
            { updated: true, note: REMEMBER_ON_NOTE },
          ),
        ),
      );

    it('keeps rows, buttons, custom ids and labels inside them', () => {
      for (const panel of panels()) {
        const rows = rowsOf(panel);
        expect(rows.length).toBeLessThanOrEqual(5);
        for (const row of rows) {
          expect(row.length).toBeLessThanOrEqual(5);
          for (const button of row) {
            expect(button.custom_id.length).toBeLessThanOrEqual(100);
            expect(button.label.length).toBeLessThanOrEqual(80);
          }
        }
      }
    });

    it('keeps fields and their values inside them, with the longest note', () => {
      for (const panel of panels()) {
        const fields = fieldsOf(panel);
        expect(fields.length).toBeLessThanOrEqual(25);
        for (const field of fields) expect(field.value.length).toBeLessThanOrEqual(1024);
      }
    });

    it('gives every button on the panel its own id', () => {
      const ids = rowsOf(renderEditorPanel('primary', CHANNEL, primaryState())).flatMap((row) =>
        row.map((b) => b.custom_id),
      );
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  /**
   * The copy rules, over what this adds to the panel in every state: its field, its buttons
   * and the notes it is given. The punctuation rules are mechanical, and nothing else checks
   * the strings an admin reads here.
   */
  describe('copy rules', () => {
    const addedText = (): string => {
      const pieces: string[] = [];
      for (const rememberPrefs of [false, true]) {
        for (const savedSettings of [undefined, 0, 1, 7]) {
          for (const note of [undefined, REMEMBER_ON_NOTE, REMEMBER_OFF_NOTE, clearedNote(7)]) {
            const panel = renderEditorPanel(
              'primary',
              CHANNEL,
              primaryState({
                rememberPrefs,
                ...(savedSettings === undefined ? {} : { savedSettings }),
              }),
              note === undefined ? {} : { updated: true, note },
            );
            pieces.push(fieldsOf(panel).find((f) => f.name === FIELD)!.value, FIELD);
            pieces.push(...rowsOf(panel)[2]!.map((b) => b.label));
            if (note !== undefined) pieces.push(note);
          }
        }
      }
      return pieces.join('\n');
    };

    it('uses no em or en dashes, curly quotes, or prose semicolons', () => {
      const text = addedText();
      expect(text).not.toMatch(/[—–]/);
      expect(text).not.toMatch(/[‘’“”]/);
      expect(text).not.toMatch(/;/);
    });

    it('never says primary or secondary to an admin', () => {
      expect(addedText().toLowerCase()).not.toMatch(/primary|secondary/);
    });
  });
});
