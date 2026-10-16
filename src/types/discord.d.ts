import 'discord.js';
import { Collection, SlashCommandBuilder, ChatInputCommandInteraction, RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';

declare module 'discord.js' {
  interface Client {
    commands: Collection<string, Command>;
  }
}

export type Command = {
    data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder;
    execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
};

export type CommandBody = RESTPostAPIChatInputApplicationCommandsJSONBody;