import 'dotenv/config';
import { Client, Collection, EmbedBuilder, Events, GatewayIntentBits, Interaction } from 'discord.js';
import type { Command } from './types/discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('TOKEN loaded?', !!process.env.DISCORD_TOKEN);

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildPresences, GatewayIntentBits.GuildMembers],
}) as Client & { commands: Collection<string, Command> };

client.commands = new Collection();

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.ts') || f.endsWith('.js'));

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const commandModule = await import(`file://${filePath}`);
  const command: Command = Object.values(commandModule)[0] as Command;
  
  if (command?.data) {
    client.commands.set(command.data.name, command);
    console.log(`Loaded command: ${command.data.name}`);
  }
}

client.on('interactionCreate', async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);

  if (!command) {
    console.error(`No command found for ${interaction.commandName}`);
    return;
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(err);
    
    const errorMessage = err instanceof Error && err.message.includes('rate limit')
      ? 'Slow down! Try again in a few seconds.'
      : 'Something went wrong';
      
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
        content: errorMessage,
        flags: 64
      });
    } else {
      await interaction.reply({
        content: errorMessage,
        flags: 64
      });
    }
  }
});


client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isStringSelectMenu()) return;
  
    if (interaction.customId === "example-select") {
      const selected = interaction.values[0];

      const embed = new EmbedBuilder()
      .setTitle("Selection Received")
      .setDescription(`You selected **${selected}**`)
      .setColor(0x5865f2) // Discord blurple
      .setFooter({ text: "BB-BOT" });
  
    await interaction.reply({
      embeds: [embed],
      ephemeral: false,
      });
    }
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isButton()) return;
    if (interaction.customId !== "noop-button") return;
  
    await interaction.reply({
      content: "✨ confetti ✨ (imagine it)",
      ephemeral: true,
    });
  });

client.once('ready', () => {
  console.log(`Logged in as ${client.user?.tag}`);
});

client.login(TOKEN);