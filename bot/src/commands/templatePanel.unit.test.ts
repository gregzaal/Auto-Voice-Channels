import { describe, expect, it } from 'vitest';
import type { EditorState } from '../features/voice/index.js';
import { buildEditorModal, editorId, parseEditorId, renderEditorPanel } from './templatePanel.js';

const state: EditorState = {
  found: true,
  currentTemplate: 'My Room',
  effectiveTemplate: 'My Room',
  preview: 'My Room',
  ownerId: 'alice',
  primaryChannelId: 'p',
  serverDefault: '## [@@game_name@@]',
};

describe('templatePanel', () => {
  it('round-trips custom ids', () => {
    expect(parseEditorId(editorId('edit', 'name', '123'))).toEqual({
      action: 'edit',
      kind: 'name',
      channelId: '123',
    });
    expect(parseEditorId('something:else')).toBeNull();
    expect(parseEditorId('avc:tpl:save:bogus:123')).toBeNull(); // invalid kind
  });

  it('renders an ephemeral panel with the preview and Edit/Reset/Close buttons', () => {
    const panel = renderEditorPanel('name', '123', state);
    expect(panel.ephemeral).toBe(true);
    const json = JSON.stringify(panel);
    expect(json).toContain('My Room'); // current + preview
    const labels = (
      panel.components![0] as { components: { data: { label?: string } }[] }
    ).components.map((c) => c.data.label);
    expect(labels).toEqual(['Edit', 'Reset to default', 'Close']);
  });

  it('builds an edit modal prefilled appropriately per kind', () => {
    // A name override starts from the override (blank if none); a template from current.
    const nameModal = buildEditorModal('name', '123', state).toJSON();
    const tmplModal = buildEditorModal('template', '123', {
      ...state,
      currentTemplate: undefined,
      effectiveTemplate: '## [@@game_name@@]',
    }).toJSON();
    expect(JSON.stringify(nameModal)).toContain('My Room');
    expect(JSON.stringify(tmplModal)).toContain('@@game_name@@'); // falls back to effective
  });
});
