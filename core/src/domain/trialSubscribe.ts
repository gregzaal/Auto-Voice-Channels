import type { AuthStatus } from './auth.js';

/**
 * Whether a server can commit today and be charged when its trial ends
 * (`plans/pricing-ladder.md` §6.5, decision 9).
 *
 * A server in its free year should be able to subscribe without forfeiting the
 * months it has left, and a server in its 30 days should be able to stop the
 * warnings by deciding. Before this the only way to subscribe was to start
 * paying immediately, which punished exactly the customer who had already made
 * up their mind.
 *
 * Pure and shared, because three surfaces have to agree about the same date:
 * the dashboard's offer, the trial-length the Paddle checkout is minted with,
 * and the copy the bot's trial warnings and `/setup` panel carry. A second
 * implementation of "how many days are left" would be a second answer to "when
 * will I be charged", which is the one number the customer will check.
 */

const DAY_MS = 86_400_000;

/**
 * The longest trial a checkout will carry.
 *
 * Paddle's own limit is not documented and is higher than this: 30, 365, 400,
 * 500 and 730 day trials were all accepted and stored verbatim against the
 * sandbox on 2026-09-07, `requires_payment_method` defaulting to true. 730 is
 * ours, and it has room to spare, because the longest trial the product can
 * actually issue is a year plus the importer's 60-to-90 day start jitter, which
 * runs to roughly 436 days from today for the imported cohort.
 *
 * **Past the cap the offer is WITHHELD, never truncated.** Truncating would
 * charge a customer before the free time they were promised had run out, which
 * is the one thing this whole path exists to avoid. They keep today's
 * behaviour, which is the ordinary charge-now checkout, and lose nothing.
 */
export const MAX_TRIAL_SUBSCRIBE_DAYS = 730;

/** The guild state this decision reads. Both fields come straight off `guilds`. */
export interface TrialSubscribeInput {
  authStatus: AuthStatus;
  /** The trial deadline. Null for a guild whose clock never started. */
  authExpiresAt: Date | null | undefined;
}

export interface TrialSubscribeWindow {
  /** Whole days of trial to put on the checkout's price. At least 1. */
  trialDays: number;
  /** When the first charge lands, which is what every surface quotes. */
  firstChargeAt: Date;
}

/**
 * The trial-subscribe window for a guild, or null when it should be charged now.
 *
 * Null for four reasons, all of which mean "the ordinary checkout is correct":
 * the guild is not on a trial at all (`active`, `grace`, `expired`, `blocked`),
 * its clock never started, the trial is already spent, or there is less than a
 * day left. §6.5 names the last two explicitly: a trial with hours left has
 * nothing left to preserve, and a Paddle trial is measured in whole days, so
 * there is no shorter one to ask for.
 *
 * **Days round UP.** A trial with 6.2 days left becomes a 7-day trial, so the
 * first charge lands after the free period rather than 0.8 days inside it.
 * Rounding down would take money before the trial we advertised had finished,
 * for every customer whose checkout is not at midnight, which is all of them.
 * The cost is up to one free day per customer, which is the right side to err
 * on and is not worth a second thought.
 *
 * `firstChargeAt` is derived from `trialDays` rather than being `authExpiresAt`
 * itself, deliberately: it has to be the date Paddle will actually bill on, or
 * the dashboard promises one day and the invoice says another.
 */
export function trialSubscribeWindow(
  input: TrialSubscribeInput,
  now: Date,
): TrialSubscribeWindow | null {
  if (input.authStatus !== 'trial') return null;
  if (!input.authExpiresAt) return null;
  const remainingMs = input.authExpiresAt.getTime() - now.getTime();
  if (remainingMs < DAY_MS) return null;
  const trialDays = Math.ceil(remainingMs / DAY_MS);
  if (trialDays > MAX_TRIAL_SUBSCRIBE_DAYS) return null;
  return { trialDays, firstChargeAt: new Date(now.getTime() + trialDays * DAY_MS) };
}
