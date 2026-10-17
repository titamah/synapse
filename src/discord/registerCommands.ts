import { REST, Routes, type Client } from 'discord.js';
import { env } from '../config/environment.js';
import { getOpenGiveaway } from '../giveaway/service.js';
import { postToChannelCommand } from './postToChannel.js';

/** Commands that only exist while a giveaway is open, so members never see a dead command. */
const GIVEAWAY_ONLY = new Set(['giveaway']);

let registeredWithGiveaway: boolean | undefined;

/**
 * Keeps the server's commands in sync with the code. `/giveaway` is included only while a
 * giveaway is open. Guild commands update instantly, so this runs at startup and every minute,
 * but only calls Discord when something changed.
 */
export async function syncCommands(client: Client, force = false) {
  const hasOpen = !!(await getOpenGiveaway());
  if (!force && hasOpen === registeredWithGiveaway) return;

  const body = [
    ...client.commands.filter(c => hasOpen || !GIVEAWAY_ONLY.has(c.data.name)).map(c => c.data.toJSON()),
    postToChannelCommand.toJSON(),
  ];
  try {
    await new REST({ version: '10' }).setToken(env.DISCORD_TOKEN).put(Routes.applicationGuildCommands(env.CLIENT_ID, env.SERVER_ID), { body });
    registeredWithGiveaway = hasOpen;
    console.log(`Registered ${body.length} commands (${hasOpen ? 'with' : 'without'} /giveaway)`);
  } catch (err) {
    // Keep running (webhooks, the admin API and jobs don't need slash commands).
    const e = err as { code?: number; message?: string };
    console.error(
      `Could not register slash commands: ${e.message ?? err}` +
        (e.code === 50001 ? ' — re-invite the bot with the "applications.commands" scope.' : ''),
    );
  }
}
