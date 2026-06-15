import { describe, expect, it } from 'vitest';
import type { EditorState } from '../features/voice/index.js';
import { buildEditorModal, editorId, parseEditorId, renderEditorPanel } from './templatePanel.js';

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
});
