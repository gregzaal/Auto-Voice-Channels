import { describe, expect, it } from 'vitest';
import {
  BLOCK_NOT_SAVED_PAUSED,
  ROOM_ACCESS_REPLIES,
  TOO_MANY_OVERWRITES,
  accessFailed,
  admitBlocked,
  admitFailed,
  admitKicked,
  admitNotInServer,
  admitted,
  deferredMessage,
  hiddenMessage,
  lockedWithoutJoin,
  roleDefeatsHide,
  roleMentions,
  savedNote,
  skippedRolesNote,
  unhiddenMessage,
  unhiddenWithoutJoin,
  withSkipped,
} from './roomAccessCopy.js';

const ONE = ['111111111111111111'];
const MANY = ['111111111111111111', '222222222222222222', '333333333333333333'];

/**
 * Every reply the room access commands can give, rendered, so the copy rules are
 * checked on what a member reads and not on source text, where only a curly quote
 * shows. The integration tests hold the replies a real run produced to the same rules.
 */
function everyReply(): string[] {
  const replies: string[] = [...Object.values(ROOM_ACCESS_REPLIES), TOO_MANY_OVERWRITES];
  for (const roles of [ONE, MANY]) {
    replies.push(roleDefeatsHide(roles), skippedRolesNote(roles), withSkipped('x', roles));
    replies.push(hiddenMessage({ viewerRoleId: null, skippedRoleIds: roles }));
    replies.push(unhiddenMessage(roles));
  }
  replies.push(
    hiddenMessage({ viewerRoleId: ONE[0]! }),
    hiddenMessage({ viewerRoleId: null }),
    unhiddenMessage(),
    lockedWithoutJoin('missing permissions'),
    unhiddenWithoutJoin('missing permissions'),
    accessFailed('missing permissions'),
    admitBlocked('999999999999999999'),
    admitKicked('999999999999999999'),
    admitNotInServer('999999999999999999'),
    admitFailed('999999999999999999', 'missing permissions'),
    admitted('999999999999999999', 'locked'),
    admitted('999999999999999999', 'hidden'),
    savedNote('blocked'),
    savedNote('trusted'),
    BLOCK_NOT_SAVED_PAUSED,
  );
  for (const command of ['private', 'public', 'hide', 'unhide', 'admit'] as const) {
    replies.push(deferredMessage(command));
  }
  return replies;
}

describe('copy rules', () => {
  it('uses no em or en dashes, curly quotes, or prose semicolons', () => {
    const text = everyReply().join('\n');
    expect(text).not.toMatch(/[—–]/);
    expect(text).not.toMatch(/[‘’“”]/);
    expect(text).not.toMatch(/;/);
  });

  it('never says primary or secondary to a member', () => {
    const text = everyReply().join('\n').toLowerCase();
    expect(text).not.toContain('primary');
    expect(text).not.toContain('secondary');
  });

  it('keeps to what hidden means: the channel list, and nothing about profiles or activity', () => {
    const text = everyReply().join('\n').toLowerCase();
    expect(text).not.toContain('profile');
    expect(text).not.toContain('activity');
    expect(text).not.toContain('invisible');
    expect(text).not.toContain('nobody can see');
  });

  it('makes no claim of generative AI', () => {
    expect(everyReply().join('\n').toLowerCase()).not.toMatch(/\b(ai|generated|llm)\b/);
  });
});

describe('hiddenMessage', () => {
  it('says what hidden means, that Administrators always see everything, and who else does', () => {
    const withRole = hiddenMessage({ viewerRoleId: ONE[0]! });
    expect(withRole).toContain('hidden from the channel list');
    expect(withRole).toContain('Administrators always see everything');
    expect(withRole).toContain(`<@&${ONE[0]}>`);
    expect(withRole).toContain('`/access trust`');
  });

  it('says only Administrators see it when there is no moderator role', () => {
    const none = hiddenMessage({ viewerRoleId: null });
    expect(none).toContain('Administrators always see everything');
    expect(none).toContain('Everyone else sees it only if you let them in');
    expect(none).not.toContain('<@&');
  });

  it('names a role it could not change, once, and says how to fix it', () => {
    const text = hiddenMessage({ viewerRoleId: null, skippedRoleIds: ONE });
    expect(text.split(`<@&${ONE[0]}>`)).toHaveLength(2);
    expect(text).toContain('sits above my role');
    expect(text).toContain('Move my role above it');
  });
});

describe('roleDefeatsHide', () => {
  it('names the roles, and says how to fix it', () => {
    const one = roleDefeatsHide(ONE);
    expect(one).toContain(`<@&${ONE[0]}>`);
    expect(one).toContain('That role sits above mine');
    const many = roleDefeatsHide(MANY);
    expect(many).toContain('Those roles sit above mine');
    expect(many).toContain('Move my role above them');
  });
});

describe('roleMentions', () => {
  it('lists one, two and three roles in a sentence', () => {
    expect(roleMentions(['a'])).toBe('<@&a>');
    expect(roleMentions(['a', 'b'])).toBe('<@&a> and <@&b>');
    expect(roleMentions(['a', 'b', 'c'])).toBe('<@&a>, <@&b> and <@&c>');
  });
});

describe('skippedRolesNote', () => {
  it('is empty for no roles, so a clean change says nothing extra', () => {
    expect(skippedRolesNote([])).toBe('');
    expect(withSkipped('Done.', [])).toBe('Done.');
  });
});

describe('deferredMessage', () => {
  it('never says the change has happened', () => {
    for (const command of ['private', 'public', 'hide', 'unhide', 'admit'] as const) {
      expect(deferredMessage(command)).toContain("hasn't taken effect yet");
    }
  });

  /**
   * Nothing watches a queued write land, so the reply has to say what to do next, and
   * it differs by direction: a lock or a hide is on its way and is undone with /public
   * if it never arrives, and an opening is only finished by asking for it again.
   */
  it('tells an exit to run the same command again, and an entry how to take it back', () => {
    expect(deferredMessage('public')).toContain('run `/public` again to finish');
    expect(deferredMessage('unhide')).toContain('run `/unhide` again to finish');
    expect(deferredMessage('private')).toContain('run `/public` and try again');
    expect(deferredMessage('hide')).toContain('run `/public` and try again');
  });
});

describe('savedNote', () => {
  /**
   * A saved entry outlives the room it was made in, so the reply has to say whose rooms
   * it applies to, and how to take it back.
   */
  it('says the entry applies to rooms the member creates in this server, and how to undo it', () => {
    for (const kind of ['blocked', 'trusted'] as const) {
      expect(savedNote(kind)).toContain('rooms you create in this server');
      expect(savedNote(kind)).toContain('`/access remove`');
    }
    expect(savedNote('blocked')).toContain('blocked list');
    expect(savedNote('trusted')).toContain('trusted list');
  });
});

describe('the lever and the preflight', () => {
  it('says what is off, and never that an undo is', () => {
    expect(ROOM_ACCESS_REPLIES.paused).toContain('switched off for now');
    expect(ROOM_ACCESS_REPLIES.alwaysPaused).toContain('Approve');
    expect(BLOCK_NOT_SAVED_PAUSED).toContain('only turned them away this time');
  });

  it('names the permission the bot is missing and who can fix it', () => {
    expect(ROOM_ACCESS_REPLIES.needsManageRoles).toContain('**Manage Roles**');
    expect(ROOM_ACCESS_REPLIES.needsManageRoles).toContain('Ask an admin');
  });
});

describe('admitNotInServer', () => {
  it('names the member and says they could not be let in', () => {
    expect(admitNotInServer('999999999999999999')).toBe(
      "<@999999999999999999> isn't in this server, so I couldn't let them in.",
    );
  });
});
