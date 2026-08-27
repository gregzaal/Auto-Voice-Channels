import type { RESTPostAPIApplicationCommandsJSONBody } from 'discord.js';

/**
 * The top.gg listing API (v1), for the two facts worth keeping in step
 * automatically: how many servers the bot is in, and what commands it has.
 *
 * Both are visible on the public listing and both go stale on their own. A
 * listing that says "0 servers" and lists no commands reads as an abandoned
 * bot, which is the specific impression this exists to prevent
 * (`plans/marketing.md` beat 6).
 *
 * Scope is deliberately these two calls. The same token can also write the
 * long description (`PATCH /projects/@me`, `headline` + `page_content`, per
 * locale) and post announcements, and neither is here yet: the description is
 * generated into `web/content/listings/out/topgg.html` and pasted for now, and
 * an announcement is a message to real people rather than a counter, so it
 * needs a human in the loop.
 */

/** The v1 base. `@me` resolves the project from the token, so no id is needed. */
export const TOPGG_API_BASE = 'https://top.gg/api/v1';

export type TopggCommandType = 'chat_input' | 'user' | 'message';

export type TopggOptionType =
  | 'sub_command'
  | 'sub_command_group'
  | 'string'
  | 'integer'
  | 'boolean'
  | 'user'
  | 'channel'
  | 'role'
  | 'mentionable'
  | 'number'
  | 'attachment';

/**
 * top.gg spells the Discord command enums as STRINGS where Discord's own JSON
 * uses NUMBERS: `"chat_input"` where Discord sends `1`, `"channel"` where it
 * sends `7`.
 *
 * This is the whole reason {@link toTopggCommands} exists rather than posting
 * `buildCommandDefinitions()` straight through. The two payloads are otherwise
 * near enough identical that passing ours along looks obviously right, and it
 * fails as a 422 on a call nothing else depends on, so it would sit broken.
 *
 * Keyed by the Discord number explicitly rather than by indexing an array in
 * enum order. The two orders do currently agree, and a future agent should not
 * have to verify that in order to read this.
 */
const COMMAND_TYPES = new Map<number, TopggCommandType>([
  [1, 'chat_input'],
  [2, 'user'],
  [3, 'message'],
]);

const OPTION_TYPES = new Map<number, TopggOptionType>([
  [1, 'sub_command'],
  [2, 'sub_command_group'],
  [3, 'string'],
  [4, 'integer'],
  [5, 'boolean'],
  [6, 'user'],
  [7, 'channel'],
  [8, 'role'],
  [9, 'mentionable'],
  [10, 'number'],
  [11, 'attachment'],
]);

export interface TopggCommandChoice {
  name: string;
  value: string | number;
  name_localizations?: Record<string, string>;
}

export interface TopggCommandOption {
  type: TopggOptionType;
  name: string;
  description: string;
  name_localizations?: Record<string, string>;
  description_localizations?: Record<string, string>;
  required?: boolean;
  choices?: TopggCommandChoice[];
  options?: TopggCommandOption[];
}

export interface TopggCommand {
  type: TopggCommandType;
  name: string;
  description: string;
  name_localizations?: Record<string, string>;
  description_localizations?: Record<string, string>;
  options?: TopggCommandOption[];
  nsfw?: boolean;
}

/** A localization map, or undefined. Discord also sends `null` for "none". */
function localizations(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (pair): pair is [string, string] => typeof pair[1] === 'string',
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function toOption(raw: unknown, path: string): TopggCommandOption {
  const o = raw as Record<string, unknown>;
  const type = OPTION_TYPES.get(o.type as number);
  if (!type) {
    throw new Error(`${path}: no top.gg name for Discord option type ${String(o.type)}`);
  }
  const nameLoc = localizations(o.name_localizations);
  const descLoc = localizations(o.description_localizations);
  const choices = Array.isArray(o.choices)
    ? o.choices.map((c) => {
        const choice = c as Record<string, unknown>;
        const loc = localizations(choice.name_localizations);
        return {
          name: String(choice.name),
          value: choice.value as string | number,
          ...(loc ? { name_localizations: loc } : {}),
        };
      })
    : undefined;
  const nested = Array.isArray(o.options)
    ? o.options.map((n, i) => toOption(n, `${path}.options[${i}]`))
    : undefined;
  return {
    type,
    name: String(o.name),
    description: String(o.description ?? ''),
    ...(nameLoc ? { name_localizations: nameLoc } : {}),
    ...(descLoc ? { description_localizations: descLoc } : {}),
    ...(typeof o.required === 'boolean' ? { required: o.required } : {}),
    ...(choices && choices.length > 0 ? { choices } : {}),
    ...(nested && nested.length > 0 ? { options: nested } : {}),
  };
}

/**
 * Projects Discord's command JSON onto what top.gg documents.
 *
 * Two jobs. It rewrites the numeric enums as named ones (see above), and it
 * keeps only the properties top.gg documents, so everything else is dropped by
 * construction rather than by a list that has to be maintained. What that
 * currently discards from the real command set: `default_member_permissions`,
 * `default_permission`, `dm_permission`, `contexts`, `integration_types`,
 * `min_value`/`max_value`, `min_length`/`max_length`, `channel_types` and
 * `autocomplete`. Those are Discord's permission and behaviour plumbing,
 * meaningless on a listing page, and sending them would mean relying on an
 * undocumented `additionalProperties` staying permissive.
 *
 * `name_localizations` and `description_localizations` are carried through, so
 * a translated command surface reaches the listing the day we have one without
 * this needing a change.
 *
 * Throws on an enum it cannot name, rather than dropping the option and
 * publishing a command whose arguments are quietly missing. `topgg.unit.test.ts`
 * maps the real command set, so a Discord type nothing here maps fails CI
 * instead of the listing.
 */
export function toTopggCommands(
  commands: readonly RESTPostAPIApplicationCommandsJSONBody[],
): TopggCommand[] {
  return commands.map((raw) => {
    const c = raw as unknown as Record<string, unknown>;
    const name = String(c.name);
    /**
     * A missing `type` is CHAT_INPUT. Discord documents it as optional and
     * defaulting to 1, and `SlashCommandBuilder` does emit it, but a caller
     * hand-writing a definition is entitled to leave it out.
     */
    const type = COMMAND_TYPES.get((c.type as number | undefined) ?? 1);
    if (!type) {
      throw new Error(`command ${name}: no top.gg name for Discord command type ${String(c.type)}`);
    }
    const nameLoc = localizations(c.name_localizations);
    const descLoc = localizations(c.description_localizations);
    const options = Array.isArray(c.options)
      ? c.options.map((o, j) => toOption(o, `command ${name}.options[${j}]`))
      : undefined;
    return {
      type,
      name,
      description: String(c.description ?? ''),
      ...(nameLoc ? { name_localizations: nameLoc } : {}),
      ...(descLoc ? { description_localizations: descLoc } : {}),
      ...(options && options.length > 0 ? { options } : {}),
      ...(c.nsfw === true ? { nsfw: true } : {}),
    };
  });
}

/**
 * A failed top.gg call, carrying the status so a caller can tell a rate limit
 * from a bad token.
 *
 * `status` is 0 for a transport failure, which is a different thing from any
 * HTTP answer and must not be mistaken for one. It does NOT tell you which
 * transport failure: Node's `fetch` rejects every one of them as
 * `TypeError: fetch failed` and puts the real reason in `cause`, so the message
 * carries that (see {@link describeFetchFailure}) and the status does not.
 */
export class TopggApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'TopggApiError';
  }
}

export interface TopggClientDeps {
  token: string;
  fetchFn?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** How much of an error body to keep. Enough to identify it, not to log a page. */
const MAX_ERROR_BODY = 300;

/**
 * The cooldown after a 429 that does not say how long to wait.
 *
 * top.gg answers a rate-limit breach by blocking the TOKEN for an hour rather
 * than by throttling the one call, so guessing short is expensive and guessing
 * long only costs a stale counter. An hour matches the documented penalty.
 */
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 3_600_000;

/**
 * The longest a `Retry-After` may park the publisher.
 *
 * The documented penalty is an hour, so anything beyond two is a proxy or a
 * policy we did not expect, and honouring it verbatim would take the listing
 * out for that long with a process restart as the only way back. Bounding the
 * upside matters as much as defaulting the downside.
 */
const MAX_RATE_LIMIT_COOLDOWN_MS = 2 * 3_600_000;

/**
 * Identifies us to top.gg. Vague on purpose about the version, which is not
 * worth a build-time injection here.
 */
const USER_AGENT = 'AutoVoiceChannels (+https://auto-voice.io)';

/**
 * What actually went wrong at the transport level.
 *
 * Node's `fetch` rejects every transport failure as `TypeError: fetch failed`
 * and puts the reason in `cause`, so a message built from `err.message` alone
 * says "fetch failed" and nothing else. That is the whole diagnostic content of
 * a failure nobody can reproduce on demand.
 */
function describeFetchFailure(err: unknown): string {
  const error = err as { message?: string; cause?: unknown };
  const cause = error?.cause;
  const causeMessage =
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  const base = error?.message ?? String(err);
  return causeMessage && !base.includes(causeMessage) ? `${base} (${causeMessage})` : base;
}

export class TopggClient {
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly deps: TopggClientDeps) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.baseUrl = deps.baseUrl ?? TOPGG_API_BASE;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Publishes the server and shard counts.
   *
   * Only these two fields. The rest of `PostMetricsInput` is for game servers
   * (`player_count`, `players_max`, `tick_rate`), and `member_count` is
   * documented as "total number of members in the server", which is per-server
   * semantics that do not describe a bot install base.
   */
  async postMetrics(metrics: { serverCount: number; shardCount: number }): Promise<void> {
    await this.send('PATCH', '/projects/@me/metrics', {
      server_count: metrics.serverCount,
      shard_count: metrics.shardCount,
    });
  }

  /** Replaces the listed command set. A full PUT, so it is idempotent. */
  async putCommands(commands: readonly TopggCommand[]): Promise<void> {
    await this.send('PUT', '/projects/@me/commands', commands);
  }

  private async send(method: string, path: string, body: unknown): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.deps.token}`,
          'content-type': 'application/json',
          /**
           * An explicit agent, because the default is the bare string `node`.
           * A generic agent is the kind of thing an API behind a WAF refuses,
           * and it would refuse it in production only: every test here injects
           * `fetch`, so nothing local would ever see it.
           */
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      /**
       * The message names the method and path, plus the transport reason. It
       * reaches logs and `/diagnostics`, and never the request, which carries
       * the token.
       */
      throw new TopggApiError(0, `${method} ${path}: ${describeFetchFailure(err)}`);
    }
    if (res.ok) return;

    let detail = '';
    try {
      detail = (await res.text()).slice(0, MAX_ERROR_BODY);
    } catch {
      // A body we cannot read does not change what the status already said.
    }
    const retryAfterMs = res.status === 429 ? retryAfter(res, detail) : null;
    throw new TopggApiError(
      res.status,
      `${method} ${path}: HTTP ${res.status}${detail ? ` ${detail}` : ''}`,
      retryAfterMs,
    );
  }
}

/**
 * How long a 429 asks us to wait, in ms.
 *
 * Header first, then the body, because top.gg documents the wait as a JSON
 * `retry-after` field in seconds while the standard header is what a proxy in
 * front of it would set. Falls back to the documented one-hour penalty rather
 * than to zero: retrying straight into a token block is what turns a throttle
 * into an outage of this feature.
 */
function retryAfter(res: Response, body: string): number {
  const clamp = (ms: number): number => Math.min(ms, MAX_RATE_LIMIT_COOLDOWN_MS);
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return clamp(header * 1000);
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const seconds = Number(parsed['retry-after'] ?? parsed.retry_after);
    if (Number.isFinite(seconds) && seconds > 0) return clamp(seconds * 1000);
  } catch {
    // Not JSON. The default below is the safe answer.
  }
  return DEFAULT_RATE_LIMIT_COOLDOWN_MS;
}

/**
 * Is this a status that will keep failing until a human changes something?
 *
 * A bad or revoked token (401/403) and a project that no longer exists (404, a
 * documented response here) are not transient, so retrying them on a timer for
 * weeks is the shape of a feature that looks switched on and is not.
 */
export function isPermanentTopggFailure(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}
