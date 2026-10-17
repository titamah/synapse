import type { Client } from 'discord.js';
import { env } from '../config/environment.js';

// Server members, cached briefly so tables, exports and draws don't refetch on every call.
let cache: { at: number; ids: Set<string> } | undefined;

/** Discord IDs of everyone currently in the server, or null if the bot isn't connected. */
export async function serverMemberIds(client?: Client): Promise<Set<string> | null> {
  if (!client?.isReady()) return null;
  if (cache && Date.now() - cache.at < 60_000) return cache.ids;
  const guild = await client.guilds.fetch(env.SERVER_ID);
  const members = await guild.members.fetch();
  cache = { at: Date.now(), ids: new Set(members.keys()) };
  return cache.ids;
}
