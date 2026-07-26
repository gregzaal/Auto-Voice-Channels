/**
 * The LLM seam for `/templateassistant` — one **OpenAI-compatible**
 * `/v1/chat/completions` call, configured by env
 * (`plans/assisted_templates.md` §3).
 *
 * Deliberately not the Anthropic SDK and deliberately not a set of per-provider
 * adapters: the driving requirement is self-host UX, where "set three env vars"
 * has to cover OpenAI, OpenRouter, Groq/Together/Fireworks, and a local Ollama /
 * LM Studio / vLLM with no code change.
 *
 * Everything above this file talks to {@link ChatClient}, so the propose loop
 * and the whole command surface are testable without a network.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatCompletion {
  content: string;
  usage: ChatUsage;
}

export interface ChatClient {
  complete(messages: ChatMessage[]): Promise<ChatCompletion>;
  /** The configured model id, for logs and diagnostics. */
  readonly model: string;
}

/**
 * A provider-side failure: the call never produced a usable completion. Callers
 * distinguish this from a *bad* completion, because only the former refunds the
 * guild's reserved build (`plans/assisted_templates.md` §5).
 */
export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

export interface OpenAiCompatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /**
   * Cap on the completion. ~500 is safe: reasoning tokens count against it and
   * observed visible completions were only ~35-85 tokens (§9).
   */
  maxCompletionTokens?: number;
  /** Attempts on a retryable failure (429 / 5xx / network). */
  maxAttempts?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface ChatCompletionBody {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_completion_tokens?: number;
  max_tokens?: number;
  /** Nudges providers that support it toward a bare JSON object (§4). */
  response_format?: { type: 'json_object' };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

export class OpenAiCompatClient implements ChatClient {
  readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly maxCompletionTokens: number;
  /**
   * Learned per-process compatibility quirks. The compat ecosystem disagrees on
   * two parameters: OpenAI's GPT-5 series rejects `max_tokens` and wants
   * `max_completion_tokens`, while several OpenAI-compatible servers only know
   * `max_tokens`; some models reject a `temperature` at all. We start with the
   * OpenAI spelling, fall back once on the specific 400, and then remember —
   * so a self-hoster on a non-OpenAI endpoint pays the probe exactly once.
   */
  private useLegacyMaxTokens = false;
  private omitTemperature = false;
  private omitResponseFormat = false;
  /**
   * Each adaptation is applied at most once per process. Without this a
   * provider whose 400 mentions both spellings of the token parameter would
   * flip the flag back and forth forever.
   */
  private readonly adaptationsApplied = new Set<string>();

  constructor(private readonly opts: OpenAiCompatOptions) {
    this.model = opts.model;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
    this.maxCompletionTokens = opts.maxCompletionTokens ?? 500;
  }

  async complete(messages: ChatMessage[]): Promise<ChatCompletion> {
    let lastError: AiProviderError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await this.attempt(messages);
      } catch (err) {
        const error =
          err instanceof AiProviderError
            ? err
            : new AiProviderError(String((err as Error)?.message ?? err), undefined, true);
        lastError = error;
        if (!error.retryable || attempt === this.maxAttempts) throw error;
        // Exponential backoff, bounded. Channel naming is not latency-critical,
        // but the admin is staring at a spinner, so keep the ceiling low.
        await this.sleep(Math.min(2_000, 250 * 2 ** (attempt - 1)));
      }
    }
    /* c8 ignore next */
    throw lastError ?? new AiProviderError('no attempt was made');
  }

  private async attempt(messages: ChatMessage[]): Promise<ChatCompletion> {
    const body: ChatCompletionBody = { model: this.model, messages };
    if (!this.omitTemperature) body.temperature = 0;
    if (!this.omitResponseFormat) body.response_format = { type: 'json_object' };
    if (this.useLegacyMaxTokens) body.max_tokens = this.maxCompletionTokens;
    else body.max_completion_tokens = this.maxCompletionTokens;

    const response = await this.post(body);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      // One-shot compat probes. Each flips a sticky flag and re-attempts, so a
      // provider that dislikes a parameter costs one extra request per process.
      if (response.status === 400 && this.adaptTo(text)) return this.attempt(messages);
      throw new AiProviderError(
        `model request failed (${response.status}): ${text.slice(0, 300)}`,
        response.status,
        response.status === 429 || response.status >= 500,
      );
    }

    const json = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      // An empty completion is usually the token cap being eaten by reasoning.
      // Retryable: at temperature 0 a retry rarely helps, but it costs one call
      // and beats surfacing a blank proposal.
      throw new AiProviderError('model returned an empty completion', undefined, true);
    }
    return {
      content,
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
      },
    };
  }

  private async post(body: ChatCompletionBody): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      return await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = (err as Error)?.name === 'AbortError';
      throw new AiProviderError(
        aborted ? `model request timed out after ${this.timeoutMs}ms` : String(err),
        undefined,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Reads a 400 body for a known "this provider does not take that parameter"
   * complaint and flips the matching flag. Returns whether anything changed —
   * false means the 400 is a real error and must surface.
   */
  private adaptTo(errorBody: string): boolean {
    const text = errorBody.toLowerCase();
    const apply = (key: string, mutate: () => void): boolean => {
      if (this.adaptationsApplied.has(key)) return false;
      this.adaptationsApplied.add(key);
      mutate();
      return true;
    };
    // Order matters: the token-parameter complaint names both spellings, so it
    // has to be matched by which one we actually sent, not by which appears.
    if (text.includes('max_completion_tokens') || text.includes('max_tokens')) {
      const swapped = apply('maxTokens', () => {
        this.useLegacyMaxTokens = !this.useLegacyMaxTokens;
      });
      if (swapped) return true;
    }
    if (text.includes('temperature')) {
      if (apply('temperature', () => (this.omitTemperature = true))) return true;
    }
    if (text.includes('response_format')) {
      if (apply('responseFormat', () => (this.omitResponseFormat = true))) return true;
    }
    return false;
  }
}
