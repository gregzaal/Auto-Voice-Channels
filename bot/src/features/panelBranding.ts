import type { APIEmbedField, EmbedFooterOptions } from 'discord.js';
import { SITE_URL, SUPPORT_URL } from './billing/messages.js';

/**
 * The two pieces of branding our panels carry, in one place.
 *
 * Shared rather than copied because both name things that change: an expired
 * support invite cannot be recreated, and the last one that lapsed was dead in
 * the panel, on all 15 pages of the website and in a cutover announcement that
 * had already gone out. `SUPPORT_URL` is imported for that reason and never
 * re-typed; this module is the second-order version of the same rule for the
 * rendered field and footer.
 *
 * **Which panels get it is a judgement, not a default.** The room control panel
 * and the two admin surfaces an admin actually sits in front of (`/setup` and
 * `/template`) carry it. Short-lived confirmations and refusals do not: a
 * "you need Manage Channels" reply with a review link under it is asking for a
 * favour at the exact moment we have just said no.
 */

/**
 * The logo, served from the site and verified live before it was put here.
 *
 * Footer icon only. A thumbnail carried the same mark a second time a few lines
 * above it, which is decoration rather than information.
 */
const LOGO_ICON_URL = `${SITE_URL}/logo-64.png`;

/**
 * The hosted listing, for the review link.
 *
 * The production application id, on every install including self-hosted ones,
 * which is the same call the footer makes: a self-hoster's panel says
 * `auto-voice.io` too, because the thing being pointed at is the project rather
 * than that person's instance.
 */
const TOPGG_REVIEWS_URL = 'https://top.gg/bot/479393422705426432#reviews';

/**
 * The last field on a panel that carries one.
 *
 * **The name is a zero-width space, not a literal one.** Discord trims an embed
 * field name and refuses the whole message when that leaves it empty, so a
 * single `' '` would 400 the panel rather than render a blank spacer. `U+200B`
 * survives the trim and renders blank, which is the spacing this is for.
 *
 * Never inline: it is a footnote to everything above it, not a peer of the
 * fields it follows, and an inline one would be pulled up beside them.
 */
export const PANEL_LINKS_FIELD: APIEmbedField = {
  name: '​',
  value:
    `Like this bot? [Review it on top.gg](${TOPGG_REVIEWS_URL})` +
    `  ·  Get help in the [support server](${SUPPORT_URL})`,
  inline: false,
};

/** The footer those same panels carry. */
export const PANEL_FOOTER: EmbedFooterOptions = {
  text: 'auto-voice.io  ·  Free and open source, dynamic voice channels.',
  iconURL: LOGO_ICON_URL,
};

/**
 * The footer with a transient confirmation in front of it.
 *
 * `/template` used the whole footer for "✅ Saved", so the two now share it
 * rather than one replacing the other: losing the branding on the one render an
 * admin is definitely looking at (the one right after they saved) would be the
 * wrong half to drop.
 */
export function panelFooterWith(prefix: string): EmbedFooterOptions {
  return { ...PANEL_FOOTER, text: `${prefix}  ·  ${PANEL_FOOTER.text}` };
}
