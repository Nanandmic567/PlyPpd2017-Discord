import {
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  TextInputBuilder,
  TextInputStyle,
  ModalBuilder,
  PermissionsBitField,
  EmbedBuilder,
  AttachmentBuilder,
  ActivityType,
  ComponentType,
  REST,
  Routes,
} from 'discord.js';
import {
  HarmBlockThreshold,
  HarmCategory
} from '@google/genai';
import fs from 'fs/promises';
import {
  createWriteStream
} from 'fs';
import path from 'path';
import {
  getTextExtractor
} from 'office-text-extractor'
import osu from 'node-os-utils';
const {
  mem,
  cpu
} = osu;
import axios from 'axios';

import config from './config.js';
import {
  client,
  genAI,
  createPartFromUri,
  token,
  activeRequests,
  chatHistoryLock,
  state,
  TEMP_DIR,
  initialize,
  saveStateToFile,
  getHistory,
  updateChatHistory,
  getUserResponsePreference,
  getUserToolPreference,
  initializeBlacklistForGuild
} from './botManager.js';

initialize().catch(console.error);


// <=====[Configuration]=====>

const MODEL = "gemini-2.5-flash";

/*
`BLOCK_NONE`  -  Always show regardless of probability of unsafe content
`BLOCK_ONLY_HIGH`  -  Block when high probability of unsafe content
`BLOCK_MEDIUM_AND_ABOVE`  -  Block when medium or high probability of unsafe content
`BLOCK_LOW_AND_ABOVE`  -  Block when low, medium or high probability of unsafe content
`HARM_BLOCK_THRESHOLD_UNSPECIFIED`  -  Threshold is unspecified, block using default threshold
*/
const safetySettings = [{
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
];

const generationConfig = {
  temperature: 1.0,
  topP: 0.95,
  // maxOutputTokens: 1000,
  thinkingConfig: {
    thinkingBudget: -1
  }
};

const defaultResponseFormat = config.defaultResponseFormat;
const defaultTool = config.defaultTool;
const hexColour = config.hexColour;
const activities = config.activities.map(activity => ({
  name: activity.name,
  type: ActivityType[activity.type]
}));
const defaultPersonality = config.defaultPersonality;
const defaultServerSettings = config.defaultServerSettings;
const workInDMs = config.workInDMs;
const shouldDisplayPersonalityButtons = config.shouldDisplayPersonalityButtons;
const SEND_RETRY_ERRORS_TO_DISCORD = config.SEND_RETRY_ERRORS_TO_DISCORD;



import {
  delay,
  retryOperation,
} from './tools/others.js';

// <==========>



// <=====[Register Commands And Activities]=====>

import {
  commands
} from './commands.js';

let activityIndex = 0;
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  const rest = new REST().setToken(token);
  try {
    console.log('Started refreshing application (/) commands.');

    await rest.put(
      Routes.applicationCommands(client.user.id), {
        body: commands
      },
    );

    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }

  client.user.setPresence({
    activities: [activities[activityIndex]],
    status: 'idle',
  });

  setInterval(() => {
    activityIndex = (activityIndex + 1) % activities.length;
    client.user.setPresence({
      activities: [activities[activityIndex]],
      status: 'idle',
    });
  }, 30000);
});

// <==========>



// <=====[Messages And Interaction]=====>

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (message.content.startsWith('!')) return;

    const isDM = message.channel.type === ChannelType.DM;

    const shouldRespond = (
      workInDMs && isDM ||
      state.alwaysRespondChannels[message.channelId] ||
      (message.mentions.users.has(client.user.id) && !isDM) ||
      state.activeUsersInChannels[message.channelId]?.[message.author.id]
    );

    if (shouldRespond) {
      if (message.guild) {
        initializeBlacklistForGuild(message.guild.id);
        if (state.blacklistedUsers[message.guild.id].includes(message.author.id)) {
          const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('อุ๊ย! อยู่ในแบล็คลิสต์')
            .setDescription('ขออภัยนะคะ ดูเหมือนว่าคุณจะอยู่ในแบล็คลิสต์ เลยยังใช้งานส่วนนี้ไม่ได้ค่ะ');
          return message.reply({
            embeds: [embed]
          });
        }
      }
      if (activeRequests.has(message.author.id)) {
        const embed = new EmbedBuilder()
          .setColor(0xFFFF00)
          .setTitle('ใจเย็นๆ น้า')
          .setDescription('กำลังจัดการคำขอของคุณอยู่ค่ะ รอสักครู่นะคะ เดี๋ยวจะรีบทำให้เลย');
        await message.reply({
          embeds: [embed]
        });
      } else {
        activeRequests.add(message.author.id);
        await handleTextMessage(message);
      }
    }
  } catch (error) {
    console.error('Error processing the message:', error);
    if (activeRequests.has(message.author.id)) {
      activeRequests.delete(message.author.id);
    }
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleCommandInteraction(interaction);
    } else if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
    } else if (interaction.isModalSubmit()) {
      await handleModalSubmit(interaction);
    }
  } catch (error) {
    console.error('Error handling interaction:', error.message);
  }
});

async function handleCommandInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;

  const commandHandlers = {
    respond_to_all: handleRespondToAllCommand,
    toggle_channel_chat_history: toggleChannelChatHistory,
    whitelist: handleWhitelistCommand,
    blacklist: handleBlacklistCommand,
    clear_memory: handleClearMemoryCommand,
    settings: showSettings,
    server_settings: showDashboard,
    status: handleStatusCommand
  };

  const handler = commandHandlers[interaction.commandName];
  if (handler) {
    await handler(interaction);
  } else {
    console.log(`Unknown command: ${interaction.commandName}`);
  }
}

async function handleButtonInteraction(interaction) {
  if (!interaction.isButton()) return;

  if (interaction.guild) {
    initializeBlacklistForGuild(interaction.guild.id);
    if (state.blacklistedUsers[interaction.guild.id].includes(interaction.user.id)) {
      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('อุ๊ย! อยู่ในแบล็คลิสต์')
        .setDescription('ขออภัยนะคะ ดูเหมือนว่าคุณจะอยู่ในแบล็คลิสต์ เลยยังใช้งานส่วนนี้ไม่ได้ค่ะ');
      return interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
    }
  }

  const buttonHandlers = {
    'server-chat-history': toggleServerWideChatHistory,
    'clear-server': clearServerChatHistory,
    'settings-save-buttons': toggleSettingSaveButton,
    'custom-server-personality': serverPersonality,
    'toggle-server-personality': toggleServerPersonality,
    'download-server-conversation': downloadServerConversation,
    'response-server-mode': toggleServerPreference,
    'toggle-response-server-mode': toggleServerResponsePreference,
    'settings': showSettings,
    'back_to_main_settings': editShowSettings,
    'clear-memory': handleClearMemoryCommand,
    'always-respond': alwaysRespond,
    'custom-personality': handleCustomPersonalityCommand,
    'remove-personality': handleRemovePersonalityCommand,
    'toggle-response-mode': handleToggleResponseMode,
    'toggle-tool-preference': toggleToolPreference,
    'download-conversation': downloadConversation,
    'download_message': downloadMessage,
    'general-settings': handleSubButtonInteraction,
  };

  for (const [key, handler] of Object.entries(buttonHandlers)) {
    if (interaction.customId.startsWith(key)) {
      await handler(interaction);
      return;
    }
  }

  if (interaction.customId.startsWith('delete_message-')) {
    const msgId = interaction.customId.replace('delete_message-', '');
    await handleDeleteMessageInteraction(interaction, msgId);
  }
}

async function handleDeleteMessageInteraction(interaction, msgId) {
  const userId = interaction.user.id;
  const userChatHistory = state.chatHistories[userId];
  const channel = interaction.channel;
  const message = channel ? (await channel.messages.fetch(msgId).catch(() => false)) : false;

  if (userChatHistory) {
    if (userChatHistory[msgId]) {
      delete userChatHistory[msgId];
      await deleteMsg();
    } else {
      try {
        const replyingTo = message ? (message.reference ? (await message.channel.messages.fetch(message.reference.messageId)).author.id : 0) : 0;
        if (userId === replyingTo) {
          await deleteMsg();
        } else {
          const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('ปุ่มนี้ไม่ใช่ของคุณน้า')
            .setDescription('ดูเหมือนว่าปุ่มนี้จะไม่ได้มีไว้สำหรับคุณนะคะ');
          return interaction.reply({
            embeds: [embed],
            flags: MessageFlags.Ephemeral
          });
        }
      } catch (error) {}
    }
  }

  async function deleteMsg() {
    await interaction.message.delete()
      .catch('Error deleting interaction message: ', console.error);

    if (channel) {
      if (message) {
        message.delete().catch(() => {});
      }
    }
  }
}

async function handleClearMemoryCommand(interaction) {
  const serverChatHistoryEnabled = interaction.guild ? state.serverSettings[interaction.guild.id]?.serverChatHistory : false;
  if (!serverChatHistoryEnabled) {
    await clearChatHistory(interaction);
  } else {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('คุณสมบัตินี้ปิดอยู่ค่ะ')
      .setDescription('ตอนนี้เซิร์ฟเวอร์เปิดใช้ประวัติการแชทแบบทั้งเซิร์ฟเวอร์อยู่ เลยล้างประวัติส่วนตัวไม่ได้นะคะ');
    await interaction.reply({
      embeds: [embed]
    });
  }
}

async function handleCustomPersonalityCommand(interaction) {
  const serverCustomEnabled = interaction.guild ? state.serverSettings[interaction.guild.id]?.customServerPersonality : false;
  if (!serverCustomEnabled) {
    await setCustomPersonality(interaction);
  } else {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('คุณสมบัตินี้ปิดอยู่ค่ะ')
      .setDescription('ตอนนี้เซิร์ฟเวอร์เปิดใช้บุคลิกภาพแบบทั้งเซิร์ฟเวอร์อยู่ เลยยังตั้งค่าบุคลิกส่วนตัวไม่ได้นะคะ');
    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }
}

async function handleRemovePersonalityCommand(interaction) {
  const isServerEnabled = interaction.guild ? state.serverSettings[interaction.guild.id]?.customServerPersonality : false;
  if (!isServerEnabled) {
    await removeCustomPersonality(interaction);
  } else {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('คุณสมบัตินี้ปิดอยู่ค่ะ')
      .setDescription('ตอนนี้เซิร์ฟเวอร์เปิดใช้บุคลิกภาพแบบทั้งเซิร์ฟเวอร์อยู่ เลยยังตั้งค่าบุคลิกส่วนตัวไม่ได้นะคะ');
    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }
}

async function handleToggleResponseMode(interaction) {
  const serverResponsePreferenceEnabled = interaction.guild ? state.serverSettings[interaction.guild.id]?.serverResponsePreference : false;
  if (!serverResponsePreferenceEnabled) {
    await toggleUserResponsePreference(interaction);
  } else {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('คุณสมบัตินี้ปิดอยู่ค่ะ')
      .setDescription('ตอนนี้เซิร์ฟเวอร์เปิดใช้โหมดการตอบกลับแบบทั้งเซิร์ฟเวอร์อยู่ เลยยังปรับเปลี่ยนส่วนตัวไม่ได้นะคะ');
    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }
}

async function editShowSettings(interaction) {
  await showSettings(interaction, true);
}

// <==========>



// <=====[Messages Handling]=====>

async function handleTextMessage(message) {
  const botId = client.user.id;
  const userId = message.author.id;
  const guildId = message.guild?.id;
  const channelId = message.channel.id;
  let messageContent = message.content.replace(new RegExp(`<@!?${botId}>`), '').trim();

  if (messageContent === '' && !(message.attachments.size > 0 && hasSupportedAttachments(message))) {
    if (activeRequests.has(userId)) {
      activeRequests.delete(userId);
    }
    const embed = new EmbedBuilder()
      .setColor(0x00FFFF)
      .setTitle('ข้อความว่างเปล่า?')
      .setDescription("เอ... เหมือนจะยังไม่ได้พิมพ์อะไรเลยนะคะ อยากคุยเรื่องอะไรดีคะ?");
    const botMessage = await message.reply({
      embeds: [embed]
    });
    await addSettingsButton(botMessage);
    return;
  }
  message.channel.sendTyping();
  const typingInterval = setInterval(() => {
    message.channel.sendTyping();
  }, 4000);
  setTimeout(() => {
    clearInterval(typingInterval);
  }, 120000);
  let botMessage = false;
  let parts;
  try {
    if (SEND_RETRY_ERRORS_TO_DISCORD) {
      clearInterval(typingInterval);
      const updateEmbedDescription = (textAttachmentStatus, imageAttachmentStatus, finalText) => {
        return `ขอเวลาคิดแป๊บนึงนะคะ...\n\n- ${textAttachmentStatus}: กำลังตรวจสอบไฟล์ข้อความ\n- ${imageAttachmentStatus}: กำลังตรวจสอบไฟล์มีเดีย\n${finalText || ''}`;
      };

      const embed = new EmbedBuilder()
        .setColor(0x00FFFF)
        .setTitle('กำลังประมวลผลค่ะ')
        .setDescription(updateEmbedDescription('[🔁]', '[🔁]'));
      botMessage = await message.reply({
        embeds: [embed]
      });

      messageContent = await extractFileText(message, messageContent);
      embed.setDescription(updateEmbedDescription('[☑️]', '[🔁]'));
      await botMessage.edit({
        embeds: [embed]
      });

      parts = await processPromptAndMediaAttachments(messageContent, message);
      embed.setDescription(updateEmbedDescription('[☑️]', '[☑️]', '### ตรวจสอบเรียบร้อย! รอคำตอบสักครู่นะคะ...'));
      await botMessage.edit({
        embeds: [embed]
      });
    } else {
      messageContent = await extractFileText(message, messageContent);
      parts = await processPromptAndMediaAttachments(messageContent, message);
    }
  } catch (error) {
    return console.error('Error initialising message', error);
  }

  let instructions;
  if (guildId) {
    if (state.channelWideChatHistory[channelId]) {
      instructions = state.customInstructions[channelId];
    } else if (state.serverSettings[guildId]?.customServerPersonality && state.customInstructions[guildId]) {
      instructions = state.customInstructions[guildId];
    } else {
      instructions = state.customInstructions[userId];
    }
  } else {
    instructions = state.customInstructions[userId];
  }

  let infoStr = '';
  if (guildId) {
    const userInfo = {
      username: message.author.username,
      displayName: message.author.displayName
    };
    infoStr = `\nตอนนี้กำลังคุยกับผู้ใช้ในเซิร์ฟเวอร์ Discord ที่ชื่อ ${message.guild.name} นะคะ\n\n## ข้อมูลผู้ใช้ปัจจุบัน\nชื่อผู้ใช้: \`${userInfo.username}\`\nชื่อที่แสดง: \`${userInfo.displayName}\``;
  }

  const isServerChatHistoryEnabled = guildId ? state.serverSettings[guildId]?.serverChatHistory : false;
  const isChannelChatHistoryEnabled = guildId ? state.channelWideChatHistory[channelId] : false;
  const finalInstructions = isServerChatHistoryEnabled ? instructions + infoStr : instructions;
  const historyId = isChannelChatHistoryEnabled ? (isServerChatHistoryEnabled ? guildId : channelId) : userId;

  // Configure tools based on user preference - only Google Search and Code Execution supported
  const userToolMode = getUserToolPreference(userId);
  let tools;

  switch (userToolMode) {
    case 'Code Execution':
      tools = [{
        codeExecution: {}
      }];
      break;
    case 'Google Search with URL Context':
    default:
      tools = [{
        googleSearch: {}
      }, {
        urlContext: {}
      }];
      break;
  }

  // Create chat with new Google GenAI API format
  const chat = genAI.chats.create({
    model: MODEL,
    config: {
      systemInstruction: {
        role: "system",
        parts: [{
          text: finalInstructions || defaultPersonality
        }]
      },
      ...generationConfig,
      safetySettings,
      tools: tools
    },
    history: getHistory(historyId)
  });

  await handleModelResponse(botMessage, chat, parts, message, typingInterval, historyId);
}

function hasSupportedAttachments(message) {
  const supportedFileExtensions = ['.html', '.js', '.css', '.json', '.xml', '.csv', '.py', '.java', '.sql', '.log', '.md', '.txt', '.docx', '.pptx'];

  return message.attachments.some((attachment) => {
    const contentType = (attachment.contentType || "").toLowerCase();
    const fileExtension = path.extname(attachment.name) || '';
    return (
      (contentType.startsWith('image/') && contentType !== 'image/gif') ||
      contentType.startsWith('audio/') ||
      contentType.startsWith('video/') ||
      contentType.startsWith('application/pdf') ||
      contentType.startsWith('application/x-pdf') ||
      supportedFileExtensions.includes(fileExtension)
    );
  });
}

async function downloadFile(url, filePath) {
  const writer = createWriteStream(filePath);
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
  });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

function sanitizeFileName(fileName) {
  return fileName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function processPromptAndMediaAttachments(prompt, message) {
  const attachments = JSON.parse(JSON.stringify(Array.from(message.attachments.values())));
  let parts = [{
    text: prompt
  }];

  if (attachments.length > 0) {
    const validAttachments = attachments.filter(attachment => {
      const contentType = (attachment.contentType || "").toLowerCase();
      return (contentType.startsWith('image/') && contentType !== 'image/gif') ||
        contentType.startsWith('audio/') ||
        contentType.startsWith('video/') ||
        contentType.startsWith('application/pdf') ||
        contentType.startsWith('application/x-pdf');
    });

    if (validAttachments.length > 0) {
      const attachmentParts = await Promise.all(
        validAttachments.map(async (attachment) => {
          const sanitizedFileName = sanitizeFileName(attachment.name);
          const uniqueTempFilename = `${message.author.id}-${attachment.id}-${sanitizedFileName}`;
          const filePath = path.join(TEMP_DIR, uniqueTempFilename);

          try {
            await downloadFile(attachment.url, filePath);
            // Upload file using new Google GenAI API format
            const uploadResult = await genAI.files.upload({
              file: filePath,
              config: {
                mimeType: attachment.contentType,
                displayName: sanitizedFileName,
              }
            });

            const name = uploadResult.name;
            if (name === null) {
              throw new Error(`Unable to extract file name from upload result.`);
            }

            if (attachment.contentType.startsWith('video/')) {
              // Wait for video processing to complete using new API
              let file = await genAI.files.get({ name: name });
              while (file.state === 'PROCESSING') {
                process.stdout.write(".");
                await new Promise((resolve) => setTimeout(resolve, 10_000));
                file = await genAI.files.get({ name: name });
              }
              if (file.state === 'FAILED') {
                throw new Error(`Video processing failed for ${sanitizedFileName}.`);
              }
            }

            return createPartFromUri(uploadResult.uri, uploadResult.mimeType);
          } catch (error) {
            console.error(`Error processing attachment ${sanitizedFileName}:`, error);
            return null;
          } finally {
            try {
              await fs.unlink(filePath);
            } catch (unlinkError) {
              if (unlinkError.code !== 'ENOENT') {
                console.error(`Error deleting temporary file ${filePath}:`, unlinkError);
              }
            }
          }
        })
      );
      parts = [...parts, ...attachmentParts.filter(part => part !== null)];
    }
  }
  return parts;
}


async function extractFileText(message, messageContent) {
  if (message.attachments.size > 0) {
    let attachments = Array.from(message.attachments.values());
    for (const attachment of attachments) {
      const fileType = path.extname(attachment.name) || '';
      const fileTypes = ['.html', '.js', '.css', '.json', '.xml', '.csv', '.py', '.java', '.sql', '.log', '.md', '.txt', '.docx', '.pptx'];

      if (fileTypes.includes(fileType)) {
        try {
          let fileContent = await downloadAndReadFile(attachment.url, fileType);
          messageContent += `\n\n[\`${attachment.name}\` File Content]:\n\`\`\`\n${fileContent}\n\`\`\``;
        } catch (error) {
          console.error(`Error reading file ${attachment.name}: ${error.message}`);
        }
      }
    }
  }
  return messageContent;
}

async function downloadAndReadFile(url, fileType) {
  switch (fileType) {
    case 'pptx':
    case 'docx':
      const extractor = getTextExtractor();
      return (await extractor.extractText({
        input: url,
        type: 'url'
      }));
    default:
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to download ${response.statusText}`);
      return await response.text();
  }
}

// <==========>



// <=====[Interaction Reply]=====>

async function handleModalSubmit(interaction) {
  if (interaction.customId === 'custom-personality-modal') {
    try {
      const customInstructionsInput = interaction.fields.getTextInputValue('custom-personality-input');
      state.customInstructions[interaction.user.id] = customInstructionsInput.trim();

      const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('เรียบร้อยค่ะ!')
        .setDescription('บันทึกบุคลิกภาพที่คุณตั้งค่าไว้ให้แล้วนะคะ');
      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
    } catch (error) {
      console.log(error.message);
    }
  } else if (interaction.customId === 'custom-server-personality-modal') {
    try {
      const customInstructionsInput = interaction.fields.getTextInputValue('custom-server-personality-input');
      state.customInstructions[interaction.guild.id] = customInstructionsInput.trim();

      const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('เรียบร้อยค่ะ!')
        .setDescription('บันทึกบุคลิกภาพสำหรับเซิร์ฟเวอร์นี้ให้แล้วนะคะ');
      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
    } catch (error) {
      console.log(error.message);
    }
  }
}

async function clearChatHistory(interaction) {
  try {
    state.chatHistories[interaction.user.id] = {};
    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle('ล้างประวัติการคุยแล้วค่ะ')
      .setDescription('ล้างประวัติการสนทนาของคุณเรียบร้อยแล้วค่ะ');
    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    console.log(error.message);
  }
}

async function alwaysRespond(interaction) {
  try {
    const userId = interaction.user.id;
    const channelId = interaction.channelId;

    if (interaction.channel.type === ChannelType.DM) {
      const dmDisabledEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('ใช้ใน DM ไม่ได้นะคะ')
        .setDescription('คุณสมบัตินี้ยังไม่รองรับการใช้งานในข้อความส่วนตัวค่ะ');
      await interaction.reply({
        embeds: [dmDisabledEmbed],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (!state.activeUsersInChannels[channelId]) {
      state.activeUsersInChannels[channelId] = {};
    }

    if (state.activeUsersInChannels[channelId][userId]) {
      delete state.activeUsersInChannels[channelId][userId];
    } else {
      state.activeUsersInChannels[channelId][userId] = true;
    }

    await handleSubButtonInteraction(interaction, true);
  } catch (error) {
    console.log(error.message);
  }
}

async function handleRespondToAllCommand(interaction) {
  try {
    if (interaction.channel.type === ChannelType.DM) {
      const dmEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('ใช้ใน DM ไม่ได้นะคะ')
        .setDescription('คำสั่งนี้ไม่สามารถใช้งานในข้อความส่วนตัวได้ค่ะ');
      return interaction.reply({
        embeds: [dmEmbed],
        flags: MessageFlags.Ephemeral
      });
    }

    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      const adminEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('ต้องเป็นแอดมินนะคะ')
        .setDescription('คำสั่งนี้สำหรับผู้ดูแลระบบเท่านั้นค่ะ');
      return interaction.reply({
        embeds: [adminEmbed],
        flags: MessageFlags.Ephemeral
      });
    }

    const channelId = interaction.channelId;
    const enabled = interaction.options.getBoolean('enabled');

    if (enabled) {
      state.alwaysRespondChannels[channelId] = true;
      const startRespondEmbed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('เปิดโหมดตอบกลับอัตโนมัติ')
        .setDescription('ตอนนี้จะตอบทุกข้อความในช่องนี้แล้วนะคะ');
      await interaction.reply({
        embeds: [startRespondEmbed],
        ephemeral: false
      });
    } else {
      delete state.alwaysRespondChannels[channelId];
      const stopRespondEmbed = new EmbedBuilder()
        .setColor(0xFFA500)
        .setTitle('ปิดโหมดตอบกลับอัตโนมัติ')
        .setDescription('ตอนนี้จะตอบกลับเมื่อถูกเรียกเท่านั้นนะคะ');
      await interaction.reply({
        embeds: [stopRespondEmbed],
        ephemeral: false
      });
    }
  } catch (error) {
    console.log(error.message);
  }
}

async function toggleChannelChatHistory(interaction) {
  try {
    if (interaction.channel.type === ChannelType.DM) {
      const dmEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('ใช้ใน DM ไม่ได้นะคะ')
        .setDescription('คำสั่งนี้ไม่สามารถใช้งานในข้อความส่วนตัวได้ค่ะ');
      return interaction.reply({
        embeds: [dmEmbed],
        flags: MessageFlags.Ephemeral
      });
    }

    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      const adminEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('ต้องเป็นแอดมินนะคะ')
        .setDescription('คำสั่งนี้สำหรับผู้ดูแลระบบเท่านั้นค่ะ');
      return interaction.reply({
        embeds: [adminEmbed],
        flags: MessageFlags.Ephemeral
      });
    }

    const channelId = interaction.channelId;
    const enabled = interaction.options.getBoolean('enabled');
    const instructions = interaction.options.getString('instructions') || defaultPersonality;

    if (enabled) {
      state.channelWideChatHistory[channelId] = true;
      state.customInstructions[channelId] = instructions;

      const enabledEmbed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('เปิดใช้งานประวัติการแชทระดับช่อง')
        .setDescription(`เปิดใช้งานประวัติการสนทนาสำหรับช่องนี้เรียบร้อยแล้วค่ะ`);
      await interaction.reply({
        embeds: [enabledEmbed],
        ephemeral: false
      });
    } else {
      delete state.channelWideChatHistory[channelId];
      delete state.customInstructions[channelId];
      delete state.chatHistories[channelId];

      const disabledEmbed = new EmbedBuilder()
        .setColor(0xFFA500)
        .setTitle('ปิดใช้งานประวัติการแชทระดับช่อง')
        .setDescription('ปิดใช้งานประวัติการสนทนาสำหรับช่องนี้แล้วนะคะ');
      await interaction.reply({
        embeds: [disabledEmbed],
        ephemeral: false
      });
    }
  } catch (error) {
    console.error('Error in toggleChannelChatHistory:', error);
  }
}

async function handleStatusCommand(interaction) {
  try {
    await interaction.deferReply();

    let interval;

    const updateMessage = async () => {
      try {
        const [{
          totalMemMb,
          usedMemMb,
          freeMemMb,
          freeMemPercentage
        }, cpuPercentage] = await Promise.all([
          mem.info(),
          cpu.usage()
        ]);

        const now = new Date();
        const nextReset = new Date();
        nextReset.setHours(0, 0, 0, 0);
        if (nextReset <= now) {
          nextReset.setDate(now.getDate() + 1);
        }
        const timeLeftMillis = nextReset - now;
        const hours = Math.floor(timeLeftMillis / 3600000);
        const minutes = Math.floor((timeLeftMillis % 3600000) / 60000);
        const seconds = Math.floor((timeLeftMillis % 60000) / 1000);
        const timeLeft = `${hours}h ${minutes}m ${seconds}s`;

        const embed = new EmbedBuilder()
          .setColor(hexColour)
          .setTitle('System Information')
          .addFields({
            name: 'Memory (RAM)',
            value: `Total Memory: \`${totalMemMb}\` MB\nUsed Memory: \`${usedMemMb}\` MB\nFree Memory: \`${freeMemMb}\` MB\nPercentage Of Free Memory: \`${freeMemPercentage}\`%`,
            inline: true
          }, {
            name: 'CPU',
            value: `Percentage of CPU Usage: \`${cpuPercentage}\`%`,
            inline: true
          }, {
            name: 'Time Until Next Reset',
            value: timeLeft,
            inline: true
          })
          .setTimestamp();

        await interaction.editReply({
          embeds: [embed]
        });
      } catch (error) {
        console.error('Error updating message:', error);
        if (interval) clearInterval(interval);
      }
    };

    await updateMessage();

    const message = await interaction.fetchReply();
    await addSettingsButton(message);

    interval = setInterval(updateMessage, 2000);

    setTimeout(() => {
      clearInterval(interval);
    }, 30000);

  } catch (error) {
    console.error('Error in handleStatusCommand function:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({
        content: 'An error occurred while fetching system status.',
        embeds: [],
        components: []
      });
    } else {
      await interaction.reply({
        content: 'An error occurred while fetching system status.',
        ephemeral: true
      });
    }
  }
}

async function handleBlacklistCommand(interaction) {
  try {
    if (interaction.channel.type === ChannelType.DM) {
      const dmEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('ใช้ใน DM ไม่ได้นะคะ')
        .setDescription('คำสั่งนี้ไม่สามารถใช้งานในข้อความส่วนตัวได้ค่ะ');
      return interaction.reply({
        embeds: [dmEmbed],
        flags: MessageFlags.Ephemeral
      });
    }

    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      const adminEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('ต้องเป็นแอดมินนะคะ')
        .setDescription('คำสั่งนี้สำหรับผู้ดูแลระบบเท่านั้นค่ะ');
      return interaction.reply({
        embeds: [adminEmbed],
        flags: MessageFlags.Ephemeral
      });
    }

    const userId = interaction.options.getUser('user').id;
    const guildId = interaction.guild.id;

    initializeBlacklistForGuild(guildId);

    if (!state.blacklistedUsers[guildId].includes(userId)) {
      state.blacklistedUsers[guildId].push(userId);
      const blacklistedEmbed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('เพิ่มเข้าแบล็คลิสต์แล้วค่ะ')
        .setDescription(`เพิ่ม <@${userId}> เข้าไปในแบล็คลิสต์เรียบร้อยแล้วค่ะ`);
      await interaction.reply({
        embeds: [blacklistedEmbed]
      });
    } else {
      const alreadyBlacklistedEmbed = new EmbedBuilder()
        .setColor(0xFFA500)
        .setTitle('อยู่ในแบล็คลิสต์อยู่แล้ว')
        .setDescription(`<@${userId}> อยู่ในแบล็คลิสต์อยู่แล้วนะคะ`);
      await interaction.reply({
        embeds: [alreadyBlacklistedEmbed]
      });
    }
  } catch (error) {
    console.log(error.message);
  }
}

async function handleWhitelistCommand(interaction) {
  try {
    if (interaction.channel.type === ChannelType.DM) {
      const dmEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('ใช้ใน DM ไม่ได้นะคะ')
        .setDescription('คำสั่งนี้ไม่สามารถใช้งานในข้อความส่วนตัวได้ค่ะ');
      return interaction.reply({
        embeds: [dmEmbed],
        flags: MessageFlags.Ephemeral
      });
    }

    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      const adminEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('ต้องเป็นแอดมินนะคะ')
        .setDescription('คำสั่งนี้สำหรับผู้ดูแลระบบเท่านั้นค่ะ');
      return interaction.reply({
        embeds: [adminEmbed],
        flags: MessageFlags.Ephemeral
      });
    }

    const userId = interaction.options.getUser('user').id;
    const guildId = interaction.guild.id;

    initializeBlacklistForGuild(guildId);

    const index = state.blacklistedUsers[guildId].indexOf(userId);
    if (index > -1) {
      state.blacklistedUsers[guildId].splice(index, 1);
      const removedEmbed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('นำออกจากแบล็คลิสต์แล้วค่ะ')
        .setDescription(`นำ <@${userId}> ออกจากแบล็คลิสต์เรียบร้อยแล้วค่ะ`);
      await interaction.reply({
        embeds: [removedEmbed]
      });
    } else {
      const notFoundEmbed = new EmbedBuilder()
        .setColor(0xFFA500)
        .setTitle('ไม่พบผู้ใช้ในแบล็คลิสต์')
        .setDescription(`<@${userId}> ไม่ได้อยู่ในแบล็คลิสต์นะคะ`);
      await interaction.reply({
        embeds: [notFoundEmbed]
      });
    }
  } catch (error) {
    console.log(error.message);
  }
}

async function setCustomPersonality(interaction) {
  const customId = 'custom-personality-input';
  const title = 'ตั้งค่าบุคลิกภาพ';

  const input = new TextInputBuilder()
    .setCustomId(customId)
    .setLabel("อยากให้มีบุคลิกแบบไหนคะ?")
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder("ลองอธิบายบุคลิกที่อยากให้เป็นที่นี่ได้เลยค่ะ...")
    .setMinLength(10)
    .setMaxLength(4000);

  const modal = new ModalBuilder()
    .setCustomId('custom-personality-modal')
    .setTitle(title)
    .addComponents(new ActionRowBuilder().addComponents(input));

  await interaction.showModal(modal);
}

async function downloadMessage(interaction) {
  try {
    const message = interaction.message;
    let textContent = message.content;
    if (!textContent && message.embeds.length > 0) {
      textContent = message.embeds[0].description;
    }

    if (!textContent) {
      const emptyEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('ข้อความว่างเปล่า?')
        .setDescription('เอ... เหมือนจะไม่มีเนื้อหาในข้อความนี้นะคะ');
      await interaction.reply({
        embeds: [emptyEmbed],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const filePath = path.join(TEMP_DIR, `message_content_${interaction.id}.txt`);
    await fs.writeFile(filePath, textContent, 'utf8');

    const attachment = new AttachmentBuilder(filePath, {
      name: 'message_content.txt'
    });

    const initialEmbed = new EmbedBuilder()
      .setColor(0xFFFFFF)
      .setTitle('บันทึกเนื้อหาข้อความแล้ว')
      .setDescription(`นี่คือเนื้อหาจากข้อความที่คุณต้องการบันทึกค่ะ`);

    let response;
    if (interaction.channel.type === ChannelType.DM) {
      response = await interaction.reply({
        embeds: [initialEmbed],
        files: [attachment],
        withResponse: true
      });
    } else {
      try {
        response = await interaction.user.send({
          embeds: [initialEmbed],
          files: [attachment]
        });
        const dmSentEmbed = new EmbedBuilder()
          .setColor(0x00FF00)
          .setTitle('ส่งให้ทาง DM แล้วนะคะ')
          .setDescription('ส่งเนื้อหาข้อความไปให้ในข้อความส่วนตัวแล้วค่ะ');
        await interaction.reply({
          embeds: [dmSentEmbed],
          flags: MessageFlags.Ephemeral
        });
      } catch (error) {
        console.error(`Failed to send DM: ${error}`);
        const failDMEmbed = new EmbedBuilder()
          .setColor(0xFF0000)
          .setTitle('ส่งไม่สำเร็จค่ะ')
          .setDescription('ขออภัยนะคะ ไม่สามารถส่งเนื้อหาไปที่ข้อความส่วนตัวของคุณได้');
        response = await interaction.reply({
          embeds: [failDMEmbed],
          files: [attachment],
          flags: MessageFlags.Ephemeral,
          withResponse: true
        });
      }
    }

    await fs.unlink(filePath);

    const msgUrl = await uploadText(textContent);
    const updatedEmbed = EmbedBuilder.from(response.embeds[0])
      .setDescription(`นี่คือเนื้อหาจากข้อความที่คุณต้องการบันทึกค่ะ\n${msgUrl}`);

    if (interaction.channel.type === ChannelType.DM) {
      await interaction.editReply({
        embeds: [updatedEmbed]
      });
    } else {
      await response.edit({
        embeds: [updatedEmbed]
      });
    }

  } catch (error) {
    console.log('Failed to process download: ', error);
  }
}

const uploadText = async (text) => {
  const siteUrl = 'https://bin.mudfish.net';
  try {
    const response = await axios.post(`${siteUrl}/api/text`, {
      text: text,
      ttl: 10080
    }, {
      timeout: 3000
    });

    const key = response.data.tid;
    return `\nURL: ${siteUrl}/t/${key}`;
  } catch (error) {
    console.log(error);
    return '\nURL Error :(';
  }
};

async function downloadConversation(interaction) {
  try {
    const userId = interaction.user.id;
    const conversationHistory = getHistory(userId);

    if (!conversationHistory || conversationHistory.length === 0) {
      const noHistoryEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('ไม่พบประวัติการสนทนา')
        .setDescription('ยังไม่มีประวัติการคุยกันเลยค่ะ ลองคุยกันก่อนนะคะ');
      await interaction.reply({
        embeds: [noHistoryEmbed],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    let conversationText = conversationHistory.map(entry => {
      const role = entry.role === 'user' ? '[User]' : '[Model]';
      const content = entry.parts.map(c => c.text).join('\n');
      return `${role}:\n${content}\n\n`;
    }).join('');

    const tempFileName = path.join(TEMP_DIR, `conversation_${interaction.id}.txt`);
    await fs.writeFile(tempFileName, conversationText, 'utf8');

    const file = new AttachmentBuilder(tempFileName, {
      name: 'conversation_history.txt'
    });

    try {
      if (interaction.channel.type === ChannelType.DM) {
        await interaction.reply({
          content: "> `นี่คือประวัติการสนทนาของคุณค่ะ:`",
          files: [file]
        });
      } else {
        await interaction.user.send({
          content: "> `นี่คือประวัติการสนทนาของคุณค่ะ:`",
          files: [file]
        });
        const dmSentEmbed = new EmbedBuilder()
          .setColor(0x00FF00)
          .setTitle('ส่งประวัติการคุยให้แล้วนะคะ')
          .setDescription('ส่งไฟล์ประวัติการสนทนาไปให้ในข้อความส่วนตัวแล้วค่ะ');
        await interaction.reply({
          embeds: [dmSentEmbed],
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (error) {
      console.error(`Failed to send DM: ${error}`);
      const failDMEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('ส่งไม่สำเร็จค่ะ')
        .setDescription('ขออภัยนะคะ ไม่สามารถส่งประวัติการสนทนาไปที่ข้อความส่วนตัวของคุณได้');
      await interaction.reply({
        embeds: [failDMEmbed],
        files: [file],
        flags: MessageFlags.Ephemeral
      });
    } finally {
      await fs.unlink(tempFileName);
    }
  } catch (error) {
    console.log(`Failed to download conversation: ${error.message}`);
  }
}


async function removeCustomPersonality(interaction) {
  try {
    delete state.customInstructions[interaction.user.id];
    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle('ลบเรียบร้อยค่ะ')
      .setDescription('ลบการตั้งค่าบุคลิกภาพของคุณแล้ว กลับไปใช้บุคลิกภาพเริ่มต้นนะคะ');

    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    console.log(error.message);
  }
}

async function toggleUserResponsePreference(interaction) {
  try {
    const userId = interaction.user.id;
    const currentPreference = getUserResponsePreference(userId);
    state.userResponsePreference[userId] = currentPreference === 'Normal' ? 'Embedded' : 'Normal';
    await handleSubButtonInteraction(interaction, true);
  } catch (error) {
    console.log(error.message);
  }
}

async function toggleToolPreference(interaction) {
  try {
    const userId = interaction.user.id;
    const currentPreference = getUserToolPreference(userId);

    const options = ['Google Search with URL Context', 'Code Execution'];
    const currentIndex = options.indexOf(currentPreference);
    const nextIndex = (currentIndex + 1) % options.length;
    state.userToolPreference[userId] = options[nextIndex];

    await handleSubButtonInteraction(interaction, true);
  } catch (error) {
    console.log(error.message);
  }
}

async function toggleServerWideChatHistory(interaction) {
  try {
    if (!interaction.guild) {
      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('ใช้ได้แค่ในเซิร์ฟเวอร์นะคะ')
        .setDescription('คำสั่งนี้สามารถใช้ได้ในเซิร์ฟเวอร์เท่านั้นค่ะ');
      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const serverId = interaction.guild.id;
    initializeBlacklistForGuild(serverId);

    state.serverSettings[serverId].serverChatHistory = !state.serverSettings[serverId].serverChatHistory;
    const statusMessage = `ตอนนี้ประวัติการแชททั่วทั้งเซิร์ฟเวอร์ถูก \`${state.serverSettings[serverId].serverChatHistory ? "เปิดใช้งาน" : "ปิดใช้งาน"}\` แล้วค่ะ`;

    let warningMessage = "";
    if (state.serverSettings[serverId].serverChatHistory && !state.serverSettings[serverId].customServerPersonality) {
      warningMessage = "\n\n⚠️ **คำเตือน:** การเปิดประวัติการแชทของเซิร์ฟเวอร์โดยไม่เปิดใช้บุคลิกภาพสำหรับเซิร์ฟเวอร์ด้วย อาจทำให้สับสนได้นะคะ เพราะจะใช้ความจำร่วมกับผู้ใช้คนอื่นค่ะ";
    }

    const embed = new EmbedBuilder()
      .setColor(state.serverSettings[serverId].serverChatHistory ? 0x00FF00 : 0xFF0000)
      .setTitle('สลับสถานะประวัติการแชท')
      .setDescription(statusMessage + warningMessage);

    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    console.log('Error toggling server-wide chat history:', error.message);
  }
}

async function toggleServerPersonality(interaction) {
  try {
    if (!interaction.guild) {
      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('ใช้ได้แค่ในเซิร์ฟเวอร์นะคะ')
        .setDescription('คำสั่งนี้สามารถใช้ได้ในเซิร์ฟเวอร์เท่านั้นค่ะ');
      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const serverId = interaction.guild.id;
    initializeBlacklistForGuild(serverId);

    state.serverSettings[serverId].customServerPersonality = !state.serverSettings[serverId].customServerPersonality;
    const statusMessage = `Server-wide Personality is now \`${state.serverSettings[serverId].customServerPersonality ? "enabled" : "disabled"}\``;

    const embed = new EmbedBuilder()
      .setColor(state.serverSettings[serverId].customServerPersonality ? 0x00FF00 : 0xFF0000)
      .setTitle('สลับสถานะบุคลิกภาพเซิร์ฟเวอร์')
      .setDescription(statusMessage);

    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    console.log('Error toggling server-wide personality:', error.message);
  }
}

async function toggleServerResponsePreference(interaction) {
  try {
    if (!interaction.guild) {
      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('ใช้ได้แค่ในเซิร์ฟเวอร์นะคะ')
        .setDescription('คำสั่งนี้สามารถใช้ได้ในเซิร์ฟเวอร์เท่านั้นค่ะ');
      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const serverId = interaction.guild.id;
    initializeBlacklistForGuild(serverId);

    state.serverSettings[serverId].serverResponsePreference = !state.serverSettings[serverId].serverResponsePreference;
    const statusMessage = `ตอนนี้การตั้งค่ารูปแบบการตอบกลับสำหรับทั้งเซิร์ฟเวอร์ถูก \`${state.serverSettings[serverId].serverResponsePreference ? "เปิดใช้งาน" : "ปิดใช้งาน"}\` แล้วค่ะ`;

    const embed = new EmbedBuilder()
      .setColor(state.serverSettings[serverId].serverResponsePreference ? 0x00FF00 : 0xFF0000)
      .setTitle('สลับสถานะรูปแบบการตอบกลับ')
      .setDescription(statusMessage);

    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    console.log('Error toggling server-wide response preference:', error.message);
  }
}

async function toggleSettingSaveButton(interaction) {
  try {
    if (!interaction.guild) {
      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('ใช้ได้แค่ในเซิร์ฟเวอร์นะคะ')
        .setDescription('คำสั่งนี้สามารถใช้ได้ในเซิร์ฟเวอร์เท่านั้นค่ะ');
      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const serverId = interaction.guild.id;
    initializeBlacklistForGuild(serverId);

    state.serverSettings[serverId].settingsSaveButton = !state.serverSettings[serverId].settingsSaveButton;
    const statusMessage = `ตอนนี้ปุ่ม "ตั้งค่าและบันทึก" สำหรับทั้งเซิร์ฟเวอร์ถูก \`${state.serverSettings[serverId].settingsSaveButton ? "เปิดใช้งาน" : "ปิดใช้งาน"}\` แล้วค่ะ`;

    const embed = new EmbedBuilder()
      .setColor(state.serverSettings[serverId].settingsSaveButton ? 0x00FF00 : 0xFF0000)
      .setTitle('สลับสถานะปุ่มตั้งค่าและบันทึก')
      .setDescription(statusMessage);

    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    console.log('Error toggling server-wide settings save button:', error.message);
  }
}

async function serverPersonality(interaction) {
  const customId = 'custom-server-personality-input';
  const title = 'Enter Custom Personality Instructions';

  const input = new TextInputBuilder()
    .setCustomId(customId)
    .setLabel("อยากให้มีบุคลิกแบบไหนคะ?")
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder("ลองอธิบายบุคลิกที่อยากให้เป็นที่นี่ได้เลยค่ะ...")
    .setMinLength(10)
    .setMaxLength(4000);

  const modal = new ModalBuilder()
    .setCustomId('custom-server-personality-modal')
    .setTitle(title)
    .addComponents(new ActionRowBuilder().addComponents(input));

  await interaction.showModal(modal);
}

async function clearServerChatHistory(interaction) {
  try {
    if (!interaction.guild) {
      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('ใช้ได้แค่ในเซิร์ฟเวอร์นะคะ')
        .setDescription('คำสั่งนี้สามารถใช้ได้ในเซิร์ฟเวอร์เท่านั้นค่ะ');
      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const serverId = interaction.guild.id;
    initializeBlacklistForGuild(serverId);

    if (state.serverSettings[serverId].serverChatHistory) {
      state.chatHistories[serverId] = {};
      const clearedEmbed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('ล้างประวัติการคุยแล้วค่ะ')
        .setDescription('ล้างประวัติการสนทนาของทั้งเซิร์ฟเวอร์เรียบร้อยแล้วค่ะ');
      await interaction.reply({
        embeds: [clearedEmbed],
        flags: MessageFlags.Ephemeral
      });
    } else {
      const disabledEmbed = new EmbedBuilder()
        .setColor(0xFFA500)
        .setTitle('คุณสมบัตินี้ปิดอยู่ค่ะ')
        .setDescription('ประวัติการแชทของเซิร์ฟเวอร์ปิดใช้งานอยู่ เลยยังล้างไม่ได้นะคะ');
      await interaction.reply({
        embeds: [disabledEmbed],
        flags: MessageFlags.Ephemeral
      });
    }
  } catch (error) {
    console.log('Failed to clear server-wide chat history:', error.message);
  }
}

async function downloadServerConversation(interaction) {
  try {
    const guildId = interaction.guild.id;
    const conversationHistory = getHistory(guildId);

    if (!conversationHistory || conversationHistory.length === 0) {
      const noHistoryEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('ไม่พบประวัติการสนทนา')
        .setDescription('ยังไม่มีประวัติการคุยกันของเซิร์ฟเวอร์เลยค่ะ');
      await interaction.reply({
        embeds: [noHistoryEmbed],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const conversationText = conversationHistory.map(entry => {
      const role = entry.role === 'user' ? '[User]' : '[Model]';
      const content = entry.parts.map(c => c.text).join('\n');
      return `${role}:\n${content}\n\n`;
    }).join('');

    const tempFileName = path.join(TEMP_DIR, `server_conversation_${interaction.id}.txt`);
    await fs.writeFile(tempFileName, conversationText, 'utf8');

    const file = new AttachmentBuilder(tempFileName, {
      name: 'server_conversation_history.txt'
    });

    try {
      if (interaction.channel.type === ChannelType.DM) {
        await interaction.reply({
          content: "> `นี่คือประวัติการสนทนาของเซิร์ฟเวอร์ค่ะ:`",
          files: [file]
        });
      } else {
        await interaction.user.send({
          content: "> `นี่คือประวัติการสนทนาของเซิร์ฟเวอร์ค่ะ:`",
          files: [file]
        });
        const dmSentEmbed = new EmbedBuilder()
          .setColor(0x00FF00)
          .setTitle('ส่งประวัติการคุยให้แล้วนะคะ')
          .setDescription('ส่งไฟล์ประวัติการสนทนาของเซิร์ฟเวอร์ไปให้ในข้อความส่วนตัวแล้วค่ะ');
        await interaction.reply({
          embeds: [dmSentEmbed],
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (error) {
      console.error(`Failed to send DM: ${error}`);
      const failDMEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('ส่งไม่สำเร็จค่ะ')
        .setDescription('ขออภัยนะคะ ไม่สามารถส่งประวัติการสนทนาของเซิร์ฟเวอร์ไปที่ข้อความส่วนตัวของคุณได้');
      await interaction.reply({
        embeds: [failDMEmbed],
        files: [file],
        flags: MessageFlags.Ephemeral
      });
    } finally {
      await fs.unlink(tempFileName);
    }
  } catch (error) {
    console.log(`Failed to download server conversation: ${error.message}`);
  }
}


async function toggleServerPreference(interaction) {
  try {
    const guildId = interaction.guild.id;
    if (state.serverSettings[guildId].responseStyle === "Embedded") {
      state.serverSettings[guildId].responseStyle = "Normal";
    } else {
      state.serverSettings[guildId].responseStyle = "Embedded";
    }
    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle('อัปเดตรูปแบบการตอบกลับแล้ว')
      .setDescription(`เปลี่ยนรูปแบบการตอบกลับของเซิร์ฟเวอร์เป็นแบบ: ${state.serverSettings[guildId].responseStyle} แล้วนะคะ`);

    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    console.log(error.message);
  }
}

async function showSettings(interaction, edit = false) {
  try {
    if (interaction.guild) {
      initializeBlacklistForGuild(interaction.guild.id);
      if (state.blacklistedUsers[interaction.guild.id].includes(interaction.user.id)) {
        const embed = new EmbedBuilder()
          .setColor(0xFF0000)
          .setTitle('อุ๊ย! อยู่ในแบล็คลิสต์')
          .setDescription('ขออภัยนะคะ ดูเหมือนว่าคุณจะอยู่ในแบล็คลิสต์ เลยยังใช้งานส่วนนี้ไม่ได้ค่ะ');
        return interaction.reply({
          embeds: [embed],
          flags: MessageFlags.Ephemeral
        });
      }
    }

    const mainButtons = [{
        customId: 'clear-memory',
        label: 'ล้างความจำ',
        emoji: '🧹',
        style: ButtonStyle.Danger
      },
      {
        customId: 'general-settings',
        label: 'ตั้งค่าทั่วไป',
        emoji: '⚙️',
        style: ButtonStyle.Secondary
      },
    ];

    const mainButtonsComponents = mainButtons.map(config =>
      new ButtonBuilder()
      .setCustomId(config.customId)
      .setLabel(config.label)
      .setEmoji(config.emoji)
      .setStyle(config.style)
    );

    const mainActionRow = new ActionRowBuilder().addComponents(...mainButtonsComponents);

    const embed = new EmbedBuilder()
      .setColor(0x00FFFF)
      .setTitle('การตั้งค่า')
      .setDescription('เลือกหัวข้อที่ต้องการตั้งค่าจากปุ่มด้านล่างได้เลยค่ะ:');
    if (edit) {
      await interaction.update({
        embeds: [embed],
        components: [mainActionRow],
        flags: MessageFlags.Ephemeral
      });
    } else {
      await interaction.reply({
        embeds: [embed],
        components: [mainActionRow],
        flags: MessageFlags.Ephemeral
      });
    }
  } catch (error) {
    console.error('Error showing settings:', error.message);
  }
}

async function handleSubButtonInteraction(interaction, update = false) {
  const channelId = interaction.channel.id;
  const userId = interaction.user.id;
  if (!state.activeUsersInChannels[channelId]) {
    state.activeUsersInChannels[channelId] = {};
  }
  const responseMode = getUserResponsePreference(userId);
  const toolMode = getUserToolPreference(userId);
  const subButtonConfigs = {
    'general-settings': [{
        customId: 'always-respond',
        label: `ตอบกลับเสมอ: ${state.activeUsersInChannels[channelId][userId] ? 'เปิด' : 'ปิด'}`,
        emoji: '↩️',
        style: ButtonStyle.Secondary
      },
      {
        customId: 'toggle-response-mode',
        label: `รูปแบบการตอบ: ${responseMode}`,
        emoji: '📝',
        style: ButtonStyle.Secondary
      },
      {
        customId: 'toggle-tool-preference',
        label: `เครื่องมือ: ${toolMode}`,
        emoji: '🛠️',
        style: ButtonStyle.Secondary
      },
      {
        customId: 'download-conversation',
        label: 'ดาวน์โหลดประวัติการคุย',
        emoji: '🗃️',
        style: ButtonStyle.Secondary
      },
      ...(shouldDisplayPersonalityButtons ? [{
          customId: 'custom-personality',
          label: 'ตั้งค่าบุคลิก',
          emoji: '🙌',
          style: ButtonStyle.Primary
        },
        {
          customId: 'remove-personality',
          label: 'ลบบุคลิก',
          emoji: '🤖',
          style: ButtonStyle.Danger
        },
      ] : []),
      {
        customId: 'back_to_main_settings',
        label: 'กลับ',
        emoji: '🔙',
        style: ButtonStyle.Secondary
      },
    ],
  };

  if (update || subButtonConfigs[interaction.customId]) {
    const subButtons = subButtonConfigs[update ? 'general-settings' : interaction.customId].map(config =>
      new ButtonBuilder()
      .setCustomId(config.customId)
      .setLabel(config.label)
      .setEmoji(config.emoji)
      .setStyle(config.style)
    );

    const actionRows = [];
    while (subButtons.length > 0) {
      actionRows.push(new ActionRowBuilder().addComponents(subButtons.splice(0, 5)));
    }

    await interaction.update({
      embeds: [
        new EmbedBuilder()
        .setColor(0x00FFFF)
        .setTitle(`${update ? 'ตั้งค่าทั่วไป' : interaction.customId.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')}`)
        .setDescription('เลือกตัวเลือกที่ต้องการจากปุ่มด้านล่างได้เลยค่ะ:'),
      ],
      components: actionRows,
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function showDashboard(interaction) {
  if (interaction.channel.type === ChannelType.DM) {
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('ใช้ใน DM ไม่ได้นะคะ')
      .setDescription('คำสั่งนี้ไม่สามารถใช้งานในข้อความส่วนตัวได้ค่ะ');
    return interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('ต้องเป็นแอดมินนะคะ')
      .setDescription('คำสั่งนี้สำหรับผู้ดูแลระบบเท่านั้นค่ะ');
    return interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }
  initializeBlacklistForGuild(interaction.guild.id);
  const buttonConfigs = [{
      customId: "server-chat-history",
      label: "เปิด/ปิด ประวัติการคุยของเซิร์ฟเวอร์",
      emoji: "📦",
      style: ButtonStyle.Primary,
    },
    {
      customId: "clear-server",
      label: "ล้างความจำของเซิร์ฟเวอร์",
      emoji: "🧹",
      style: ButtonStyle.Danger,
    },
    {
      customId: "settings-save-buttons",
      label: "เปิด/ปิด ปุ่มตั้งค่าและบันทึก",
      emoji: "🔘",
      style: ButtonStyle.Primary,
    },
    {
      customId: "toggle-server-personality",
      label: "เปิด/ปิด บุคลิกของเซิร์ฟเวอร์",
      emoji: "🤖",
      style: ButtonStyle.Primary,
    },
    {
      customId: "custom-server-personality",
      label: "ตั้งค่าบุคลิกเซิร์ฟเวอร์",
      emoji: "🙌",
      style: ButtonStyle.Primary,
    },
    {
      customId: "toggle-response-server-mode",
      label: "เปิด/ปิด รูปแบบการตอบของเซิร์ฟเวอร์",
      emoji: "✏️",
      style: ButtonStyle.Primary,
    },
    {
      customId: "response-server-mode",
      label: "รูปแบบการตอบของเซิร์ฟเวอร์",
      emoji: "📝",
      style: ButtonStyle.Secondary,
    },
    {
      customId: "download-server-conversation",
      label: "ดาวน์โหลดประวัติการคุยของเซิร์ฟเวอร์",
      emoji: "🗃️",
      style: ButtonStyle.Secondary,
    }
  ];

  const allButtons = buttonConfigs.map((config) =>
    new ButtonBuilder()
    .setCustomId(config.customId)
    .setLabel(config.label)
    .setEmoji(config.emoji)
    .setStyle(config.style)
  );

  const actionRows = [];
  while (allButtons.length > 0) {
    actionRows.push(
      new ActionRowBuilder().addComponents(allButtons.splice(0, 5))
    );
  }

  const embed = new EmbedBuilder()
    .setColor(0xFFFFFF)
    .setTitle('การตั้งค่าเซิร์ฟเวอร์')
    .setDescription('นี่คือการตั้งค่าสำหรับเซิร์ฟเวอร์ของคุณค่ะ:');
  await interaction.reply({
    embeds: [embed],
    components: actionRows,
    flags: MessageFlags.Ephemeral
  });
}

// <==========>



// <=====[Others]=====>

async function addDownloadButton(botMessage) {
  try {
    const messageComponents = botMessage.components || [];
    const downloadButton = new ButtonBuilder()
      .setCustomId('download_message')
      .setLabel('บันทึก')
      .setEmoji('⬇️')
      .setStyle(ButtonStyle.Secondary);

    let actionRow;
    if (messageComponents.length > 0 && messageComponents[0].type === ComponentType.ActionRow) {
      actionRow = ActionRowBuilder.from(messageComponents[0]);
    } else {
      actionRow = new ActionRowBuilder();
    }

    actionRow.addComponents(downloadButton);
    return await botMessage.edit({
      components: [actionRow]
    });
  } catch (error) {
    console.error('Error adding download button:', error.message);
    return botMessage;
  }
}

async function addDeleteButton(botMessage, msgId) {
  try {
    const messageComponents = botMessage.components || [];
    const downloadButton = new ButtonBuilder()
      .setCustomId(`delete_message-${msgId}`)
      .setLabel('ลบ')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Secondary);

    let actionRow;
    if (messageComponents.length > 0 && messageComponents[0].type === ComponentType.ActionRow) {
      actionRow = ActionRowBuilder.from(messageComponents[0]);
    } else {
      actionRow = new ActionRowBuilder();
    }

    actionRow.addComponents(downloadButton);
    return await botMessage.edit({
      components: [actionRow]
    });
  } catch (error) {
    console.error('Error adding delete button:', error.message);
    return botMessage;
  }
}

async function addSettingsButton(botMessage) {
  try {
    const settingsButton = new ButtonBuilder()
      .setCustomId('settings')
      .setEmoji('⚙️')
      .setStyle(ButtonStyle.Secondary);

    const actionRow = new ActionRowBuilder().addComponents(settingsButton);
    return await botMessage.edit({
      components: [actionRow]
    });
  } catch (error) {
    console.log('Error adding settings button:', error.message);
    return botMessage;
  }
}

// <==========>



// <=====[Model Response Handling]=====>

async function handleModelResponse(initialBotMessage, chat, parts, originalMessage, typingInterval, historyId) {
  const userId = originalMessage.author.id;
  const userResponsePreference = originalMessage.guild && state.serverSettings[originalMessage.guild.id]?.serverResponsePreference ? state.serverSettings[originalMessage.guild.id].responseStyle : getUserResponsePreference(userId);
  const maxCharacterLimit = userResponsePreference === 'Embedded' ? 3900 : 1900;
  let attempts = 3;

  let updateTimeout;
  let tempResponse = '';
  // Metadata from Google Search with URL Context tool
  let groundingMetadata = null;
  let urlContextMetadata = null;

  const stopGeneratingButton = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
      .setCustomId('stopGenerating')
      .setLabel('หยุดสร้าง')
      .setStyle(ButtonStyle.Danger)
    );
  let botMessage;
  if (!initialBotMessage) {
    clearInterval(typingInterval);
    try {
      botMessage = await originalMessage.reply({
        content: 'ขอคิดแป๊บนึงนะคะ..',
        components: [stopGeneratingButton]
      });
    } catch (error) {}
  } else {
    botMessage = initialBotMessage;
    try {
      botMessage.edit({
        components: [stopGeneratingButton]
      });
    } catch (error) {}
  }

  let stopGeneration = false;
  const filter = (interaction) => interaction.customId === 'stopGenerating';
  try {
    const collector = await botMessage.createMessageComponentCollector({
      filter,
      time: 120000
    });
    collector.on('collect', (interaction) => {
      if (interaction.user.id === originalMessage.author.id) {
        try {
          const embed = new EmbedBuilder()
            .setColor(0xFFA500)
            .setTitle('หยุดสร้างคำตอบแล้วค่ะ')
            .setDescription('หยุดการสร้างคำตอบตามที่คุณต้องการแล้วนะคะ');

          interaction.reply({
            embeds: [embed],
            flags: MessageFlags.Ephemeral
          });
        } catch (error) {
          console.error('Error sending reply:', error);
        }
        stopGeneration = true;
      } else {
        try {
          const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('ปุ่มนี้ไม่ใช่ของคุณน้า')
            .setDescription('ดูเหมือนว่าปุ่มนี้จะไม่ได้มีไว้สำหรับคุณนะคะ');

          interaction.reply({
            embeds: [embed],
            flags: MessageFlags.Ephemeral
          });
        } catch (error) {
          console.error('Error sending unauthorized reply:', error);
        }
      }
    });
  } catch (error) {
    console.error('Error creating or handling collector:', error);
  }

  const updateMessage = () => {
    if (stopGeneration) {
      return;
    }
    if (tempResponse.trim() === "") {
      botMessage.edit({
        content: '...'
      });
    } else if (userResponsePreference === 'Embedded') {
      updateEmbed(botMessage, tempResponse, originalMessage, groundingMetadata, urlContextMetadata);
    } else {
      botMessage.edit({
        content: tempResponse,
        embeds: []
      });
    }
    clearTimeout(updateTimeout);
    updateTimeout = null;
  };

  while (attempts > 0 && !stopGeneration) {
    try {
      let finalResponse = '';
      let isLargeResponse = false;
      const newHistory = [];
      newHistory.push({
        role: 'user',
        content: parts
      });
      async function getResponse(parts) {
        let newResponse = '';
        const messageResult = await chat.sendMessageStream({
          message: parts
        });
        for await (const chunk of messageResult) {
          if (stopGeneration) break;

          const chunkText = chunk.text;
          if (chunkText && chunkText !== '') {
            finalResponse += chunkText;
            tempResponse += chunkText;
            newResponse += chunkText;
          }

          // Capture grounding metadata from Google Search with URL Context tool
          if (chunk.candidates && chunk.candidates[0]?.groundingMetadata) {
            groundingMetadata = chunk.candidates[0].groundingMetadata;
          }

          // Capture URL context metadata from Google Search with URL Context tool
          if (chunk.candidates && chunk.candidates[0]?.url_context_metadata) {
            urlContextMetadata = chunk.candidates[0].url_context_metadata;
          }

          if (finalResponse.length > maxCharacterLimit) {
            if (!isLargeResponse) {
              isLargeResponse = true;
              const embed = new EmbedBuilder()
                .setColor(0xFFFF00)
                .setTitle('คำตอบยาวเกินไป')
                .setDescription('คำตอบยาวไปหน่อยนะคะ เดี๋ยวพอสร้างเสร็จแล้วจะส่งเป็นไฟล์ให้นะคะ');

              botMessage.edit({
                embeds: [embed]
              });
            }
          } else if (!updateTimeout) {
            updateTimeout = setTimeout(updateMessage, 500);
          }
        }
        newHistory.push({
          role: 'assistant',
          content: [{
            text: newResponse
          }]
        });
      }
      await getResponse(parts);

      // Final update to ensure grounding and URL context metadata is displayed in embedded responses
      if (!isLargeResponse && userResponsePreference === 'Embedded') {
        updateEmbed(botMessage, finalResponse, originalMessage, groundingMetadata, urlContextMetadata);
      }

      botMessage = await addSettingsButton(botMessage);
      if (isLargeResponse) {
        sendAsTextFile(finalResponse, originalMessage, botMessage.id);
        botMessage = await addDeleteButton(botMessage, botMessage.id);
      } else {
        const shouldAddDownloadButton = originalMessage.guild ? state.serverSettings[originalMessage.guild.id]?.settingsSaveButton : true;
        if (shouldAddDownloadButton) {
          botMessage = await addDownloadButton(botMessage);
          botMessage = await addDeleteButton(botMessage, botMessage.id);
        } else {
          botMessage.edit({
            components: []
          });
        }
      }

      await chatHistoryLock.runExclusive(async () => {
        updateChatHistory(historyId, newHistory, botMessage.id);
        await saveStateToFile();
      });
      break;
    } catch (error) {
      if (activeRequests.has(userId)) {
        activeRequests.delete(userId);
      }
      console.error('Generation Attempt Failed: ', error);
      attempts--;

      if (attempts === 0 || stopGeneration) {
        if (!stopGeneration) {
          if (SEND_RETRY_ERRORS_TO_DISCORD) {
            const embed = new EmbedBuilder()
              .setColor(0xFF0000)
              .setTitle('สร้างคำตอบไม่สำเร็จ')
              .setDescription(`พยายามสร้างคำตอบหลายครั้งแล้วแต่ไม่สำเร็จค่ะ :(\n\`\`\`${error.message}\`\`\``);
            const errorMsg = await originalMessage.channel.send({
              content: `<@${originalMessage.author.id}>`,
              embeds: [embed]
            });
            await addSettingsButton(errorMsg);
            await addSettingsButton(botMessage);
          } else {
            const simpleErrorEmbed = new EmbedBuilder()
              .setColor(0xFF0000)
              .setTitle('ระบบอาจจะทำงานหนักไปหน่อย')
              .setDescription('เหมือนจะมีบางอย่างผิดปกตินะคะ ระบบอาจจะทำงานหนักเกินไป! :(');
            const errorMsg = await originalMessage.channel.send({
              content: `<@${originalMessage.author.id}>`,
              embeds: [simpleErrorEmbed]
            });
            await addSettingsButton(errorMsg);
            await addSettingsButton(botMessage);
          }
        }
        break;
      } else if (SEND_RETRY_ERRORS_TO_DISCORD) {
        const errorMsg = await originalMessage.channel.send({
          content: `<@${originalMessage.author.id}>`,
          embeds: [new EmbedBuilder()
            .setColor(0xFFFF00)
            .setTitle('กำลังลองใหม่อีกครั้ง')
            .setDescription(`การสร้างคำตอบล้มเหลว กำลังลองใหม่อีกครั้งนะคะ..\n\`\`\`${error.message}\`\`\``)
          ]
        });
        setTimeout(() => errorMsg.delete().catch(console.error), 5000);
        await delay(500);
      }
    }
  }
  if (activeRequests.has(userId)) {
    activeRequests.delete(userId);
  }
}

function updateEmbed(botMessage, finalResponse, message, groundingMetadata = null, urlContextMetadata = null) {
  try {
    const isGuild = message.guild !== null;
    const embed = new EmbedBuilder()
      .setColor(hexColour)
      .setDescription(finalResponse)
      .setAuthor({
        name: `ถึงคุณ ${message.author.displayName}`,
        iconURL: message.author.displayAvatarURL()
      })
      .setTimestamp();

    // Add grounding metadata if user has Google Search tool enabled and Embedded responses selected
    if (groundingMetadata && shouldShowGroundingMetadata(message)) {
      addGroundingMetadataToEmbed(embed, groundingMetadata);
    }

    // Add URL context metadata if user has Google Search tool enabled and Embedded responses selected
    if (urlContextMetadata && shouldShowGroundingMetadata(message)) {
      addUrlContextMetadataToEmbed(embed, urlContextMetadata);
    }

    if (isGuild) {
      embed.setFooter({
        text: message.guild.name,
        iconURL: message.guild.iconURL() || 'https://ai.google.dev/static/site-assets/images/share.png'
      });
    }

    botMessage.edit({
      content: ' ',
      embeds: [embed]
    });
  } catch (error) {
    console.error("An error occurred while updating the embed:", error.message);
  }
}

function addGroundingMetadataToEmbed(embed, groundingMetadata) {
  // Add search queries used by the model
  if (groundingMetadata.webSearchQueries && groundingMetadata.webSearchQueries.length > 0) {
    embed.addFields({
      name: '🔍 คำค้นหา',
      value: groundingMetadata.webSearchQueries.map(query => `• ${query}`).join('\n'),
      inline: false
    });
  }

  // Add grounding sources with clickable links
  if (groundingMetadata.groundingChunks && groundingMetadata.groundingChunks.length > 0) {
    const chunks = groundingMetadata.groundingChunks
      .slice(0, 5) // Limit to first 5 chunks to avoid embed limits
      .map((chunk, index) => {
        if (chunk.web) {
          return `• [${chunk.web.title || 'แหล่งข้อมูล'}](${chunk.web.uri})`;
        }
        return `• แหล่งข้อมูล ${index + 1}`;
      })
      .join('\n');
    
    embed.addFields({
      name: '📚 แหล่งข้อมูล',
      value: chunks,
      inline: false
    });
  }
}

function addUrlContextMetadataToEmbed(embed, urlContextMetadata) {
  // Add URL retrieval status with success/failure indicators
  if (urlContextMetadata.url_metadata && urlContextMetadata.url_metadata.length > 0) {
    const urlList = urlContextMetadata.url_metadata
      .map(urlData => {
        const emoji = urlData.url_retrieval_status === 'URL_RETRIEVAL_STATUS_SUCCESS' ? '✔️' : '❌';
        return `${emoji} ${urlData.retrieved_url}`;
      })
      .join('\n');
    
    embed.addFields({
      name: '🔗 URL Context',
      value: urlList,
      inline: false
    });
  }
}

function shouldShowGroundingMetadata(message) {
  // Only show grounding metadata when:
  // 1. User has "Google Search with URL Context" tool enabled
  // 2. User has "Embedded" response preference selected
  const userId = message.author.id;
  const userToolMode = getUserToolPreference(userId);
  const userResponsePreference = message.guild && state.serverSettings[message.guild.id]?.serverResponsePreference 
    ? state.serverSettings[message.guild.id].responseStyle 
    : getUserResponsePreference(userId);
  
  return userToolMode === 'Google Search with URL Context' && userResponsePreference === 'Embedded';
}

async function sendAsTextFile(text, message, orgId) {
  try {
    const filename = `response-${Date.now()}.txt`;
    const tempFilePath = path.join(TEMP_DIR, filename);
    await fs.writeFile(tempFilePath, text);

    const botMessage = await message.channel.send({
      content: `<@${message.author.id}>, Here is the response:`,
      files: [tempFilePath]
    });
    await addSettingsButton(botMessage);
    await addDeleteButton(botMessage, orgId);

    await fs.unlink(tempFilePath);
  } catch (error) {
    console.error('An error occurred:', error);
  }
}

// <==========>

client.login(token);  
