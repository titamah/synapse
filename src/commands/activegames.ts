import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import type { Command } from '../types/discord.js';

export const ActiveGamesCommand: Command = {
    data: new SlashCommandBuilder()
    .setName('activegames')
    .setDescription('See the top games other blerds in the server are playing.'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();

        const guild = interaction.guild;
        if (!guild) {
            await interaction.editReply("This command only works in a server!");
            return;
        }

        const members = await guild.members.fetch();
        const gameCount = new Map<string, number>();
        
        members.forEach(member => {
            const presence = member.presence;
            if (!presence) return;

            presence.activities.forEach(activity => {
                if (activity.type === 0 && activity.name) {
                    gameCount.set(activity.name, (gameCount.get(activity.name) || 0) + 1);
                }
            });
        });

        const sortedGames = Array.from(gameCount.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10); // Top 10

        if (sortedGames.length === 0) {
            await interaction.editReply("No one is playing anything right now! 😴");
            return;
        }

        const gameList = sortedGames
            .map(([game, count], i) => `${i + 1}. **${game}** - ${count} player${count > 1 ? 's' : ''}`)
            .join('\n');

        
        await interaction.editReply(`🎮 **Top Games Right Now:**\n\n${gameList}`);

    },
}