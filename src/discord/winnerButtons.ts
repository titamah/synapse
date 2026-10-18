import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, type ButtonInteraction } from 'discord.js';
import { db } from '../db/client.js';
import { isAdmin } from '../lib/permissions.js';
import { WINNER_BUTTON, confirmWinnerCheck, getWinner, notifyWinner, resolveWinner } from '../giveaway/winners.js';

const ephemeral = MessageFlags.Ephemeral;

/** All winner buttons: admin ones in #community-updates, and Accept/Decline in the winner's DM. */
export async function handleWinnerButton(interaction: ButtonInteraction) {
  const [, action, idText, ruleText] = interaction.customId.match(WINNER_BUTTON)!;
  const winnerId = Number(idText);
  const w = await getWinner(winnerId);
  if (!w) {
    await interaction.reply({ content: 'This winner no longer exists.', flags: ephemeral });
    return;
  }
  const by = `discord:${interaction.user.username}`;

  // ----- Admin buttons (#community-updates)
  if (action === 'check-yes' || action === 'check-no') {
    if (!isAdmin(interaction)) {
      await interaction.reply({ content: '🔒 Admins only.', flags: ephemeral });
      return;
    }
    await interaction.deferReply({ flags: ephemeral });
    const result = await confirmWinnerCheck(interaction.client, winnerId, Number(ruleText), action === 'check-yes', by);
    // Remove this check's buttons; others stay until confirmed.
    const remaining = interaction.message.components.filter(row => !JSON.stringify(row.toJSON()).includes(`:${winnerId}:${ruleText}"`));
    await interaction.message.edit({ components: action === 'check-no' ? [] : remaining }).catch(() => undefined);
    await interaction.editReply(result.ok ? (action === 'check-yes' ? '✅ Confirmed.' : '❌ Marked as not met. The winner is disqualified.') : `ℹ️ ${result.error}`);
    return;
  }

  if (action === 'notify' || action === 'mark-accepted' || action === 'mark-declined') {
    if (!isAdmin(interaction)) {
      await interaction.reply({ content: '🔒 Admins only.', flags: ephemeral });
      return;
    }
    await interaction.deferReply({ flags: ephemeral });
    const result =
      action === 'notify'
        ? await notifyWinner(interaction.client, winnerId, by)
        : await resolveWinner(interaction.client, winnerId, action === 'mark-accepted' ? 'accepted' : 'declined', by);
    // Buttons on this post are done either way.
    await interaction.message.edit({ components: [] }).catch(() => undefined);
    await interaction.editReply(result.ok ? '✅ Done.' : `ℹ️ ${result.error}`);
    return;
  }

  // ----- Winner buttons (their DM)
  const entrant = await db.query.entrants.findFirst({ where: (e, { eq }) => eq(e.id, w.entrantId!) });
  if (entrant?.discordId !== interaction.user.id) {
    await interaction.reply({ content: "This prize isn't yours to claim.", flags: ephemeral });
    return;
  }

  if (w.status !== 'notified' || (w.claimDeadline && w.claimDeadline < new Date())) {
    const message = w.status === 'accepted' ? "You've already accepted. 🎉" : 'This prize can no longer be claimed.';
    await interaction.reply({ content: message, flags: ephemeral });
    return;
  }

  if (action === 'decline') {
    await interaction.reply({
      content: 'Are you sure you want to decline? This gives the prize to someone else.',
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`winner:decline-confirm:${w.id}`).setLabel('Yes, decline').setStyle(ButtonStyle.Danger),
        ),
      ],
      flags: ephemeral,
    });
    return;
  }

  const outcome = action === 'accept' ? 'accepted' : 'declined';
  const result = await resolveWinner(interaction.client, winnerId, outcome, by);
  if (!result.ok) {
    await interaction.reply({ content: result.error, flags: ephemeral });
    return;
  }
  const text = outcome === 'accepted' ? "🎉 You're confirmed! We'll reach out soon to get your prize to you." : 'Got it, you declined the prize. Thanks for playing!';
  if (action === 'accept') {
    await interaction.update({ embeds: [...interaction.message.embeds.map(e => EmbedBuilder.from(e)), new EmbedBuilder().setDescription(text)], components: [] });
  } else {
    await interaction.update({ content: text, components: [] });
  }
}
