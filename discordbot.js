// discordbot.js
// Node 18+ (uses global fetch)

require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');

console.log('ENV CHECK:', {
  TSSERVER_URL: process.env.TSSERVER_URL,
  ADMIN_TOKEN: process.env.ADMIN_TOKEN ? '(set)' : '(not set)',
});

// ---- Helper: update server /config ----
async function updateServerConfig({ lowerC, upperC }) {
  const body = {};
  if (typeof lowerC === 'number') body.lowerC = lowerC;
  if (typeof upperC === 'number') body.upperC = upperC;

  const adminToken = process.env.ADMIN_TOKEN || '';

  // Primary: whatever you set in env (e.g. https://freezer-monitor-server.onrender.com/config)
  const primaryBase = process.env.TSSERVER_URL || null;

  // Fallback: local dev server
  const fallbackBase = 'http://localhost:3000/config';

  // Only keep non-null entries
  const targets = [primaryBase, fallbackBase].filter(Boolean);

  let lastError = null;

  for (const baseUrl of targets) {
    const url = baseUrl + (adminToken ? `?token=${encodeURIComponent(adminToken)}` : '');

    console.log('[CONFIG] Trying backend:', {
      baseUrl,
      url,
      body,
    });

    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error('[CONFIG] Backend responded with error:', res.status, text, 'for', baseUrl);
        lastError = new Error(`Backend ${baseUrl} responded with ${res.status}`);
        continue; // try next backend
      }

      console.log('[CONFIG] Backend config update OK with status:', res.status, 'for', baseUrl);
      return; // success, stop trying others
    } catch (err) {
      console.error('[CONFIG] Fetch failed (network-level error) for', baseUrl, ':', err);
      lastError = err;
      continue; // try next backend
    }
  }

  console.error('[CONFIG] All backend targets failed. Last error:', lastError);
  throw new Error('config_update_failed');
}

// ---- Helper: fetch current /config with cloud+local fallback ----
async function fetchServerConfig() {
  const adminToken = process.env.ADMIN_TOKEN || '';

  const primaryBase = process.env.TSSERVER_URL || null;
  const fallbackBase = 'http://localhost:3000/config'; // local dev

  const targets = [primaryBase, fallbackBase].filter(Boolean);

  let lastError = null;

  for (const baseUrl of targets) {
    const url = baseUrl + (adminToken ? `?token=${encodeURIComponent(adminToken)}` : '');

    console.log('[CONFIG] Fetching config from:', { baseUrl, url });

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error('[CONFIG] GET /config error:', res.status, text, 'for', baseUrl);
        lastError = new Error(`Backend ${baseUrl} responded with ${res.status}`);
        continue;
      }

      const data = await res.json().catch(err => {
        console.error('[CONFIG] Failed to parse JSON from', baseUrl, err);
        return null;
      });

      if (!data) {
        lastError = new Error(`Invalid JSON from ${baseUrl}`);
        continue;
      }

      console.log('[CONFIG] Current config from', baseUrl, ':', data);
      return data; // { lowerC, upperC, ... }
    } catch (err) {
      console.error('[CONFIG] Fetch failed (network-level) for', baseUrl, ':', err);
      lastError = err;
      continue;
    }
  }

  console.error('[CONFIG] All config fetch targets failed. Last error:', lastError);
  throw new Error('config_fetch_failed');
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
  new SlashCommandBuilder()
    .setName('getrange')
    .setDescription('Show current configured temperature range'),
].map(c => c.toJSON());


// ---- Register commands with Discord ---- ----
// ---- Register commands with Discord ----
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

if (process.env.REGISTER_COMMANDS === 'true') {
  (async () => {
    try {
      console.log('Registering slash commands...');

      // Use GUILD commands during dev
      await rest.put(
        Routes.applicationGuildCommands(
          process.env.CLIENT_ID,
          process.env.GUILD_ID,        // <-- add this env var
        ),
        { body: commands },
      );

      console.log('✅ Slash commands registered!');
    } catch (err) {
      console.error('Error registering slash commands:', err);
    }
  })();
}



// ---- Handle user input ----
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, options } = interaction;

  try {
    await interaction.deferReply({ ephemeral: true });

    if (commandName === 'setmin') {
      const val = options.getNumber('value');
      await updateServerConfig({ lowerC: val });
      await interaction.editReply(
        `✅ Minimum temperature set to **${val}°C** (server config updated)`
      );

    } else if (commandName === 'setmax') {
      const val = options.getNumber('value');
      await updateServerConfig({ upperC: val });
      await interaction.editReply(
        `✅ Maximum temperature set to **${val}°C** (server config updated)`
      );

    } else if (commandName === 'setrange') {
      const min = options.getNumber('min');
      const max = options.getNumber('max');
      await updateServerConfig({ lowerC: min, upperC: max });
      await interaction.editReply(
        `✅ Temperature range set to **${min}°C → ${max}°C** (server config updated)`
      );

    } else if (commandName === 'getrange') {
      const cfg = await fetchServerConfig();
      const lower = cfg.lowerC ?? 'not set';
      const upper = cfg.upperC ?? 'not set';

      await interaction.editReply(
        `📏 Current temperature range:\n` +
        `• Minimum: **${lower}°C**\n` +
        `• Maximum: **${upper}°C**`
      );
    }

  } catch (e) {
    console.error(e);
    const errorMsg = '❌ Failed to update or fetch server config on the backend.';

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(errorMsg);
      } else {
        await interaction.reply({
          content: errorMsg,
          ephemeral: true,   // <-- here too
        });
      }
    } catch (replyErr) {
      console.error('Failed to send error reply:', replyErr);
    }
  }
});


// ---- Bot online log ----
client.once('ready', () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
});

// ---- Login ----
client.login(process.env.DISCORD_TOKEN);
