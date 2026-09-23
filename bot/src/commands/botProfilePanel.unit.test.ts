import { ButtonStyle, ComponentType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  BOT_PROFILE_FILE_ID,
  BOT_PROFILE_TEXT_ID,
  botProfileResetId,
  botProfileSetId,
  botProfileViewOf,
  buildBotProfileModal,
  buildBotProfilePanel,
  parseBotProfileId,
  type BotProfileView,
} from './botProfilePanel.js';
import { BOT_PROFILE_FIELDS } from '../features/botProfile.js';

const VIEW: BotProfileView = {
  nickname: null,
  defaultName: 'Auto Voice Channels',
  avatarUrl: 'https://cdn.discordapp.com/avatars/1/a.png',
  customAvatar: false,
  animatedAvatar: false,
  bannerUrl: null,
  canRename: true,
};

interface RowJson {
  components: { custom_id: string; label: string; style: number; emoji?: { name: string } }[];
}

function panel(view: BotProfileView, canChange: boolean, note?: string) {
  const reply = buildBotProfilePanel(view, { canChange, ...(note ? { note } : {}) });
  const rows = (reply.components ?? []).map((r) => ('toJSON' in r ? r.toJSON() : r)) as RowJson[];
  const embed = reply.embeds?.[0] as {
    title: string;
    description: string;
    fields: { name: string; value: string }[];
    image?: { url: string };
    thumbnail?: { url: string };
  };
  return { rows, embed, reply };
}

describe('parseBotProfileId', () => {
  it('round-trips every set and reset id', () => {
    for (const field of BOT_PROFILE_FIELDS) {
      expect(parseBotProfileId(botProfileSetId(field))).toEqual({ action: 'set', field });
      expect(parseBotProfileId(botProfileResetId(field))).toEqual({ action: 'reset', field });
    }
  });

  /** Client input on the wire, however it got there. */
  it('refuses an unknown field or action, and ids that are not ours', () => {
    expect(parseBotProfileId('avc:bp:set:colour')).toBeNull();
    expect(parseBotProfileId('avc:bp:delete:avatar')).toBeNull();
    expect(parseBotProfileId('avc:bp:set')).toBeNull();
    expect(parseBotProfileId('avc:cp:set:avatar')).toBeNull();
  });
});

describe('buildBotProfilePanel', () => {
  /**
   * The layout the owner asked for: one row per field, set then reset, and no
   * Close, since Discord puts Dismiss under every ephemeral message.
   */
  it('gives each field its own row of set and reset, and nothing else', () => {
    const { rows } = panel(VIEW, true);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.components.map((c) => c.label))).toEqual([
      ['Upload custom avatar', 'Reset avatar'],
      ['Upload custom banner', 'Reset banner'],
      ['Set custom bot name', 'Reset name'],
      ['Set custom bio', 'Reset bio'],
    ]);
    BOT_PROFILE_FIELDS.forEach((field, i) => {
      expect(rows[i]!.components.map((c) => c.custom_id)).toEqual([
        botProfileSetId(field),
        botProfileResetId(field),
      ]);
    });
  });

  it('puts an emoji on each set button and none on the resets', () => {
    const { rows } = panel(VIEW, true);
    expect(rows.map((r) => r.components.map((c) => c.emoji?.name ?? null))).toEqual([
      ['👤', null],
      ['🖼️', null],
      ['🏷️', null],
      ['📝', null],
    ]);
  });

  /** Decision 11: none of the eight is more the thing to press than another. */
  it('makes every button Secondary', () => {
    for (const row of panel(VIEW, true).rows) {
      for (const button of row.components) expect(button.style).toBe(ButtonStyle.Secondary);
    }
  });

  it('opens with the one line that says what the panel is for', () => {
    expect(panel(VIEW, true).embed.description).toBe(
      'Customize how this bot looks to members in this server.',
    );
  });

  /**
   * The gate refuses the set buttons in a hard-gated guild and lets the resets
   * through, so the panel offers exactly the resets and says why.
   */
  it('offers only the resets in a gated server, in one row', () => {
    const { rows, embed } = panel(VIEW, false);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.components.map((c) => c.custom_id)).toEqual(
      BOT_PROFILE_FIELDS.map(botProfileResetId),
    );
    expect(embed.description).toContain('can be reset but not changed');
  });

  it('reports the defaults when nothing is customised', () => {
    const { embed } = panel(VIEW, true);
    const value = (name: string) => embed.fields.find((f) => f.name === name)?.value;
    expect(value('Avatar')).toBe('Default');
    expect(value('Banner')).toBe('Default');
    expect(value('Name')).toBe('Default, Auto Voice Channels');
    expect(embed.image).toBeUndefined();
    expect(embed.thumbnail?.url).toBe(VIEW.avatarUrl);
  });

  it('reports what is customised, and shows the banner itself', () => {
    const { embed } = panel(
      {
        ...VIEW,
        nickname: 'Room *Bot*',
        customAvatar: true,
        animatedAvatar: true,
        bannerUrl: 'https://cdn.discordapp.com/guilds/1/users/2/banners/b.png',
      },
      true,
    );
    const value = (name: string) => embed.fields.find((f) => f.name === name)?.value;
    expect(value('Avatar')).toBe('Custom, animated');
    expect(value('Banner')).toBe('Custom, shown below');
    // Markdown in a nickname is shown as typed, not rendered.
    expect(value('Name')).toBe('Room \\*Bot\\*');
    expect(embed.image?.url).toContain('/banners/');
  });

  /**
   * The invite does not ask for Change Nickname, so the panel says so before
   * an admin types a name that is about to be refused.
   */
  it('warns on the Name field when the bot cannot rename itself', () => {
    const name = (canRename: boolean) =>
      panel({ ...VIEW, canRename }, true).embed.fields.find((f) => f.name === 'Name')?.value;
    expect(name(true)).not.toContain('Change Nickname');
    expect(name(false)).toContain('Change Nickname permission');
    expect(name(false)).toContain('Server Settings > Roles');
  });

  /** Discord does not return a bot its own guild bio, so the panel cannot. */
  it('says where to see the bio rather than claiming one', () => {
    expect(panel(VIEW, true).embed.fields.find((f) => f.name === 'Bio')?.value).toBe(
      "Open the bot's profile to see it",
    );
  });

  it('appends a note as a nameless field, capped at the field limit', () => {
    const { embed } = panel(VIEW, true, 'x'.repeat(2000));
    const last = embed.fields.at(-1)!;
    expect(last.name).toBe('​');
    expect(last.value).toHaveLength(1024);
  });
});

interface ModalJson {
  custom_id: string;
  title: string;
  components: {
    type: number;
    content?: string;
    label?: string;
    description?: string;
    component?: {
      type: number;
      custom_id: string;
      required?: boolean;
      max_length?: number;
      min_values?: number;
      max_values?: number;
      value?: string;
      style?: number;
    };
  }[];
}

const modalJson = (field: (typeof BOT_PROFILE_FIELDS)[number], view: BotProfileView | null) =>
  buildBotProfileModal(field, view).toJSON() as unknown as ModalJson;

describe('buildBotProfileModal', () => {
  it('answers to the same id as the button that opened it', () => {
    for (const field of BOT_PROFILE_FIELDS) {
      expect(modalJson(field, VIEW).custom_id).toBe(botProfileSetId(field));
    }
  });

  it('asks for exactly one required file for each image, under the rules line', () => {
    for (const field of ['avatar', 'banner'] as const) {
      const json = modalJson(field, VIEW);
      expect(json.components[0]).toMatchObject({
        type: ComponentType.TextDisplay,
        content: 'PNG, JPG or GIF (animation supported), under 10 MB.',
      });
      expect(json.components[1]?.component).toMatchObject({
        type: ComponentType.FileUpload,
        custom_id: BOT_PROFILE_FILE_ID,
        required: true,
        min_values: 1,
        max_values: 1,
      });
    }
    expect(modalJson('avatar', VIEW).components[1]?.description).toBe(
      'Square works best, gets circular crop like any avatar',
    );
    expect(modalJson('banner', VIEW).components[1]?.description).toBe(
      'Wide, 5:2 works best, like 600x240',
    );
  });

  it("prefills the name with the current nickname, capped at Discord's 32", () => {
    const json = modalJson('name', { ...VIEW, nickname: 'Roomie' });
    expect(json.components[0]?.component).toMatchObject({
      custom_id: BOT_PROFILE_TEXT_ID,
      required: true,
      max_length: 32,
      value: 'Roomie',
    });
  });

  it('still opens the name modal when the profile could not be read', () => {
    expect(modalJson('name', null).components[0]?.component?.value).toBeUndefined();
  });

  it("takes a bio up to Discord's 300, with nothing to prefill", () => {
    const component = modalJson('bio', VIEW).components[0]?.component;
    expect(component).toMatchObject({ required: true, max_length: 300 });
    expect(component?.value).toBeUndefined();
  });

  /** Discord refuses a modal whose title passes 45 or a description past 100. */
  it("keeps every title and description inside Discord's limits", () => {
    for (const field of BOT_PROFILE_FIELDS) {
      const json = modalJson(field, VIEW);
      expect(json.title.length).toBeLessThanOrEqual(45);
      for (const c of json.components) {
        expect((c.label ?? '').length).toBeLessThanOrEqual(45);
        expect((c.description ?? '').length).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('botProfileViewOf', () => {
  const member = (avatar: string | null, banner: string | null) => ({
    nickname: null,
    avatar,
    banner,
    user: { username: 'avc', globalName: null },
    permissions: { has: () => false },
    displayAvatarURL: () => 'https://cdn.discordapp.com/x.png',
    bannerURL: () => 'https://cdn.discordapp.com/banner.png',
  });

  it('reads an animated avatar from its hash', () => {
    expect(botProfileViewOf(member('a_123', null))).toMatchObject({
      customAvatar: true,
      animatedAvatar: true,
    });
    expect(botProfileViewOf(member('123', null)).animatedAvatar).toBe(false);
  });

  /** This server's banner, never the application's global one. */
  it('reports no banner when this server has none', () => {
    expect(botProfileViewOf(member(null, null)).bannerUrl).toBeNull();
    expect(botProfileViewOf(member(null, 'b1')).bannerUrl).toContain('banner');
  });

  it('falls back to the username when there is no display name', () => {
    expect(botProfileViewOf(member(null, null)).defaultName).toBe('avc');
  });

  it('reads Change Nickname from the member', () => {
    expect(botProfileViewOf(member(null, null)).canRename).toBe(false);
  });
});
