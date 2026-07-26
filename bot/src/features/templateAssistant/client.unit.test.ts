import { describe, expect, it, vi } from 'vitest';
import { AiProviderError, OpenAiCompatClient } from './client.js';

interface Recorded {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** A fake `fetch` that replays a scripted list of responses and records requests. */
function fakeFetch(responses: { status: number; body: unknown }[]): {
  impl: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let i = 0;
  const impl = ((url: string, init: RequestInit) => {
    calls.push({
      url,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      headers: init.headers as Record<string, string>,
    });
    const next = responses[Math.min(i++, responses.length - 1)]!;
    const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return Promise.resolve({
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: () => Promise.resolve(text),
      json: () => Promise.resolve(JSON.parse(text) as unknown),
    } as Response);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const completion = (content: string): unknown => ({
  choices: [{ message: { content } }],
  usage: { prompt_tokens: 3500, completion_tokens: 60 },
});

function clientWith(responses: { status: number; body: unknown }[]): {
  client: OpenAiCompatClient;
  calls: Recorded[];
} {
  const { impl, calls } = fakeFetch(responses);
  const client = new OpenAiCompatClient({
    baseUrl: 'https://api.example.com/v1/',
    apiKey: 'sk-test',
    model: 'gpt-5.4-mini',
    fetchImpl: impl,
    sleep: () => Promise.resolve(),
  });
  return { client, calls };
}

describe('OpenAiCompatClient', () => {
  it('posts an OpenAI-shaped request and returns the completion with usage', async () => {
    const { client, calls } = clientWith([{ status: 200, body: completion('{"name":"x"}') }]);
    const result = await client.complete([{ role: 'user', content: 'hi' }]);

    expect(result.content).toBe('{"name":"x"}');
    expect(result.usage).toEqual({ promptTokens: 3500, completionTokens: 60 });
    // A trailing slash on the base url must not produce a double slash.
    expect(calls[0]!.url).toBe('https://api.example.com/v1/chat/completions');
    expect(calls[0]!.headers['authorization']).toBe('Bearer sk-test');
    // temperature 0 for deterministic structured extraction (§7 step 1), and the
    // GPT-5-series spelling of the completion cap (§4).
    expect(calls[0]!.body['temperature']).toBe(0);
    expect(calls[0]!.body['max_completion_tokens']).toBe(500);
    expect(calls[0]!.body['max_tokens']).toBeUndefined();
  });

  // The compat ecosystem disagrees on this parameter, and a self-hoster pointing
  // at Ollama or an older gateway must not need a code change.
  it('falls back to max_tokens when the provider rejects max_completion_tokens', async () => {
    const { client, calls } = clientWith([
      {
        status: 400,
        body: { error: { message: "Unsupported parameter: 'max_completion_tokens'" } },
      },
      { status: 200, body: completion('{"name":"x"}') },
    ]);
    await client.complete([{ role: 'user', content: 'hi' }]);

    expect(calls).toHaveLength(2);
    expect(calls[1]!.body['max_tokens']).toBe(500);
    expect(calls[1]!.body['max_completion_tokens']).toBeUndefined();
  });

  it('drops temperature when the provider rejects it', async () => {
    const { client, calls } = clientWith([
      { status: 400, body: { error: { message: "'temperature' is not supported" } } },
      { status: 200, body: completion('{"name":"x"}') },
    ]);
    await client.complete([{ role: 'user', content: 'hi' }]);
    expect(calls[1]!.body['temperature']).toBeUndefined();
  });

  it('remembers an adaptation instead of re-probing on every call', async () => {
    const { client, calls } = clientWith([
      {
        status: 400,
        body: { error: { message: "Unsupported parameter: 'max_completion_tokens'" } },
      },
      { status: 200, body: completion('{"name":"x"}') },
    ]);
    await client.complete([{ role: 'user', content: 'one' }]);
    await client.complete([{ role: 'user', content: 'two' }]);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.body['max_tokens']).toBe(500);
  });

  // A provider whose 400 names both spellings could otherwise flip the flag
  // back and forth forever.
  it('applies each adaptation at most once, so it cannot loop', async () => {
    const { client, calls } = clientWith([
      {
        status: 400,
        body: { error: { message: "'max_tokens' is not supported. Use 'max_completion_tokens'." } },
      },
    ]);
    await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      AiProviderError,
    );
    // One probe, then the 400 surfaces (attempt cap 3, non-retryable status).
    expect(calls).toHaveLength(2);
  });

  it('retries a 429 and a 5xx, then succeeds', async () => {
    const { client, calls } = clientWith([
      { status: 429, body: { error: 'slow down' } },
      { status: 200, body: completion('{"name":"x"}') },
    ]);
    const result = await client.complete([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('{"name":"x"}');
    expect(calls).toHaveLength(2);
  });

  it('gives up after the attempt cap and reports a provider error', async () => {
    const { client, calls } = clientWith([{ status: 503, body: 'upstream down' }]);
    await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      name: 'AiProviderError',
      status: 503,
      retryable: true,
    });
    expect(calls).toHaveLength(3);
  });

  it('does not retry a plain 401', async () => {
    const { client, calls } = clientWith([{ status: 401, body: 'bad key' }]);
    await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      status: 401,
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  it('treats an empty completion as a provider failure', async () => {
    const { client } = clientWith([{ status: 200, body: { choices: [{ message: {} }] } }]);
    await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /empty completion/,
    );
  });

  it('surfaces a timeout as a retryable provider error', async () => {
    const impl = vi.fn(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    }) as unknown as typeof fetch;
    const client = new OpenAiCompatClient({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'm',
      timeoutMs: 5,
      fetchImpl: impl,
      sleep: () => Promise.resolve(),
    });
    await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(/timed out/);
  });
});
