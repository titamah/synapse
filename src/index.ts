import { Client, Collection, Events, GatewayIntentBits, MessageFlags, REST, Routes, type Interaction } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { env } from './config/environment.js';
import { pool, runMigrations } from './db/client.js';
import { handleGiveawayModal } from './giveaway/interactions.js';
import { getGiveaway } from './giveaway/service.js';
import { isAdmin } from './lib/permissions.js';
import type { Command } from './types/discord.js';
import { startWebServer } from './web/server.js';
import { syncComments } from './instagram/comments.js';
import { processPendingInstagramEvents } from './instagram/webhook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await runMigrations();
await getGiveaway();
console.log('Database ready');

const webServer = startWebServer();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildPresences, GatewayIntentBits.GuildMembers],
});

client.commands = new Collection();

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => /\.(ts|js)$/.test(f) && !f.endsWith('.d.ts'));

for (const file of commandFiles) {
  const commandModule = await import(`file://${path.join(commandsPath, file)}`);
  const command = Object.values(commandModule)[0] as Command | undefined;
  if (command?.data) {
    client.commands.set(command.data.name, command);
    console.log(`Loaded command: ${command.data.name}`);
  }
}

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) {
        console.error(`No command found for ${interaction.commandName}`);
        return;
      }
      // Every slash command is admin-only unless it's explicitly marked public.
      if (!command.public && !isAdmin(interaction)) {
        await interaction.reply({ content: '🔒 This command is for admins only.', flags: MessageFlags.Ephemeral });
        return;
      }
      await command.execute(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('giveaway:')) {
      await handleGiveawayModal(interaction);
    }
  } catch (err) {
    console.error(err);
    if (!interaction.isRepliable()) return;

    const content = 'Something went wrong. Try again in a moment.';
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
  }
});

client.once(Events.ClientReady, async readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  // Registering on every boot keeps Discord in sync with the code; guild commands update instantly.
  const rest = new REST({ version: '10' }).setToken(env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(env.CLIENT_ID, env.SERVER_ID), {
    body: client.commands.map(c => c.data.toJSON()),
  });
  console.log(`Registered ${client.commands.size} commands`);
});

// Instagram comments: read the giveaway post every 10 minutes and award any missing comment bonuses.
// Works without Meta App Review because it only reads @BostonBlerds' own post.
const COMMENT_SYNC_MS = 10 * 60 * 1000;
async function runCommentSync() {
  try {
    const result = await syncComments();
    if (result) console.log('Comment sync:', JSON.stringify(result));
  } catch (err) {
    console.error('Comment sync failed:', (err as Error).message);
  }
}
let commentSync: NodeJS.Timeout | undefined;
if (env.IG_ACCESS_TOKEN) {
  void processPendingInstagramEvents().catch(err => console.error('Pending webhook retry failed:', err));
}
if (env.IG_ACCESS_TOKEN && env.IG_GIVEAWAY_POST) {
  void runCommentSync();
  commentSync = setInterval(runCommentSync, COMMENT_SYNC_MS);
}

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  clearInterval(commentSync);
  webServer.close();
  await client.destroy();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await client.login(env.DISCORD_TOKEN);
