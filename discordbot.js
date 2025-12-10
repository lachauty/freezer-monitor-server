// discordbot.js
// Node 18+ (uses global fetch)

require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');

// ---- Helper: update server /config ----
async function updateServerConfig({ lowerC, upperC }) {
  const body = {};
  if (typeof lowerC === 'number') body.lowerC = lowerC;
  if (typeof upperC === 'number') body.upperC = upperC;

  // If TSSERVER_URL is not set, default to local dev server
  const baseUrl = process.env.TSSERVER_URL || 'http://localhost:3000/config';
  const adminToken = process.env.ADMIN_TOKEN || '';

  const url = baseUrl + (adminToken ? `?token=${encodeURIComponent(adminToken)}` : '');

  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('Failed to update server config:', res.status, text);
    throw new Error('config_update_failed');
  }
}

// ---- Discord client ----
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ---- Slash commands ----
const commands = [
  new SlashCommandBuilder()
    .setName('setmin')
    .setDescription('Set minimum temperature')
    .addNumberOption(option =>
      option.setName('value')
        .setDescription('Minimum temperature in °C')
        .setRequired(true)),
  new SlashCommandBuilder()
    .setName('setmax')
    .setDescription('Set maximum temperature')
    .addNumberOption(option =>
      option.setName('value')
        .setDescription('Maximum temperature in °C')
        .setRequired(true)),
  new SlashCommandBuilder()
    .setName('setrange')
    .setDescription('Set full temperature range')
    .addNumberOption(option =>
      option.setName('min')
        .setDescription('Minimum temperature')
        .setRequired(true))
    .addNumberOption(option =>
      option.setName('max')
        .setDescription('Maximum temperature')
        .setRequired(true)),
].map(c => c.toJSON());

// ---- Register commands with Discord ----
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands },
    );
    console.log('✅ Slash commands registered!');
  } catch (err) {
    console.error('Error registering slash commands:', err);
  }
})();

// ---- Handle user input ----
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, options } = interaction;

  try {
    if (commandName === 'setmin') {
      const val = options.getNumber('value');
      await updateServerConfig({ lowerC: val });
      await interaction.reply(`✅ Minimum temperature set to **${val}°C** (server config updated)`);
    }

    if (commandName === 'setmax') {
      const val = options.getNumber('value');
      await updateServerConfig({ upperC: val });
      await interaction.reply(`✅ Maximum temperature set to **${val}°C** (server config updated)`);
    }

    if (commandName === 'setrange') {
      const min = options.getNumber('min');
      const max = options.getNumber('max');
      await updateServerConfig({ lowerC: min, upperC: max });
      await interaction.reply(`✅ Temperature range set to **${min}°C → ${max}°C** (server config updated)`);
    }
  } catch (e) {
    console.error(e);
    if (!interaction.replied) {
      await interaction.reply({
        content: '❌ Failed to update server config on the backend.',
        ephemeral: true,
      });
    }
  }
});

// ---- Bot online log ----
client.once('clientReady', () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
});


// ---- Login ----
client.login(process.env.DISCORD_TOKEN);
