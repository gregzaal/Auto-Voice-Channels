import { describe, expect, it } from 'vitest';
import { buildTextChannelsModal } from './textChannelsModal.js';

/**
 * The modal behind the "Room text channels" setting. Its role picker also decides who
 * sees a hidden room, which a label about chat does not say, so the field carries a
 * description that does.
 */
describe('buildTextChannelsModal', () => {
  const fields = (current: { name: string; roleId: string | null }) =>
    (
      buildTextChannelsModal(current).toJSON() as {
        components: { label: string; description?: string }[];
      }
    ).components;

  it('keeps the role label about chat and says in its description that the role also sees hidden rooms', () => {
    const role = fields({ name: 'voice context', roleId: null }).find((c) =>
      c.label.startsWith('Role that can read'),
    )!;
    expect(role.label).toBe('Role that can read every room chat');
    expect(role.description).toBe('This role can also see hidden rooms.');
  });

  /** Discord caps a modal label at 45 characters and its description at 100. */
  it('stays inside Discord’s limits', () => {
    for (const c of fields({ name: 'x', roleId: null })) {
      expect(c.label.length).toBeLessThanOrEqual(45);
      expect((c.description ?? '').length).toBeLessThanOrEqual(100);
    }
  });

  it('follows the copy rules in everything it says', () => {
    const text = JSON.stringify(buildTextChannelsModal({ name: 'x', roleId: null }).toJSON());
    expect(text).not.toMatch(/[—–‘’“”;]/);
    expect(text.toLowerCase()).not.toMatch(/primary|secondary/);
  });
});
