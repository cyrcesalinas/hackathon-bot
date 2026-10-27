import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import express from 'express';
import {
  ButtonStyleTypes,
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
  MessageComponentTypes,
  verifyKeyMiddleware,
} from 'discord-interactions';
import { getRandomEmoji, DiscordRequest } from './utils.js';
import { getShuffledOptions, getResult } from './game.js';
import { ASK_SYSTEM_PROMPT } from './agents/ask.js';
import { RESEARCH_SYSTEM_PROMPT } from './agents/research.js';
import { getOciSystemPrompt, getOciTopic } from './agents/oci.js';
import { buildDevOpenRouterRequest, DevFileError, getDevCommandRequest } from './agents/dev.js';
import { getOpenRouterAnswer, isOpenRouterConfigured } from './openrouter.js';
import {
  buildStudyOpenRouterRequest,
  getStudyCommandRequest,
  StudyFileError,
} from './study.js';
import { answerAdbQuestion } from './agents/db-query.js';
import {
  AgentCommandError,
  buildUserAgentRequest,
  editAgent,
  listAgents,
  removeAgent,
  requireOwnedAgent,
  saveNewAgent,
  validateNewAgent,
} from './agents/user-agent.js';
import { AdbCatalogScanError, scanAdbCatalog } from './db/catalog-scan.js';
import { closeAgentStorePool, isAgentStoreConfigured } from './db/agent-store.js';
import { checkAdbConnection, closeAdbPool, isAdbConfigured } from './db/connection.js';

// Create an express app
const app = express();
// Get port, or default to 3000
const PORT = process.env.PORT || 3000;
const DISCORD_API_URL = 'https://discord.com/api/v10';
// To keep track of our active games
const activeGames = {};
const recentAdbQueriesByUser = new Map();
let recentAdbQueriesGlobal = [];
const recentAgentRunsByUser = new Map();
let recentAgentRunsGlobal = [];
const pendingAgentDrafts = new Map();

const DISCORD_PERMISSION_ADMINISTRATOR = 1n << 3n;
const DISCORD_PERMISSION_MANAGE_GUILD = 1n << 5n;
const ADB_REQUESTS_PER_USER_PER_MINUTE = 5;
const ADB_REQUESTS_GLOBAL_PER_MINUTE = 30;
const AGENT_RUNS_PER_USER_PER_MINUTE = 5;
const AGENT_RUNS_GLOBAL_PER_MINUTE = 30;
const AGENT_DRAFT_TTL_MS = 10 * 60_000;
const AGENT_DRAFT_LIMIT = 200;

async function updateInteractionResponse(applicationId, interactionToken, content) {
  const response = await fetch(
    `${DISCORD_API_URL}/webhooks/${applicationId}/${encodeURIComponent(interactionToken)}/messages/@original`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        allowed_mentions: { parse: [] },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Discord returned HTTP ${response.status} while updating the response`);
  }
}

function limitDiscordMessage(content) {
  const characters = Array.from(content);
  return characters.length > 1900
    ? `${characters.slice(0, 1897).join('')}…`
    : content;
}

async function answerInteraction(applicationId, interactionToken, requestFactory, operation, failureMessage) {
  let content;
  try {
    const request = await requestFactory();
    const answer = await getOpenRouterAnswer(request);
    content = limitDiscordMessage(answer);
  } catch (error) {
    if (error instanceof StudyFileError || error instanceof DevFileError || error instanceof AgentCommandError) {
      content = error.userMessage;
    } else {
      console.error(`${operation} failed:`, error.message);
      content = failureMessage;
    }
  }

  try {
    await updateInteractionResponse(applicationId, interactionToken, content);
  } catch (error) {
    console.error('Could not update the Discord interaction:', error.message);
  }
}

function deferOpenRouterCommand(res, req, requestFactory, operation, failureMessage) {
  res.send({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  });

  setImmediate(() => {
    void answerInteraction(
      req.body.application_id,
      req.body.token,
      requestFactory,
      operation,
      failureMessage,
    );
  });
}

function getDiscordUserId(req) {
  return req.body.member?.user?.id ?? req.body.user?.id;
}

function getOptionValue(options, name) {
  return options?.find((option) => option.name === name)?.value;
}

function makeServerRepliesPublic(res, interaction) {
  if (!interaction.guild_id || !interaction.channel_id) return;

  const send = res.send.bind(res);
  res.send = (payload) => {
    const flags = Number(payload?.data?.flags ?? 0);
    if (flags & InteractionResponseFlags.EPHEMERAL) {
      const { flags: _flags, ...responseData } = payload.data;
      const publicFlags = flags & ~InteractionResponseFlags.EPHEMERAL;
      payload = {
        ...payload,
        data: publicFlags ? { ...responseData, flags: publicFlags } : responseData,
      };
    }
    return send(payload);
  };
}

function isAgentRunRateLimited(userId) {
  const now = Date.now();
  const cutoff = now - 60_000;
  const recent = (recentAgentRunsByUser.get(userId) ?? []).filter((timestamp) => timestamp > cutoff);
  recentAgentRunsGlobal = recentAgentRunsGlobal.filter((timestamp) => timestamp > cutoff);

  if (
    recent.length >= AGENT_RUNS_PER_USER_PER_MINUTE ||
    recentAgentRunsGlobal.length >= AGENT_RUNS_GLOBAL_PER_MINUTE
  ) {
    recentAgentRunsByUser.set(userId, recent);
    return true;
  }

  recent.push(now);
  recentAgentRunsGlobal.push(now);
  recentAgentRunsByUser.set(userId, recent);

  for (const [trackedUserId, timestamps] of recentAgentRunsByUser) {
    if (timestamps.every((timestamp) => timestamp <= cutoff)) {
      recentAgentRunsByUser.delete(trackedUserId);
    }
  }
  return false;
}

function deferAgentOperation(res, req, operation, operationName, failureMessage) {
  res.send({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  });

  setImmediate(async () => {
    let content;
    try {
      content = limitDiscordMessage(await operation());
    } catch (error) {
      if (error?.userMessage) {
        content = error.userMessage;
      } else {
        console.error(`${operationName} failed:`, error?.code ?? error?.name ?? 'unknown error');
        content = failureMessage;
      }
    }

    try {
      await updateInteractionResponse(req.body.application_id, req.body.token, content);
    } catch (error) {
      console.error(`Could not update the Discord ${operationName} response:`, error.message);
    }
  });
}

function cleanExpiredAgentDrafts() {
  const now = Date.now();
  for (const [draftId, draft] of pendingAgentDrafts) {
    if (draft.expiresAt <= now) pendingAgentDrafts.delete(draftId);
  }
  while (pendingAgentDrafts.size >= AGENT_DRAFT_LIMIT) {
    pendingAgentDrafts.delete(pendingAgentDrafts.keys().next().value);
  }
}

function getAgentCapabilityLabel(capability) {
  return {
    chat: 'Chat',
    study: 'Study help with files',
    research: 'Web research',
  }[capability] ?? 'Unknown';
}

function formatAgentSummary(agent) {
  return `**${agent.name}** · ${getAgentCapabilityLabel(agent.capability)}\nGoal: ${agent.goal}\nStyle: ${agent.style}`;
}

function handleAgentCommand(res, req) {
  if (!isAgentStoreConfigured()) {
    return res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: InteractionResponseFlags.EPHEMERAL,
        content: 'Agent storage is not configured yet. Contact the bot administrator.',
      },
    });
  }

  const userId = getDiscordUserId(req);
  if (!userId) {
    return res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: InteractionResponseFlags.EPHEMERAL, content: 'I could not identify your Discord account.' },
    });
  }

  const subcommand = req.body.data.options?.find((option) => option.type === 1);
  const options = subcommand?.options ?? [];

  if (subcommand?.name === 'create') {
    let profile;
    try {
      profile = validateNewAgent({
        ownerUserId: userId,
        name: getOptionValue(options, 'name'),
        goal: getOptionValue(options, 'goal'),
        style: getOptionValue(options, 'style'),
        capability: getOptionValue(options, 'capability'),
      });
    } catch (error) {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          flags: InteractionResponseFlags.EPHEMERAL,
          content: error?.userMessage ?? 'I could not create that agent draft.',
        },
      });
    }

    cleanExpiredAgentDrafts();
    const draftId = randomUUID();
    pendingAgentDrafts.set(draftId, {
      ownerUserId: userId,
      profile,
      expiresAt: Date.now() + AGENT_DRAFT_TTL_MS,
    });

    return res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: InteractionResponseFlags.EPHEMERAL,
        allowed_mentions: { parse: [] },
        content: `Preview your private agent\n\n${formatAgentSummary(profile)}\n\nIt will use the bot's configured OpenRouter model. Save it to make it available through /agent run.`,
        components: [
          {
            type: MessageComponentTypes.ACTION_ROW,
            components: [
              {
                type: MessageComponentTypes.BUTTON,
                custom_id: `agent_save:${draftId}`,
                label: 'Save agent',
                style: ButtonStyleTypes.PRIMARY,
              },
              {
                type: MessageComponentTypes.BUTTON,
                custom_id: `agent_cancel:${draftId}`,
                label: 'Cancel',
                style: ButtonStyleTypes.SECONDARY,
              },
            ],
          },
        ],
      },
    });
  }

  if (subcommand?.name === 'list') {
    return deferAgentOperation(
      res,
      req,
      async () => {
        const agents = await listAgents(userId);
        if (!agents.length) return 'You have no saved agents yet. Start with /agent create.';
        return `Your private agents (${agents.length}):\n\n${agents.map(formatAgentSummary).join('\n\n')}`;
      },
      '/agent list',
      'I could not load your agents right now. Please try again shortly.',
    );
  }

  if (subcommand?.name === 'run') {
    const name = getOptionValue(options, 'name');
    const task = getOptionValue(options, 'task');
    const attachmentId = getOptionValue(options, 'file');
    if (typeof name !== 'string' || !name.trim() || typeof task !== 'string' || !task.trim()) {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: InteractionResponseFlags.EPHEMERAL, content: 'Choose one of your agents and enter a task.' },
      });
    }
    if (!isOpenRouterConfigured()) {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          flags: InteractionResponseFlags.EPHEMERAL,
          content: 'Configure OPENROUTER_API_KEY and OPENROUTER_MODEL on the bot host first.',
        },
      });
    }
    if (isAgentRunRateLimited(userId)) {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          flags: InteractionResponseFlags.EPHEMERAL,
          content: 'You are running agents too quickly. Wait a minute and try again.',
        },
      });
    }

    return deferOpenRouterCommand(
      res,
      req,
      async () => {
        const agent = await requireOwnedAgent(userId, name.trim());
        return buildUserAgentRequest(agent, task, attachmentId, req.body.data.resolved?.attachments);
      },
      '/agent run',
      'I could not run that agent right now. Please try again shortly.',
    );
  }

  if (subcommand?.name === 'edit') {
    const name = getOptionValue(options, 'name');
    const patch = {};
    const newName = getOptionValue(options, 'new_name');
    const goal = getOptionValue(options, 'goal');
    const style = getOptionValue(options, 'style');
    const capability = getOptionValue(options, 'capability');
    if (newName !== undefined) patch.name = newName;
    if (goal !== undefined) patch.goal = goal;
    if (style !== undefined) patch.style = style;
    if (capability !== undefined) patch.capability = capability;
    if (typeof name !== 'string' || !name.trim()) {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: InteractionResponseFlags.EPHEMERAL, content: 'Enter the current name of your agent.' },
      });
    }
    return deferAgentOperation(
      res,
      req,
      async () => `Updated your agent:\n\n${formatAgentSummary(await editAgent(userId, name.trim(), patch))}`,
      '/agent edit',
      'I could not update that agent right now. Please try again shortly.',
    );
  }

  if (subcommand?.name === 'delete') {
    const name = getOptionValue(options, 'name');
    if (typeof name !== 'string' || !name.trim()) {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: InteractionResponseFlags.EPHEMERAL, content: 'Enter the name of your agent.' },
      });
    }
    return deferAgentOperation(
      res,
      req,
      async () => {
        await removeAgent(userId, name.trim());
        return `Deleted your agent "${name.trim()}".`;
      },
      '/agent delete',
      'I could not delete that agent right now. Please try again shortly.',
    );
  }

  return res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: InteractionResponseFlags.EPHEMERAL,
      content: 'Choose create, list, run, edit, or delete for /agent.',
    },
  });
}

function handleAgentDraftButton(res, req, componentId) {
  const separator = componentId.indexOf(':');
  const action = componentId.slice(0, separator);
  const draftId = componentId.slice(separator + 1);
  const draft = pendingAgentDrafts.get(draftId);
  const userId = getDiscordUserId(req);

  if (!draft || draft.expiresAt <= Date.now()) {
    pendingAgentDrafts.delete(draftId);
    return res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: InteractionResponseFlags.EPHEMERAL, content: 'That agent preview expired. Create it again to continue.' },
    });
  }
  if (draft.ownerUserId !== userId) {
    return res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: InteractionResponseFlags.EPHEMERAL, content: 'Only the student who created this preview can save it.' },
    });
  }

  if (action === 'agent_cancel') {
    if (draft.saving) {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: InteractionResponseFlags.EPHEMERAL, content: 'The agent is being saved. Please wait for that response.' },
      });
    }
    pendingAgentDrafts.delete(draftId);
    return res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: InteractionResponseFlags.EPHEMERAL, content: 'Agent creation cancelled.' },
    });
  }

  if (action !== 'agent_save') {
    return res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: InteractionResponseFlags.EPHEMERAL, content: 'That agent action is not available.' },
    });
  }

  if (draft.saving) {
    return res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: InteractionResponseFlags.EPHEMERAL, content: 'This agent is already being saved.' },
    });
  }
  draft.saving = true;
  return deferAgentOperation(
    res,
    req,
    async () => {
      try {
        const agent = await saveNewAgent(draft.profile);
        pendingAgentDrafts.delete(draftId);
        return `Saved **${agent.name}** as a private agent. Use /agent run to try it.`;
      } catch (error) {
        if (error?.userMessage) pendingAgentDrafts.delete(draftId);
        else draft.saving = false;
        throw error;
      }
    },
    '/agent save',
    'I could not save that agent right now. Please try again shortly.',
  );
}

function hasAdbPermission(req) {
  const requiredGuildId = process.env.ADB_ALLOWED_GUILD_ID?.trim();
  const allowedRoleIds = (process.env.ADB_ALLOWED_ROLE_IDS ?? '')
    .split(',')
    .map((roleId) => roleId.trim())
    .filter(Boolean);

  // Database commands are server-only even if a stale global command is still
  // visible in a DM before Discord finishes propagating command updates.
  if (!req.body.guild_id || !req.body.member) return false;

  if (requiredGuildId && req.body.guild_id !== requiredGuildId) {
    return false;
  }

  if (allowedRoleIds.length) {
    const memberRoleIds = req.body.member.roles;
    return Array.isArray(memberRoleIds) && allowedRoleIds.some((roleId) => memberRoleIds.includes(roleId));
  }

  // A configured guild intentionally permits its members when no role filter
  // is configured. With no access settings at all, fail closed to guild admins.
  if (requiredGuildId) return true;

  try {
    const permissions = BigInt(req.body.member.permissions ?? '0');
    return Boolean(
      permissions & DISCORD_PERMISSION_ADMINISTRATOR ||
      permissions & DISCORD_PERMISSION_MANAGE_GUILD
    );
  } catch {
    return false;
  }
}

function hasAdbAdminPermission(req) {
  const requiredGuildId = process.env.ADB_ALLOWED_GUILD_ID?.trim();
  if (!req.body.guild_id || !req.body.member) return false;
  if (requiredGuildId && req.body.guild_id !== requiredGuildId) return false;

  try {
    const permissions = BigInt(req.body.member.permissions ?? '0');
    return Boolean(
      permissions & DISCORD_PERMISSION_ADMINISTRATOR ||
      permissions & DISCORD_PERMISSION_MANAGE_GUILD
    );
  } catch {
    return false;
  }
}

function isAdbRateLimited(req) {
  const userId = req.body.member?.user?.id ?? req.body.user?.id;
  if (!userId) return true;

  const now = Date.now();
  const cutoff = now - 60_000;
  const recent = (recentAdbQueriesByUser.get(userId) ?? []).filter((timestamp) => timestamp > cutoff);
  recentAdbQueriesGlobal = recentAdbQueriesGlobal.filter((timestamp) => timestamp > cutoff);

  if (
    recent.length >= ADB_REQUESTS_PER_USER_PER_MINUTE ||
    recentAdbQueriesGlobal.length >= ADB_REQUESTS_GLOBAL_PER_MINUTE
  ) {
    recentAdbQueriesByUser.set(userId, recent);
    return true;
  }

  recent.push(now);
  recentAdbQueriesGlobal.push(now);
  recentAdbQueriesByUser.set(userId, recent);

  for (const [trackedUserId, timestamps] of recentAdbQueriesByUser) {
    if (timestamps.every((timestamp) => timestamp <= cutoff)) {
      recentAdbQueriesByUser.delete(trackedUserId);
    }
  }
  return false;
}

function deferAdbCommand(res, req, question) {
  res.send({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  });

  setImmediate(async () => {
    let content;
    try {
      content = limitDiscordMessage(await answerAdbQuestion(question));
    } catch (error) {
      if (error?.userMessage) {
        content = error.userMessage;
      } else {
        console.error('ADB question failed:', error?.code ?? error?.name ?? 'unknown error');
        content = 'The database question could not be answered right now. Please try again later.';
      }
    }

    try {
      await updateInteractionResponse(req.body.application_id, req.body.token, content);
    } catch (error) {
      console.error('Could not update the Discord ADB response:', error.message);
    }
  });
}

function deferAdbStatus(res, req) {
  res.send({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  });

  setImmediate(async () => {
    let content;
    try {
      await checkAdbConnection();
      content = 'The bot connected to Oracle ADB successfully.';
    } catch (error) {
      console.error('ADB connection check failed:', error.code ?? error.name);
      content = 'The bot could not connect to Oracle ADB. Check the server configuration and database network access.';
    }

    try {
      await updateInteractionResponse(req.body.application_id, req.body.token, content);
    } catch (error) {
      console.error('Could not update the Discord ADB status response:', error.message);
    }
  });
}

function deferAdbScan(res, req) {
  res.send({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  });

  setImmediate(async () => {
    let content;
    try {
      content = limitDiscordMessage(await scanAdbCatalog());
    } catch (error) {
      if (error instanceof AdbCatalogScanError) {
        content = error.userMessage;
      } else {
        console.error('ADB catalog scan failed:', error?.code ?? error?.name ?? 'unknown error');
        content = 'The catalog scan could not be completed. Check the ADB configuration and metadata permissions.';
      }
    }

    try {
      await updateInteractionResponse(req.body.application_id, req.body.token, content);
    } catch (error) {
      console.error('Could not update the Discord ADB scan response:', error.message);
    }
  });
}

/**
 * Interactions endpoint URL where Discord will send HTTP requests
 * Parse request body and verifies incoming requests using discord-interactions package
 */
app.post('/interactions', verifyKeyMiddleware(process.env.PUBLIC_KEY), async function (req, res) {
  // Interaction id, type and data
  const { id, type, data } = req.body;

  /**
   * Handle verification requests
   */
  if (type === InteractionType.PING) {
    return res.send({ type: InteractionResponseType.PONG });
  }

  if (type === InteractionType.APPLICATION_COMMAND || type === InteractionType.MESSAGE_COMPONENT) {
    makeServerRepliesPublic(res, req.body);
  }

  /**
   * Handle slash command requests
   * See https://discord.com/developers/docs/interactions/application-commands#slash-commands
   */
  if (type === InteractionType.APPLICATION_COMMAND) {
    const { name } = data;

    if (name === 'agent') {
      return handleAgentCommand(res, req);
    }

    if (name === 'dev') {
      const devRequest = getDevCommandRequest(data.options, data.resolved?.attachments);
      if (devRequest.error) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { flags: InteractionResponseFlags.EPHEMERAL, content: devRequest.error },
        });
      }

      if (!isOpenRouterConfigured()) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: 'Configura OPENROUTER_API_KEY y OPENROUTER_MODEL en el entorno del bot.',
          },
        });
      }

      return deferOpenRouterCommand(
        res,
        req,
        () => buildDevOpenRouterRequest(devRequest),
        '/dev ask',
        'I could not answer the engineering question just now. Please try again shortly.',
      );
    }

    if (name === 'db') {
      const subcommand = data.options?.find((option) => option.type === 1)?.name;
      if (!['status', 'scan', 'lookup'].includes(subcommand)) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: 'Choose the lookup, scan, or status database command.',
          },
        });
      }

      const hasPermission = subcommand === 'scan'
        ? hasAdbAdminPermission(req)
        : hasAdbPermission(req);
      if (!hasPermission) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: subcommand === 'scan'
              ? 'The database catalog scan is restricted to server administrators.'
              : 'This database command is restricted to an approved server or role.',
          },
        });
      }

      if (isAdbRateLimited(req)) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: 'You are sending database requests too quickly. Wait a minute and try again.',
          },
        });
      }

      if (subcommand === 'status') {
        if (!isAdbConfigured()) {
          return res.send({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              flags: InteractionResponseFlags.EPHEMERAL,
              content: 'The ADB connection is not configured yet. Contact the bot administrator.',
            },
          });
        }
        return deferAdbStatus(res, req);
      }

      if (subcommand === 'scan') {
        if (!isAdbConfigured()) {
          return res.send({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              flags: InteractionResponseFlags.EPHEMERAL,
              content: 'The ADB connection is not configured yet. Contact the bot administrator.',
            },
          });
        }
        return deferAdbScan(res, req);
      }

      const lookup = data.options?.find((option) => option.name === 'lookup');
      const question = lookup?.options?.find((option) => option.name === 'question')?.value;
      if (typeof question !== 'string' || !question.trim()) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: 'Enter a database question to continue.',
          },
        });
      }

      if (!isAdbConfigured()) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: 'The ADB connection is not configured yet. Contact the bot administrator.',
          },
        });
      }

      if (!isOpenRouterConfigured()) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: 'The database question service is not configured yet. Contact the bot administrator.',
          },
        });
      }

      return deferAdbCommand(res, req, question.trim());
    }

    if (name === 'ask') {
      const prompt = data.options?.find((option) => option.name === 'prompt')?.value;

      if (typeof prompt !== 'string' || !prompt.trim()) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: 'Escribe una pregunta para el asistente.',
          },
        });
      }

      if (!isOpenRouterConfigured()) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: 'Configura OPENROUTER_API_KEY y OPENROUTER_MODEL en el entorno del bot.',
          },
        });
      }

      return deferOpenRouterCommand(
        res,
        req,
        async () => ({
          systemPrompt: ASK_SYSTEM_PROMPT,
          userContent: prompt.trim(),
          maxTokens: 800,
        }),
        '/ask',
        'No pude obtener una respuesta ahora. Inténtalo de nuevo en un momento.',
      );
    }

    if (name === 'research') {
      const query = data.options?.find((option) => option.name === 'query')?.value;

      if (typeof query !== 'string' || !query.trim()) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: 'Escribe una pregunta o tema para investigar.',
          },
        });
      }

      if (!isOpenRouterConfigured()) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: 'Configura OPENROUTER_API_KEY y OPENROUTER_MODEL en el entorno del bot.',
          },
        });
      }

      return deferOpenRouterCommand(
        res,
        req,
        async () => ({
          systemPrompt: RESEARCH_SYSTEM_PROMPT,
          userContent: query.trim(),
          maxTokens: 1200,
          tools: [{ type: 'openrouter:web_search' }],
        }),
        '/research',
        'No pude completar la investigación ahora. Inténtalo de nuevo en un momento.',
      );
    }

    if (name === 'oci') {
      const topicValue = data.options?.find((option) => option.name === 'topic')?.value;
      const question = data.options?.find((option) => option.name === 'question')?.value;
      const topic = getOciTopic(topicValue);

      if (!topic || typeof question !== 'string' || !question.trim()) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: 'Elige un tema de OCI y escribe una pregunta.',
          },
        });
      }

      if (!isOpenRouterConfigured()) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: 'Configura OPENROUTER_API_KEY y OPENROUTER_MODEL en el entorno del bot.',
          },
        });
      }

      return deferOpenRouterCommand(
        res,
        req,
        async () => ({
          systemPrompt: getOciSystemPrompt(topic),
          userContent: question.trim(),
          maxTokens: 1400,
          tools: [{ type: 'openrouter:web_search' }],
        }),
        `/oci ${topic.value}`,
        'No pude responder la consulta de OCI ahora. Inténtalo de nuevo en un momento.',
      );
    }

    // "test" command
    if (name === 'test') {
      // Send a message into the channel where command was triggered from
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          flags: InteractionResponseFlags.IS_COMPONENTS_V2,
          components: [
            {
              type: MessageComponentTypes.TEXT_DISPLAY,
              // Fetches a random emoji to send from a helper function
              content: `hello world ${getRandomEmoji()}`
            }
          ]
        },
      });
    }

    if (name === 'study') {
      const studyRequest = getStudyCommandRequest(data.options, data.resolved?.attachments);
      if (studyRequest.error) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: studyRequest.error,
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }

      if (!isOpenRouterConfigured()) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: 'Configura OPENROUTER_API_KEY y OPENROUTER_MODEL en el entorno del bot.',
          },
        });
      }

      return deferOpenRouterCommand(
        res,
        req,
        () => buildStudyOpenRouterRequest(studyRequest),
        `/study ${studyRequest.name}`,
        'No pude completar la solicitud de estudio ahora. Inténtalo de nuevo en un momento.',
      );
    }

    // "challenge" command
    if (name === 'challenge' && id) {
      // User ID is in the member field for servers and the user field for DMs.
      const userId = req.body.member?.user?.id ?? req.body.user?.id;
      const objectName = data.options?.[0]?.value;

      if (!userId || !objectName) {
        return res.status(400).json({ error: 'invalid challenge command' });
      }

      activeGames[id] = {
        id: userId,
        objectName,
      };

      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          flags: InteractionResponseFlags.IS_COMPONENTS_V2,
          components: [
            {
              type: MessageComponentTypes.TEXT_DISPLAY,
              content: `Rock paper scissors challenge from <@${userId}>`,
            },
            {
              type: MessageComponentTypes.ACTION_ROW,
              components: [
                {
                  type: MessageComponentTypes.BUTTON,
                  custom_id: `accept_button_${id}`,
                  label: 'Accept',
                  style: ButtonStyleTypes.PRIMARY,
                },
              ],
            },
          ],
        },
      });
    }

    console.error(`unknown command: ${name}`);
    return res.status(400).json({ error: 'unknown command' });
  }

  /**
   * Handle button and select menu interactions.
   * See https://discord.com/developers/docs/components/using-message-components#using-message-components-with-interactions
   */
  if (type === InteractionType.MESSAGE_COMPONENT) {
    const componentId = data.custom_id;

    if (componentId.startsWith('agent_save:') || componentId.startsWith('agent_cancel:')) {
      return handleAgentDraftButton(res, req, componentId);
    }

    if (componentId.startsWith('accept_button_')) {
      const gameId = componentId.replace('accept_button_', '');

      if (!activeGames[gameId]) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: 'This challenge is no longer active.',
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }

      const endpoint = `webhooks/${process.env.APP_ID}/${req.body.token}/messages/${req.body.message.id}`;

      try {
        res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags:
              InteractionResponseFlags.EPHEMERAL |
              InteractionResponseFlags.IS_COMPONENTS_V2,
            components: [
              {
                type: MessageComponentTypes.TEXT_DISPLAY,
                content: 'What is your object of choice?',
              },
              {
                type: MessageComponentTypes.ACTION_ROW,
                components: [
                  {
                    type: MessageComponentTypes.STRING_SELECT,
                    custom_id: `select_choice_${gameId}`,
                    options: getShuffledOptions(),
                  },
                ],
              },
            ],
          },
        });

        await DiscordRequest(endpoint, { method: 'DELETE' });
      } catch (err) {
        console.error('Error accepting challenge:', err);
      }

      return;
    }

    if (componentId.startsWith('select_choice_')) {
      const gameId = componentId.replace('select_choice_', '');
      const game = activeGames[gameId];

      if (!game) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: 'This challenge is no longer active.',
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }

      const userId = req.body.member?.user?.id ?? req.body.user?.id;
      const objectName = data.values?.[0];

      if (!userId || !objectName) {
        return res.status(400).json({ error: 'invalid challenge selection' });
      }

      const result = getResult(game, { id: userId, objectName });
      delete activeGames[gameId];

      const endpoint = `webhooks/${process.env.APP_ID}/${req.body.token}/messages/${req.body.message.id}`;

      try {
        res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.IS_COMPONENTS_V2,
            components: [
              {
                type: MessageComponentTypes.TEXT_DISPLAY,
                content: result,
              },
            ],
          },
        });

        await DiscordRequest(endpoint, {
          method: 'PATCH',
          body: {
            components: [
              {
                type: MessageComponentTypes.TEXT_DISPLAY,
                content: `Nice choice ${getRandomEmoji()}`,
              },
            ],
          },
        });
      } catch (err) {
        console.error('Error completing challenge:', err);
      }

      return;
    }

    return res.status(400).json({ error: 'unknown component' });
  }

  console.error('unknown interaction type', type);
  return res.status(400).json({ error: 'unknown interaction type' });
});

const server = app.listen(PORT, () => {
  console.log('Listening on port', PORT);
});

async function shutdown() {
  server.close(async () => {
    try {
      await closeAdbPool();
    } catch (error) {
      console.error('Could not close the ADB pool cleanly:', error.code ?? error.name);
    }
    try {
      await closeAgentStorePool();
    } catch (error) {
      console.error('Could not close the agent store pool cleanly:', error.code ?? error.name);
    }
  });
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
