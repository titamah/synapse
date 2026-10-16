import {
  ChatInputCommandInteraction,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { IDS, followReminder } from './messages.js';
import { getEntrantByDiscord, isClosed, submitEntry } from './service.js';

const ephemeral = MessageFlags.Ephemeral;
const CLOSED = '⏰ Entries are closed. Thanks for playing!';
const CONTACT_ADMIN = "We couldn't save that username. Message an admin and we'll sort it out.";

/** Opens the entry form for `/giveaway enter`, pre-filled if they've already entered. */
export async function showEntryModal(interaction: ChatInputCommandInteraction) {
  if (isClosed()) {
    await interaction.reply({ content: CLOSED, flags: ephemeral });
    return;
  }
  const existing = await getEntrantByDiscord(interaction.user.id);

  const input = new TextInputBuilder()
    .setCustomId(IDS.igInput)
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('yourusername')
    .setMinLength(1)
    .setMaxLength(60)
    .setRequired(true);
  if (existing) input.setValue(existing.igUsername);

  const modal = new ModalBuilder()
    .setCustomId(IDS.enterModal)
    .setTitle(existing ? 'Update your Instagram username' : 'Enter the GTA VI Giveaway')
    .addLabelComponents(new LabelBuilder().setLabel('Instagram username').setTextInputComponent(input));

  await interaction.showModal(modal);
}

export async function handleGiveawayModal(interaction: ModalSubmitInteraction) {
  if (interaction.customId !== IDS.enterModal) return;
  await interaction.deferReply({ flags: ephemeral });

  const result = await submitEntry({
    discordId: interaction.user.id,
    discordUsername: interaction.user.username,
    rawIg: interaction.fields.getTextInputValue(IDS.igInput),
  });

  // Entrants only ever learn that their username was captured or updated.
  const reply = {
    closed: CLOSED,
    invalid:
      "❌ That doesn't look like an Instagram username. Use only letters, numbers, periods and underscores (up to 30 characters).",
    revoked: CONTACT_ADMIN,
    conflict: CONTACT_ADMIN,
    created: `✅ Username captured! ${followReminder}`,
    updated: `✅ Username updated! ${followReminder}`,
    unchanged: `✅ Username captured! ${followReminder}`,
  }[result.status];

  await interaction.editReply(reply);
}
