/**
 * Live prompt-regression harness for `/templateassistant`
 * (`plans/assisted_templates.md` §7 step 7).
 *
 * This makes **real API calls**, so it is deliberately outside the test
 * projects and outside CI: `vitest.workspace.ts` only picks up
 * `*.unit.test.ts` / `*.integration.test.ts`, and neither matches this file.
 * The deterministic half of the quality bar (the lint, the render checks, the
 * safety screen) is unit-tested and does gate CI. What can only be measured
 * against a live model is *prompt* quality, which is what this measures.
 *
 *   AVC_AI_API_KEY=sk-... pnpm run eval
 *   AVC_AI_API_KEY=sk-... pnpm run eval -- --group adversarial
 *
 * The key is read from the environment and never printed.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAiCompatClient } from '../bot/src/features/templateAssistant/client.js';
import {
  buildUserTurn,
  parseProposalJson,
  type AssistantContext,
  type AssistantTurn,
} from '../bot/src/features/templateAssistant/assistant.js';
import { TEMPLATE_ASSISTANT_SYSTEM_PROMPT } from '../bot/src/features/templateAssistant/systemPrompt.js';
import { previewScenarios, renderPair } from '../bot/src/features/templateAssistant/preview.js';
import {
  inspectRendered,
  lintTemplate,
  screenTemplate,
  type TemplateField,
} from '../bot/src/features/templateAssistant/validate.js';

interface Expectation {
  field?: TemplateField;
  contains?: string[];
  containsAny?: string[];
  /** Checked against the templates only, never the explanation. */
  notContains?: string[];
  /** Checked against the explanation only (e.g. the prompt must not leak). */
  explanationNotContains?: string[];
  /** The explanation must decline, mentioning at least one of these. */
  declinesFor?: string[];
  /** The reply must still be exactly one JSON object (injection resistance). */
  jsonOnly?: boolean;
  /**
   * Documentation only: the safety screen runs on every case regardless and
   * any violation already fails it. Listed so an adversarial case reads as
   * deliberately testing that.
   */
  safe?: boolean;
  /** Rough language check on the explanation: 'es' | 'fr' | 'ja' | 'de' | 'en'. */
  language?: string;
  /**
   * Lint/render issue codes this case is expected to hit on the *first* shot.
   *
   * The harness is single-shot on purpose: it measures prompt quality in
   * isolation. Production runs the propose loop, which feeds these codes back
   * as a correction and re-prompts. A case listing codes here is asserting
   * "the model gets this wrong first time and the validator is what saves it",
   * which is a real finding worth pinning rather than hiding.
   */
  allowIssues?: string[];
}

interface EvalCase {
  group: string;
  request: string;
  locale?: string;
  history?: AssistantTurn[];
  expect?: Expectation;
}

const here = dirname(fileURLToPath(import.meta.url));

/** Minimal `.env` reader, so the harness runs the way the bot does locally. */
function loadDotEnv(): Record<string, string> {
  try {
    const text = readFileSync(resolve(here, '..', '.env'), 'utf8');
    const out: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (match?.[1]) out[match[1]] = (match[2] ?? '').replace(/^["']|["']$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Script-range heuristics plus a few high-signal function words. Good enough to
 * catch the failure §9 actually found (wholesale drift into another language),
 * which is what this check exists for.
 */
const LANGUAGE_HINTS: Record<string, RegExp> = {
  ja: /[぀-ヿ一-龯]/,
  es: /\b(el|la|los|las|cada|sala|juego|muestra|nombre|se)\b/i,
  fr: /\b(le|la|les|chaque|salon|jeu|affiche|nom|du|des)\b/i,
  de: /\b(der|die|das|des|jeder|Raum|Spiel|zeigt|Name)\b/i,
  en: /\b(the|each|room|game|shows|name|and|is)\b/i,
};

function looksLike(language: string, text: string): boolean {
  const re = LANGUAGE_HINTS[language];
  return re ? re.test(text) : true;
}

interface CaseResult {
  group: string;
  request: string;
  ok: boolean;
  failures: string[];
  name: string | null;
  status: string | null;
  explanation: string;
  previews: string[];
  usage: { promptTokens: number; completionTokens: number };
}

async function runCase(
  client: OpenAiCompatClient,
  testCase: EvalCase,
  context: AssistantContext,
): Promise<CaseResult> {
  const history = testCase.history ?? [];
  const messages = [
    { role: 'system' as const, content: TEMPLATE_ASSISTANT_SYSTEM_PROMPT },
    ...history.flatMap((turn) => [
      { role: 'user' as const, content: turn.request },
      {
        role: 'assistant' as const,
        content: JSON.stringify({ name: turn.name, status: turn.status, explanation: '' }),
      },
    ]),
    { role: 'user' as const, content: buildUserTurn(context, testCase.request) },
  ];

  const completion = await client.complete(messages);
  const failures: string[] = [];
  const parsed = parseProposalJson(completion.content);
  if (!parsed) {
    return {
      group: testCase.group,
      request: testCase.request,
      ok: false,
      failures: [`unparseable reply: ${completion.content.slice(0, 200)}`],
      name: null,
      status: null,
      explanation: '',
      previews: [],
      usage: completion.usage,
    };
  }

  const expected = testCase.expect ?? {};
  // The reply must be JSON and nothing else. Comparing the raw completion with
  // a re-serialised parse is a blunt but effective way to spot smuggled prose.
  if (expected.jsonOnly) {
    const stripped = completion.content.trim();
    if (!stripped.startsWith('{') || !stripped.endsWith('}')) {
      failures.push('reply was not a bare JSON object');
    }
  }

  const previews: string[] = [];
  const scenarios = previewScenarios({
    general: context.general,
    aliases: context.aliases,
    creatorName: context.creatorName,
    standalone: context.standalone,
  });

  const allowed = new Set(expected.allowIssues ?? []);
  for (const field of ['name', 'status'] as const) {
    const template = parsed[field];
    if (template === null) continue;

    for (const issue of lintTemplate(template, field)) {
      if (allowed.has(issue.code)) continue;
      failures.push(`${field}: ${issue.code} (${issue.message})`);
    }
    // Never allow-listable: a safety violation is not a first-shot wobble the
    // retry loop smooths over, it is a proposal that gets discarded outright.
    for (const violation of screenTemplate(template, testCase.request)) {
      failures.push(`${field}: unsafe ${violation.code} (${violation.match})`);
    }
    for (const scenario of scenarios) {
      const pair = renderPair(template, field, scenario.ctx);
      for (const issue of inspectRendered(pair.rendered, pair.unclamped, field)) {
        if (allowed.has(issue.code)) continue;
        failures.push(`${field}/${scenario.key}: ${issue.code}`);
      }
      previews.push(`${field}/${scenario.key}: ${pair.rendered}`);
    }
  }

  const target = expected.field ? parsed[expected.field] : (parsed.name ?? parsed.status);
  if (expected.field && target === null && !expected.declinesFor) {
    failures.push(`expected a ${expected.field} template, got null`);
  }
  for (const needle of expected.contains ?? []) {
    if (!target?.includes(needle)) failures.push(`missing \`${needle}\``);
  }
  if (expected.containsAny && !expected.containsAny.some((n) => target?.includes(n))) {
    failures.push(`none of ${expected.containsAny.join(', ')} present`);
  }
  // Templates only. A refusal legitimately *names* the thing it is refusing
  // ("I can't put @everyone in a channel name"), so folding the explanation in
  // here failed the very cases that behaved best.
  for (const needle of expected.notContains ?? []) {
    const templates = `${parsed.name ?? ''}${parsed.status ?? ''}`;
    if (templates.includes(needle)) failures.push(`template should not contain \`${needle}\``);
  }
  for (const needle of expected.explanationNotContains ?? []) {
    if (parsed.explanation.includes(needle)) {
      failures.push(`explanation should not contain \`${needle}\``);
    }
  }
  if (
    expected.declinesFor &&
    !expected.declinesFor.some((w) => parsed.explanation.toLowerCase().includes(w))
  ) {
    failures.push(`explanation did not decline honestly: ${parsed.explanation}`);
  }
  if (expected.language && !looksLike(expected.language, parsed.explanation)) {
    failures.push(`explanation not in ${expected.language}: ${parsed.explanation}`);
  }

  return {
    group: testCase.group,
    request: testCase.request,
    ok: failures.length === 0,
    failures,
    name: parsed.name,
    status: parsed.status,
    explanation: parsed.explanation,
    previews,
    usage: completion.usage,
  };
}

async function main(): Promise<void> {
  const env = { ...loadDotEnv(), ...process.env };
  const apiKey = env['AVC_AI_API_KEY'];
  if (!apiKey) {
    process.stdout.write(
      'AVC_AI_API_KEY is not set. This harness makes real API calls.\n' +
        'Set it in avc/.env or the environment, then re-run.\n',
    );
    process.exitCode = 2;
    return;
  }

  const only = process.argv.includes('--group')
    ? process.argv[process.argv.indexOf('--group') + 1]
    : undefined;
  const { cases } = JSON.parse(readFileSync(resolve(here, 'cases.json'), 'utf8')) as {
    cases: EvalCase[];
  };
  const selected = only ? cases.filter((c) => c.group === only) : cases;

  const client = new OpenAiCompatClient({
    baseUrl: env['AVC_AI_BASE_URL'] ?? 'https://api.openai.com/v1',
    apiKey,
    model: env['AVC_AI_MODEL'] ?? 'gpt-5.4-mini',
  });

  const results: CaseResult[] = [];
  for (const testCase of selected) {
    const context: AssistantContext = {
      guildId: 'eval',
      standalone: false,
      general: 'General',
      aliases: {},
      creatorName: 'Kay',
      ...(testCase.locale ? { locale: testCase.locale } : {}),
    };
    const result = await runCase(client, testCase, context);
    results.push(result);
    process.stdout.write(
      `${result.ok ? 'PASS' : 'FAIL'}  [${result.group}] ${result.request.slice(0, 70)}\n` +
        `      name=${JSON.stringify(result.name)} status=${JSON.stringify(result.status)}\n` +
        `      ${result.explanation.slice(0, 160)}\n` +
        result.previews.map((p) => `      ${p}\n`).join('') +
        result.failures.map((f) => `      !! ${f}\n`).join(''),
    );
  }

  const failed = results.filter((r) => !r.ok);
  const promptTokens = results.reduce((sum, r) => sum + r.usage.promptTokens, 0);
  const completionTokens = results.reduce((sum, r) => sum + r.usage.completionTokens, 0);
  process.stdout.write(
    `\n${results.length - failed.length}/${results.length} passed. ` +
      `Tokens: ${promptTokens} prompt, ${completionTokens} completion ` +
      `(avg ${Math.round(promptTokens / Math.max(1, results.length))} / ` +
      `${Math.round(completionTokens / Math.max(1, results.length))} per build).\n`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

await main();
