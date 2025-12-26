// discordbot.js
// Node 18+ (uses global fetch)

require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');

// create log for TSSERVER_URL and ADMIN_TOKEN
console.log('ENV CHECK:', {
  TSSERVER_URL: process.env.TSSERVER_URL,
  // checks for .env file admin token and if it exists, set admit token, else set to not set
  ADMIN_TOKEN: process.env.ADMIN_TOKEN ? '(set)' : '(not set)',
});

// asynchronous function that updates server configs
async function updateServerConfig({ lowerC, upperC }) {
  const body = {};
  // checks if lower and upper bounds is a number datatype to set the body fields
  if (typeof lowerC === 'number') body.lowerC = lowerC;
  if (typeof upperC === 'number') body.upperC = upperC;

  // admin token to be set to environment variable or nothing
  const adminToken = process.env.ADMIN_TOKEN || '';

  // Primary: whatever you set in env (e.g. https://freezer-monitor-server.onrender.com/config)
  const primaryBase = process.env.TSSERVER_URL || null;

  // Fallback: local dev server
  const fallbackBase = 'http://localhost:3000/config';

  // Only keep non-null entries
  const targets = [primaryBase, fallbackBase].filter(Boolean);

  // set lastError to null
  let lastError = null;

  // for loop that loops over every item in targets using baseURL
  for (const baseUrl of targets) {
    const url = baseUrl + (adminToken ? `?token=${encodeURIComponent(adminToken)}` : '');

    // log displaying trying backend for baseURL, url, and body
    console.log('[CONFIG] Trying backend:', {
      baseUrl,
      url,
      body,
    });

    // try to set response to fetch url, and populated fields for
    // method, headers, and body
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      // if response ok field is false
      if (!res.ok) {
        // set text to await for response text to catch
        const text = await res.text().catch(() => '');
        // log an error message with response status, text, and baseURL
        console.error('[CONFIG] Backend responded with error:', res.status, text, 'for', baseUrl);
        // set lasterror as the newly created error object
        lastError = new Error(`Backend ${baseUrl} responded with ${res.status}`);
        continue; // try next backend
      }

      // log the config ok message
      console.log('[CONFIG] Backend config update OK with status:', res.status, 'for', baseUrl);
      return; // success, stop trying others
    } catch (err) {
      //catch error if try fails and log message and set last error
      console.error('[CONFIG] Fetch failed (network-level error) for', baseUrl, ':', err);
      lastError = err;
      continue; // try next backend
    }
  }

  //error message log
  console.error('[CONFIG] All backend targets failed. Last error:', lastError);
  // throw a new error for config update failure
  throw new Error('config_update_failed');
}

// asynchronous function that fetches server configs
async function fetchServerConfig() {
  // sets admin token to environment variable
  const adminToken = process.env.ADMIN_TOKEN || '';

  // sets primary base and fall back base
  const primaryBase = process.env.TSSERVER_URL || null;
  const fallbackBase = 'http://localhost:3000/config'; // local dev

  // targets is set as an array to primary or fall back base
  // with boolean filter
  const targets = [primaryBase, fallbackBase].filter(Boolean);

  // sets last error to be null
  let lastError = null;

  // for loop to loop through targets 
  for (const baseUrl of targets) {
    // sets the url to baseurl and admin token
    const url = baseUrl + (adminToken ? `?token=${encodeURIComponent(adminToken)}` : '');

    // display config
    console.log('[CONFIG] Fetching config from:', { baseUrl, url });

    try {
      // response to await for fetch for method and headers
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });

      // response ok field if false
      if (!res.ok) {
        // set the text to await for response text to be catched
        const text = await res.text().catch(() => '');
        // error message
        console.error('[CONFIG] GET /config error:', res.status, text, 'for', baseUrl);
        // create a new error object
        lastError = new Error(`Backend ${baseUrl} responded with ${res.status}`);
        continue;
      }

      // sets data to await for response json file catch
      const data = await res.json().catch(err => {
        //error handle
        console.error('[CONFIG] Failed to parse JSON from', baseUrl, err);
        return null;
      });

      // if data doesnt exist issue error
      if (!data) {
        lastError = new Error(`Invalid JSON from ${baseUrl}`);
        continue;
      }

      // log current config details
      console.log('[CONFIG] Current config from', baseUrl, ':', data);
      return data; // { lowerC, upperC, ... }
    } catch (err) {
      // issue error handle
      console.error('[CONFIG] Fetch failed (network-level) for', baseUrl, ':', err);
      lastError = err;
      continue;
    }
  }

  // log error message and create error object
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

// Register commands with Discord
// set rest to created REST object for endpoint handling
// we use the discord token in our .env file
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

// if register commands is not boolean and true
if (process.env.REGISTER_COMMANDS === 'true') {
  // asynchonous
  (async () => {
    // try displaying registering slash commands
    try {
      console.log('Registering slash commands...');

      // Use GUILD commands during dev
      await rest.put(
        // builds API endpoint URL for server specific slash commands
        Routes.applicationGuildCommands(
          process.env.CLIENT_ID,
          process.env.GUILD_ID,
        ),
        { body: commands },
      );

      // success log
      console.log('✅ Slash commands registered!');
    } // catch error
    catch (err) {
      console.error('Error registering slash commands:', err);
    }
  })();
}



// Handle user input
client.on('interactionCreate', async interaction => {
  // if slash command isn't inputted, return
  if (!interaction.isChatInputCommand()) return;

  // commandname and options is set to interaction
  const { commandName, options } = interaction;

  try {
    // wait for discord to reply
    await interaction.deferReply({ ephemeral: true });

    // set the minimum temperature range
    if (commandName === 'setmin') {
      const val = options.getNumber('value');
      await updateServerConfig({ lowerC: val });
      await interaction.editReply(
        `✅ Minimum temperature set to **${val}°C** (server config updated)`
      );

    // set the maximum temperature range
    } else if (commandName === 'setmax') {
      const val = options.getNumber('value');
      await updateServerConfig({ upperC: val });
      await interaction.editReply(
        `✅ Maximum temperature set to **${val}°C** (server config updated)`
      );

    // set the temperature range
    } else if (commandName === 'setrange') {
      const min = options.getNumber('min');
      const max = options.getNumber('max');
      await updateServerConfig({ lowerC: min, upperC: max });
      await interaction.editReply(
        `✅ Temperature range set to **${min}°C → ${max}°C** (server config updated)`
      );

    // get the temperature range
    } else if (commandName === 'getrange') {
      const cfg = await fetchServerConfig();
      const lower = cfg.lowerC ?? 'not set';
      const upper = cfg.upperC ?? 'not set';

      // display current temperature range
      await interaction.editReply(
        `📏 Current temperature range:\n` +
        `• Minimum: **${lower}°C**\n` +
        `• Maximum: **${upper}°C**`
      );
    }

    // catch error and display log
  } catch (e) {
    console.error(e);
    const errorMsg = '❌ Failed to update or fetch server config on the backend.';

    try {
      // checks if interration has been deferred or replied
      if (interaction.deferred || interaction.replied) {
        // wait for interaction to edit reply for error message
        await interaction.editReply(errorMsg);
      } else {
        // else await for reply
        await interaction.reply({
          content: errorMsg,
          ephemeral: true,
        });
      }
      // catch reply error and display message
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
