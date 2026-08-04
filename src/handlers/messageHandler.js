import { ChannelType } from 'discord.js';

import { activeRequests, client } from '../core/runtime.js';
import {
  initializeGuildState,
  isChannelUserActive,
  isUserBlacklisted,
  state,
} from '../state/botState.js';
import { WORK_IN_DMS } from '../constants.js';
import { handleTextMessage } from '../services/conversationService.js';
import { applyEmbedFallback, canSendMessages, createStatusEmbed } from '../utils/discord.js';
import { logError } from '../utils/errorHandler.js';

function shouldRespondToMessage(message) {
  const isDirectMessage = message.channel.type === ChannelType.DM;

  if (message.mentions.everyone && !message.mentions.users.has(client.user.id)) {
    return false;
  }

  return (
    (WORK_IN_DMS && isDirectMessage) ||
    Boolean(state.alwaysRespondChannels[message.channelId]) ||
    (!isDirectMessage && message.mentions.users.has(client.user.id)) ||
    isChannelUserActive(message.channelId, message.author.id)
  );
}

async function replyBlacklisted(message) {
  try {
    return await message.reply(applyEmbedFallback(message.channel, {
      embeds: [createStatusEmbed({
        variant: 'error',
        title: 'อุ๊ย! อยู่ในแบล็กลิสต์',
        description: 'ขออภัยนะคะ ดูเหมือนว่าคุณจะอยู่ในแบล็กลิสต์ เลยยังใช้งานส่วนนี้ไม่ได้ค่ะ',
      })],
    }));
  } catch (error) {
    logError('ReplyBlacklisted', error, {
      messageId: message.id,
      userId: message.author?.id,
    });
  }
}

async function replyRequestInProgress(message) {
  try {
    return await message.reply(applyEmbedFallback(message.channel, {
      embeds: [createStatusEmbed({
        variant: 'warning',
        title: 'ใจเย็นๆ น้า',
        description: 'กำลังจัดการคำขอของคุณอยู่ค่ะ รอสักครู่นะคะ เดี๋ยวจะรีบทำให้เลย',
      })],
    }));
  } catch (error) {
    logError('ReplyRequestInProgress', error, {
      messageId: message.id,
      userId: message.author?.id,
    });
  }
}

export async function handleMessageCreate(message) {
  if (message.author.bot || message.content.startsWith('!')) {
    return;
  }

  if (!canSendMessages(message.channel)) {
    return;
  }

  if (!shouldRespondToMessage(message)) {
    return;
  }

  try {
    if (message.guild) {
      initializeGuildState(message.guild.id);
      if (isUserBlacklisted(message.guild.id, message.author.id)) {
        await replyBlacklisted(message);
        return;
      }
    }

    if (activeRequests.has(message.author.id)) {
      await replyRequestInProgress(message);
      return;
    }

    activeRequests.add(message.author.id);
    await handleTextMessage(message);
  } catch (error) {
    logError('MessageHandler', error, {
      messageId: message.id,
      userId: message.author?.id,
      guildId: message.guild?.id,
    });
  } finally {
    activeRequests.delete(message.author.id);
  }
}
