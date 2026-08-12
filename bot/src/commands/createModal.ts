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
  privacy: 'open' | 'private';
  /** The chosen category id, if any (re-selected in the picker on retry). */
  parentId?: string;
}

const TEMPLATE_INPUT_MAX = 1000;
const DEFAULT_PRIMARY_NAME = '➕ New Session';

/**
 * Builds the `/create` setup modal using the newer Label-component modals, so
 * Category is a real category picker and Default privacy a dropdown (the
 * templates + name stay text inputs). A modal is capped at 5 components; position
 * is intentionally left out (new channels default to below the creator — editable
 * later with `/position`) so the 5th slot is the privacy selector. Field labels
 * point at `/template` / `/alwaysprivate` for editing later.
 *
 * Pass `prefill` to re-open the modal with a user's prior selections intact (used
 * by the "Retry" button after a failed create) instead of the guild defaults.
 */
export function buildCreateModal(defaults: CreateDefaults, prefill?: CreatePrefill): ModalBuilder {
  const name = prefill?.name ?? DEFAULT_PRIMARY_NAME;
  const nameTemplate = (prefill?.nameTemplate ?? defaults.nameTemplate).slice(
    0,
    TEMPLATE_INPUT_MAX,
  );
  const statusTemplate = (prefill?.statusTemplate ?? defaults.statusTemplate).slice(
    0,
    TEMPLATE_INPUT_MAX,
  );
  const privatePicked = prefill?.privacy === 'private';

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
    .setCustomId(CREATE_MODAL_ID)
    .setTitle('Create a creator channel')
    .addLabelComponents(
      new LabelBuilder().setLabel('Category').setChannelSelectMenuComponent(category),
      new LabelBuilder()
        .setLabel('Primary (creation) channel name')
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
      // The 5th (final) slot: whether new channels are public or private by
      // default. Editable per-creator later with `/alwaysprivate`.
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
                .setDefault(!privatePicked),
              new StringSelectMenuOptionBuilder()
                .setLabel('Private, others request to join')
                .setValue('private')
                .setDefault(privatePicked),
            ),
        ),
    );
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
    privacy: fields.getStringSelectValues('privacy')[0] === 'private' ? 'private' : 'open',
    ...(parentId ? { parentId } : {}),
  };
}

/**
 * Reads the submitted modal: text inputs via `getTextInputValue`, the category
 * via the channel select, and the public/private default via the `privacy`
 * select. Templates left at the guild default are dropped (so the primary
 * inherits rather than pins them). Position isn't collected here — new channels
 * default to below the creator (change later with `/position`).
 */
export function parseCreateModal(
  fields: ModalSubmitFields,
  defaults: CreateDefaults,
): CreatePrimaryOptions {
  const name = fields.getTextInputValue('name').trim();
  const nameTemplate = fields.getTextInputValue('nameTemplate').trim();
  const statusTemplate = fields.getTextInputValue('statusTemplate').trim();
  const privacy = fields.getStringSelectValues('privacy')[0] ?? 'open';
  const parentId = fields.getSelectedChannels('category', false)?.first()?.id;
  return {
    ...(parentId ? { parentId } : {}),
    ...(name ? { name } : {}),
    ...(nameTemplate && nameTemplate !== defaults.nameTemplate ? { nameTemplate } : {}),
    ...(statusTemplate && statusTemplate !== defaults.statusTemplate ? { statusTemplate } : {}),
    ...(privacy === 'private' ? { defaultPrivate: true } : {}),
  };
}
