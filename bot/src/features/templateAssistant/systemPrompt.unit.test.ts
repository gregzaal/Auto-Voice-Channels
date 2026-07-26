import { describe, expect, it } from 'vitest';
import { AT_TOKENS, CONDITION_VARIABLES, NUMBER_TOKENS } from '../voice/nameTemplate.js';
import { STYLE_MODES } from '../voice/stringTransforms.js';
import { TEMPLATE_ASSISTANT_SYSTEM_PROMPT } from './systemPrompt.js';

/**
 * The drift guard `plans/assisted_templates.md` §8 asks for: "keep the
 * system-prompt docs in sync with the engine".
 *
 * A token the prompt never mentions is a token the assistant will never use,
 * and — worse — one it may invent a wrong spelling for. That failure is
 * invisible in production: the model just quietly writes worse templates. So
 * the engine's own exported vocabulary is the test oracle, and adding a token
 * to the engine without documenting it here fails the build.
 */
describe('the assistant system prompt', () => {
  it('ships as a readable asset beside the module', () => {
    expect(TEMPLATE_ASSISTANT_SYSTEM_PROMPT.length).toBeGreaterThan(1_000);
    expect(TEMPLATE_ASSISTANT_SYSTEM_PROMPT).toContain('# Token reference');
  });

  it('documents every token the engine substitutes', () => {
    for (const token of AT_TOKENS) {
      expect(TEMPLATE_ASSISTANT_SYSTEM_PROMPT, `${token} is undocumented`).toContain(token);
    }
    for (const token of NUMBER_TOKENS) {
      expect(TEMPLATE_ASSISTANT_SYSTEM_PROMPT, `${token} is undocumented`).toContain(token);
    }
  });

  it('documents every conditional variable', () => {
    for (const variable of CONDITION_VARIABLES) {
      expect(TEMPLATE_ASSISTANT_SYSTEM_PROMPT, `${variable} is undocumented`).toContain(
        `\`${variable}\``,
      );
    }
  });

  it('documents every style mode', () => {
    for (const mode of STYLE_MODES) {
      expect(TEMPLATE_ASSISTANT_SYSTEM_PROMPT, `${mode} is undocumented`).toContain(`\`${mode}\``);
    }
  });

  it('documents the block constructs', () => {
    for (const construct of ['[[a/b/c]]', '<<one/many>>', '__empty/in-use__', '""mode:text""']) {
      expect(TEMPLATE_ASSISTANT_SYSTEM_PROMPT).toContain(construct);
    }
  });

  it('states the JSON output contract the parser depends on', () => {
    for (const key of ['"name"', '"status"', '"explanation"']) {
      expect(TEMPLATE_ASSISTANT_SYSTEM_PROMPT).toContain(key);
    }
  });

  // The §9 "not yet probed" gap the plan requires to land with the command.
  it('tells the model the request is data, not instructions', () => {
    expect(TEMPLATE_ASSISTANT_SYSTEM_PROMPT).toContain('<<<REQUEST');
    expect(TEMPLATE_ASSISTANT_SYSTEM_PROMPT).toContain('REQUEST>>>');
    expect(TEMPLATE_ASSISTANT_SYSTEM_PROMPT).toMatch(/never add a link, an invite, or a mass/i);
  });

  // §9 finding 1: the reply-language field is what took explanation drift to zero.
  it('binds the explanation language to the context field', () => {
    expect(TEMPLATE_ASSISTANT_SYSTEM_PROMPT).toContain('Reply language');
  });

  // §9 finding 4: for this one, a concrete worked example beat a blunt rule.
  it('keeps the worked example that stopped the member-count conditional', () => {
    expect(TEMPLATE_ASSISTANT_SYSTEM_PROMPT).toContain('{{@@num@@ >= 5 ?? busy}}');
  });
});
