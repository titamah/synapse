import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  type MessageContextMenuCommandInteraction,
} from 'discord.js';
import { GIVEAWAY_FOOTER } from '../giveaway/embeds.js';
import { discordChannel, getGiveaway } from '../giveaway/service.js';
import { isAdmin } from '../lib/permissions.js';
import { channelName, textChannelByName } from './channels.js';

export const POST_TO_CHANNEL = 'Post to giveaway channel';

/** Right-click a bot update → Apps → "Post to giveaway channel": reposts it publicly, without admin buttons. */
export const postToChannelCommand = new ContextMenuCommandBuilder()
  .setName(POST_TO_CHANNEL)
  .setType(ApplicationCommandType.Message)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function handlePostToChannel(interaction: MessageContextMenuCommandInteraction) {
  const ephemeral = MessageFlags.Ephemeral;
  if (!isAdmin(interaction)) {
    await interaction.reply({ content: '🔒 Admins only.', flags: ephemeral });
    return;
  }
  const message = interaction.targetMessage;
  const id = message.author.id === interaction.client.user.id ? message.embeds[0]?.footer?.text.match(GIVEAWAY_FOOTER)?.[1] : undefined;
  if (!id) {
    await interaction.reply({ content: 'Use this on a giveaway update posted by BB-Bot.', flags: ephemeral });
    return;
  }
  const g = await getGiveaway(Number(id));
  const entryChannel = g ? discordChannel(g) : null;
  if (!entryChannel) {
    await interaction.reply({ content: "This giveaway doesn't have an entry channel set.", flags: ephemeral });
    return;
  }
  const channel = await textChannelByName(interaction.client, entryChannel);
  if (!channel) {
    await interaction.reply({ content: `Couldn't find #${channelName(entryChannel)}.`, flags: ephemeral });
    return;
  }
  const posted = await channel.send({ embeds: message.embeds.map(e => EmbedBuilder.from(e)) });
  await interaction.reply({ content: `Posted in ${channel}: ${posted.url}`, flags: ephemeral });
}
