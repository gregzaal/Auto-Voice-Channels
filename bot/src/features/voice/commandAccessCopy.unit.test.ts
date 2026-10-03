import { describe, expect, it } from 'vitest';
import {
  AVAILABLE_FEATURES,
  COMMAND_FEATURES,
  type CommandAccess,
  type RestrictTarget,
} from './commandAccess.js';
import {
  RESTRICT_NOTE,
  RESTRICT_REFUSALS,
  renderRestrictionList,
  restrictAddedMessage,
  restrictClearedMessage,
  restrictMention,
  restrictRemovedMessage,
} from './commandAccessCopy.js';

const USER: RestrictTarget = { kind: 'user', id: '111111111111111111' };
const ROLE: RestrictTarget = { kind: 'role', id: '333333333333333333' };

/** `count` distinct 19-digit snowflakes, the longest a real mention gets. */
const ids = (offset: number, count: number): string[] =>
  Array.from({ length: count }, (_, i) => `${offset}${String(i).padStart(18, '0')}`);

/** The longest list the writer allows in every feature `/restrict` offers. */
const fullAccess = (): CommandAccess =>
  Object.fromEntries(
    AVAILABLE_FEATURES.map((feature, i) => [
      feature,
      { users: ids(i + 1, 50), roles: ids(i + 6, 25) },
    ]),
  );

/**
 * Every reply `/restrict` can give, rendered, so the copy rules are checked on
 * what an admin reads and not on source text, where only a curly quote shows.
 */
function everyReply(): string[] {
  const replies: string[] = [RESTRICT_NOTE];
  for (const feature of COMMAND_FEATURES) {
    for (const target of [USER, ROLE]) {
      for (const already of [false, true]) {
        for (const nicknameCleared of [false, true]) {
          replies.push(restrictAddedMessage(target, feature, { already, nicknameCleared }));
        }
      }
      for (const was of [false, true])
        replies.push(restrictRemovedMessage(target, feature, { was }));
    }
    for (const removed of [0, 1, 7]) replies.push(restrictClearedMessage(feature, { removed }));
    replies.push(
      RESTRICT_REFUSALS.tooManyUsers(feature),
      RESTRICT_REFUSALS.tooManyRoles(feature),
      RESTRICT_REFUSALS.unreadable(feature),
    );
  }
  replies.push(
    RESTRICT_REFUSALS.everyone,
    RESTRICT_REFUSALS.unusable,
    RESTRICT_REFUSALS.unknownFeature,
    RESTRICT_REFUSALS.tooMany,
    RESTRICT_REFUSALS.bot(USER),
    RESTRICT_REFUSALS.manager(USER),
    RESTRICT_REFUSALS.manager(ROLE),
    renderRestrictionList({}),
    renderRestrictionList(fullAccess()),
    renderRestrictionList({ rename: { users: [USER.id], roles: [ROLE.id] } }),
  );
  return replies;
}

describe('the /restrict copy rules', () => {
  it('uses no em or en dashes, no curly quotes and no prose semicolons', () => {
    for (const text of everyReply()) {
      expect(text, 'no em or en dashes').not.toMatch(/[—–]/);
      expect(text, 'straight quotes only').not.toMatch(/[‘’“”]/);
      expect(text, 'no prose semicolons').not.toContain(';');
    }
  });

  it('never says primary or secondary to an admin', () => {
    for (const text of everyReply()) expect(text.toLowerCase()).not.toMatch(/primary|secondary/);
  });

  /** Sentence case: every sentence starts a capital, a mention, a bold label or a command. */
  it('starts every reply the way a sentence starts', () => {
    for (const text of everyReply()) expect(text).toMatch(/^[A-Z<*]/);
  });

  it('claims nothing about generated or automatic content', () => {
    for (const text of everyReply()) expect(text.toLowerCase()).not.toMatch(/\bai\b|generat/);
  });
});

describe('restrictMention', () => {
  it('renders a user and a role as the mention Discord expects', () => {
    expect(restrictMention(USER)).toBe('<@111111111111111111>');
    expect(restrictMention(ROLE)).toBe('<@&333333333333333333>');
  });
});

describe('the note under add and list', () => {
  /** Both halves are true limits an admin should hear before relying on a rule. */
  it('says the rules only apply on versions that include them', () => {
    expect(RESTRICT_NOTE).toContain('Restrictions only apply on versions of AVC that include them');
  });

  it('says Discord Integrations still apply to slash commands and the panel ignores them', () => {
    expect(RESTRICT_NOTE).toContain(
      "Discord's own Integrations settings still apply to slash commands",
    );
    expect(RESTRICT_NOTE).toContain('room panel buttons ignore those settings');
  });
});

describe('restrictAddedMessage', () => {
  it('says who can no longer use what, and what that covers', () => {
    expect(restrictAddedMessage(USER, 'rename', { already: false, nicknameCleared: false })).toBe(
      '<@111111111111111111> can no longer use **Name**. That covers the /name command, the Name ' +
        'button, the template editor for their own room and the voice status.',
    );
  });

  it('says an undo direction stays open where the feature has one', () => {
    const privacy = restrictAddedMessage(ROLE, 'privacy', {
      already: false,
      nicknameCleared: false,
    });
    expect(privacy).toContain('Opening a room again stays open to everyone.');
  });

  it('says a repeat changed nothing', () => {
    expect(restrictAddedMessage(USER, 'limit', { already: true, nicknameCleared: false })).toBe(
      '<@111111111111111111> is already restricted from **Size**, so nothing changed.',
    );
  });

  it('says the saved nickname was removed, on a new restriction and on a repeat', () => {
    for (const already of [false, true]) {
      const text = restrictAddedMessage(USER, 'nick', { already, nicknameCleared: true });
      expect(text).toMatch(/ Their saved nickname was removed\.$/);
    }
  });

  /** A repeat that removed a name did change something, so it cannot say it did not. */
  it('does not say "nothing changed" in the same breath as a removed nickname', () => {
    expect(restrictAddedMessage(USER, 'nick', { already: true, nicknameCleared: true })).toBe(
      '<@111111111111111111> is already restricted from **Nickname**. Their saved nickname was removed.',
    );
    expect(restrictAddedMessage(USER, 'nick', { already: true, nicknameCleared: false })).toBe(
      '<@111111111111111111> is already restricted from **Nickname**, so nothing changed.',
    );
  });

  it('does not mention a nickname when none was removed', () => {
    const text = restrictAddedMessage(USER, 'nick', { already: false, nicknameCleared: false });
    expect(text).not.toContain('nickname');
  });
});

describe('restrictRemovedMessage', () => {
  it('says who can use what again', () => {
    expect(restrictRemovedMessage(ROLE, 'transfer', { was: true })).toBe(
      '<@&333333333333333333> can use **Transfer** again.',
    );
  });

  it('says there was nothing to remove', () => {
    expect(restrictRemovedMessage(USER, 'privacy', { was: false })).toBe(
      '<@111111111111111111> was not restricted from **Private and Public**, so nothing changed.',
    );
  });
});

describe('restrictClearedMessage', () => {
  it('says how many restrictions came off and that everyone can use it again', () => {
    expect(restrictClearedMessage('rename', { removed: 1 })).toBe(
      'Removed 1 restriction on **Name**. Everyone can use it again.',
    );
    expect(restrictClearedMessage('rename', { removed: 7 })).toBe(
      'Removed 7 restrictions on **Name**. Everyone can use it again.',
    );
  });

  it('says there was nothing to clear', () => {
    expect(restrictClearedMessage('limit', { removed: 0 })).toBe(
      'Nobody was restricted from **Size**, so nothing changed.',
    );
  });
});

describe('the refusals', () => {
  it('say why, and what to do instead', () => {
    expect(RESTRICT_REFUSALS.everyone).toContain('everyone role');
    expect(RESTRICT_REFUSALS.everyone).toContain('Pick');
    expect(RESTRICT_REFUSALS.bot(USER)).toContain('is a bot');
    expect(RESTRICT_REFUSALS.manager(USER)).toContain('Manage Channels or Administrator');
    expect(RESTRICT_REFUSALS.manager(USER)).toContain('would do nothing');
    expect(RESTRICT_REFUSALS.tooManyUsers('rename')).toContain('50 people');
    expect(RESTRICT_REFUSALS.tooManyRoles('rename')).toContain('25 roles');
    expect(RESTRICT_REFUSALS.tooMany).toContain('150 restrictions');
  });

  /**
   * A full list can be full of people who left and roles that were deleted, which
   * Discord's picker cannot offer to `remove`, so a refusal that said only "remove
   * someone" would send the admin to something that cannot work.
   */
  it('name /restrict clear as the way out of a full list', () => {
    expect(RESTRICT_REFUSALS.tooManyUsers('rename')).toContain('/restrict clear');
    expect(RESTRICT_REFUSALS.tooManyRoles('rename')).toContain('/restrict clear');
    expect(RESTRICT_REFUSALS.tooMany).toContain('/restrict clear');
  });

  it('say a list of a shape this version cannot change was left alone', () => {
    expect(RESTRICT_REFUSALS.unreadable('rename')).toBe(
      'The saved restrictions for **Name** are in a form this version of AVC cannot change, so nothing was changed.',
    );
  });

  it('name the target as a mention, which nobody is pinged by', () => {
    expect(RESTRICT_REFUSALS.bot(USER)).toContain('<@111111111111111111>');
    expect(RESTRICT_REFUSALS.manager(ROLE)).toContain('<@&333333333333333333>');
  });
});

describe('renderRestrictionList', () => {
  /** The lists name who is DENIED, so a heading about who "can use" reads as the opposite. */
  it('is headed by what the lists are, who is restricted, and never by who can use', () => {
    for (const access of [{}, fullAccess()]) {
      const first = renderRestrictionList(access).split('\n')[0];
      expect(first).toBe('**Restricted from room commands**');
    }
    expect(renderRestrictionList({})).not.toContain('Who can use');
  });

  it('says nobody is restricted for every feature when nothing is stored', () => {
    const text = renderRestrictionList({});
    for (const label of ['Private and Public', 'Size', 'Name', 'Transfer', 'Nickname']) {
      expect(text).toContain(`**${label}**: nobody is restricted`);
    }
  });

  /** Hide and Saved lists have no command yet, so offering them would restrict nothing. */
  it('lists only the features /restrict offers, even when others are stored', () => {
    const text = renderRestrictionList({
      hide: { users: [USER.id], roles: [] },
      access: { users: [USER.id], roles: [] },
    });
    expect(text).not.toContain('Hide');
    expect(text).not.toContain('Saved lists');
    expect(text).not.toContain(USER.id);
  });

  it('shows roles before people, as mentions', () => {
    const text = renderRestrictionList({
      rename: { users: [USER.id], roles: [ROLE.id] },
    });
    expect(text).toContain(`**Name**: <@&${ROLE.id}>, <@${USER.id}>`);
  });

  it('keeps each feature to its own line, in the order /restrict offers them', () => {
    const lines = renderRestrictionList({ nick: { users: [USER.id], roles: [] } }).split('\n');
    expect(lines.slice(1, 6).map((l) => l.split(':')[0])).toEqual([
      '**Private and Public**',
      '**Size**',
      '**Name**',
      '**Transfer**',
      '**Nickname**',
    ]);
  });

  it('caps a long list with an honest tail rather than cutting it off', () => {
    const text = renderRestrictionList({ rename: { users: ids(1, 20), roles: ids(2, 5) } });
    expect(text).toContain('and 17 more');
    expect(text.match(/<@&?\d+>/g)).toHaveLength(8);
  });

  it('does not add a tail to a list that fits', () => {
    const text = renderRestrictionList({ rename: { users: ids(1, 8), roles: [] } });
    expect(text).not.toContain('more');
  });

  /** The most the writer allows, in every feature at once. */
  it('fits one Discord message at the largest size the caps allow', () => {
    expect(renderRestrictionList(fullAccess()).length).toBeLessThanOrEqual(2000);
  });

  /** Whatever was cut, the two lines an admin must not miss are the last two. */
  it('always ends with who is never restricted and the note', () => {
    for (const access of [{}, fullAccess()]) {
      const lines = renderRestrictionList(access).split('\n');
      expect(lines.at(-1)).toBe(RESTRICT_NOTE);
      expect(lines.at(-2)).toContain('Manage Channels or Administrator');
    }
  });
});
