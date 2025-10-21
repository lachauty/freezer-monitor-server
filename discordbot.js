const { Client, GatewayIntentBits, Routes } = require('discord.js');
const { SlashCommandBuilder } = require('@discordjs/builders');
require('dotenv').config()



const { REST } = require('@discordjs/rest');
const rest = new REST({ version: '10' }).setToken(" "); //insert discord token

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

const temps = new SlashCommandBuilder()
  .setName('temp')
  .setDescription('Enter the minimum and maximum temperatures')
  .addNumberOption((option)=>
    
    option
    .setName('minimum')
    .setDescription('Enter the minimum temperature (Celsius)')
    .setRequired(true)
  )

  .addNumberOption((option) =>

    option
    .setName('maximum')
    .setDescription('Enter the maximum temperature (Celsius)')
    .setRequired(true)
)

const min = new SlashCommandBuilder()
  .setName('min')
  .setDescription('Enter the minimum temperature')
  .addNumberOption((option)=>
    
    option
    .setName('minimum')
    .setDescription('Enter the minimum temperature (Celsius)')
    .setRequired(true)
  )

const max = new SlashCommandBuilder()
  .setName('max')
  .setDescription('Enter the maximum temperature')
  .addNumberOption((option)=>
    
    option
    .setName('maximum')
    .setDescription('Enter the maximum temperature (Celsius)')
    .setRequired(true)
  )

  const range = new SlashCommandBuilder()
  .setName('range')
  .setDescription('View current range of temperatures')

let MinTemp=0 
let MaxTemp=0

client.on('interactionCreate', (interaction) => {
    if (interaction.commandName === 'temp') {
      MinTemp= Math.min(interaction.options.getNumber('minimum'), interaction.options.getNumber('maximum'))
      MaxTemp= Math.max(interaction.options.getNumber('minimum'), interaction.options.getNumber('maximum'))

      
      interaction.reply({
        content: "Minimum: " + MinTemp + "°C" + "\nMaximum: " + MaxTemp + "°C",
      })
    }

    if (interaction.commandName === 'min') {
      MinTemp= (interaction.options.getNumber('minimum'))
      
      interaction.reply({
        content: "Minimum: " + MinTemp + "°C",
      })
    }

    if (interaction.commandName === 'max') {
      MaxTemp= (interaction.options.getNumber('maximum'))
      
      interaction.reply({
        content: "Maximum: " + MaxTemp + "°C",
      })
    }

    if (interaction.commandName === 'range') {
      if (MinTemp>MaxTemp){
          [MinTemp, MaxTemp] = [MaxTemp, MinTemp];
      }
      interaction.reply({
        content: "Minimum: " + MinTemp + "°C" + "\nMaximum: " + MaxTemp + "°C",
      })
    }
  }
)




client.on('ready', () => {
  console.log(`We have logged in as ${client.user.tag}`);

  const CLIENT_ID = client.user.id;   // Get CLIENT_ID automatically from the bot user
  const GUILD_ID = client.guilds.cache.id; // Get all guild IDs the bot is in

  console.log(CLIENT_ID)
  //console.log(GUILD_ID)

  async function main() {
  const commands = [
  temps, min, max, range
  ];
  try {
    console.log('Started refreshing application (/) commands.');
    await rest.put(Routes.applicationCommands(CLIENT_ID), {
      body: commands,
    });
    client.login(" "); //insert discord token
  } catch (err) {
    console.log(err);
  }
}

main()
});

// $ sign commands
//client.on('messageCreate', async (message) => {
//   // Ignore bot's own messages
  //if (message.author.id === client.user.id) {
    //return;
   //}

//   // $hello command
 //if (message.content.startsWith('$helpt')) {
   // await message.channel.send('Enter "$temp " followed by a space then the temperature range');
   //}

   //if (message.content.startsWith('$temp')) {
   //const re = /^(-?\d+)\s(-?\d+)$/;
   //let splitContent = message.content.slice(6);
  //const patternRec = splitContent.match(re)
  
   //if(patternRec ){
  //MinTemp = parseInt(patternRec[1]);
  //MaxTemp = parseInt(patternRec[2]);

  //if(MinTemp>MaxTemp){
    //MinTemp = patternRec[2]
    //MaxTemp = patternRec[1]
  //}
    
    //await message.channel.send('Minimum: '+ MinTemp + '°C' + '\nMaximum: ' + MaxTemp + '°C')
 // }
   //else{
    //await message.channel.send('Please enter integer values')
 //}
//}
//}
//)

module.exports = {temps: temps.toJSON()};
module.exports = {min: min.toJSON()};
module.exports = {max: max.toJSON()};
module.exports = {range: range.toJSON()};
client.login(" "); //insert discord token