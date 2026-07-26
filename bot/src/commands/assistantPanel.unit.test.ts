import { describe, expect, it } from 'vitest';
import type { Proposal } from '../features/templateAssistant/index.js';
import {
  assistantId,
  buildAssistantModal,
  buildProposalPanel,
  parseAssistantId,
  REQUEST_INPUT_MAX,
} from './assistantPanel.js';

const proposal: Proposal = {
  name: '## - @@game_name@@',
  status: null,
  explanation: 'Each room is numbered and shows the game.',
  fields: [
    {
      field: 'name',
      template: '## - @@game_name@@',
      previews: [
        { label: 'one person, nothing playing', rendered: '#1 - General' },
        { label: 'three people in a game', rendered: '#1 - Halo' },
      ],
    },
  ],
  notes: [],
};

const json = (value: unknown): string => JSON.stringify(value);

describe('assistant custom ids', () => {
  it('round-trips an action and a session id', () => {
    expect(parseAssistantId(assistantId('apply', 'abc123'))).toEqual({
      action: 'apply',
      sessionId: 'abc123',
    });
  });

  it('ignores ids from other features', () => {
    expect(parseAssistantId('avc:tpl:edit:primary:name:1')).toBeNull();
    expect(parseAssistantId('avc:ai:apply')).toBeNull();
  });

  // Discord caps a custom id at 100 characters, which is why the proposal
  // itself lives in memory and only a key rides in the id.
  it('stays well inside Discord’s custom-id limit', () => {
    expect(assistantId('refine', 'a'.repeat(12)).length).toBeLessThan(100);
  });
});

describe('buildAssistantModal', () => {
  it('asks for a description on the first pass and a change on a refine', () => {
    const first = json(buildAssistantModal('s1', false).toJSON());
    expect(first).toContain('Describe the name you want');
    expect(first).toContain('avc:ai:ask:s1');

    const refine = json(buildAssistantModal('s1', true).toJSON());
    expect(refine).toContain('What should change?');
    expect(refine).toContain('avc:ai:refine:s1');
  });

  it('bounds the request length', () => {
    const modal = buildAssistantModal('s1', false).toJSON();
    const input = modal.components[0]!.components[0] as { max_length?: number; custom_id: string };
    expect(input.custom_id).toBe('request');
    expect(input.max_length).toBe(REQUEST_INPUT_MAX);
  });
});

describe('buildProposalPanel', () => {
  it('shows the template, every preview state, and Apply / Refine / Cancel', () => {
    const panel = buildProposalPanel('s1', proposal);
    const text = json(panel);

    expect(text).toContain('## - @@game_name@@');
    // The previews are the point: the admin is clicking Apply on states they
    // cannot see in their own channel right now.
    expect(text).toContain('#1 - General');
    expect(text).toContain('one person, nothing playing');
    expect(text).toContain('avc:ai:apply:s1');
    expect(text).toContain('avc:ai:refine:s1');
    expect(text).toContain('avc:ai:cancel:s1');
    expect(panel.ephemeral).toBe(true);
  });

  it('offers no Apply when the assistant declined and set nothing', () => {
    const declined: Proposal = {
      name: null,
      status: null,
      explanation: 'There is no token for whether a channel is locked.',
      fields: [],
      notes: [],
    };
    const text = json(buildProposalPanel('s1', declined));
    expect(text).toContain('no token for whether a channel is locked');
    expect(text).not.toContain('avc:ai:apply:s1');
    expect(text).toContain('avc:ai:refine:s1');
  });

  it('surfaces notes and the cap notice without turning them into a blocker', () => {
    const text = json(
      buildProposalPanel(
        's1',
        { ...proposal, notes: ['The conditional has no fallback.'] },
        { capNotice: 'Heads up, that is 100 of 200 AI builds this month for this server.' },
      ),
    );
    expect(text).toContain('The conditional has no fallback.');
    expect(text).toContain('100 of 200 AI builds');
    // Still fully usable: the notice never removes Apply.
    expect(text).toContain('avc:ai:apply:s1');
  });

  it('truncates a long template rather than blowing the embed field limit', () => {
    const long = { ...proposal, fields: [{ ...proposal.fields[0]!, template: 'x'.repeat(2_000) }] };
    const panel = buildProposalPanel('s1', long);
    const field = (panel.embeds![0] as { fields: { value: string }[] }).fields[0]!;
    expect(field.value.length).toBeLessThanOrEqual(1_024);
  });
});
