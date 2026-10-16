import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import type { Command } from '../types/discord.js';

export const PlayingCommand: Command = {
    data: new SlashCommandBuilder()
    .setName('playing')
    .setDescription('See who is playing right now.')
    .addStringOption(option =>
        option.setName('game')
            .setDescription('The title of the game')
            .setRequired(true)
    ),


    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();

        const guild = interaction.guild;
        if (!guild) {
            await interaction.editReply("This command only works in a server!");
            return;
        }

        const members = await guild.members.fetch();
        const gameMap = new Map<string, string[] >();
        
        members.forEach(member => {
            const presence = member.presence;
            if (!presence) return;

            presence.activities.forEach(activity => {
                if (activity.type === 0 && activity.name) {
                    const gameName = activity.name.toLowerCase();
                    
                    if (!gameMap.has(gameName)) {
                        gameMap.set(gameName, [member.displayName]);
                    } else {
                        gameMap.get(gameName)!.push(member.displayName);
                    }
                }
            });
        });

        const gameName = interaction.options.getString('game', true).toLowerCase();

        const players = gameMap.get(gameName);

        if (!players) {
            await interaction.editReply(`No one is playing ${gameName} right now!`);
            return;
        }

        await interaction.editReply(
            `${players.length} player${players.length === 1 ? '' : 's'} active: ${players.join(', ')}`
            );

    },
}