/**
 * Conversation context building utilities.
 * Resolves personality, history, and system instructions based on the
 * message's guild/channel/user context.
 */

import config from '../../config.js';
import { DEFAULT_PERSONALITY } from '../constants.js';
import {
  getActiveSessionHistoryId,
  getChannelSettings,
  getCustomInstruction,
  getUserResponsePreference,
  state,
} from '../state/botState.js';
import { logServiceError } from '../utils/errorHandler.js';
import {
  resolveConversationScope,
  resolveInstructionScope,
  resolveResponseStyle,
} from './scopeResolution.js';

function getConversationScope(message) {
  const guildId = message.guild?.id;
  const channelId = message.channel.id;

  return resolveConversationScope({
    guildId,
    channelId,
    userHistoryId: getActiveSessionHistoryId(message.author.id),
    channelWideChatHistory: getChannelSettings(channelId).channelWideChatHistory,
    serverWideChatHistory: Boolean(guildId ? state.serverSettings[guildId]?.serverChatHistory : false),
  });
}

/**
 * Resolve the effective response style for a message, checking channel -> server -> user preference.
 * @param {import('discord.js').Message} message - The Discord message.
 * @returns {string} "Embedded" or "Normal".
 */
export function getResponsePreference(message) {
  const guildId = message.guild?.id;
  const channelId = message.channel.id;
  const serverStyle = guildId ? state.serverSettings[guildId]?.responseStyle : null;
  const channelStyle = getChannelSettings(channelId).responseStyle;

  return resolveResponseStyle(
    channelStyle,
    serverStyle,
    getUserResponsePreference(message.author.id),
  );
}

/**
 * Resolve the personality instructions for a message, checking channel -> server -> user custom instructions.
 * @param {import('discord.js').Message} message - The Discord message.
 * @returns {string} The personality instructions string.
 */
export function resolveInstructions(message) {
  const guildId = message.guild?.id;
  const channelId = message.channel.id;
  const userId = message.author.id;
  const channelSettings = getChannelSettings(channelId);

  return resolveInstructionScope({
    guildId,
    channelId,
    userId,
    channelCustomEnabled: Boolean(channelSettings.customChannelPersonality),
    serverCustomEnabled: Boolean(guildId ? state.serverSettings[guildId]?.customServerPersonality : false),
    getInstruction: getCustomInstruction,
    defaultInstruction: DEFAULT_PERSONALITY,
  });
}

/**
 * Combine personality text with tool-specific guidance into the final system instruction.
 * @param {string} personality - The base personality instructions.
 * @param {Object} userToolPreferences - The user's Gemini tool preferences.
 * @returns {string} The assembled system instruction string.
 */
export function buildFinalSystemInstruction(personality, userToolPreferences) {
  const sections = [
    personality,
    [
      'You are chatting with the user through a Discord bot. You are a multimodal model, equipped with the ability to read images, videos, and audio files.',
      '',
      '**ข้อจำกัดในการจัดรูปแบบ**',
      'ห้ามใช้การจัดรูปแบบด้วย LaTeX ในคำตอบของคุณ เนื่องจาก Discord ไม่รองรับการแสดงผลรูปแบบนี้โดยธรรมชาติ คุณจะสามารถสร้างข้อความในรูปแบบ LaTeX ได้ก็ต่อเมื่อผู้ใช้ร้องขออย่างชัดเจน*เท่านั้น*',
    ].join('\n'),
  ];

  if (userToolPreferences.codeExecution) {
    sections.push([
      '**การสร้างและการแชร์ไฟล์**',
      'หากผู้ใช้ร้องขอให้สร้าง ทำ หรือบันทึกไฟล์ คุณจะต้องตอบสนองคำขอโดยการใช้เครื่องมือประมวลผลโค้ด (Code Execution) เพื่อบันทึกไฟล์ลงในไดเรกทอรีทำงานปัจจุบันของคุณ โดยคุณสามารถใช้วิธีการหรือไลบรารีที่เหมาะสมในการบันทึกไฟล์ได้ (เช่น Python file I/O ทั่วไป, pandas.to_csv, matplotlib.pyplot.savefig, PIL.Image.save เป็นต้น) ทั้งนี้ ตัวระบบจัดการบอต Discord จะตรวจจับไฟล์ใดๆ ที่ถูกบันทึกในสภาพแวดล้อม Sandbox โดยอัตโนมัติ และส่งไฟล์เหล่านั้นไปยังผู้ใช้โดยตรงในรูปแบบไฟล์แนบในแชต',
      '* ขอแนะนำให้ใส่ลิงก์รูปแบบ Markdown ไปยังไฟล์ที่ถูกสร้างขึ้นในคำตอบสุดท้ายของคุณ โดยใช้รูปแบบที่ถูกต้องคือ [filename](sandbox:/filename) ซึ่งวิธีนี้จะช่วยให้บอตสามารถสกัดจับชื่อไฟล์ได้อย่างถูกต้อง',
      '* **สำคัญมาก:** ห้ามบอกผู้ใช้เด็ดขาดว่าคุณไม่สามารถส่งไฟล์ได้ ห้ามอ้างว่าสภาพแวดล้อมของคุณถูกแยกส่วน (Isolated), อยู่ใน Sandbox หรือไม่มีความสามารถในการแชร์ไฟล์ ให้บันทึกไฟล์ลงในสภาพแวดล้อมโดยใช้ Python เท่านั้น',
    ].join('\n'));
  }

  if (userToolPreferences.googleSearch) {
    sections.push([
      '**การค้นหาและวิจัยบนเว็บ**',
      'เมื่อใช้งานเครื่องมือ Google Search ขอให้มั่นใจว่าคุณทำการค้นคว้าอย่างถี่ถ้วนและครอบคลุม สำหรับหัวข้อที่มีความซับซ้อนหรือเฉพาะเจาะจง ให้ทำการค้นหาด้วยคีย์เวิร์ดที่หลากหลายหลายๆ ครั้ง และทำการตรวจสอบเช็กข้อมูลข้ามแหล่งอ้างอิง (Cross-reference) ก่อนที่จะสรุปคำตอบ',
    ].join('\n'));
  }

  return sections.join('\n\n').trim();
}

const MAX_CHANNEL_MESSAGE_LENGTH = 500;

/**
 * Fetches recent messages from the Discord channel and formats them
 * as a context section for the system instructions.
 */
async function fetchRecentChannelMessages(message) {
  const limit = config.recentChannelMessagesLimit || 20;

  try {
    const fetched = await message.channel.messages.fetch({ limit, before: message.id });
    const recentMessages = [...fetched.values()].reverse();

    if (recentMessages.length === 0) return '';

    const formatted = recentMessages
      .map((msg) => {
        const author = msg.author.bot ? `[BOT] ${msg.author.username}` : msg.author.username;
        let content = msg.content
          || (msg.embeds.length > 0
            ? (msg.embeds[0].description || msg.embeds[0].title || '[embed]')
            : (msg.attachments.size > 0 ? '[attachment]' : '[empty message]'));
        if (content.length > MAX_CHANNEL_MESSAGE_LENGTH) {
          content = `${content.slice(0, MAX_CHANNEL_MESSAGE_LENGTH)}... [truncated]`;
        }
        return `${author}: ${content}`;
      })
      .join('\n');

    return (
      '## ข้อความล่าสุดในช่อง\n'
      + 'ด้านล่างนี้คือข้อความล่าสุดจากช่องนี้ เพื่อเป็นบริบทสำหรับการสนทนาที่กำลังดำเนินอยู่ '
      + 'ใช้สิ่งเหล่านี้เพื่อเข้าใจลำดับการสนทนา แต่โปรดทราบว่าประวัติการสนทนาโดยตรงของคุณ (หากมี) จะถูกจัดเตรียมไว้แยกต่างหาก\n'
      + '```\n'
      + formatted
      + '\n```'
    );
  } catch (error) {
    logServiceError('ConversationContext', error, { operation: 'fetchRecentChannelMessages' });
    return '';
  }
}

export async function buildConversationContext(message, instructions) {
  if (!message.guild) {
    return instructions;
  }

  const guildId = message.guild.id;
  const channelId = message.channel.id;
  const serverHistoryEnabled = state.serverSettings[guildId]?.serverChatHistory;
  const channelHistoryEnabled = getChannelSettings(channelId).channelWideChatHistory;

  if (!serverHistoryEnabled && !channelHistoryEnabled) {
    return instructions;
  }

  const contextSections = [];

  contextSections.push(`ขณะนี้คุณกำลังพูดคุยกับผู้ใช้งานในเซิร์ฟเวอร์ Discord ${message.guild.name}`);

  if (channelHistoryEnabled) {
    const channelName = message.channel.name || 'ในช่องนี้';
    contextSections.push(`การสนทนานี้กำลังดำเนินอยู่ในช่อง #${channelName}`);
  }

  contextSections.push(
    '## รูปแบบการสนทนาแบบหลายผู้ใช้\n'
    + 'นี่คือบทสนทนาที่แชร์ร่วมกัน ซึ่งมีผู้ใช้งาน Discord หลายคนเข้าร่วม '
    + 'ข้อความของผู้ใช้แต่ละข้อความในประวัติการสนทนาจะถูกนำหน้าด้วยแท็กในรูปแบบ:\n'
    + '`[user:<username>|display:<displayName>]`\n'
    + 'คอยสังเกตแท็กเหล่านี้เสมอ เพื่อระบุว่าใครเป็นผู้ส่งแต่ละข้อความได้อย่างถูกต้อง '
    + 'ผู้ใช้แต่ละคนอาจมีบริบท คำถาม และหัวข้อการสนทนาที่แตกต่างกัน'
  );

  contextSections.push(`## ผู้ส่งข้อความคนปัจจุบัน\n- ชื่อผู้ใช้: \`${message.author.username}\`\n- ชื่อที่แสดง: \`${message.author.displayName}\``);

  const recentContext = await fetchRecentChannelMessages(message);
  if (recentContext) {
    contextSections.push(recentContext);
  }

  return `${instructions}\n${contextSections.join('\n\n')}`;
}

export function resolveHistoryId(message) {
  return getConversationScope(message).historyId;
}

export function isSharedConversation(message) {
  return getConversationScope(message).shared;
}

export function isSharedPersonality(message) {
  const guildId = message.guild?.id;
  if (!guildId) return false;

  const channelId = message.channel.id;
  const channelSettings = getChannelSettings(channelId);

  if (channelSettings.customChannelPersonality && getCustomInstruction(channelId)) {
    return true;
  }

  if (state.serverSettings[guildId]?.customServerPersonality && getCustomInstruction(guildId)) {
    return true;
  }

  return false;
}

export function tagPartsWithUser(parts, message) {
  const tag = `[user:${message.author.username}|display:${message.author.displayName}]`;
  if (parts.length > 0 && parts[0].text !== undefined) {
    return [{ ...parts[0], text: `${tag} ${parts[0].text}` }, ...parts.slice(1)];
  }
  return [{ text: tag }, ...parts];
}

export function resolveHistoryCategory(message) {
  return getConversationScope(message).category;
}
