import {
  ChatInputCommandInteraction,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { FormField } from '../db/schema.js';
import { channelName } from '../discord/channels.js';
import { enterChannels, getEntrantByDiscord, getGiveaway, getOpenGiveaway, isInstagramField, submitEntry, type Entrant, type EntryResult, type Giveaway } from './service.js';
import { announceConflict } from './announcements.js';

const ephemeral = MessageFlags.Ephemeral;
const MODAL_PREFIX = 'giveaway:enter:';
const NOT_OPEN = "There's no giveaway open right now. Keep an eye out for the next one!";
const CONTACT_ADMIN = "We couldn't save your entry. Message an admin and we'll sort it out.";

function currentValue(field: FormField, entrant: Entrant | undefined) {
  if (!entrant) return undefined;
  return isInstagramField(field) ? (entrant.igUsername ?? undefined) : entrant.answers[field.id];
}

/** One form field as a labeled Discord component, pre-filled with the person's last answer. */
function buildField(field: FormField, entrant: Entrant | undefined) {
  const label = new LabelBuilder().setLabel(field.label.slice(0, 45));
  const value = currentValue(field, entrant);

  if (field.type === 'select' && field.options?.length) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(field.id)
      .setRequired(field.required)
      .setMinValues(field.required ? 1 : 0)
      .setMaxValues(1)
      .addOptions(field.options.slice(0, 25).map(o => ({ label: o.slice(0, 100), value: o.slice(0, 100), default: o === value })));
    if (field.placeholder) select.setPlaceholder(field.placeholder);
    return label.setStringSelectMenuComponent(select);
  }

  const input = new TextInputBuilder()
    .setCustomId(field.id)
    .setStyle(field.type === 'long_text' ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(field.required)
    .setMaxLength(isInstagramField(field) ? 60 : field.type === 'long_text' ? 1000 : 200);
  if (field.placeholder) input.setPlaceholder(field.placeholder);
  if (value) input.setValue(value);
  return label.setTextInputComponent(input);
}

/** Opens the open giveaway's entry form for `/giveaway enter`, pre-filled if they've already entered. */
export async function showEntryModal(interaction: ChatInputCommandInteraction) {
  const g = await getOpenGiveaway();
  if (!g) {
    await interaction.reply({ content: NOT_OPEN, flags: ephemeral });
    return;
  }

  const here = interaction.channel && 'name' in interaction.channel ? interaction.channel.name : null;
  const wanted = enterChannels(g).map(channelName);
  if (!here || !wanted.includes(here)) {
    const mention = (name: string) => {
      const target = interaction.guild?.channels.cache.find(c => c.name === name);
      return target ? `<#${target.id}>` : `#${name}`;
    };
    await interaction.reply({ content: `Head over to ${wanted.map(mention).join(' or ')} to enter!`, flags: ephemeral });
    return;
  }

  // No questions to ask (e.g. a Discord-only giveaway): enter right away, no form.
  if (!g.formFields.length) {
    await interaction.deferReply({ flags: ephemeral });
    const result = await submitEntry({ giveaway: g, discordId: interaction.user.id, discordUsername: interaction.user.username, channel: here, values: {} });
    await interaction.editReply(entryReply(g, result));
    return;
  }

  const existing = await getEntrantByDiscord(g.id, interaction.user.id);
  const title = `${existing ? 'Update' : 'Enter'}: ${g.name ?? 'Giveaway'}`;
  const modal = new ModalBuilder()
    .setCustomId(`${MODAL_PREFIX}${g.id}`)
    .setTitle(title.slice(0, 45))
    .addLabelComponents(...g.formFields.slice(0, 5).map(f => buildField(f, existing)));

  await interaction.showModal(modal);
}

export async function handleGiveawayModal(interaction: ModalSubmitInteraction) {
  if (!interaction.customId.startsWith(MODAL_PREFIX)) return;
  await interaction.deferReply({ flags: ephemeral });

  const g = await getGiveaway(Number(interaction.customId.slice(MODAL_PREFIX.length)));
  if (!g) {
    await interaction.editReply(NOT_OPEN);
    return;
  }

  const values: Record<string, string> = {};
  for (const field of g.formFields) {
    try {
      values[field.id] =
        field.type === 'select'
          ? (interaction.fields.getStringSelectValues(field.id)[0] ?? '')
          : interaction.fields.getTextInputValue(field.id);
    } catch {
      values[field.id] = '';
    }
  }

  // The form opens only in an entry channel, so it's submitted from one.
  const here = interaction.channel && 'name' in interaction.channel ? interaction.channel.name : null;
  const channel = here && enterChannels(g).includes(here) ? here : enterChannels(g)[0];
  if (!channel) {
    await interaction.editReply(NOT_OPEN);
    return;
  }
  const result = await submitEntry({
    giveaway: g,
    discordId: interaction.user.id,
    discordUsername: interaction.user.username,
    channel,
    values,
  });
  if (result.status === 'conflict' && result.igUsername) {
    void announceConflict(interaction.client, g, { igUsername: result.igUsername, claimedBy: result.claimedBy, attemptedBy: interaction.user.id }).catch(err =>
      console.error('Conflict alert failed:', err),
    );
  }

  await interaction.editReply(entryReply(g, result));
}

/** Entrants only ever learn that their entry was captured or updated. */
function entryReply(g: Giveaway, result: EntryResult): string {
  const reminder = g.reminderText ? `\n${g.reminderText}` : '';
  switch (result.status) {
    case 'created':
    case 'unchanged':
      return `✅ Entry captured!${reminder}`;
    case 'updated':
      return `✅ Entry updated!${reminder}`;
    case 'invalid':
      return isInstagramField(result.field)
        ? "❌ That doesn't look like an Instagram username. Use only letters, numbers, periods and underscores (up to 30 characters)."
        : `❌ Please check "${result.field.label}" and try again.`;
    case 'closed':
    case 'full':
      return '⏰ This giveaway is closed. Thanks for playing!';
    case 'revoked':
    case 'conflict':
      return CONTACT_ADMIN;
  }
}
