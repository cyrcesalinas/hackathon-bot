import { buildStudyOpenRouterRequest, getStudyCommandRequest } from '../study.js';
import { getUserAgentSystemPrompt } from '../prompts.js';
import {
  AgentStoreConflictError,
  createAgent,
  deleteAgent,
  getAgent,
  getRunnableAgent,
  listGlobalAgents,
  updateAgent,
} from '../db/agent-store.js';
import {
  AGENT_LANGUAGES,
  AGENT_PRESET_DEFINITIONS,
  AGENT_RESPONSE_FORMATS,
  AGENT_TOOLS,
  getAgentPreset,
  getLegacyCapability,
  normalizeAgentTools,
} from './agent-config.js';

export const MAX_AGENT_NAME_LENGTH = 32;
export const MAX_AGENT_GOAL_LENGTH = 1000;
export const MAX_AGENT_STYLE_LENGTH = 300;

const MAX_AGENT_TASK_LENGTH = 1500;

export function resolveAgentProviderPolicy(env = process.env) {
  const dataCollection = env.OPENROUTER_AGENT_DATA_COLLECTION?.trim().toLowerCase();
  return { data_collection: dataCollection === 'allow' ? 'allow' : 'deny' };
}
export class AgentCommandError extends Error {
  constructor(userMessage) {
    super(userMessage);
    this.name = 'AgentCommandError';
    this.userMessage = userMessage;
  }
}

function normalizeField(value, label, maxLength) {
  if (typeof value !== 'string') throw new AgentCommandError(`Enter a ${label}.`);
  const normalized = value.replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!normalized) throw new AgentCommandError(`Enter a ${label}.`);
  if (Array.from(normalized).length > maxLength) {
    throw new AgentCommandError(`${label[0].toUpperCase()}${label.slice(1)} must be ${maxLength} characters or fewer.`);
  }
  return normalized;
}

function normalizeChoice(value, choices, label) {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  if (!Object.hasOwn(choices, normalized)) {
    throw new AgentCommandError(`Choose a supported ${label}.`);
  }
  return normalized;
}

function setTool(tools, tool, enabled) {
  const next = new Set(tools);
  if (enabled === true) next.add(tool);
  if (enabled === false) next.delete(tool);
  return normalizeAgentTools([...next]);
}

export function validateNewAgent({
  name,
  goal,
  style,
  preset = 'general',
  webSearch,
  fileAnalysis,
  responseFormat,
  language = 'auto',
  ownerUserId,
}) {
  const presetId = normalizeChoice(preset, AGENT_PRESET_DEFINITIONS, 'agent preset');
  const presetDefinition = getAgentPreset(presetId);
  let tools = [...presetDefinition.tools];
  tools = setTool(tools, AGENT_TOOLS.WEB_SEARCH, webSearch);
  tools = setTool(tools, AGENT_TOOLS.FILE_ANALYSIS, fileAnalysis);

  const selectedResponseFormat = responseFormat === undefined
    ? presetDefinition.responseFormat
    : normalizeChoice(responseFormat, AGENT_RESPONSE_FORMATS, 'response format');

  return {
    ownerUserId,
    name: normalizeField(name, 'agent name', MAX_AGENT_NAME_LENGTH),
    goal: normalizeField(goal, 'agent goal', MAX_AGENT_GOAL_LENGTH),
    style: style === undefined
      ? presetDefinition.style
      : normalizeField(style, 'response style', MAX_AGENT_STYLE_LENGTH),
    preset: presetId,
    tools,
    responseFormat: selectedResponseFormat,
    language: normalizeChoice(language, AGENT_LANGUAGES, 'language'),
    capability: getLegacyCapability(tools),
    visibility: 'global',
    version: 1,
  };
}

export async function saveNewAgent(profile, createAgentOperation = createAgent) {
  try {
    const result = await createAgentOperation(profile);
    if (result.limitReached) {
      throw new AgentCommandError('You have reached the limit of 20 saved agents. Delete one before creating another.');
    }
    return result.agent;
  } catch (error) {
    if (error instanceof AgentStoreConflictError) {
      throw new AgentCommandError('That agent name is already taken. Choose a different name.');
    }
    throw error;
  }
}

export async function editAgent(ownerUserId, oldName, options) {
  const current = await getAgent(ownerUserId, oldName);
  if (!current) throw new AgentCommandError('I could not find one of your agents with that name.');

  const patch = {};
  let tools = [...current.tools];
  let toolsChanged = false;

  if (options.preset !== undefined) {
    const preset = normalizeChoice(options.preset, AGENT_PRESET_DEFINITIONS, 'agent preset');
    const definition = getAgentPreset(preset);
    patch.preset = preset;
    patch.style = definition.style;
    patch.responseFormat = definition.responseFormat;
    tools = [...definition.tools];
    toolsChanged = true;
  }
  if (options.name !== undefined) patch.name = normalizeField(options.name, 'agent name', MAX_AGENT_NAME_LENGTH);
  if (options.goal !== undefined) patch.goal = normalizeField(options.goal, 'agent goal', MAX_AGENT_GOAL_LENGTH);
  if (options.style !== undefined) patch.style = normalizeField(options.style, 'response style', MAX_AGENT_STYLE_LENGTH);
  if (options.responseFormat !== undefined) {
    patch.responseFormat = normalizeChoice(options.responseFormat, AGENT_RESPONSE_FORMATS, 'response format');
  }
  if (options.language !== undefined) {
    patch.language = normalizeChoice(options.language, AGENT_LANGUAGES, 'language');
  }
  if (options.webSearch !== undefined) {
    tools = setTool(tools, AGENT_TOOLS.WEB_SEARCH, options.webSearch);
    toolsChanged = true;
  }
  if (options.fileAnalysis !== undefined) {
    tools = setTool(tools, AGENT_TOOLS.FILE_ANALYSIS, options.fileAnalysis);
    toolsChanged = true;
  }
  if (toolsChanged) {
    patch.tools = tools;
    patch.capability = getLegacyCapability(tools);
  }
  if (!Object.keys(patch).length) {
    throw new AgentCommandError('Provide at least one field to change.');
  }

  try {
    const updated = await updateAgent(ownerUserId, oldName, patch);
    if (!updated) throw new AgentCommandError('I could not find one of your agents with that name.');
    return updated;
  } catch (error) {
    if (error instanceof AgentStoreConflictError) {
      throw new AgentCommandError('That agent name is already taken. Choose a different name.');
    }
    throw error;
  }
}

export async function removeAgent(ownerUserId, name) {
  const deleted = await deleteAgent(ownerUserId, name);
  if (!deleted) throw new AgentCommandError('I could not find one of your agents with that name.');
}

export async function requireOwnedAgent(ownerUserId, name) {
  const agent = await getAgent(ownerUserId, name);
  if (!agent) throw new AgentCommandError('I could not find one of your agents with that name.');
  return agent;
}

export async function requireRunnableAgent(name) {
  const agent = await getRunnableAgent(name);
  if (!agent) throw new AgentCommandError('I could not find an agent with that name.');
  return agent;
}

export async function listAvailableAgents() {
  return listGlobalAgents();
}

export async function buildUserAgentRequest(agent, taskValue, attachmentId, resolvedAttachments = {}) {
  const task = normalizeField(taskValue, 'task', MAX_AGENT_TASK_LENGTH);
  const tools = normalizeAgentTools(agent.tools);
  const canAnalyzeFiles = tools.includes(AGENT_TOOLS.FILE_ANALYSIS);
  const canSearchWeb = tools.includes(AGENT_TOOLS.WEB_SEARCH);

  if (attachmentId !== undefined && !canAnalyzeFiles) {
    throw new AgentCommandError('This agent does not have the study-file analysis tool. Enable it before attaching a file.');
  }

  const systemPrompt = getUserAgentSystemPrompt(agent, { canSearchWeb, canAnalyzeFiles });

  const maxTokens = ['detailed', 'report'].includes(agent.responseFormat) ? 4000
    : agent.responseFormat === 'concise' ? 1000
      : 2500;
  const openRouterTools = canSearchWeb ? [{ type: 'openrouter:web_search' }] : undefined;
  const provider = resolveAgentProviderPolicy();
  const reasoning = attachmentId !== undefined
    ? { enabled: false }
    : ['detailed', 'report'].includes(agent.responseFormat)
      ? { effort: 'low' }
      : { enabled: false };

  if (attachmentId !== undefined) {
    const options = [
      { name: 'topic', value: task },
      { name: 'file', value: attachmentId },
    ];
    const studyRequest = getStudyCommandRequest(
      [{ type: 1, name: 'guide', options }],
      resolvedAttachments,
    );
    if (studyRequest.error) throw new AgentCommandError(studyRequest.error);
    const request = await buildStudyOpenRouterRequest(studyRequest);
    return {
      ...request,
      systemPrompt,
      maxTokens,
      maxContinuations: 2,
      tools: openRouterTools,
      provider,
      reasoning,
    };
  }

  return {
    systemPrompt,
    userContent: task,
    maxTokens,
    maxContinuations: 2,
    tools: openRouterTools,
    provider,
    reasoning,
  };
}
