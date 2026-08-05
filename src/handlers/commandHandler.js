/**
 * Slash command interaction handlers.
 * Each exported function corresponds to a registered slash command.
 */

import { MessageFlags } from 'discord.js';
import { OSUtils } from 'node-os-utils';

import {
  addBlacklistedUser,
  clearChatHistoryFor,
  getTimeUntilNextReset,
  removeBlacklistedUser,
  shouldShowActionButtons,
} from '../state/botState.js';
import { getActiveSessionDetails } from '../services/sessionService.js';
import {
  STATUS_LIFETIME_MS,
  STATUS_REFRESH_INTERVAL_MS,
} from '../constants.js';
import { addSettingsButton } from '../ui/messageActions.js';
import { showDashboard, showChannelDashboard, showSettings } from '../ui/settingsViews.js';
import { applyEmbedFallback, createStatusEmbed, replyWithEmbed } from '../utils/discord.js';
import { replyWithError, logError } from '../utils/errorHandler.js';
import {
  ensureInteractionNotBlacklisted,
  getClearMemoryDisabledReason,
  persistStateChange,
  requireGuildAdmin,
  replyFeatureDisabled,
} from './interactionHelpers.js';

const osu = new OSUtils();

function getMonitorData(result, label) {
  if (!result.success) {
    const reason = result.error?.message || 'Unknown monitor error';
    throw new Error(`Failed to fetch ${label}: ${reason}`);
  }

  return result.data;
}

async function handleClearMemoryCommand(interaction) {
  const disabledReason = getClearMemoryDisabledReason(interaction);
  if (disabledReason) {
    return replyFeatureDisabled(interaction, disabledReason);
  }

  const activeSession = getActiveSessionDetails(interaction.user.id);

  clearChatHistoryFor(activeSession.historyId);
  await persistStateChange();

  return replyWithEmbed(interaction, {
    variant: 'success',
    title: 'ล้างประวัติการคุยแล้วค่ะ',
    description: `ปลายล้างประวัติการใช้งานสำหรับเซสชัน **${activeSession.sessionName}** (ID: ${activeSession.sessionId}) เรียบร้อยแล้วนะคะ`,
  });
}

async function handleStatusCommand(interaction) {
  await interaction.deferReply();
  let intervalId;

  const updateReply = async () => {
    try {
      const [memoryResult, cpuResult] = await Promise.all([
        osu.memory.info(),
        osu.cpu.usage(),
      ]);
      const memoryInfo = getMonitorData(memoryResult, 'memory info');
      const cpuPercentage = getMonitorData(cpuResult, 'CPU usage');

      await interaction.editReply(applyEmbedFallback(interaction.channel, {
        embeds: [createStatusEmbed({
          variant: 'primary',
          title: 'System Information',
          fields: [
            {
              name: 'Memory (RAM)',
              value: `Total Memory: \`${memoryInfo.total.toMB().toFixed(0)}\` MB\nUsed Memory: \`${memoryInfo.used.toMB().toFixed(0)}\` MB\nFree Memory: \`${memoryInfo.free.toMB().toFixed(0)}\` MB\nPercentage Of Free Memory: \`${memoryInfo.free.toBytes() > 0 && memoryInfo.total.toBytes() > 0 ? ((memoryInfo.free.toBytes() / memoryInfo.total.toBytes()) * 100).toFixed(2) : '0.00'}\`%`,
              inline: true,
            },
            {
              name: 'CPU',
              value: `Percentage of CPU Usage: \`${cpuPercentage.toFixed(2)}\`%`,
              inline: true,
            },
            {
              name: 'Time Until Next Reset',
              value: getTimeUntilNextReset(),
              inline: true,
            },
          ],
        })],
      }));
    } catch (error) {
      logError('StatusCommandUpdate', error, {
        userId: interaction.user?.id,
        interactionId: interaction.id,
      });
      clearInterval(intervalId);
    }
  };

  try {
    await updateReply();
    const reply = await interaction.fetchReply();
    if (shouldShowActionButtons(interaction.guild?.id, interaction.user.id, interaction.channelId)) {
      await addSettingsButton(reply);
    }
    intervalId = setInterval(updateReply, STATUS_REFRESH_INTERVAL_MS);
    setTimeout(() => clearInterval(intervalId), STATUS_LIFETIME_MS);
  } catch (error) {
    logError('StatusCommand', error, {
      userId: interaction.user?.id,
      interactionId: interaction.id,
    });

    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(applyEmbedFallback(interaction.channel, {
        content: null,
        embeds: [createStatusEmbed({
          variant: 'error',
          title: 'การส่งคำขอตรวจสอบสถานะไม่สำเร็จนะคะ',
          description: 'เกิดข้อผิดพลาดขึ้นระหว่างดึงข้อมูลสถานะของระบบนะคะ',
        })],
        components: [],
      }));
      return;
    }

    await replyWithEmbed(interaction, {
      variant: 'error',
      title: 'การส่งคำขอตรวจสอบสถานะไม่สำเร็จนะคะ',
      description: 'เกิดข้อผิดพลาดขึ้นระหว่างดึงข้อมูลสถานะของระบบนะคะ',
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleBlacklistCommand(interaction) {
  if (!(await requireGuildAdmin(interaction))) {
    return;
  }

  const userId = interaction.options.getUser('user').id;
  const guildId = interaction.guild.id;

  if (addBlacklistedUser(guildId, userId)) {
    await persistStateChange();
    return replyWithEmbed(interaction, {
      variant: 'success',
      title: 'ผู้ใช้ถูกบล็อกเรียบร้อยแล้วค่ะ',
      description: `เรียบร้อยค่ะ บล็อกคุณ <@${userId}> ให้แล้วนะคะ`,
      flags: undefined,
    });
  }

  return replyWithEmbed(interaction, {
    variant: 'warning',
    title: 'ผู้ใช้คนนี้ถูกบล็อกไปแล้วนะคะ',
    description: `คุณ <@${userId}> ถูกบล็อกไปแล้วก่อนหน้านี้นะคะ`,
    flags: undefined,
  });
}

async function handleWhitelistCommand(interaction) {
  if (!(await requireGuildAdmin(interaction))) {
    return;
  }

  const userId = interaction.options.getUser('user').id;
  const guildId = interaction.guild.id;

  if (removeBlacklistedUser(guildId, userId)) {
    await persistStateChange();
    return replyWithEmbed(interaction, {
      variant: 'success',
      title: 'ปลดบล็อกผู้ใช้เรียบร้อยแล้วนะคะ',
      description: `นำ <@${userId}> ออกจากรายการบล็อกเรียบร้อยแล้วนะคะ`,
      flags: undefined,
    });
  }

  return replyWithEmbed(interaction, {
    variant: 'warning',
    title: 'ไม่พบผู้ใช้ท่านนี้ค่ะ',
    description: `คุณ <@${userId}> ไม่ได้อยู่ในรายชื่อที่ถูกบล็อกนะคะ`,
    flags: undefined,
  });
}

/** Routes a chat-input command interaction to its handler. */
export async function handleCommandInteraction(interaction) {
  try {
    if (!(await ensureInteractionNotBlacklisted(interaction))) {
      return;
    }

    const handlers = {
      unblock: handleWhitelistCommand,
      block: handleBlacklistCommand,
      clear_memory: handleClearMemoryCommand,
      settings: showSettings,
      server_settings: async (cmd) => {
        if (!(await requireGuildAdmin(cmd))) {
          return;
        }
        return showDashboard(cmd);
      },
      channel_settings: async (cmd) => {
        if (!(await requireGuildAdmin(cmd))) {
          return;
        }
        return showChannelDashboard(cmd);
      },
      status: handleStatusCommand,
    };

    const handler = handlers[interaction.commandName];
    if (handler) {
      await handler(interaction);
      return;
    }

    logError('Command', `Unknown command: ${interaction.commandName}`, {
      commandName: interaction.commandName,
    });
  } catch (error) {
    logError('CommandHandler', error, {
      commandName: interaction.commandName,
      userId: interaction.user?.id,
    });
    await replyWithError(interaction, 'Command Error', 'An error occurred while running this command.');
  }
}

