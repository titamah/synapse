import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../types/discord.js';
import { showEntryModal } from '../giveaway/interactions.js';

/** The only command everyone can use. */
export const GiveawayCommand: Command = {
  public: true,
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('GTA VI giveaway')
    .addSubcommand(sc => sc.setName('enter').setDescription('Enter, or update your Instagram username.')),

  async execute(interaction: ChatInputCommandInteraction) {
    await showEntryModal(interaction);
  },
};
