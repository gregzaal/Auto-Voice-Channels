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

/** Custom id of the `/create` setup modal, and the "Create another" button. */
export const CREATE_MODAL_ID = 'avc:create:submit';
export const CREATE_AGAIN_ID = 'avc:create:again';

/** The guild's effective default templates, used to prefill the modal. */
export interface CreateDefaults {
  nameTemplate: string;
  statusTemplate: string;
}

const TEMPLATE_INPUT_MAX = 1000;

/**
 * Builds the `/create` setup modal using the newer Label-component modals, so
 * Category is a real category picker and Default privacy a dropdown (the
 * templates + name stay text inputs). A modal is capped at 5 components; position
 * is intentionally left out (new channels default to below the creator — editable
 * later with `/position`) so the 5th slot is the privacy selector. Field labels
 * point at `/template` / `/alwaysprivate` for editing later.
 */
export function buildCreateModal(defaults: CreateDefaults): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(CREATE_MODAL_ID)
    .setTitle('Create a creator channel')
    .addLabelComponents(
      new LabelBuilder().setLabel('Category').setChannelSelectMenuComponent(
        new ChannelSelectMenuBuilder()
          .setCustomId('category')
          .setChannelTypes(ChannelType.GuildCategory)
          // Optional: a modal select needs required=false to allow min_values 0.
          .setRequired(false)
          .setMinValues(0)
          .setMaxValues(1)
          .setPlaceholder('Pick a category (optional)'),
      ),
      new LabelBuilder()
        .setLabel('Primary (creation) channel name')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('name')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(100)
            .setValue('➕ New Session'),
        ),
      new LabelBuilder()
        .setLabel('Name template (/template to edit later)')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('nameTemplate')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(TEMPLATE_INPUT_MAX)
            .setValue(defaults.nameTemplate.slice(0, TEMPLATE_INPUT_MAX)),
        ),
      new LabelBuilder()
        .setLabel('Status template (/template to edit later)')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('statusTemplate')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(TEMPLATE_INPUT_MAX)
            .setValue(defaults.statusTemplate.slice(0, TEMPLATE_INPUT_MAX)),
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
                .setLabel('Open — anyone can join')
                .setValue('open')
                .setDefault(true),
              new StringSelectMenuOptionBuilder()
                .setLabel('Private — locked; others request to join')
                .setValue('private'),
            ),
        ),
    );
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
