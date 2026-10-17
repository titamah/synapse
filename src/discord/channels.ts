import { ChannelType, type Client, type TextChannel } from 'discord.js';
import { env } from '../config/environment.js';

/** All bot updates go here first (admin-only channel). */
export const ADMIN_CHANNEL_NAME = 'community-updates';

export async function textChannelByName(client: Client, name: string): Promise<TextChannel | null> {
  const guild = await client.guilds.fetch(env.SERVER_ID);
  const channels = await guild.channels.fetch();
  const channel = channels.find(c => c?.type === ChannelType.GuildText && c.name === name);
  return (channel as TextChannel | undefined) ?? null;
}

export function adminChannel(client: Client) {
  return textChannelByName(client, ADMIN_CHANNEL_NAME);
}
