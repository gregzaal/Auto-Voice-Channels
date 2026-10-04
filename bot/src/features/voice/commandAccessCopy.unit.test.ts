import { describe, expect, it } from 'vitest';
import {
  ACCESS_LISTS,
  AVAILABLE_FEATURES,
  COMMAND_FEATURES,
  type AccessList,
  type CommandAccess,
  type RestrictTarget,
} from './commandAccess.js';
import {
  DELETED_ROLE_NOTE,
  RESTRICT_NOTE,
  RESTRICT_PAUSED,
  RESTRICT_REFUSALS,
  renderRestrictionList,
  restrictAllowedMessage,
  restrictClearedMessage,
  restrictDeniedMessage,
  restrictedRefusal,
  restrictMention,
  restrictRemovedMessage,
} from './commandAccessCopy.js';

const USER: RestrictTarget = { kind: 'user', id: '111111111111111111' };
const ROLE: RestrictTarget = { kind: 'role', id: '333333333333333333' };
const OTHER_ROLE = '444444444444444444';

/** `count` distinct 19-digit snowflakes, the longest a real mention gets. */
const ids = (offset: number, count: number): string[] =>
  Array.from({ length: count }, (_, i) => `${offset}${String(i).padStart(18, '0')}`);

/** The longest lists the writer allows, on both lists of every feature `/restrict` offers. */
const fullAccess = (): CommandAccess =>
  Object.fromEntries(
    AVAILABLE_FEATURES.map((feature, i) => [
      feature,
      {
        allow: { users: ids(i + 1, 50), roles: ids(i + 6, 25) },
        deny: { users: ids(i + 2, 50), roles: ids(i + 7, 25) },
      },
    ]),
  );

const bools = [false, true] as const;

/**
 * Every reply `/restrict` can give, rendered, so the copy rules are checked on
 * what an admin reads and not on source text, where only a curly quote shows.
 */
function everyReply(): string[] {
  const replies: string[] = [RESTRICT_NOTE, RESTRICT_PAUSED, DELETED_ROLE_NOTE];
  for (const feature of COMMAND_FEATURES) {
    replies.push(restrictedRefusal(feature));
    for (const target of [USER, ROLE]) {
      for (const already of bools) {
        for (const nicknameCleared of bools) {
          for (const moved of bools) {
            for (const allowEmptied of bools) {
              replies.push(
                restrictDeniedMessage(target, feature, {
                  already,
                  nicknameCleared,
                  moved,
                  allowEmptied,
                }),
              );
            }
          }
        }
        for (const created of bools) {
          for (const manager of bools) {
            for (const moved of bools) {
              replies.push(
                restrictAllowedMessage(target, feature, { already, created, manager, moved }),
              );
            }
          }
        }
      }
      for (const from of [[], ['allow'], ['deny'], ['allow', 'deny']] as AccessList[][]) {
        for (const allowEmptied of bools) {
          for (const allowAfter of bools) {
            replies.push(
              restrictRemovedMessage(target, feature, { from, allowEmptied, allowAfter }),
            );
          }
        }
      }
    }
    for (const removed of [0, 1, 7]) replies.push(restrictClearedMessage(feature, { removed }));
    for (const list of ACCESS_LISTS) {
      replies.push(
        RESTRICT_REFUSALS.tooManyUsers(feature, list),
        RESTRICT_REFUSALS.tooManyRoles(feature, list),
      );
    }
    replies.push(RESTRICT_REFUSALS.unreadable(feature));
  }
  replies.push(
    RESTRICT_REFUSALS.everyone,
    RESTRICT_REFUSALS.everyoneAllowed,
    RESTRICT_REFUSALS.unusable,
    RESTRICT_REFUSALS.unknownFeature,
    RESTRICT_REFUSALS.tooMany,
    RESTRICT_REFUSALS.bot(USER),
    RESTRICT_REFUSALS.manager(USER),
    RESTRICT_REFUSALS.manager(ROLE),
    renderRestrictionList({}),
    renderRestrictionList(fullAccess()),
    renderRestrictionList({ rename: { deny: { users: [USER.id], roles: [ROLE.id] } } }),
    renderRestrictionList(
      { rename: { allow: { users: [], roles: [ROLE.id] }, deny: { users: [USER.id], roles: [] } } },
      { roleExists: () => false },
    ),
    renderRestrictionList(fullAccess(), { paused: true }),
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

describe('the note under allow, deny and list', () => {
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

describe('restrictDeniedMessage', () => {
  const plain = { already: false, nicknameCleared: false, moved: false, allowEmptied: false };

  it('says who can no longer use what, and what that covers', () => {
    expect(restrictDeniedMessage(USER, 'rename', plain)).toBe(
      '<@111111111111111111> can no longer use **Name**. That covers the /name command, the Name ' +
        "button, the template editor for a member's own room and the voice status.",
    );
  });

  it('says an undo direction stays open where the feature has one', () => {
    expect(restrictDeniedMessage(ROLE, 'privacy', plain)).toContain(
      'Opening a room again stays open to everyone.',
    );
  });

  it('says a repeat changed nothing', () => {
    expect(restrictDeniedMessage(USER, 'limit', { ...plain, already: true })).toBe(
      '<@111111111111111111> is already restricted from **Size**, so nothing changed.',
    );
  });

  it('says the saved nickname was removed, on a new restriction and on a repeat', () => {
    for (const already of bools) {
      const text = restrictDeniedMessage(USER, 'nick', {
        ...plain,
        already,
        nicknameCleared: true,
      });
      expect(text).toMatch(/ Their saved nickname was removed\.$/);
    }
  });

  /** A repeat that removed a name did change something, so it cannot say it did not. */
  it('does not say "nothing changed" in the same breath as a removed nickname', () => {
    expect(
      restrictDeniedMessage(USER, 'nick', { ...plain, already: true, nicknameCleared: true }),
    ).toBe(
      '<@111111111111111111> is already restricted from **Nickname**. Their saved nickname was removed.',
    );
  });

  it('does not say a nickname was removed when none was', () => {
    const text = restrictDeniedMessage(USER, 'nick', plain);
    // What Nickname covers does say "nickname", so it is the removal that is absent.
    expect(text).not.toContain('Their saved nickname was removed');
    expect(text).toContain('a saved nickname showing in a room name');
  });

  /** A move off the allow list is said, and one that empties it opens the feature. */
  it('says the target left the allow list, and that an emptied allow list opens the feature', () => {
    const moved = restrictDeniedMessage(ROLE, 'rename', { ...plain, moved: true });
    expect(moved).toContain('<@&333333333333333333> is no longer on its allow list.');
    expect(moved).not.toContain('empty now');
    const emptied = restrictDeniedMessage(ROLE, 'rename', {
      ...plain,
      moved: true,
      allowEmptied: true,
    });
    expect(emptied).toContain(
      'Its allow list is empty now, so everyone who is not denied can use it again.',
    );
  });
});

describe('restrictAllowedMessage', () => {
  const plain = { already: false, created: false, manager: false, moved: false };

  /** The moment an allow list comes into force is the moment the feature closes to everyone else. */
  it('says plainly that only the listed and managers can use it from now on, and what that covers', () => {
    expect(restrictAllowedMessage(ROLE, 'rename', { ...plain, created: true })).toBe(
      'From now on only <@&333333333333333333> and members who can manage channels can use **Name**. ' +
        "That covers the /name command, the Name button, the template editor for a member's own room and the voice status.",
    );
  });

  /**
   * The first allow reply ends on the same clause a deny reply does, and there the people
   * the rule stops are everyone BUT the one named. So the clause never says "they" about
   * the person named, which would read as their lists going inert or their clicks refused.
   */
  it('never points a pronoun at the person it allows', () => {
    for (const feature of ['access', 'kick', 'claim'] as const) {
      const text = restrictAllowedMessage(ROLE, feature, { ...plain, created: true });
      expect(text, feature).toMatch(/a member it stops/i);
      expect(text, feature).not.toMatch(/refuses them|The lists they have|to them\b/);
    }
  });

  /** "Allow Name to @Admins" keeps a feature to admins, and says that. */
  it('words an allow list of a manager as the admins-only rule it is', () => {
    const text = restrictAllowedMessage(ROLE, 'rename', { ...plain, created: true, manager: true });
    expect(text).toMatch(
      /^From now on only members who can manage channels, like <@&333333333333333333>, can use \*\*Name\*\*\./,
    );
    const later = restrictAllowedMessage(ROLE, 'rename', { ...plain, manager: true });
    expect(later).toContain('Members who can manage channels can always use it.');
  });

  it('says a later entry is on the list, and who else can use it', () => {
    expect(restrictAllowedMessage(USER, 'limit', plain)).toBe(
      '<@111111111111111111> is on the allow list for **Size** now. Only the people and roles on its allow list, and members who can manage channels, can use it.',
    );
  });

  it('says a repeat changed nothing, unless it also took them off the deny list', () => {
    expect(restrictAllowedMessage(USER, 'limit', { ...plain, already: true })).toBe(
      '<@111111111111111111> is already on the allow list for **Size**, so nothing changed.',
    );
    expect(restrictAllowedMessage(USER, 'limit', { ...plain, already: true, moved: true })).toBe(
      '<@111111111111111111> is no longer on the deny list for **Size**, and stays on its allow list.',
    );
  });

  it('says the target left the deny list', () => {
    expect(restrictAllowedMessage(USER, 'limit', { ...plain, moved: true })).toContain(
      '<@111111111111111111> is no longer on its deny list.',
    );
  });
});

describe('restrictRemovedMessage', () => {
  const none = { allowEmptied: false, allowAfter: false };

  it('says who can use what again, off a deny list with no allow list', () => {
    expect(restrictRemovedMessage(ROLE, 'transfer', { ...none, from: ['deny'] })).toBe(
      '<@&333333333333333333> can use **Transfer** again.',
    );
  });

  it('does not say they can use it again while an allow list still leaves them out', () => {
    expect(
      restrictRemovedMessage(USER, 'transfer', { ...none, from: ['deny'], allowAfter: true }),
    ).toBe(
      '<@111111111111111111> is off the deny list for **Transfer**. Only the people and roles on its allow list, and members who can manage channels, can use it.',
    );
  });

  it('says an allow list that emptied opens the feature again', () => {
    expect(
      restrictRemovedMessage(USER, 'transfer', { ...none, from: ['allow'], allowEmptied: true }),
    ).toBe(
      '<@111111111111111111> is off the allow list for **Transfer**. Its allow list is empty now, so everyone who is not denied can use it again.',
    );
  });

  it('says somebody on both lists is off both', () => {
    expect(
      restrictRemovedMessage(USER, 'transfer', { ...none, from: ['allow', 'deny'] }),
    ).toContain('is off both lists for **Transfer**');
  });

  it('says there was nothing to remove', () => {
    expect(restrictRemovedMessage(USER, 'privacy', { ...none, from: [] })).toBe(
      '<@111111111111111111> was not on the allow list or the deny list for **Private and Public**, so nothing changed.',
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
    expect(RESTRICT_REFUSALS.everyoneAllowed).toContain('everyone role');
    expect(RESTRICT_REFUSALS.everyoneAllowed).toContain('/restrict clear');
    expect(RESTRICT_REFUSALS.bot(USER)).toContain('is a bot');
    expect(RESTRICT_REFUSALS.manager(USER)).toContain('Manage Channels or Administrator');
    expect(RESTRICT_REFUSALS.manager(USER)).toContain('would do nothing');
    expect(RESTRICT_REFUSALS.tooManyUsers('rename', 'deny')).toContain(
      'The deny list for **Name** already holds 50 people',
    );
    expect(RESTRICT_REFUSALS.tooManyRoles('rename', 'allow')).toContain(
      'The allow list for **Name** already holds 25 roles',
    );
    expect(RESTRICT_REFUSALS.tooMany).toContain('150 restrictions');
  });

  /**
   * A full list can be full of people who left and roles that were deleted, which
   * Discord's picker cannot offer to `remove`, so a refusal that said only "remove
   * someone" would send the admin to something that cannot work.
   */
  it('name /restrict clear as the way out of a full list', () => {
    expect(RESTRICT_REFUSALS.tooManyUsers('rename', 'allow')).toContain('/restrict clear');
    expect(RESTRICT_REFUSALS.tooManyRoles('rename', 'deny')).toContain('/restrict clear');
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

/**
 * What a member is told when a rule stops them, on every path. It says that a
 * server admin turned the feature off for them and nothing else: never why, and
 * never who else is restricted.
 */
describe('restrictedRefusal', () => {
  it('names only the feature, and that a server admin turned it off for the member', () => {
    expect(restrictedRefusal('rename')).toBe('A server admin has turned off **Name** for you.');
    expect(restrictedRefusal('privacy')).toBe('A server admin has turned off **Private** for you.');
    expect(restrictedRefusal('kick')).toBe('A server admin has turned off **Kick** for you.');
    expect(restrictedRefusal('claim')).toBe('A server admin has turned off **Claim** for you.');
  });

  /**
   * Opening a room again is never restricted (`PANEL_ACTION_FEATURE.unlock` is
   * null and `/public` has no feature), so a member who was just refused `/private`
   * must not be told they lost Public. The admin's label for the pair stays "Private
   * and Public", which is what `/restrict` shows next to the explanation.
   */
  it('does not tell a member who was refused Private that Public is off too', () => {
    expect(restrictedRefusal('privacy')).not.toContain('Public');
    expect(
      restrictRemovedMessage(ROLE, 'privacy', {
        from: ['deny'],
        allowEmptied: false,
        allowAfter: false,
      }),
    ).toContain('Private and Public');
  });

  it('names a feature the way its button reads, for every feature but privacy', () => {
    expect(restrictedRefusal('limit')).toContain('**Size**');
    expect(restrictedRefusal('transfer')).toContain('**Transfer**');
    expect(restrictedRefusal('nick')).toContain('**Nickname**');
  });

  it('never mentions anybody, so it cannot ping', () => {
    for (const feature of COMMAND_FEATURES) {
      expect(restrictedRefusal(feature)).not.toMatch(/<@|<#|@everyone|@here/);
    }
  });
});

describe('the paused note', () => {
  it('says rules are kept and nobody is refused', () => {
    expect(RESTRICT_PAUSED).toContain('nobody is being refused');
    expect(RESTRICT_PAUSED).toContain('kept');
  });

  it('leads a list that is paused, and does not appear in one that is not', () => {
    const paused = renderRestrictionList({}, { paused: true }).split('\n');
    expect(paused[0]).toBe(RESTRICT_PAUSED);
    expect(paused[1]).toBe('');
    expect(paused[2]).toBe('**Who can use room commands**');
    expect(renderRestrictionList({})).not.toContain(RESTRICT_PAUSED);
    expect(renderRestrictionList({}, { paused: false })).not.toContain(RESTRICT_PAUSED);
  });

  /** The note is added to the largest list the caps allow, which is the one that has to fit. */
  it('still fits one Discord message at the largest size the caps allow', () => {
    expect(renderRestrictionList(fullAccess(), { paused: true }).length).toBeLessThanOrEqual(2000);
  });
});

describe('renderRestrictionList', () => {
  /** Each line reads as who can use the feature, so the heading says that. */
  it('is headed by who can use room commands', () => {
    for (const access of [{}, fullAccess()]) {
      const first = renderRestrictionList(access).split('\n')[0];
      expect(first).toBe('**Who can use room commands**');
    }
  });

  it('says everyone can use every feature when nothing is stored', () => {
    const text = renderRestrictionList({});
    for (const label of [
      'Private and Public',
      'Hide',
      'Size',
      'Name',
      'Transfer',
      'Saved lists',
      'Nickname',
      'Kick',
      'Claim',
    ]) {
      expect(text).toContain(`**${label}**: everyone`);
    }
  });

  it('reads a deny list as everyone except, an allow list as only, and both as only and never', () => {
    const text = renderRestrictionList({
      hide: { deny: { users: [USER.id], roles: [] } },
      rename: { allow: { users: [], roles: [ROLE.id] } },
      kick: {
        allow: { users: [], roles: [ROLE.id] },
        deny: { users: [USER.id], roles: [] },
      },
    });
    expect(text).toContain(`**Hide**: everyone except <@${USER.id}>`);
    expect(text).toContain(`**Name**: only <@&${ROLE.id}>`);
    expect(text).toContain(`**Kick**: only <@&${ROLE.id}>, never <@${USER.id}>`);
  });

  it('lists only the features /restrict offers, even when others are stored', () => {
    const text = renderRestrictionList({
      info: { deny: { users: [USER.id], roles: [] } },
    } as never);
    expect(text).not.toContain('Info');
    expect(text).not.toContain(USER.id);
  });

  it('shows roles before people, as mentions, joined the way a sentence lists them', () => {
    const text = renderRestrictionList({
      rename: { deny: { users: [USER.id], roles: [ROLE.id, OTHER_ROLE] } },
    });
    expect(text).toContain(
      `**Name**: everyone except <@&${ROLE.id}>, <@&${OTHER_ROLE}> and <@${USER.id}>`,
    );
  });

  it('keeps each feature to its own line, in the order /restrict offers them', () => {
    const lines = renderRestrictionList({ nick: { deny: { users: [USER.id], roles: [] } } }).split(
      '\n',
    );
    expect(lines.slice(1, 10).map((l) => l.split(':')[0])).toEqual([
      '**Private and Public**',
      '**Hide**',
      '**Size**',
      '**Name**',
      '**Transfer**',
      '**Saved lists**',
      '**Nickname**',
      '**Kick**',
      '**Claim**',
    ]);
  });

  /**
   * A deleted role on an allow list keeps everyone it was meant to let in out, which
   * an admin cannot see from a mention Discord renders as "@deleted-role". It is
   * flagged, on either list, with what it does and the way out.
   */
  it('flags a role the server no longer has, on either list, and says what it does', () => {
    const exists = (id: string): boolean => id !== ROLE.id;
    const text = renderRestrictionList(
      {
        rename: { allow: { users: [], roles: [ROLE.id, OTHER_ROLE] } },
        limit: { deny: { users: [], roles: [ROLE.id] } },
      },
      { roleExists: exists },
    );
    expect(text).toContain(`**Name**: only a deleted role and <@&${OTHER_ROLE}>`);
    expect(text).toContain('**Size**: everyone except a deleted role');
    expect(text).not.toContain(`<@&${ROLE.id}>`);
    expect(text).toContain(DELETED_ROLE_NOTE);
    expect(DELETED_ROLE_NOTE).toContain('lets nobody in');
    expect(DELETED_ROLE_NOTE).toContain('/restrict clear');
  });

  it('flags nothing when every role exists, or when nothing can say', () => {
    const access: CommandAccess = { rename: { allow: { users: [], roles: [ROLE.id] } } };
    for (const opts of [{ roleExists: () => true }, {}]) {
      const text = renderRestrictionList(access, opts);
      expect(text).toContain(`<@&${ROLE.id}>`);
      expect(text).not.toContain('deleted');
    }
  });

  it('caps a long list with an honest tail rather than cutting it off', () => {
    const text = renderRestrictionList({
      rename: { deny: { users: ids(1, 20), roles: ids(2, 5) } },
    });
    expect(text).toContain('and 18 more');
    expect(text.match(/<@&?\d+>/g)).toHaveLength(7);
  });

  it('does not add a tail to a list that fits', () => {
    const text = renderRestrictionList({ rename: { deny: { users: ids(1, 7), roles: [] } } });
    expect(text).not.toContain('more');
  });

  /** The most the writer allows on one list, everywhere at once. */
  it('fits one Discord message at the largest size the caps allow, and still shows counts', () => {
    const text = renderRestrictionList(fullAccess());
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toMatch(/\*\*Claim\*\*: only .*, never /);
  });

  /** Whatever was cut, the two lines an admin must not miss are the last two. */
  it('always ends with who is never restricted and the note', () => {
    for (const access of [{}, fullAccess()]) {
      const lines = renderRestrictionList(access, { roleExists: () => false }).split('\n');
      expect(lines.at(-1)).toBe(RESTRICT_NOTE);
      expect(lines.at(-2)).toContain('Manage Channels or Administrator');
    }
  });
});
