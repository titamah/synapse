import { ChannelType, type Client, type TextChannel } from 'discord.js';
import { env } from '../config/environment.js';

/** All bot updates go here first (admin-only channel). */
export const ADMIN_CHANNEL_NAME = 'community-updates';

/** "#GTA-Giveaway " → "gta-giveaway": how Discord stores channel names. */
export function channelName(raw: string): string {
  return raw.trim().replace(/^#+/, '').trim().toLowerCase();
}

export async function textChannelByName(client: Client, name: string): Promise<TextChannel | null> {
  const guild = await client.guilds.fetch(env.SERVER_ID);
  const channels = await guild.channels.fetch();
  const wanted = channelName(name);
  const channel = channels.find(c => c?.type === ChannelType.GuildText && c.name === wanted);
  return (channel as TextChannel | undefined) ?? null;
}

export function adminChannel(client: Client) {
  return textChannelByName(client, ADMIN_CHANNEL_NAME);
}
