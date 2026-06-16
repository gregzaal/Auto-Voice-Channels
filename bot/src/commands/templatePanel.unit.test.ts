import { describe, expect, it } from 'vitest';
import type { EditorState } from '../features/voice/index.js';
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
    expect(json).toContain('https://wiki.dotsbots.com/en/commands/template'); // docs link

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
