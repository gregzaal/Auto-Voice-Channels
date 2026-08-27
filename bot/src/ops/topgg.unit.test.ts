import { describe, expect, it } from 'vitest';
import { buildCommandDefinitions } from '../commands/definitions.js';
import { TopggClient, toTopggCommands, type TopggApiError } from './topgg.js';

/** A Response stand-in. `fetch`'s own type is more than these tests need. */
function reply(status: number, body = '', headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('toTopggCommands', () => {
  it('names the enums that Discord sends as numbers', () => {
    const [command] = toTopggCommands([
      {
        name: 'limit',
        description: 'Set the user limit.',
        type: 1,
        options: [{ type: 4, name: 'count', description: 'Maximum members.', required: true }],
      } as never,
    ]);
    expect(command?.type).toBe('chat_input');
    expect(command?.options?.[0]?.type).toBe('integer');
  });

  it('drops the Discord-only fields top.gg has no property for', () => {
    const [command] = toTopggCommands([
      {
        name: 'template',
        description: 'Set the template.',
        type: 1,
        dm_permission: false,
        default_member_permissions: '16',
        contexts: [0],
        integration_types: [0],
        options: [
          {
            type: 7,
            name: 'channel',
            description: 'Which channel.',
            channel_types: [2],
            min_value: 0,
            max_value: 99,
            autocomplete: false,
          },
        ],
      } as never,
    ]);
    const keys = Object.keys(command ?? {});
    expect(keys.sort()).toEqual(['description', 'name', 'options', 'type']);
    expect(Object.keys(command?.options?.[0] ?? {}).sort()).toEqual([
      'description',
      'name',
      'type',
    ]);
  });

  it('treats a missing command type as chat_input', () => {
    const [command] = toTopggCommands([{ name: 'ping', description: 'Pong.' } as never]);
    expect(command?.type).toBe('chat_input');
  });

  it('carries localizations through, including on choices', () => {
    const [command] = toTopggCommands([
      {
        name: 'nick',
        description: 'Set a nickname.',
        type: 1,
        name_localizations: { de: 'spitzname' },
        description_localizations: { de: 'Spitznamen setzen.' },
        options: [
          {
            type: 3,
            name: 'mode',
            description: 'How.',
            name_localizations: { de: 'modus' },
            choices: [{ name: 'always', value: 'always', name_localizations: { de: 'immer' } }],
          },
        ],
      } as never,
    ]);
    expect(command?.name_localizations).toEqual({ de: 'spitzname' });
    expect(command?.description_localizations).toEqual({ de: 'Spitznamen setzen.' });
    expect(command?.options?.[0]?.name_localizations).toEqual({ de: 'modus' });
    expect(command?.options?.[0]?.choices?.[0]?.name_localizations).toEqual({ de: 'immer' });
  });

  it('omits a null localization map rather than sending null', () => {
    const [command] = toTopggCommands([
      { name: 'ping', description: 'Pong.', type: 1, name_localizations: null } as never,
    ]);
    expect('name_localizations' in (command ?? {})).toBe(false);
  });

  it('maps a nested subcommand group', () => {
    const [command] = toTopggCommands([
      {
        name: 'group',
        description: 'Groups.',
        type: 1,
        options: [
          {
            type: 2,
            name: 'edit',
            description: 'Edit.',
            options: [
              {
                type: 1,
                name: 'add',
                description: 'Add.',
                options: [{ type: 6, name: 'who', description: 'Who.' }],
              },
            ],
          },
        ],
      } as never,
    ]);
    expect(command?.options?.[0]?.type).toBe('sub_command_group');
    expect(command?.options?.[0]?.options?.[0]?.type).toBe('sub_command');
    expect(command?.options?.[0]?.options?.[0]?.options?.[0]?.type).toBe('user');
  });

  /**
   * The guard that a wrong build would otherwise pass. An unmapped enum has to
   * fail loudly: dropping the option would publish a command whose arguments
   * are silently missing, and the listing is not a surface anybody re-reads.
   */
  it('throws on an option type it cannot name, naming where it was', () => {
    expect(() =>
      toTopggCommands([
        {
          name: 'future',
          description: 'x',
          type: 1,
          options: [{ type: 99, name: 'o', description: 'd' }],
        } as never,
      ]),
    ).toThrow(/command future\.options\[0\].*option type 99/);
  });

  it('throws on a command type it cannot name', () => {
    expect(() =>
      toTopggCommands([{ name: 'future', description: 'x', type: 42 } as never]),
    ).toThrow(/command type 42/);
  });

  /**
   * Binds the mapper to the real command surface. A new option type reaching
   * `definitions.ts` fails here rather than on a listing nobody is watching --
   * the same trick `systemPrompt.unit.test.ts` uses on the template engine.
   */
  it('maps the real command set with every field top.gg accepts', () => {
    const source = buildCommandDefinitions({ includeAssistant: true, includeDebug: true });
    const mapped = toTopggCommands(source);
    expect(mapped).toHaveLength(source.length);
    expect(mapped.length).toBeGreaterThan(20);

    const allowedCommandKeys = new Set([
      'type',
      'name',
      'description',
      'name_localizations',
      'description_localizations',
      'options',
      'nsfw',
    ]);
    const allowedOptionKeys = new Set([
      'type',
      'name',
      'description',
      'name_localizations',
      'description_localizations',
      'required',
      'choices',
      'options',
    ]);
    const walk = (options: readonly { options?: unknown }[] | undefined): void => {
      for (const option of options ?? []) {
        for (const key of Object.keys(option)) expect(allowedOptionKeys).toContain(key);
        walk(option.options as never);
      }
    };
    for (const command of mapped) {
      for (const key of Object.keys(command)) expect(allowedCommandKeys).toContain(key);
      expect(command.type).toBe('chat_input');
      expect(command.name).toMatch(/^[\w-]+$/);
      expect(command.description.length).toBeGreaterThan(0);
      walk(command.options);
    }
  });
});

describe('TopggClient', () => {
  it('PATCHes the metrics with snake_case keys and a bearer token', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new TopggClient({
      token: 'tok',
      baseUrl: 'https://example.test/v1',
      fetchFn: ((url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Promise.resolve(reply(204));
      }) as unknown as typeof fetch,
    });

    await client.postMetrics({ serverCount: 5556, shardCount: 4 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://example.test/v1/projects/@me/metrics');
    expect(calls[0]?.init.method).toBe('PATCH');
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      server_count: 5556,
      shard_count: 4,
    });
  });

  it('PUTs the command list', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new TopggClient({
      token: 'tok',
      baseUrl: 'https://example.test/v1',
      fetchFn: ((url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Promise.resolve(reply(204));
      }) as unknown as typeof fetch,
    });

    await client.putCommands([{ type: 'chat_input', name: 'ping', description: 'Pong.' }]);

    expect(calls[0]?.url).toBe('https://example.test/v1/projects/@me/commands');
    expect(calls[0]?.init.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual([
      { type: 'chat_input', name: 'ping', description: 'Pong.' },
    ]);
  });

  it('throws with the status and a bounded body on a refusal', async () => {
    const client = new TopggClient({
      token: 'tok',
      fetchFn: (() => Promise.resolve(reply(422, 'x'.repeat(1000)))) as unknown as typeof fetch,
    });
    await expect(client.postMetrics({ serverCount: 1, shardCount: 1 })).rejects.toMatchObject({
      status: 422,
      retryAfterMs: null,
    });
    await client.postMetrics({ serverCount: 1, shardCount: 1 }).catch((err: TopggApiError) => {
      expect(err.message.length).toBeLessThan(400);
    });
  });

  it('reports a transport failure as status 0, not as an HTTP answer', async () => {
    const client = new TopggClient({
      token: 'tok',
      fetchFn: (() =>
        Promise.reject(new Error('getaddrinfo ENOTFOUND'))) as unknown as typeof fetch,
    });
    await expect(client.postMetrics({ serverCount: 1, shardCount: 1 })).rejects.toMatchObject({
      status: 0,
    });
  });

  it('never puts the token in the error message', async () => {
    const client = new TopggClient({
      token: 'super-secret-token',
      fetchFn: (() => Promise.reject(new Error('boom'))) as unknown as typeof fetch,
    });
    const err = await client.postMetrics({ serverCount: 1, shardCount: 1 }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain('super-secret-token');
  });

  describe('a 429, whose penalty is an hour-long token block', () => {
    const rateLimited = (body: string, headers: Record<string, string> = {}) =>
      new TopggClient({
        token: 'tok',
        fetchFn: (() => Promise.resolve(reply(429, body, headers))) as unknown as typeof fetch,
      });

    it('prefers the Retry-After header', async () => {
      await expect(
        rateLimited('{}', { 'retry-after': '30' }).postMetrics({ serverCount: 1, shardCount: 1 }),
      ).rejects.toMatchObject({ retryAfterMs: 30_000 });
    });

    it('falls back to the documented JSON retry-after field', async () => {
      await expect(
        rateLimited('{"retry-after": 3600}').postMetrics({ serverCount: 1, shardCount: 1 }),
      ).rejects.toMatchObject({ retryAfterMs: 3_600_000 });
    });

    it('defaults to an hour rather than to zero when the body says nothing', async () => {
      await expect(
        rateLimited('nope').postMetrics({ serverCount: 1, shardCount: 1 }),
      ).rejects.toMatchObject({ retryAfterMs: 3_600_000 });
    });
  });
});
