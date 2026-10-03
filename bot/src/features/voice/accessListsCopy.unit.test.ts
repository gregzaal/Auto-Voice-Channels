import { describe, expect, it } from 'vitest';
import {
  ACCESS_REFUSALS,
  clearedMessage,
  listMessage,
  removedMessage,
  roomsNote,
  savedMessage,
  type RoomSync,
} from './accessListsCopy.js';

const ID = '999999999999999999';
const sync = (over: Partial<RoomSync> = {}): RoomSync => ({
  rooms: 1,
  capped: 0,
  updated: 0,
  queued: 0,
  failed: 0,
  paused: false,
  movedTarget: false,
  ...over,
});

const ids = (count: number, offset = 0): string[] =>
  Array.from({ length: count }, (_, i) => `${offset + i}`.padStart(18, '1'));

/**
 * Every reply `/access` can give, rendered, so the copy rules are checked on what a member
 * reads and not on source text, where only a curly quote shows. The integration tests hold
 * the replies a real run produced to the same rules.
 */
function everyReply(): string[] {
  const replies: string[] = [
    ACCESS_REFUSALS.unusable,
    ACCESS_REFUSALS.self,
    ACCESS_REFUSALS.bot(ID),
    ACCESS_REFUSALS.notInServer(ID),
    ACCESS_REFUSALS.unblockable(ID),
    ACCESS_REFUSALS.full('trusted'),
    ACCESS_REFUSALS.full('blocked'),
    ACCESS_REFUSALS.failed,
    listMessage({ trusted: [], blocked: [] }),
    listMessage({ trusted: ids(25), blocked: ids(25, 100) }),
    listMessage({ trusted: [], blocked: [] }, { inert: true }),
    listMessage({ trusted: ids(25), blocked: ids(25, 100) }, { inert: true }),
    removedMessage(ID, 'trusted'),
    removedMessage(ID, 'blocked'),
    removedMessage(ID, null),
  ];
  for (const kind of ['trusted', 'blocked'] as const) {
    for (const outcome of ['added', 'flipped', 'already'] as const) {
      replies.push(savedMessage(ID, kind, outcome));
    }
    for (const removed of [0, 1, 7]) replies.push(clearedMessage(kind, removed));
  }
  for (const removed of [0, 1, 7]) replies.push(clearedMessage(undefined, removed));
  for (const over of [
    { updated: 1 },
    { updated: 3, movedTarget: true },
    { updated: 1, movedTarget: true },
    { queued: 1 },
    { queued: 2 },
    { failed: 1 },
    { failed: 4 },
    { updated: 2, queued: 1, failed: 1, rooms: 9, capped: 5 },
    { paused: true },
  ]) {
    replies.push(roomsNote(sync(over)));
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

  it('makes no claim of generative AI', () => {
    expect(everyReply().join('\n').toLowerCase()).not.toMatch(/\b(ai|generated|llm)\b/);
  });

  /** A reply is one Discord message, and the longest is both lists at their caps. */
  it('fits one Discord message, at the largest the caps allow', () => {
    for (const reply of everyReply()) expect(reply.length).toBeLessThanOrEqual(2000);
  });
});

/**
 * A saved entry outlives the room it was made in, so every reply that saves says whose
 * rooms it applies to, and a block never claims to stop an Administrator.
 */
describe('savedMessage', () => {
  it('says a saved entry applies to the rooms the member creates in this server, and how to undo it', () => {
    for (const kind of ['trusted', 'blocked'] as const) {
      for (const outcome of ['added', 'flipped'] as const) {
        const text = savedMessage(ID, kind, outcome);
        expect(text, `${kind} ${outcome}`).toContain('rooms you create in this server');
        expect(text).toContain('`/access remove`');
        expect(text).toContain(`<@${ID}>`);
      }
    }
  });

  it('says an Administrator can still enter, wherever a block is saved or flipped to', () => {
    for (const outcome of ['added', 'flipped'] as const) {
      expect(savedMessage(ID, 'blocked', outcome)).toContain('Administrators can still enter');
    }
    expect(savedMessage(ID, 'trusted', 'added')).not.toContain('Administrators');
  });

  it('names the list the member left, when they moved from one to the other', () => {
    expect(savedMessage(ID, 'trusted', 'flipped')).toContain(
      'moved from your blocked list to your trusted list',
    );
    expect(savedMessage(ID, 'blocked', 'flipped')).toContain(
      'moved from your trusted list to your blocked list',
    );
  });

  it('says a repeat changed nothing, and does not repeat the promise', () => {
    expect(savedMessage(ID, 'blocked', 'already')).toBe(
      `<@${ID}> is already on your blocked list.`,
    );
    expect(savedMessage(ID, 'trusted', 'already')).toBe(
      `<@${ID}> is already on your trusted list.`,
    );
  });

  it('says what each list lets or keeps them from', () => {
    expect(savedMessage(ID, 'trusted', 'added')).toContain('can join the locked or hidden rooms');
    expect(savedMessage(ID, 'blocked', 'added')).toContain('cannot join the rooms');
  });
});

describe('the refusals', () => {
  it('say an Administrator can still enter, and that nothing was saved', () => {
    expect(ACCESS_REFUSALS.unblockable(ID)).toContain('Administrators can still enter every room');
    expect(ACCESS_REFUSALS.unblockable(ID)).toContain("I haven't added them");
  });

  it('name the member they refused, so the reply stands alone', () => {
    for (const text of [
      ACCESS_REFUSALS.bot(ID),
      ACCESS_REFUSALS.notInServer(ID),
      ACCESS_REFUSALS.unblockable(ID),
    ]) {
      expect(text).toContain(`<@${ID}>`);
    }
  });

  it('say how to make room in a full list', () => {
    for (const kind of ['trusted', 'blocked'] as const) {
      const text = ACCESS_REFUSALS.full(kind);
      expect(text).toContain(`Your ${kind} list is full (25)`);
      expect(text).toContain('`/access remove`');
      expect(text).toContain('`/access clear`');
    }
  });
});

describe('removedMessage and clearedMessage', () => {
  it('say which list the member came off, or that they were on neither', () => {
    expect(removedMessage(ID, 'blocked')).toBe(`<@${ID}> is off your blocked list.`);
    expect(removedMessage(ID, 'trusted')).toBe(`<@${ID}> is off your trusted list.`);
    expect(removedMessage(ID, null)).toContain('nothing changed');
  });

  it('count what was emptied, in the singular and the plural, and say when there was nothing', () => {
    expect(clearedMessage('blocked', 1)).toBe('Emptied your blocked list (1 person).');
    expect(clearedMessage('trusted', 7)).toBe('Emptied your trusted list (7 people).');
    expect(clearedMessage(undefined, 3)).toBe('Emptied both your lists (3 people).');
    expect(clearedMessage('blocked', 0)).toBe('Your blocked list was already empty.');
    expect(clearedMessage(undefined, 0)).toBe('Both your lists were already empty.');
  });
});

describe('listMessage', () => {
  it('shows both lists with how full each is, as mentions, and says "nobody" for an empty one', () => {
    const text = listMessage({ trusted: ['111', '222'], blocked: [] });
    expect(text).toContain('**Trusted** (2 of 25): <@111>, <@222>');
    expect(text).toContain('**Blocked** (0 of 25): nobody');
  });

  it('says where the lists apply, what each does, and how to change them', () => {
    const text = listMessage({ trusted: [], blocked: [] });
    expect(text).toContain('rooms you create in this server');
    expect(text).toContain('Administrators can always enter');
    expect(text).toContain('`/access remove`');
    expect(text).toContain('`/access clear`');
  });

  /**
   * A member an admin has denied Saved lists can still read their lists, and the sentence
   * that says they apply to their rooms is contradicted by the code, so it is replaced, and
   * says only that an admin turned it off for them, never why or who else.
   */
  it('says, for a member denied Saved lists, that the lists apply to nothing and are kept', () => {
    const text = listMessage({ trusted: ['111'], blocked: ['222'] }, { inert: true });
    expect(text).toContain('**Trusted** (1 of 25): <@111>');
    expect(text).toContain('**Blocked** (1 of 25): <@222>');
    expect(text).toContain('A server admin has turned off **Saved lists** for you');
    expect(text).toContain('apply to none of your rooms right now');
    expect(text).toContain('They are kept, and apply again if it is turned back on');
    expect(text).toContain('`/access remove`');
    expect(text).toContain('`/access clear`');
    // The sentences that promise what the lists do are the ones that are not true for them.
    expect(text).not.toContain('They apply to the rooms you create');
    expect(text).not.toContain('Blocked people cannot join');
  });
});

describe('roomsNote', () => {
  it('says nothing for a member with no open rooms', () => {
    expect(roomsNote(sync({ rooms: 0 }))).toBe('');
  });

  it('says it applied the change, and that it moved the person out when it did', () => {
    expect(roomsNote(sync({ updated: 1 }))).toBe(" I've applied it to your current room.");
    expect(roomsNote(sync({ rooms: 3, updated: 3, movedTarget: true }))).toBe(
      " I've applied it to 3 of your current rooms and moved them out of it.",
    );
  });

  /** A queued write is never reported as done, and a failure says to run it again. */
  it('does not say a queued change has happened, and says to retry a failure', () => {
    expect(roomsNote(sync({ queued: 1 }))).toContain('queued');
    expect(roomsNote(sync({ queued: 1 }))).not.toContain('applied');
    expect(roomsNote(sync({ failed: 2 }))).toContain('I could not update 2 rooms');
    expect(roomsNote(sync({ failed: 2 }))).toContain('Run the command again to retry');
  });

  it('says how many rooms it stopped at when it hit the cap', () => {
    expect(roomsNote(sync({ rooms: 30, capped: 5, updated: 25 }))).toContain(
      'I only updated the first 25 of your 30 rooms.',
    );
  });

  it('says applying lists is off while the lever is on, and claims no change', () => {
    const text = roomsNote(sync({ paused: true }));
    expect(text).toContain('switched off for now');
    expect(text).toContain('were not changed');
  });
});
