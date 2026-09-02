/**
 * Hosted fleets (`plans/fleets.md`).
 *
 * Three live bots share one database: production, an opt-in beta that is
 * deliberately indistinguishable from production to the people using it, and
 * gold, which carries the legacy patron bot's own application id
 * (`plans/migration.md` 7).
 *
 * The split follows one rule: **anything about the customer is shared, anything
 * about the bot's own operation is per fleet.** So entitlement, subscriptions,
 * billing and guild settings live on shared rows and are identical whichever bot
 * a guild is running; shard leases, identify buckets, runtime flags and the
 * channels a bot manages are scoped by fleet.
 *
 * Self-host is always `prod`, is the only fleet in its own database, and never
 * notices any of this.
 */
/**
 * **Append only, never insert or reorder.** {@link fleetOrdinal} is the array
 * index and is packed into advisory-lock keys that are already live, so moving
 * an existing entry repoints a running fleet's locks at another fleet's
 * namespace.
 */
export const FLEETS = ['prod', 'beta', 'gold'] as const;

export type Fleet = (typeof FLEETS)[number];

/** The default for self-host and for any row written before fleets existed. */
export const DEFAULT_FLEET: Fleet = 'prod';

/**
 * Stable small integer per fleet, for packing into advisory-lock keys.
 *
 * Derived from the position in {@link FLEETS}, so **never reorder that array** —
 * a fleet's ordinal is baked into live lock keys, and changing it would let two
 * fleets collide on a lock that is meant to serialize exactly one of them.
 */
export function fleetOrdinal(fleet: Fleet): number {
  return FLEETS.indexOf(fleet);
}

/**
 * Namespaces an advisory-lock key by fleet.
 *
 * Advisory locks are scoped by database and by nothing else — the key is a bare
 * integer, so two fleets sharing a database would contend on the same lock
 * whatever tables they touch. That is correct for work on shared rows and wrong
 * for per-fleet work: beta must not block prod from claiming a shard, and
 * Discord's `max_concurrency` is per application, so a shared identify throttler
 * would compute wrong spacing for both.
 *
 * Uses the single 64-bit `pg_advisory_*(bigint)` form rather than the two-int
 * form, because the two-int form's second slot is already spent on the identify
 * bucket. Layout: `<base:32><fleet:16><slot:16>`.
 *
 * @param base  the lock's own namespace (e.g. `IDENTIFY_ADVISORY_LOCK`)
 * @param fleet which fleet is asking
 * @param slot  the sub-key within that namespace (e.g. an identify bucket)
 */
export function fleetAdvisoryKey(base: number, fleet: Fleet, slot = 0): bigint {
  if (!Number.isInteger(slot) || slot < 0 || slot > 0xffff) {
    throw new RangeError(`advisory slot out of range: ${slot}`);
  }
  return (BigInt(base) << 32n) | (BigInt(fleetOrdinal(fleet)) << 16n) | BigInt(slot);
}
