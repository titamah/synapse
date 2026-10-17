import {
  ButtonInteraction,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { announceExtended } from '../giveaway/announcements.js';
import { EXTEND_BUTTON_PREFIX } from '../giveaway/embeds.js';
import { extendGiveaway, getGiveaway } from '../giveaway/service.js';
import { isAdmin } from '../lib/permissions.js';

const MODAL_PREFIX = 'admin:extend-modal:';
const ephemeral = MessageFlags.Ephemeral;

/** [Extend] on an update in #community-updates: opens a small form (admins only). */
export async function handleExtendButton(interaction: ButtonInteraction) {
  if (!isAdmin(interaction)) {
    await interaction.reply({ content: '🔒 Admins only.', flags: ephemeral });
    return;
  }
  const g = await getGiveaway(Number(interaction.customId.slice(EXTEND_BUTTON_PREFIX.length)));
  if (!g) {
    await interaction.reply({ content: 'That giveaway no longer exists.', flags: ephemeral });
    return;
  }

  const hours = new TextInputBuilder().setCustomId('hours').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('e.g. 24').setMaxLength(5);
  const modal = new ModalBuilder()
    .setCustomId(`${MODAL_PREFIX}${g.id}`)
    .setTitle(`Extend: ${g.name ?? 'Giveaway'}`.slice(0, 45))
    .addLabelComponents(new LabelBuilder().setLabel('Add hours').setTextInputComponent(hours));
  if (g.maxParticipants) {
    const spots = new TextInputBuilder().setCustomId('spots').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('e.g. 50').setMaxLength(5);
    modal.addLabelComponents(new LabelBuilder().setLabel(`Add spots (cap is ${g.maxParticipants})`).setTextInputComponent(spots));
  }
  await interaction.showModal(modal);
}

export async function handleExtendModal(interaction: ModalSubmitInteraction) {
  if (!isAdmin(interaction)) {
    await interaction.reply({ content: '🔒 Admins only.', flags: ephemeral });
    return;
  }
  await interaction.deferReply({ flags: ephemeral });
  const g = await getGiveaway(Number(interaction.customId.slice(MODAL_PREFIX.length)));
  if (!g) {
    await interaction.editReply('That giveaway no longer exists.');
    return;
  }

  const read = (id: string) => {
    try {
      const raw = interaction.fields.getTextInputValue(id).trim();
      return raw ? Number(raw) : undefined;
    } catch {
      return undefined;
    }
  };
  const hours = read('hours');
  const spots = read('spots');
  if ((hours !== undefined && !(hours > 0 && hours <= 2000)) || (spots !== undefined && !(Number.isInteger(spots) && spots > 0))) {
    await interaction.editReply('Use positive numbers: hours (up to 2000) and/or whole spots.');
    return;
  }

  const result = await extendGiveaway(g, { ...(hours ? { hours } : {}), ...(spots ? { spots } : {}) }, `discord:${interaction.user.username}`);
  if (!result.ok) {
    await interaction.editReply(`❌ ${result.error}`);
    return;
  }
  await announceExtended(interaction.client, result.giveaway, result.change);
  const parts = [
    result.change.endsAt && `now ends <t:${Math.floor(result.change.endsAt.getTime() / 1000)}:F>`,
    result.change.maxParticipants && `cap is now ${result.change.maxParticipants}`,
  ].filter(Boolean);
  await interaction.editReply(`✅ Extended: ${parts.join(', ')}.`);
}

export const isExtendModal = (customId: string) => customId.startsWith(MODAL_PREFIX);
