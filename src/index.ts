import { Client, Collection, Events, GatewayIntentBits, MessageFlags, type Interaction } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { env } from './config/environment.js';
import { pool, runMigrations } from './db/client.js';
import { handleExtendButton, handleExtendModal, isExtendModal } from './discord/extend.js';
import { POST_TO_CHANNEL, handlePostToChannel } from './discord/postToChannel.js';
import { syncCommands } from './discord/registerCommands.js';
import { handleWinnerButton } from './discord/winnerButtons.js';
import { WINNER_BUTTON, runWinnerJobs } from './giveaway/winners.js';
import { runAnnouncements } from './giveaway/announcements.js';
import { EXTEND_BUTTON_PREFIX } from './giveaway/embeds.js';
import { handleGiveawayModal } from './giveaway/interactions.js';
import { isAdmin } from './lib/permissions.js';
import type { Command } from './types/discord.js';
import { startWebServer } from './web/server.js';
import { runScheduledSyncs } from './instagram/sync.js';
import { renewTokenIfDue } from './instagram/token.js';
import { processPendingInstagramEvents } from './instagram/webhook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await runMigrations();
console.log('Database ready');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildPresences, GatewayIntentBits.GuildMembers],
});

client.commands = new Collection();

const webServer = startWebServer(client);

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

    if (interaction.isMessageContextMenuCommand() && interaction.commandName === POST_TO_CHANNEL) {
      await handlePostToChannel(interaction);
      return;
    }

    if (interaction.isButton() && WINNER_BUTTON.test(interaction.customId)) {
      await handleWinnerButton(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith(EXTEND_BUTTON_PREFIX)) {
      await handleExtendButton(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      if (isExtendModal(interaction.customId)) await handleExtendModal(interaction);
      else if (interaction.customId.startsWith('giveaway:')) await handleGiveawayModal(interaction);
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

  await syncCommands(readyClient, true);
});

// Instagram, every 30 minutes: re-read the giveaway post's comments (catches anything a webhook
// missed and removes entries for deleted comments), do a final read for giveaways that just
// closed, and process webhook events that were waiting for the post to be set.
const INSTAGRAM_JOB_MS = 30 * 60 * 1000;
async function runInstagramJob() {
  try {
    await renewTokenIfDue();
    await runScheduledSyncs();
    await processPendingInstagramEvents();
  } catch (err) {
    console.error('Instagram job failed:', (err as Error).message);
  }
}
let instagramJob: NodeJS.Timeout | undefined;

// Every minute: post due updates to #community-updates, show/hide /giveaway as giveaways open and
// close, and move winners along (draws, DMs, expired claim windows).
const MINUTE_JOB_MS = 60 * 1000;
const minuteJob = setInterval(() => {
  if (!client.isReady()) return;
  void runAnnouncements(client).catch(err => console.error('Updates job failed:', err));
  void syncCommands(client).catch(err => console.error('Command sync failed:', err));
  void runWinnerJobs(client);
}, MINUTE_JOB_MS);
if (env.IG_ACCESS_TOKEN) {
  void runInstagramJob();
  instagramJob = setInterval(runInstagramJob, INSTAGRAM_JOB_MS);
}

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  clearInterval(instagramJob);
  clearInterval(minuteJob);
  webServer.close();
  await client.destroy();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await client.login(env.DISCORD_TOKEN);
