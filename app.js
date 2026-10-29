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
  parseStudyQuiz,
  buildStudyOpenRouterRequest,
  getStudyGuideFilename,
  getStudyCommandRequest,
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
  AGENT_VISIBILITIES,
} from './agents/agent-config.js';
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
const pendingAgentDrafts = new Map();

const ADB_REQUESTS_PER_USER_PER_MINUTE = 5;
const ADB_REQUESTS_GLOBAL_PER_MINUTE = 30;
const AGENT_RUNS_PER_USER_PER_MINUTE = 5;
const AGENT_RUNS_GLOBAL_PER_MINUTE = 30;
const AGENT_DRAFT_TTL_MS = 10 * 60_000;
const AGENT_DRAFT_LIMIT = 200;
const STUDY_QUIZ_TTL_MS = 30 * 60_000;
const STUDY_QUIZ_LIMIT = 100;
const pendingStudyQuizzes = new Map();

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
      const formattedResponse = responseFormatter(answer, request, ownerUserId);
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
      ? (answer, _request, ownerUserId) => {
        let parsedQuiz;
        try {
          parsedQuiz = parseStudyQuiz(answer, studyRequest.questionCount);
        } catch (error) {
          if (!(error instanceof StudyQuizError)) throw error;
          return { content: limitDiscordMessage(answer) };
        }
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

function deferAgentOperation(res, req, operation, operationName, failureMessage) {
  res.send({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  });

  setImmediate(async () => {
    let response;
    try {
      const result = await operation();
      response = typeof result === 'string'
        ? { content: limitDiscordMessage(result) }
        : result;
    } catch (error) {
      if (error?.userMessage) {
        response = { content: error.userMessage };
      } else {
        console.error(`${operationName} failed:`, error?.code ?? error?.name ?? 'unknown error');
        response = { content: failureMessage };
      }
    }

    try {
      await updateInteractionResponse(
        req.body.application_id,
        req.body.token,
        response.content,
        response.components,
        response.attachment,
      );
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

  const options = req.body.data.options ?? [];
  const action = getOptionValue(options, 'action');

  if (action === 'create') {
    let profile;
    try {
      profile = validateNewAgent({
        ownerUserId: userId,
        name: getOptionValue(options, 'name'),
        goal: getOptionValue(options, 'goal'),
        style: getOptionValue(options, 'style'),
        preset: getOptionValue(options, 'preset'),
        webSearch: getOptionValue(options, 'web_search'),
        fileAnalysis: getOptionValue(options, 'file_analysis'),
        responseFormat: getOptionValue(options, 'response_format'),
        language: getOptionValue(options, 'language'),
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
        content: `Preview your agent\n\n${formatAgentSummary(profile)}\n\nIts name must be unique, and anyone who uses the bot will be able to run it. It will use the bot's configured OpenRouter model. Save it, then choose Run an agent from /agent.`,
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

  if (action === 'list' || action === 'browse' || action === 'shared') {
    return deferAgentOperation(
      res,
      req,
      async () => {
        const agents = await listAvailableAgents();
        if (!agents.length) return 'No agents have been created yet. Start with /agent and choose Create agent.';

        const ownedAgents = agents.filter((agent) => agent.ownerUserId === userId);
        const otherAgents = agents.filter((agent) => agent.ownerUserId !== userId);
        const ownedSection = ownedAgents.length
          ? ownedAgents.map(formatAgentSummary).join('\n\n')
          : 'You have not created any agents yet.';
        const otherSection = otherAgents.length
          ? otherAgents.map((agent) => formatAgentSummary(agent, { showOwner: true })).join('\n\n')
          : 'No agents created by other users yet.';

        const directory = [
          `## Your agents (${ownedAgents.length})`,
          ownedSection,
          `## Agents created by others (${otherAgents.length})`,
          otherSection,
        ].join('\n\n');
        return prepareDiscordResponse(directory, {
          title: 'Agent directory',
          filename: 'agent-directory.md',
          description: 'Agents grouped by ownership in Markdown format',
        });
      },
      '/agent list',
      'I could not load the agents right now. Please try again shortly.',
    );
  }

  if (action === 'share' || action === 'unshare') {
    return res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: InteractionResponseFlags.EPHEMERAL,
        content: 'Sharing controls are no longer needed. Every saved agent is available to everyone who uses the bot.',
      },
    });
  }

  if (action === 'run' || action === 'test') {
    const isTest = action === 'test';
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
        const agent = isTest
          ? await requireOwnedAgent(userId, name.trim())
          : await requireRunnableAgent(name.trim());
        return {
          ...(await buildUserAgentRequest(agent, task, attachmentId, req.body.data.resolved?.attachments)),
          responseDelivery: {
            title: `${agent.name} completed your request`,
            filename: `${agent.name}-response.md`,
            description: `Complete response from ${agent.name} in Markdown format`,
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

  if (action === 'edit') {
    const name = getOptionValue(options, 'name');
    const patch = {};
    const newName = getOptionValue(options, 'new_name');
    const goal = getOptionValue(options, 'goal');
    const style = getOptionValue(options, 'style');
    const preset = getOptionValue(options, 'preset');
    const webSearch = getOptionValue(options, 'web_search');
    const fileAnalysis = getOptionValue(options, 'file_analysis');
    const responseFormat = getOptionValue(options, 'response_format');
    const language = getOptionValue(options, 'language');
    if (newName !== undefined) patch.name = newName;
    if (goal !== undefined) patch.goal = goal;
    if (style !== undefined) patch.style = style;
    if (preset !== undefined) patch.preset = preset;
    if (webSearch !== undefined) patch.webSearch = webSearch;
    if (fileAnalysis !== undefined) patch.fileAnalysis = fileAnalysis;
    if (responseFormat !== undefined) patch.responseFormat = responseFormat;
    if (language !== undefined) patch.language = language;
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

  if (action === 'delete') {
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
      content: 'Choose an action under /agent: Create, Delete, Edit, List, Run, or Test an agent.',
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
        return `Saved **${agent.name}**. It is now available for anyone using the bot to run.`;
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
    (type === InteractionType.APPLICATION_COMMAND && ['agent', 'db', 'study'].includes(data?.name)) ||
    (type === InteractionType.MESSAGE_COMPONENT && (
      data?.custom_id?.startsWith('agent_save:') ||
      data?.custom_id?.startsWith('agent_cancel:')
    ));
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
        async () => ({
          systemPrompt: ASK_SYSTEM_PROMPT,
          userContent: prompt.trim(),
          maxTokens: 800,
        }),
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

    if (componentId.startsWith('agent_save:') || componentId.startsWith('agent_cancel:')) {
      return handleAgentDraftButton(res, req, componentId);
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
