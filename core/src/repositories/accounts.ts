import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { accounts } from '../db/schema.js';

/**
 * The Discord snowflake behind an Auth.js user id, via `accounts`.
 *
 * NOT the reverse of `subscriptions.purchaser_user_id`'s trap — this IS the
 * lookup that trap exists to distinguish from a raw `users.id` comparison.
 * Shared between web (`lib/discord.ts` has its own copy for the same query)
 * and the bot, which needs it to DM a pool's purchaser directly rather than
 * through any one guild (`plans/member-based-pricing.md` §6.6).
 */
export async function resolveDiscordUserId(
  db: Database,
  authUserId: string,
): Promise<string | null> {
  const [account] = await db
    .select({ providerAccountId: accounts.providerAccountId })
    .from(accounts)
    .where(and(eq(accounts.userId, authUserId), eq(accounts.provider, 'discord')))
    .limit(1);
  return account?.providerAccountId ?? null;
}
