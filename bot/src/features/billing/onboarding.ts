import {
  parseBillingMeta,
  trialDurationMs,
  trialPolicyFor,
  type GuildRepository,
  type GuildRow,
  type GuildSettingsStore,
  type Logger,
  type TrialPolicy,
} from '@avc/core';
import type { Client, Guild } from 'discord.js';
import type { GuildDispatcher } from '../../runtime/dispatcher.js';
import type { BillingNotifier } from './notifier.js';

/** What new-guild onboarding should do for this guild (pure — unit-tested). */
export interface OnboardingDecision {
  policy: TrialPolicy;
  /** Start the trial clock (only when no window exists yet — re-adds keep theirs). */
  setExpiresAt?: Date;
  /** ≥1M members joining fresh: no trial — hard-gate until a deal is arranged (§3). */
  hardGate: boolean;
  /** Send the one-time welcome message. */
  welcome: boolean;
}

const STALE_WELCOME_MS = 7 * 86_400_000;

/**
 * Decides the §3 onboarding path for a `GUILD_CREATE`. Idempotent by design:
 * the welcome is one-shot (`metadata.billing.onboardedAt`), the trial window is
 * only ever set once (the clock starts at FIRST add), and a returning guild
 * keeps whatever auth state it had.
 */
export function decideOnboarding(
  row: GuildRow,
  memberCount: number,
  now: Date,
): OnboardingDecision {
  const policy = trialPolicyFor(memberCount);
  const meta = parseBillingMeta(row.metadata);
  /**
   * Welcome once, and only when the guild is actually starting out.
   *
   * The `authStatus === 'trial'` guard is the load-bearing one. Every welcome
   * message announces a trial ("your 1-year free trial just started"), but the
   * message was previously chosen from member count alone, so re-adding the bot
   * to a PAYING server told the subscriber their trial had just begun. The
   * other two guards did not catch it: the one-shot flag is only written once a
   * welcome has actually been delivered, and the staleness window keys off the
   * ROW's age, which is recent for any guild first seen recently regardless of
   * how long it has been a customer.
   *
   * Anything that is not `trial` (active, grace, expired, blocked) is a
   * returning guild whose story we would get wrong, so we say nothing.
   */
  const welcome =
    !meta.onboardedAt &&
    row.authStatus === 'trial' &&
    now.getTime() - row.createdAt.getTime() < STALE_WELCOME_MS;

  const decision: OnboardingDecision = { policy, hardGate: false, welcome };
  if (row.authStatus === 'trial' && row.authExpiresAt === null) {
    if (policy === 'hard_gate') {
      decision.hardGate = true;
    } else {
      const duration = trialDurationMs(policy);
      // Anchor on the ROW's creation, not "now" (§3: the clock starts at
      // first add) — identical for fresh joins, and it keeps this writer in
      // agreement with the reconcile job's backfill for old re-added rows.
      if (duration !== null) decision.setExpiresAt = new Date(row.createdAt.getTime() + duration);
    }
  }
  return decision;
}

export interface OnboardingDeps {
  client: Client;
  dispatcher: GuildDispatcher;
  /** Raw repo for bookkeeping reads/writes (samples, onboarded flag). */
  guilds: GuildRepository;
  /** Write-through store so auth transitions invalidate cluster-wide. */
  store: GuildSettingsStore;
  notifier: BillingNotifier;
  logger: Logger;
  now?: () => Date;
}

/**
 * New-guild onboarding (§6): on `GUILD_CREATE`, ensure the row, sample the
 * member count, start the trial clock (or hard-gate an XXL join), and send the
 * size-appropriate welcome. Runs through the per-guild dispatcher, and every
 * step is idempotent — a redelivered GUILD_CREATE is a no-op.
 *
 * @returns a disposer detaching the listener.
 */
export function registerGuildOnboarding(deps: OnboardingDeps): () => void {
  const now = deps.now ?? (() => new Date());

  const onGuildCreate = (guild: Guild): void => {
    void deps.dispatcher
      .dispatch(guild.id, 'billing:onboard', () => onboardGuild(deps, guild, now()))
      .catch((err: unknown) => {
        deps.logger.error({ err, guildId: guild.id }, 'guild onboarding failed');
      });
  };

  deps.client.on('guildCreate', onGuildCreate);
  return () => {
    deps.client.off('guildCreate', onGuildCreate);
  };
}

async function onboardGuild(deps: OnboardingDeps, guild: Guild, at: Date): Promise<void> {
  const memberCount = guild.memberCount ?? 0;
  await deps.guilds.ensure(guild.id);
  const { row } =
    memberCount > 0
      ? await deps.guilds.recordMemberCountSample(guild.id, memberCount, { at })
      : { row: await deps.guilds.getOrThrow(guild.id) };

  const decision = decideOnboarding(row, memberCount, at);

  if (decision.setExpiresAt) {
    // Set-once at the DB level: a concurrent backfill/onboarding writer can
    // never overwrite an existing window (§3 first-add semantics).
    await deps.store.transitionAuth({
      guildId: guild.id,
      toStatus: 'trial',
      reason: `trial_started:${decision.policy}`,
      actor: 'onboarding',
      expiresAtIfNull: decision.setExpiresAt,
    });
  } else if (decision.hardGate) {
    await deps.store.transitionAuth({
      guildId: guild.id,
      toStatus: 'expired',
      reason: 'joined_at_xxl',
      actor: 'onboarding',
    });
  }

  if (decision.welcome) {
    const delivered = await deps.notifier.welcomeGuild(guild.id, decision.policy, memberCount);
    if (delivered) await deps.guilds.markOnboarded(guild.id, at);
  }
}
