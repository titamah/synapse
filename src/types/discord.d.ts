import 'discord.js';
import type {
  ChatInputCommandInteraction,
  Collection,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';

declare module 'discord.js' {
  interface Client {
    commands: Collection<string, Command>;
  }
}

export type Command = {
  /** Everyone can use it. Without this, the command is admin-only. */
  public?: boolean;
  data: { name: string; toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
};

export type CommandBody = RESTPostAPIChatInputApplicationCommandsJSONBody;
