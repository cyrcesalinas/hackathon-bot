import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import express from 'express';
import {
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
  verifyKeyMiddleware,
} from 'discord-interactions';
import {
  ActivityType,
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
} from 'discord.js';
import { getRandomEmoji, DiscordRequest } from './utils.js';
import { ASK_SYSTEM_PROMPT } from './agents/ask.js';
import { RESEARCH_SYSTEM_PROMPT } from './agents/research.js';
import { getOciSystemPrompt, getOciTopic } from './agents/oci.js';
import {
  getOpenRouterAnswer,
  getOpenRouterModel,
  isOpenRouterConfigured,
  withOpenRouterDateTimeTool,
} from './openrouter.js';
import {
  getMissedQuestionIndexesForReview,
  buildStudyOpenRouterRequest,
  getStudyGuideFilename,
  getStudyCommandRequest,
  parseStudyQuizWithRetry,
  renderStudyQuiz,
  StudyFileError,
  StudyQuizError,
} from './study.js';
import { answerAdbQuestion } from './agents/db-query.js';
import {
  AgentCommandError,
  buildUserAgentRequest,
  editAgent,
  listAvailableAgents,
  removeAgent,
  requireOwnedAgent,
  requireRunnableAgent,
  saveNewAgent,
  validateNewAgent,
} from './agents/user-agent.js';
import {
  AGENT_LANGUAGES,
  AGENT_PRESET_DEFINITIONS,
  AGENT_RESPONSE_FORMATS,
  AGENT_TOOL_DEFINITIONS,
  AGENT_TOOLS,
  AGENT_VISIBILITIES,
} from './agents/agent-config.js';
import {
  AGENT_UI_MODAL_PREFIX,
  AGENT_UI_PREFIX,
  buildAgentBrowserData,
  buildAgentDeleteData,
  buildAgentDetailData,
  buildAgentDraftData,
  buildAgentHomeData,
  buildAgentProfileModal,
  buildAgentRunModal,
  buildAgentSearchModal,
  createAgentUiSession,
  deleteAgentUiSession,
  getAgentUiSession,
  getModalValue,
  getSelectedAgent,
  parseAgentUiCustomId,
  setAgentUiAgents,
} from './agent-ui.js';
import { AdbCatalogScanError, scanAdbCatalog } from './db/catalog-scan.js';
import { closeAgentStorePool, isAgentStoreConfigured } from './db/agent-store.js';
import { checkAdbConnection, closeAdbPool, isAdbConfigured } from './db/connection.js';
import { prepareDiscordResponse } from './discord-response.js';

// Create an express app
const app = express();
// Get port, or default to 3000
const PORT = process.env.PORT || 3000;
const DISCORD_API_URL = 'https://discord.com/api/v10';
const recentAdbQueriesByUser = new Map();
let recentAdbQueriesGlobal = [];
const recentAgentRunsByUser = new Map();
let recentAgentRunsGlobal = [];

const ADB_REQUESTS_PER_USER_PER_MINUTE = 5;
const ADB_REQUESTS_GLOBAL_PER_MINUTE = 30;
const AGENT_RUNS_PER_USER_PER_MINUTE = 5;
const AGENT_RUNS_GLOBAL_PER_MINUTE = 30;
const STUDY_QUIZ_TTL_MS = 30 * 60_000;
const STUDY_QUIZ_LIMIT = 100;
const pendingStudyQuizzes = new Map();
const MENTION_REQUESTS_PER_USER_PER_MINUTE = 5;
const MENTION_REQUESTS_GLOBAL_PER_MINUTE = 30;
const recentMentionRequestsByUser = new Map();
let recentMentionRequestsGlobal = [];

async function updateInteractionResponse(applicationId, interactionToken, content, components, attachment) {
  const body = {
    content,
    allowed_mentions: { parse: [] },
  };
  if (components !== undefined) body.components = components;

  let requestBody;
  let headers;
  if (attachment) {
    const formData = new FormData();
    formData.set('payload_json', JSON.stringify({
      ...body,
      attachments: [{
        id: 0,
        filename: attachment.filename,
        description: attachment.description || 'Response in Markdown format',
      }],
    }));
    formData.set(
      'files[0]',
      new Blob([attachment.content], { type: 'text/markdown; charset=utf-8' }),
      attachment.filename,
    );
    requestBody = formData;
  } else {
    headers = { 'Content-Type': 'application/json' };
    requestBody = JSON.stringify(body);
  }

  const response = await fetch(
    `${DISCORD_API_URL}/webhooks/${applicationId}/${encodeURIComponent(interactionToken)}/messages/@original`,
    {
      method: 'PATCH',
      headers,
      body: requestBody,
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

function isMentionRequestRateLimited(userId) {
  const now = Date.now();
  const cutoff = now - 60_000;
  const recent = (recentMentionRequestsByUser.get(userId) ?? []).filter((timestamp) => timestamp > cutoff);
  recentMentionRequestsGlobal = recentMentionRequestsGlobal.filter((timestamp) => timestamp > cutoff);

  if (
    recent.length >= MENTION_REQUESTS_PER_USER_PER_MINUTE ||
    recentMentionRequestsGlobal.length >= MENTION_REQUESTS_GLOBAL_PER_MINUTE
  ) {
    recentMentionRequestsByUser.set(userId, recent);
    return true;
  }

  recent.push(now);
  recentMentionRequestsGlobal.push(now);
  recentMentionRequestsByUser.set(userId, recent);

  for (const [trackedUserId, timestamps] of recentMentionRequestsByUser) {
    if (timestamps.every((timestamp) => timestamp <= cutoff)) {
      recentMentionRequestsByUser.delete(trackedUserId);
    }
  }
  return false;
}

function buildAskRequest(prompt) {
  return {
    systemPrompt: ASK_SYSTEM_PROMPT,
    userContent: prompt,
    maxTokens: 800,
  };
}

async function handleMentionedMessage(message) {
  const botId = message.client.user?.id;
  if (!botId || message.author.bot || !message.mentions.users.has(botId)) return;

  const prompt = message.content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
  const replyOptions = { allowedMentions: { parse: [], repliedUser: false } };

  if (!prompt) {
    await message.reply({
      content: `Hi! Mention me with a question, for example: <@${botId}> explain this concept.`,
      ...replyOptions,
    });
    return;
  }

  if (!isOpenRouterConfigured()) {
    await message.reply({
      content: 'Set OPENROUTER_API_KEY and OPENROUTER_MODEL in the bot environment.',
      ...replyOptions,
    });
    return;
  }

  if (isMentionRequestRateLimited(message.author.id)) {
    await message.reply({
      content: 'You are asking too quickly. Wait a minute and try again.',
      ...replyOptions,
    });
    return;
  }

  try {
    await message.channel.sendTyping().catch(() => {});
    const request = buildAskRequest(prompt);
    const answer = await getOpenRouterAnswer({
      ...request,
      tools: withOpenRouterDateTimeTool(request.tools),
    });
    const prepared = prepareDiscordResponse(answer, {
      title: 'Assistant answer',
      filename: 'assistant-response.md',
      description: 'Complete assistant response in Markdown format',
    });
    const files = prepared.attachment
      ? [new AttachmentBuilder(Buffer.from(prepared.attachment.content, 'utf8'), {
        name: prepared.attachment.filename,
        description: prepared.attachment.description,
      })]
      : [];

    await message.reply({
      content: prepared.content,
      files,
      ...replyOptions,
    });
  } catch (error) {
    console.error('Mention response failed:', error?.code ?? error?.name ?? 'unknown error');
    try {
      await message.reply({
        content: "I couldn't get an answer right now. Please try again shortly.",
        ...replyOptions,
      });
    } catch (replyError) {
      console.error('Could not send the mention error response:', replyError?.code ?? replyError?.name ?? 'unknown error');
    }
  }
}

function cleanExpiredStudyQuizzes() {
  const now = Date.now();
  for (const [quizId, quiz] of pendingStudyQuizzes) {
    if (quiz.expiresAt <= now) pendingStudyQuizzes.delete(quizId);
  }
  while (pendingStudyQuizzes.size >= STUDY_QUIZ_LIMIT) {
    pendingStudyQuizzes.delete(pendingStudyQuizzes.keys().next().value);
  }
}

function handleLongResponseButton(res, _req, componentId) {
  const match = /^answer_page:([0-9a-f-]{36}):(\d+)$/.exec(componentId);
  if (!match) return res.status(400).json({ error: 'invalid long response button' });
  return res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: InteractionResponseFlags.EPHEMERAL,
      content: 'This older paginated response is no longer available. The visible message was left unchanged.',
    },
  });
}

function handleStudyQuizButton(res, req, componentId) {
  const match = /^study_quiz:([0-9a-f-]{36}):([a-z_]+)(?::(\d+))?(?::(\d+))?$/.exec(componentId);
  if (!match) return res.status(400).json({ error: 'invalid study quiz button' });

  const [, quizId, action, firstValue, secondValue] = match;
  const quiz = pendingStudyQuizzes.get(quizId);
  if (!quiz || quiz.expiresAt <= Date.now()) {
    pendingStudyQuizzes.delete(quizId);
    return res.send({
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: {
        content: 'This quiz is no longer available. Run `/study exam` again to start a new one.',
        components: [],
        allowed_mentions: { parse: [] },
      },
    });
  }

  if (quiz.ownerUserId !== getDiscordUserId(req)) {
    return res.send({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
  }

  if (action === 'answer') {
    const questionIndex = Number(firstValue);
    const answerIndex = Number(secondValue);
    if (
      quiz.status !== 'answering' ||
      !Number.isInteger(questionIndex) ||
      questionIndex !== quiz.questionIndex ||
      !Number.isInteger(answerIndex) ||
      answerIndex < 0 ||
      answerIndex > 3
    ) {
      return res.send({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
    }
    quiz.answers[quiz.questionIndex] = answerIndex;
    quiz.status = 'feedback';
  } else if (action === 'next') {
    if (quiz.status !== 'feedback' || Number(firstValue) !== quiz.questionIndex) {
      return res.send({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
    }
    if (quiz.questionIndex === quiz.questions.length - 1) {
      quiz.status = 'complete';
    } else {
      quiz.questionIndex += 1;
      quiz.status = 'answering';
    }
  } else if (action === 'review') {
    if (quiz.status !== 'complete') return res.send({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
    quiz.reviewIndexes = getMissedQuestionIndexesForReview(quiz);
    if (quiz.reviewIndexes.length === 0) return res.send({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
    quiz.reviewIndex = 0;
    quiz.status = 'review';
  } else if (action === 'previous') {
    if (quiz.status !== 'review' || Number(firstValue) !== quiz.reviewIndex || quiz.reviewIndex === 0) {
      return res.send({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
    }
    quiz.reviewIndex -= 1;
  } else if (action === 'review_next') {
    if (
      quiz.status !== 'review' ||
      Number(firstValue) !== quiz.reviewIndex ||
      quiz.reviewIndex >= quiz.reviewIndexes.length - 1
    ) {
      return res.send({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
    }
    quiz.reviewIndex += 1;
  } else if (action === 'score') {
    if (quiz.status !== 'review') return res.send({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
    quiz.status = 'complete';
  } else {
    return res.status(400).json({ error: 'unknown study quiz action' });
  }

  quiz.expiresAt = Date.now() + STUDY_QUIZ_TTL_MS;
  const response = renderStudyQuiz(quiz);
  return res.send({
    type: InteractionResponseType.UPDATE_MESSAGE,
    data: { ...response, allowed_mentions: { parse: [] } },
  });
}

async function answerInteraction(
  applicationId,
  interactionToken,
  requestFactory,
  operation,
  failureMessage,
  ownerUserId,
  responseFormatter,
) {
  let content;
  let components;
  let attachment;
  let storedStudyQuizId;
  try {
    const request = await requestFactory();
    const answer = await getOpenRouterAnswer({
      ...request,
      tools: withOpenRouterDateTimeTool(request.tools),
    });
    if (responseFormatter) {
      const formattedResponse = await responseFormatter(answer, request, ownerUserId);
      content = formattedResponse.content;
      components = formattedResponse.components;
      attachment = formattedResponse.attachment;
      storedStudyQuizId = formattedResponse.studyQuizId;
    } else {
      const preparedResponse = prepareDiscordResponse(answer, request.responseDelivery);
      content = preparedResponse.content;
      components = preparedResponse.components;
      attachment = preparedResponse.attachment;
    }
  } catch (error) {
    if (
      error instanceof StudyFileError ||
      error instanceof StudyQuizError ||
      error instanceof AgentCommandError
    ) {
      content = error.userMessage;
    } else {
      console.error(`${operation} failed:`, error.message);
      content = failureMessage;
    }
  }

  try {
    await updateInteractionResponse(applicationId, interactionToken, content, components, attachment);
  } catch (error) {
    if (storedStudyQuizId) pendingStudyQuizzes.delete(storedStudyQuizId);
    console.error('Could not update the Discord interaction:', error.message);
  }
}

function deferOpenRouterCommand(
  res,
  req,
  requestFactory,
  operation,
  failureMessage,
  responseFormatter,
  { ephemeral = true } = {},
) {
  res.send({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: ephemeral ? { flags: InteractionResponseFlags.EPHEMERAL } : {},
  });

  setImmediate(() => {
    void answerInteraction(
      req.body.application_id,
      req.body.token,
      requestFactory,
      operation,
      failureMessage,
      getDiscordUserId(req),
      responseFormatter,
    );
  });
}

function getDiscordUserId(req) {
  return req.body.member?.user?.id ?? req.body.user?.id;
}

function getOptionValue(options, name) {
  return options?.find((option) => option.name === name)?.value;
}

function handleStudyRequest(res, req, studyRequest) {
  if (studyRequest.error) {
    return res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: studyRequest.error,
        flags: InteractionResponseFlags.EPHEMERAL,
      },
    });
  }

  const studyModel = getOpenRouterModel('study');
  if (!isOpenRouterConfigured(studyModel)) {
    return res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: InteractionResponseFlags.EPHEMERAL,
        content: 'Set OPENROUTER_API_KEY and either OPENROUTER_STUDY_MODEL or OPENROUTER_MODEL in the bot environment.',
      },
    });
  }

  const responseFormatter = studyRequest.name === 'guide'
    ? (answer) => {
      const filename = getStudyGuideFilename(studyRequest);
      return {
        content: `Your complete study guide is attached as \`${filename}\`.`,
        attachment: {
          filename,
          description: 'Full study guide in Markdown format',
          content: answer,
        },
      };
    }
    : studyRequest.name === 'exam'
      ? async (answer, request, ownerUserId) => {
        const parsedQuiz = await parseStudyQuizWithRetry(
          answer,
          { ...request, questionCount: studyRequest.questionCount },
          async (retryRequest) => getOpenRouterAnswer({
            ...retryRequest,
            tools: withOpenRouterDateTimeTool(retryRequest.tools),
          }),
        );
        cleanExpiredStudyQuizzes();
        const quizId = randomUUID();
        const quiz = {
          id: quizId,
          ownerUserId,
          ...parsedQuiz,
          answers: new Array(parsedQuiz.questions.length).fill(null),
          questionIndex: 0,
          status: 'answering',
          expiresAt: Date.now() + STUDY_QUIZ_TTL_MS,
        };
        pendingStudyQuizzes.set(quizId, quiz);
        return { ...renderStudyQuiz(quiz), studyQuizId: quizId };
      }
      : undefined;

  const activityName = studyRequest.name;
  return deferOpenRouterCommand(
    res,
    req,
    async () => ({
      ...(await buildStudyOpenRouterRequest(studyRequest)),
      model: studyModel,
    }),
    `/study ${activityName}`,
    "I couldn't complete the study request right now. Please try again shortly.",
    responseFormatter,
  );
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

function formatAgentSummary(agent, { showOwner = false } = {}) {
  const preset = AGENT_PRESET_DEFINITIONS[agent.preset]?.name ?? 'Custom';
  const tools = agent.tools
    .map((tool) => AGENT_TOOL_DEFINITIONS[tool]?.name)
    .filter(Boolean);
  const responseFormat = AGENT_RESPONSE_FORMATS[agent.responseFormat] ?? 'Balanced';
  const language = AGENT_LANGUAGES[agent.language] ?? 'Match the user';
  const visibility = AGENT_VISIBILITIES[agent.visibility] ?? AGENT_VISIBILITIES.global;
  return [
    `**${agent.name}** · ${preset} · v${agent.version ?? 1}`,
    ...(showOwner ? [`Creator: <@${agent.ownerUserId}>`] : []),
    `Goal: ${agent.goal}`,
    `Style: ${agent.style}`,
    `Tools: ${tools.length ? tools.join(', ') : 'No extra tools'}`,
    `Output: ${responseFormat} · Language: ${language} · ${visibility}`,
  ].join('\n');
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
  const session = createAgentUiSession(userId);
  return res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: InteractionResponseFlags.EPHEMERAL,
      allowed_mentions: { parse: [] },
      ...buildAgentHomeData(session),
    },
  });
}

function sendAgentUiUpdate(res, data) {
  return res.send({
    type: InteractionResponseType.UPDATE_MESSAGE,
    data: { ...data, allowed_mentions: { parse: [] } },
  });
}

function sendExpiredAgentUi(res) {
  return res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: InteractionResponseFlags.EPHEMERAL,
      content: 'This Agent Center session expired. Run /agent again to start a new one.',
    },
  });
}

function deferAgentUiUpdate(res, req, operation, operationName, fallbackData) {
  res.send({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
  setImmediate(async () => {
    let response;
    try {
      response = await operation();
    } catch (error) {
      console.error(`${operationName} failed:`, error?.code ?? error?.name ?? 'unknown error');
      response = fallbackData;
    }
    try {
      await updateInteractionResponse(
        req.body.application_id,
        req.body.token,
        response.content,
        response.components,
      );
    } catch (error) {
      console.error(`Could not update the Discord ${operationName} response:`, error.message);
    }
  });
}

function setDraftTool(draft, tool, enabled) {
  const tools = new Set(draft.tools);
  if (enabled) tools.add(tool);
  else tools.delete(tool);
  draft.tools = [...tools];
}

function validateAgentDraft(draft) {
  return validateNewAgent({
    ownerUserId: draft.ownerUserId,
    name: draft.name,
    goal: draft.goal,
    style: draft.style,
    preset: draft.preset,
    webSearch: draft.tools.includes(AGENT_TOOLS.WEB_SEARCH),
    fileAnalysis: draft.tools.includes(AGENT_TOOLS.FILE_ANALYSIS),
    responseFormat: draft.responseFormat,
    language: draft.language,
  });
}

function getSingleAgentModalValue(data, customId) {
  const value = getModalValue(data, customId);
  return Array.isArray(value) ? value[0] : value;
}

function handleAgentUiComponent(res, req, componentId) {
  const parsed = parseAgentUiCustomId(componentId);
  const userId = getDiscordUserId(req);
  const session = parsed && userId ? getAgentUiSession(parsed.sessionId, userId) : null;
  if (!session) return sendExpiredAgentUi(res);

  const { action } = parsed;
  if (action === 'home') return sendAgentUiUpdate(res, buildAgentHomeData(session));
  if (action === 'close') {
    deleteAgentUiSession(session.id);
    return sendAgentUiUpdate(res, { content: 'Agent Center closed.', components: [] });
  }
  if (action === 'create') {
    return res.send({ type: InteractionResponseType.MODAL, data: buildAgentProfileModal(session) });
  }
  if (action === 'browse') {
    return deferAgentUiUpdate(
      res,
      req,
      async () => {
        setAgentUiAgents(session, await listAvailableAgents());
        return buildAgentBrowserData(session);
      },
      '/agent browse',
      { content: 'I could not load the agents right now. Please try again shortly.', components: buildAgentHomeData(session).components },
    );
  }
  if (action === 'previous' || action === 'next') {
    session.page += action === 'previous' ? -1 : 1;
    return sendAgentUiUpdate(res, buildAgentBrowserData(session));
  }
  if (action === 'search') {
    return res.send({ type: InteractionResponseType.MODAL, data: buildAgentSearchModal(session) });
  }
  if (action === 'clear_search') {
    session.query = '';
    session.page = 0;
    return sendAgentUiUpdate(res, buildAgentBrowserData(session));
  }
  if (action === 'select') {
    session.selectedAgentId = req.body.data.values?.[0] ?? null;
    const agent = getSelectedAgent(session);
    if (!agent) return sendAgentUiUpdate(res, buildAgentBrowserData(session));
    return sendAgentUiUpdate(res, buildAgentDetailData(
      session,
      agent,
      formatAgentSummary(agent, { showOwner: true }),
    ));
  }

  const agent = getSelectedAgent(session);
  if (!agent && ['detail', 'run', 'test', 'edit', 'delete', 'delete_confirm'].includes(action)) {
    return sendAgentUiUpdate(res, buildAgentBrowserData(session));
  }
  if (action === 'detail') {
    return sendAgentUiUpdate(res, buildAgentDetailData(
      session,
      agent,
      formatAgentSummary(agent, { showOwner: true }),
    ));
  }
  if (action === 'run' || action === 'test') {
    if (action === 'test' && agent.ownerUserId !== userId) {
      return sendAgentUiUpdate(res, buildAgentDetailData(
        session,
        agent,
        formatAgentSummary(agent, { showOwner: true }),
        'Only the creator can privately test this agent.',
      ));
    }
    if (!isOpenRouterConfigured()) {
      return sendAgentUiUpdate(res, buildAgentDetailData(
        session,
        agent,
        formatAgentSummary(agent, { showOwner: true }),
        'OpenRouter is not configured on the bot host.',
      ));
    }
    return res.send({
      type: InteractionResponseType.MODAL,
      data: buildAgentRunModal(session, agent, action),
    });
  }
  if (action === 'edit') {
    if (agent.ownerUserId !== userId) return sendAgentUiUpdate(res, buildAgentBrowserData(session));
    return res.send({
      type: InteractionResponseType.MODAL,
      data: buildAgentProfileModal(session, { agent, mode: 'edit' }),
    });
  }
  if (action === 'delete') {
    if (agent.ownerUserId !== userId) return sendAgentUiUpdate(res, buildAgentBrowserData(session));
    return sendAgentUiUpdate(res, buildAgentDeleteData(session, agent));
  }
  if (action === 'delete_confirm') {
    if (agent.ownerUserId !== userId) return sendAgentUiUpdate(res, buildAgentBrowserData(session));
    return deferAgentUiUpdate(
      res,
      req,
      async () => {
        await removeAgent(userId, agent.name);
        setAgentUiAgents(session, session.agents.filter((candidate) => candidate.id !== agent.id));
        const browser = buildAgentBrowserData(session);
        return { ...browser, content: `> Deleted **${agent.name}**.\n\n${browser.content}` };
      },
      '/agent delete',
      buildAgentDetailData(
        session,
        agent,
        formatAgentSummary(agent, { showOwner: true }),
        'I could not delete that agent right now. Please try again shortly.',
      ),
    );
  }
  if (action === 'draft_response' || action === 'draft_language') {
    if (!session.draft) return sendAgentUiUpdate(res, buildAgentHomeData(session));
    const value = req.body.data.values?.[0];
    if (action === 'draft_response' && Object.hasOwn(AGENT_RESPONSE_FORMATS, value)) {
      session.draft.responseFormat = value;
    }
    if (action === 'draft_language' && Object.hasOwn(AGENT_LANGUAGES, value)) {
      session.draft.language = value;
    }
    return sendAgentUiUpdate(res, buildAgentDraftData(session, formatAgentSummary(session.draft)));
  }
  if (action === 'toggle_web' || action === 'toggle_file') {
    if (!session.draft) return sendAgentUiUpdate(res, buildAgentHomeData(session));
    const tool = action === 'toggle_web' ? AGENT_TOOLS.WEB_SEARCH : AGENT_TOOLS.FILE_ANALYSIS;
    setDraftTool(session.draft, tool, !session.draft.tools.includes(tool));
    return sendAgentUiUpdate(res, buildAgentDraftData(session, formatAgentSummary(session.draft)));
  }
  if (action === 'draft_edit_profile') {
    if (!session.draft) return sendAgentUiUpdate(res, buildAgentHomeData(session));
    return res.send({
      type: InteractionResponseType.MODAL,
      data: buildAgentProfileModal(session, {
        agent: session.draft,
        mode: session.draftMode,
      }),
    });
  }
  if (action === 'draft_cancel') {
    const wasEditing = session.draftMode === 'edit';
    session.draft = null;
    session.draftMode = null;
    session.editingAgentName = null;
    return sendAgentUiUpdate(
      res,
      wasEditing && agent
        ? buildAgentDetailData(session, agent, formatAgentSummary(agent, { showOwner: true }))
        : buildAgentHomeData(session),
    );
  }
  if (action === 'draft_save') {
    if (!session.draft) return sendAgentUiUpdate(res, buildAgentHomeData(session));
    if (session.busy) {
      return sendAgentUiUpdate(res, buildAgentDraftData(
        session,
        formatAgentSummary(session.draft),
        'This agent is already being saved.',
      ));
    }
    session.busy = true;
    return deferAgentUiUpdate(res, req, async () => {
      try {
        const profile = validateAgentDraft(session.draft);
        const saved = session.draftMode === 'edit'
          ? await editAgent(userId, session.editingAgentName, {
            name: profile.name,
            goal: profile.goal,
            style: profile.style,
            preset: profile.preset,
            webSearch: profile.tools.includes(AGENT_TOOLS.WEB_SEARCH),
            fileAnalysis: profile.tools.includes(AGENT_TOOLS.FILE_ANALYSIS),
            responseFormat: profile.responseFormat,
            language: profile.language,
          })
          : await saveNewAgent(profile);
        setAgentUiAgents(session, [
          ...session.agents.filter((candidate) => candidate.id !== saved.id),
          saved,
        ]);
        session.selectedAgentId = saved.id;
        session.draft = null;
        session.draftMode = null;
        session.editingAgentName = null;
        return buildAgentDetailData(
          session,
          saved,
          formatAgentSummary(saved, { showOwner: true }),
          `Saved **${saved.name}**. Anyone using the bot can now run it.`,
        );
      } catch (error) {
        if (error instanceof AgentCommandError) {
          return buildAgentDraftData(session, formatAgentSummary(session.draft), error.userMessage);
        }
        throw error;
      } finally {
        session.busy = false;
      }
    }, '/agent save', buildAgentDraftData(
      session,
      formatAgentSummary(session.draft),
      'I could not save that agent right now. Please try again shortly.',
    ));
  }

  return res.status(400).json({ error: 'unknown agent component' });
}

function handleAgentUiModal(res, req, customId) {
  const parsed = parseAgentUiCustomId(customId, AGENT_UI_MODAL_PREFIX);
  const userId = getDiscordUserId(req);
  const session = parsed && userId ? getAgentUiSession(parsed.sessionId, userId) : null;
  if (!session) return sendExpiredAgentUi(res);

  const { action } = parsed;
  if (action === 'search_submit') {
    session.query = String(getSingleAgentModalValue(req.body.data, 'agent_search') ?? '').trim();
    session.page = 0;
    return sendAgentUiUpdate(res, buildAgentBrowserData(session));
  }

  if (action === 'create_submit' || action === 'edit_submit') {
    const editing = action === 'edit_submit';
    const current = editing ? getSelectedAgent(session) : null;
    if (editing && (!current || current.ownerUserId !== userId)) {
      return sendAgentUiUpdate(res, buildAgentBrowserData(session));
    }
    try {
      const preset = getSingleAgentModalValue(req.body.data, 'agent_preset');
      const styleValue = String(getSingleAgentModalValue(req.body.data, 'agent_style') ?? '').trim();
      const baseProfile = session.draft ?? current;
      const keepExistingOptions = Boolean(baseProfile && preset === baseProfile.preset);
      session.draft = validateNewAgent({
        ownerUserId: userId,
        name: getSingleAgentModalValue(req.body.data, 'agent_name'),
        goal: getSingleAgentModalValue(req.body.data, 'agent_goal'),
        style: styleValue || undefined,
        preset,
        webSearch: keepExistingOptions
          ? baseProfile.tools.includes(AGENT_TOOLS.WEB_SEARCH)
          : undefined,
        fileAnalysis: keepExistingOptions
          ? baseProfile.tools.includes(AGENT_TOOLS.FILE_ANALYSIS)
          : undefined,
        responseFormat: keepExistingOptions ? baseProfile.responseFormat : undefined,
        language: baseProfile?.language ?? 'auto',
      });
      session.draftMode = editing ? 'edit' : 'create';
      session.editingAgentName = editing ? current.name : null;
      return sendAgentUiUpdate(res, buildAgentDraftData(
        session,
        formatAgentSummary(session.draft),
      ));
    } catch (error) {
      return sendAgentUiUpdate(res, {
        ...buildAgentHomeData(session),
        content: `> ${error?.userMessage ?? 'I could not prepare that agent.'}\n\n${buildAgentHomeData(session).content}`,
      });
    }
  }

  if (action === 'run_submit' || action === 'test_submit') {
    const isTest = action === 'test_submit';
    const selected = getSelectedAgent(session);
    if (!selected) return sendAgentUiUpdate(res, buildAgentBrowserData(session));
    if (isTest && selected.ownerUserId !== userId) {
      return sendAgentUiUpdate(res, buildAgentDetailData(
        session,
        selected,
        formatAgentSummary(selected, { showOwner: true }),
        'Only the creator can privately test this agent.',
      ));
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
    const task = getSingleAgentModalValue(req.body.data, 'agent_task');
    const attachmentValue = getModalValue(req.body.data, 'agent_file');
    const attachmentId = Array.isArray(attachmentValue) ? attachmentValue[0] : undefined;
    return deferOpenRouterCommand(
      res,
      req,
      async () => {
        const runnable = isTest
          ? await requireOwnedAgent(userId, selected.name)
          : await requireRunnableAgent(selected.name);
        return {
          ...(await buildUserAgentRequest(
            runnable,
            task,
            attachmentId,
            req.body.data.resolved?.attachments,
          )),
          responseDelivery: {
            title: `${runnable.name} completed your request`,
            filename: `${runnable.name}-response.md`,
            description: `Complete response from ${runnable.name} in Markdown format`,
          },
        };
      },
      isTest ? '/agent test' : '/agent run',
      isTest
        ? 'I could not test that agent right now. Please try again shortly.'
        : 'I could not run that agent right now. Please try again shortly.',
      undefined,
      { ephemeral: isTest },
    );
  }

  return res.status(400).json({ error: 'unknown agent modal' });
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

  const isPrivateInteraction =
    (type === InteractionType.APPLICATION_COMMAND && data?.name === 'agent') ||
    (type === InteractionType.MESSAGE_COMPONENT && data?.custom_id?.startsWith(AGENT_UI_PREFIX)) ||
    (type === InteractionType.MODAL_SUBMIT && data?.custom_id?.startsWith(AGENT_UI_MODAL_PREFIX));
  if (
    !isPrivateInteraction &&
    (type === InteractionType.APPLICATION_COMMAND || type === InteractionType.MESSAGE_COMPONENT)
  ) {
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

    if (name === 'db') {
      const options = data.options ?? [];
      const action = getOptionValue(options, 'action');
      if (!['status', 'scan', 'lookup'].includes(action)) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: 'Choose an action for /db.',
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

      if (action === 'status') {
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

      if (action === 'scan') {
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

      const question = getOptionValue(options, 'question');
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
            content: 'Enter a question for the assistant.',
          },
        });
      }

      if (!isOpenRouterConfigured()) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: 'Set OPENROUTER_API_KEY and OPENROUTER_MODEL in the bot environment.',
          },
        });
      }

      return deferOpenRouterCommand(
        res,
        req,
        async () => buildAskRequest(prompt.trim()),
        '/ask',
        "I couldn't get an answer right now. Please try again shortly.",
      );
    }

    if (name === 'research') {
      const query = data.options?.find((option) => option.name === 'query')?.value;

      if (typeof query !== 'string' || !query.trim()) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: 'Enter a question or topic to research.',
          },
        });
      }

      if (!isOpenRouterConfigured()) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: 'Set OPENROUTER_API_KEY and OPENROUTER_MODEL in the bot environment.',
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
        "I couldn't complete the research right now. Please try again shortly.",
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
            content: 'Choose an OCI topic and enter a question.',
          },
        });
      }

      if (!isOpenRouterConfigured()) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: 'Set OPENROUTER_API_KEY and OPENROUTER_MODEL in the bot environment.',
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
        "I couldn't answer this OCI question right now. Please try again shortly.",
      );
    }


    if (name === 'study') {
      return handleStudyRequest(res, req, getStudyCommandRequest(data.options, data.resolved?.attachments));
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

    if (componentId.startsWith('study_quiz:')) {
      return handleStudyQuizButton(res, req, componentId);
    }

    if (componentId.startsWith('answer_page:')) {
      return handleLongResponseButton(res, req, componentId);
    }

    if (componentId.startsWith(AGENT_UI_PREFIX)) {
      return handleAgentUiComponent(res, req, componentId);
    }

    return res.status(400).json({ error: 'unknown component' });
  }

  if (type === InteractionType.MODAL_SUBMIT) {
    if (data.custom_id?.startsWith(AGENT_UI_MODAL_PREFIX)) {
      return handleAgentUiModal(res, req, data.custom_id);
    }
    return res.status(400).json({ error: 'unknown modal' });
  }

  console.error('unknown interaction type', type);
  return res.status(400).json({ error: 'unknown interaction type' });
});

const mentionClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  presence: {
    status: 'online',
    activities: [{
      name: '@cyrce-boton para preguntas',
      type: ActivityType.Listening,
    }],
  },
});

mentionClient.on(Events.MessageCreate, (message) => {
  void handleMentionedMessage(message).catch((error) => {
    console.error('Mention handler failed:', error?.code ?? error?.name ?? 'unknown error');
  });
});

mentionClient.on(Events.Error, (error) => {
  console.error('Discord Gateway error:', error?.code ?? error?.name ?? 'unknown error');
});

const server = app.listen(PORT, () => {
  console.log('Listening on port', PORT);
});

if (process.env.DISCORD_TOKEN?.trim()) {
  mentionClient.login(process.env.DISCORD_TOKEN.trim()).catch((error) => {
    console.error('Discord Gateway login failed:', error?.code ?? error?.name ?? 'unknown error');
  });
} else {
  console.error('DISCORD_TOKEN is missing; mention replies are disabled.');
}

async function shutdown() {
  mentionClient.destroy();
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
