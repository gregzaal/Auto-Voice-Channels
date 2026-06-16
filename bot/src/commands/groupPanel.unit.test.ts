import { describe, expect, it } from 'vitest';
import {
  buildGroupDisablePanel,
  buildGroupEnablePanel,
  groupId,
  parseGroupId,
} from './groupPanel.js';

describe('groupPanel', () => {
  it('round-trips and validates group button ids (incl. the @root sentinel)', () => {
    expect(parseGroupId(groupId('below', 'cat-1'))).toEqual({
      action: 'below',
      categoryKey: 'cat-1',
    });
    expect(parseGroupId(groupId('above', '@root'))).toEqual({
      action: 'above',
      categoryKey: '@root',
    });
    expect(parseGroupId(groupId('off', 'cat-1'))).toEqual({ action: 'off', categoryKey: 'cat-1' });
    expect(parseGroupId(groupId('cancel', 'cat-1'))).toMatchObject({ action: 'cancel' });
    expect(parseGroupId('avc:group:bogus:cat-1')).toBeNull();
    expect(parseGroupId('avc:tpl:edit:channel:name:1')).toBeNull();
  });

  it('builds the enable panel with Group below / above / Cancel and the category name', () => {
    const panel = buildGroupEnablePanel('cat-1', 'Gaming', 3);
    expect(panel.ephemeral).toBe(true);
    const json = JSON.stringify(panel);
    expect(json).toContain('Gaming'); // category named in the copy
    expect(json).toContain('**3** creator channels'); // count surfaced
    expect(json).toContain('avc:group:below:cat-1');
    expect(json).toContain('avc:group:above:cat-1');
    expect(json).toContain('avc:group:cancel:cat-1');
  });

  it('the enable panel labels the server root and singularizes the count', () => {
    const json = JSON.stringify(buildGroupEnablePanel('@root', null, 1));
    expect(json).toContain('the server root');
    expect(json).toContain('**1** creator channel here'); // singular
  });

  it('builds the disable panel with current direction + a Turn off button', () => {
    const json = JSON.stringify(buildGroupDisablePanel('cat-1', 'Gaming', true));
    expect(json).toContain('above'); // shows current direction
    expect(json).toContain('avc:group:off:cat-1');
    expect(json).toContain('avc:group:cancel:cat-1');
  });
});
