import { ChatInputCommandInteraction, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../types/discord.js';
import { postTimer } from '../giveaway/announcements.js';
import { getOpenGiveaway } from '../giveaway/service.js';

/** Admin-only tools. Hidden from members (Manage Server), and the bot checks the admin role too. */
export const AdminCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Admin tools')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommandGroup(group =>
      group
        .setName('giveaway')
        .setDescription('Giveaway tools')
        .addSubcommand(sc => sc.setName('timer').setDescription('Post a live countdown for the open giveaway in #community-updates.')),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const ephemeral = MessageFlags.Ephemeral;
    const group = interaction.options.getSubcommandGroup();
    const sub = interaction.options.getSubcommand();

    if (group === 'giveaway' && sub === 'timer') {
      const g = await getOpenGiveaway();
      if (!g) {
        await interaction.reply({ content: 'No giveaway is open right now.', flags: ephemeral });
        return;
      }
      await interaction.deferReply({ flags: ephemeral });
      const posted = await postTimer(interaction.client, g);
      await interaction.editReply(`Posted in <#${posted.channelId}>. Right-click it → Apps → **Post to giveaway channel** to share it.`);
    }
  },
};
