import { z } from 'zod';

/**
 * Billing bookkeeping stored in `guilds.metadata.billing` (jsonb):
 * daily member-count samples, notification dedupe records, and the
 * pending-anomaly holdover for the sample clamps (monetization.md §5, §12).
 *
 * Parsed defensively — corrupt metadata degrades to empty defaults and
 * quarantines to its guild rather than throwing on the hot path.
 */

/** How many daily samples to retain (covers the 30-day downgrade window + slack). */
export const MAX_MEMBER_SAMPLES = 45;

export const memberCountSampleSchema = z.object({
  /** UTC day key, `YYYY-MM-DD`. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  count: z.number().int().nonnegative(),
});
export type MemberCountSample = z.infer<typeof memberCountSampleSchema>;

export interface BillingMeta {
  /** Rolling daily member-count samples, oldest → newest, one per UTC day. */
  samples: MemberCountSample[];
  /** Notification dedupe map: key → ISO timestamp of last delivery. */
  notifications: Record<string, string>;
  /** A clamped anomalous sample awaiting next-day confirmation (§12 clamps). */
  pendingAnomaly?: MemberCountSample;
  /** ISO timestamp of the one-time new-guild onboarding message. */
  onboardedAt?: string;
}

const billingMetaSchema = z.object({
  samples: z.array(memberCountSampleSchema).catch([]),
  notifications: z.record(z.string()).catch({}),
  pendingAnomaly: memberCountSampleSchema.optional().catch(undefined),
  onboardedAt: z.string().optional().catch(undefined),
});

/** Reads the billing bookkeeping out of a guild's `metadata` jsonb. */
export function parseBillingMeta(metadata: Record<string, unknown>): BillingMeta {
  const raw = metadata['billing'];
  if (typeof raw !== 'object' || raw === null) return { samples: [], notifications: {} };
  const parsed = billingMetaSchema.safeParse(raw);
  if (!parsed.success) return { samples: [], notifications: {} };
  const meta = parsed.data;
  return {
    samples: meta.samples,
    notifications: meta.notifications,
    ...(meta.pendingAnomaly ? { pendingAnomaly: meta.pendingAnomaly } : {}),
    ...(meta.onboardedAt ? { onboardedAt: meta.onboardedAt } : {}),
  };
}

/** The UTC day key (`YYYY-MM-DD`) for a date. */
export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface SampleDecision {
  /** Record `count` as the day's sample? */
  accept: boolean;
  /** True when the value was held back by the anomaly clamps. */
  clamped: boolean;
  /** When clamped, the raw value to remember so a repeat can confirm it. */
  pendingAnomaly?: MemberCountSample;
}

/**
 * Anomaly clamps for a new member-count sample (monetization.md §12): a single
 * sample of ~0, or a >50% single-day swing, is never acted on alone. A clamped
 * value is remembered as `pendingAnomaly`; if the next (different-day) sample
 * agrees with it, the change is real and is accepted. Small absolute moves
 * (≤50 members) are always accepted — tiny guilds swing wildly in % terms.
 */
export function sanitizeMemberCountSample(
  previous: number | null,
  count: number,
  day: string,
  pendingAnomaly?: MemberCountSample,
): SampleDecision {
  if (previous === null || previous <= 0) return { accept: true, clamped: false };
  const delta = Math.abs(count - previous);
  if (delta <= 50) return { accept: true, clamped: false };
  const anomalous = count < previous * 0.5 || count > previous * 1.5;
  if (!anomalous) return { accept: true, clamped: false };
  // A previously-clamped value seen again on a later day confirms the change.
  if (pendingAnomaly && pendingAnomaly.day !== day && agrees(pendingAnomaly.count, count)) {
    return { accept: true, clamped: false };
  }
  return { accept: false, clamped: true, pendingAnomaly: { day, count } };
}

/** Whether two counts corroborate each other (within 25%, or both near zero). */
function agrees(a: number, b: number): boolean {
  if (a === 0 && b === 0) return true;
  const larger = Math.max(a, b);
  return larger > 0 && Math.abs(a - b) <= larger * 0.25;
}

/**
 * Whether a cached gateway count and an authoritative REST count disagree
 * enough to prefer the authoritative one and log a `member_count.discrepancy`
 * (§5 step 4). Threshold: `max(50 members, 5% of the cached count)` (§12).
 */
export function isCountDiscrepant(cached: number, authoritative: number): boolean {
  return Math.abs(cached - authoritative) > Math.max(50, cached * 0.05);
}
