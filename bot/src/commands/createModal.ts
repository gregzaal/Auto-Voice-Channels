import {
  ChannelSelectMenuBuilder,
  ChannelType,
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitFields,
} from 'discord.js';
import type { CreatePrimaryOptions } from '../features/voice/index.js';

/** Custom id of the `/create` setup modal, the "Create another" + "Retry" buttons. */
export const CREATE_MODAL_ID = 'avc:create:submit';
/**
 * The same modal, opened from the `/setup` panel's own button.
 *
 * The id carries the origin because `isFromMessage()` cannot: "Create another"
 * and "Retry" are buttons on their own result messages, so all three paths look
 * message-borne and only this one has a panel behind it to refresh.
 *
 * Deliberately NOT on `allowedWhileExpired`'s modal whitelist. It creates a
 * channel, so it is a write path exactly like {@link CREATE_MODAL_ID}.
 */
export const CREATE_FROM_SETUP_MODAL_ID = 'avc:create:submit:setup';
export const CREATE_AGAIN_ID = 'avc:create:again';
/** Prefix for the "Retry" button; `:<token>` keys the saved selections to re-prefill. */
export const CREATE_RETRY_PREFIX = 'avc:create:retry:';

/** The guild's effective default templates, used to prefill the modal. */
export interface CreateDefaults {
  nameTemplate: string;
  statusTemplate: string;
}

/**
 * The raw selections a user made in the modal, captured so a failed `/create`
 * (e.g. no permission in the chosen category) can re-open the modal with their
 * choices intact instead of making them start over.
 */
export interface CreatePrefill {
  name: string;
  nameTemplate: string;
  statusTemplate: string;
  privacy: 'open' | 'private' | 'hidden';
  /** The chosen category id, if any (re-selected in the picker on retry). */
  parentId?: string;
}

const TEMPLATE_INPUT_MAX = 1000;
const DEFAULT_PRIMARY_NAME = '➕ New Session';

/**
 * Builds the `/create` setup modal using the newer Label-component modals, so
 * Category is a real category picker and Default privacy a dropdown (the
 * templates + name stay text inputs). A modal is capped at 5 components; position
 * is intentionally left out (new rooms default to below the creator channel — editable
 * later with `/position`) so the 5th slot is the privacy selector. Field labels
 * point at `/template` / `/alwaysprivate` for editing later.
 *
 * Pass `prefill` to re-open the modal with a user's prior selections intact (used
 * by the "Retry" button after a failed create) instead of the guild defaults.
 */
export function buildCreateModal(
  defaults: CreateDefaults,
  prefill?: CreatePrefill,
  customId: string = CREATE_MODAL_ID,
): ModalBuilder {
  const name = prefill?.name ?? DEFAULT_PRIMARY_NAME;
  const nameTemplate = (prefill?.nameTemplate ?? defaults.nameTemplate).slice(
    0,
    TEMPLATE_INPUT_MAX,
  );
  const statusTemplate = (prefill?.statusTemplate ?? defaults.statusTemplate).slice(
    0,
    TEMPLATE_INPUT_MAX,
  );
  const privacyPicked = prefill?.privacy ?? 'open';

  const category = new ChannelSelectMenuBuilder()
    .setCustomId('category')
    .setChannelTypes(ChannelType.GuildCategory)
    // Optional: a modal select needs required=false to allow min_values 0.
    .setRequired(false)
    .setMinValues(0)
    .setMaxValues(1)
    .setPlaceholder('Pick a category (optional)');
  // Re-select the category they chose, so a retry defaults to the same one.
  if (prefill?.parentId) category.setDefaultChannels(prefill.parentId);

  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Create a creator channel')
    .addLabelComponents(
      new LabelBuilder().setLabel('Category').setChannelSelectMenuComponent(category),
      new LabelBuilder()
        .setLabel('Creator channel name')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('name')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(100)
            .setValue(name),
        ),
      new LabelBuilder()
        .setLabel('Name template (/template to edit later)')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('nameTemplate')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(TEMPLATE_INPUT_MAX)
            .setValue(nameTemplate),
        ),
      new LabelBuilder()
        .setLabel('Status template (/template to edit later)')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('statusTemplate')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(TEMPLATE_INPUT_MAX)
            .setValue(statusTemplate),
        ),
      // The 5th (final) slot: whether new rooms are public, private or hidden by
      // default. Editable per creator channel later with `/alwaysprivate` and
      // `/alwayshidden`.
      new LabelBuilder()
        .setLabel('Default privacy (/alwaysprivate later)')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId('privacy')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(
              new StringSelectMenuOptionBuilder()
                .setLabel('Open, anyone can join')
                .setValue('open')
                .setDefault(privacyPicked === 'open'),
              new StringSelectMenuOptionBuilder()
                .setLabel('Private, others request to join')
                .setValue('private')
                .setDefault(privacyPicked === 'private'),
              new StringSelectMenuOptionBuilder()
                .setLabel('Hidden, not in the channel list')
                .setValue('hidden')
                .setDefault(privacyPicked === 'hidden'),
            ),
        ),
    );
}

/** The modal's privacy choice, with anything unrecognised (a stale client) read as open. */
function privacyOf(value: string | undefined): CreatePrefill['privacy'] {
  return value === 'private' || value === 'hidden' ? value : 'open';
}

/**
 * Reads the modal's raw selections (verbatim text + the chosen category/privacy),
 * for stashing so a failed create can be retried with the same inputs. Unlike
 * {@link parseCreateModal} this keeps every value as-entered (no default-dropping)
 * so the re-opened modal looks exactly as the user left it.
 */
export function readCreateModalRaw(fields: ModalSubmitFields): CreatePrefill {
  const parentId = fields.getSelectedChannels('category', false)?.first()?.id;
  return {
    name: fields.getTextInputValue('name'),
    nameTemplate: fields.getTextInputValue('nameTemplate'),
    statusTemplate: fields.getTextInputValue('statusTemplate'),
    privacy: privacyOf(fields.getStringSelectValues('privacy')[0]),
    ...(parentId ? { parentId } : {}),
  };
}

/**
 * Reads the submitted modal: text inputs via `getTextInputValue`, the category
 * via the channel select, and the public/private default via the `privacy`
 * select. Templates left at the guild default are dropped (so the primary
 * inherits rather than pins them). Position isn't collected here — new rooms
 * default to below the creator channel (change later with `/position`).
 */
export function parseCreateModal(
  fields: ModalSubmitFields,
  defaults: CreateDefaults,
): CreatePrimaryOptions {
  const name = fields.getTextInputValue('name').trim();
  const nameTemplate = fields.getTextInputValue('nameTemplate').trim();
  const statusTemplate = fields.getTextInputValue('statusTemplate').trim();
  const privacy = privacyOf(fields.getStringSelectValues('privacy')[0]);
  const parentId = fields.getSelectedChannels('category', false)?.first()?.id;
  return {
    ...(parentId ? { parentId } : {}),
    ...(name ? { name } : {}),
    ...(nameTemplate && nameTemplate !== defaults.nameTemplate ? { nameTemplate } : {}),
    ...(statusTemplate && statusTemplate !== defaults.statusTemplate ? { statusTemplate } : {}),
    // Hidden is a kind of private, so it stores both: an instance that predates hiding
    // still starts the room locked rather than public.
    ...(privacy === 'private' || privacy === 'hidden' ? { defaultPrivate: true } : {}),
    ...(privacy === 'hidden' ? { defaultHidden: true } : {}),
  };
}
