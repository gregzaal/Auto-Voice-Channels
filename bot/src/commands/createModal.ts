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
 * Category is a real category picker and Position a dropdown (the templates +
 * name stay text inputs). Field labels point at `/template` / `/toggleposition`
 * for editing later.
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
      // A modal allows at most 5 top-level components, and the four above fill
      // four slots — so position and privacy share this one multi-select rather
      // than each taking a slot. Nothing selected = the defaults (below, public);
      // both are still editable later via `/position` and `/alwaysprivate`.
      new LabelBuilder()
        .setLabel('Options (/position, /alwaysprivate later)')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId('options')
            // min 0 needs required=false (a modal select defaults to required).
            .setRequired(false)
            .setMinValues(0)
            .setMaxValues(2)
            .setPlaceholder('Defaults: below the creator, public')
            .addOptions(
              new StringSelectMenuOptionBuilder()
                .setLabel('Position new channels above the creator')
                .setDescription('Default is below the creator channel.')
                .setValue('above'),
              new StringSelectMenuOptionBuilder()
                .setLabel('Make new channels private')
                .setDescription('Locked to @everyone; others request to join.')
                .setValue('private'),
            ),
        ),
    );
}

/** What the `/create` modal collected — ready to pass to `createPrimary`. */
export interface ParsedCreate extends CreatePrimaryOptions {
  /** Always set by {@link parseCreateModal} (defaults to below). */
  above: boolean;
}

/**
 * Reads the submitted modal: text inputs via `getTextInputValue`, the category
 * via the channel select, and the position/privacy toggles via the combined
 * `options` multi-select. Templates left at the guild default are dropped (so the
 * primary inherits rather than pins them).
 */
export function parseCreateModal(
  fields: ModalSubmitFields,
  defaults: CreateDefaults,
): ParsedCreate {
  const name = fields.getTextInputValue('name').trim();
  const nameTemplate = fields.getTextInputValue('nameTemplate').trim();
  const statusTemplate = fields.getTextInputValue('statusTemplate').trim();
  const options = fields.getStringSelectValues('options');
  const parentId = fields.getSelectedChannels('category', false)?.first()?.id;
  return {
    ...(parentId ? { parentId } : {}),
    ...(name ? { name } : {}),
    ...(nameTemplate && nameTemplate !== defaults.nameTemplate ? { nameTemplate } : {}),
    ...(statusTemplate && statusTemplate !== defaults.statusTemplate ? { statusTemplate } : {}),
    ...(options.includes('private') ? { defaultPrivate: true } : {}),
    above: options.includes('above'),
  };
}
