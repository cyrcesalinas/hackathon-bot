import { randomUUID } from 'node:crypto';
import {
  ButtonStyleTypes,
  MessageComponentTypes,
} from 'discord-interactions';
import {
  AGENT_LANGUAGES,
  AGENT_PRESET_DEFINITIONS,
  AGENT_RESPONSE_FORMATS,
  AGENT_TOOLS,
} from './agents/agent-config.js';

export const AGENT_UI_SESSION_TTL_MS = 10 * 60_000;
export const AGENT_UI_PAGE_SIZE = 25;
export const AGENT_UI_PREFIX = 'agent_ui:';
export const AGENT_UI_MODAL_PREFIX = 'agent_ui_modal:';

const AGENT_UI_SESSION_LIMIT = 200;
const COMPONENT_TYPE_LABEL = MessageComponentTypes.LABEL ?? 18;
const COMPONENT_TYPE_TEXT_INPUT = MessageComponentTypes.INPUT_TEXT ?? 4;
const COMPONENT_TYPE_FILE_UPLOAD = 19;
const COMPONENT_TYPE_RADIO_GROUP = 21;
const TEXT_INPUT_STYLE_SHORT = 1;
const TEXT_INPUT_STYLE_PARAGRAPH = 2;
const sessions = new Map();

function componentId(sessionId, action) {
  return `${AGENT_UI_PREFIX}${sessionId}:${action}`;
}

function modalId(sessionId, action) {
  return `${AGENT_UI_MODAL_PREFIX}${sessionId}:${action}`;
}

function actionRow(components) {
  return { type: MessageComponentTypes.ACTION_ROW, components };
}

function button(sessionId, action, label, style, options = {}) {
  return {
    type: MessageComponentTypes.BUTTON,
    custom_id: componentId(sessionId, action),
    label,
    style,
    ...options,
  };
}

function label(labelText, component, description) {
  return {
    type: COMPONENT_TYPE_LABEL,
    label: labelText,
    ...(description ? { description } : {}),
    component,
  };
}

function textInput(customId, { style, required = true, maxLength, value, placeholder }) {
  return {
    type: COMPONENT_TYPE_TEXT_INPUT,
    custom_id: customId,
    style,
    required,
    ...(maxLength ? { max_length: maxLength } : {}),
    ...(value ? { value } : {}),
    ...(placeholder ? { placeholder } : {}),
  };
}

function clampPage(page, count) {
  const lastPage = Math.max(0, Math.ceil(count / AGENT_UI_PAGE_SIZE) - 1);
  return Math.min(Math.max(0, page), lastPage);
}

function truncate(value, maxLength) {
  const characters = Array.from(String(value ?? ''));
  return characters.length <= maxLength
    ? characters.join('')
    : `${characters.slice(0, Math.max(0, maxLength - 1)).join('')}…`;
}

function getChildComponents(components = []) {
  const children = [];
  for (const item of components) {
    if (item?.component) children.push(item.component);
    if (Array.isArray(item?.components)) children.push(...getChildComponents(item.components));
  }
  return children;
}

export function getModalValue(data, customId) {
  const component = getChildComponents(data?.components)
    .find((item) => item?.custom_id === customId);
  if (!component) return undefined;
  if (Object.hasOwn(component, 'value')) return component.value;
  if (Array.isArray(component.values)) return component.values;
  return undefined;
}

export function parseAgentUiCustomId(customId, prefix = AGENT_UI_PREFIX) {
  if (typeof customId !== 'string' || !customId.startsWith(prefix)) return null;
  const remainder = customId.slice(prefix.length);
  const separator = remainder.indexOf(':');
  if (separator < 1 || separator === remainder.length - 1) return null;
  return {
    sessionId: remainder.slice(0, separator),
    action: remainder.slice(separator + 1),
  };
}

export function cleanExpiredAgentUiSessions(now = Date.now()) {
  for (const [sessionId, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(sessionId);
  }
  while (sessions.size >= AGENT_UI_SESSION_LIMIT) {
    sessions.delete(sessions.keys().next().value);
  }
}

export function createAgentUiSession(ownerUserId) {
  cleanExpiredAgentUiSessions();
  const id = randomUUID();
  const session = {
    id,
    ownerUserId,
    agents: [],
    page: 0,
    query: '',
    directRun: false,
    selectedAgentId: null,
    draft: null,
    draftMode: null,
    editingAgentName: null,
    busy: false,
    expiresAt: Date.now() + AGENT_UI_SESSION_TTL_MS,
  };
  sessions.set(id, session);
  return session;
}

export function getAgentUiSession(sessionId, ownerUserId) {
  const session = sessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  if (session.ownerUserId !== ownerUserId) return null;
  session.expiresAt = Date.now() + AGENT_UI_SESSION_TTL_MS;
  return session;
}

export function deleteAgentUiSession(sessionId) {
  sessions.delete(sessionId);
}

export function setAgentUiAgents(session, agents) {
  session.agents = [...agents].sort((left, right) => {
    const leftOwned = left.ownerUserId === session.ownerUserId ? 0 : 1;
    const rightOwned = right.ownerUserId === session.ownerUserId ? 0 : 1;
    return leftOwned - rightOwned || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  });
  session.page = 0;
  session.selectedAgentId = null;
}

export function getSelectedAgent(session) {
  return session.agents.find((agent) => agent.id === session.selectedAgentId) ?? null;
}

export function buildAgentHomeData(session) {
  return {
    content: [
      '## Agent Center',
      'Run an existing agent, create a new one, or browse every agent available to this bot.',
      'Selecting one of your agents also reveals Test, Edit, and Delete controls.',
    ].join('\n\n'),
    components: [
      actionRow([
        button(session.id, 'run_browser', 'Run agent', ButtonStyleTypes.PRIMARY),
        button(session.id, 'create', 'Create agent', ButtonStyleTypes.SECONDARY),
        button(session.id, 'browse', 'Browse agents', ButtonStyleTypes.SECONDARY),
        button(session.id, 'close', 'Close', ButtonStyleTypes.SECONDARY),
      ]),
    ],
  };
}

export function buildAgentProfileModal(session, { agent, mode = 'create' } = {}) {
  const selectedPreset = agent?.preset ?? 'general';
  const selectedLanguage = Object.hasOwn(AGENT_LANGUAGES, agent?.language)
    ? agent.language
    : 'auto';
  return {
    custom_id: modalId(session.id, mode === 'edit' ? 'edit_submit' : 'create_submit'),
    title: mode === 'edit' ? 'Edit agent' : 'Create agent',
    components: [
      label('Agent name', textInput('agent_name', {
        style: TEXT_INPUT_STYLE_SHORT,
        maxLength: 32,
        value: agent?.name,
        placeholder: 'Example: WebVerifier',
      }), 'Names are globally unique.'),
      label('Goal', textInput('agent_goal', {
        style: TEXT_INPUT_STYLE_PARAGRAPH,
        maxLength: 1000,
        value: agent?.goal,
        placeholder: 'What should this agent help people accomplish?',
      })),
      label('Response style', textInput('agent_style', {
        style: TEXT_INPUT_STYLE_PARAGRAPH,
        required: false,
        maxLength: 300,
        value: agent?.style,
        placeholder: 'Optional; the preset provides a default.',
      })),
      label('Preset', {
        type: COMPONENT_TYPE_RADIO_GROUP,
        custom_id: 'agent_preset',
        required: true,
        options: Object.values(AGENT_PRESET_DEFINITIONS).map((preset) => ({
          value: preset.id,
          label: preset.name,
          description: truncate(preset.style, 100),
          default: preset.id === selectedPreset,
        })),
      }),
      label('Response language', {
        type: COMPONENT_TYPE_RADIO_GROUP,
        custom_id: 'agent_language',
        required: true,
        options: Object.entries(AGENT_LANGUAGES).map(([value, name]) => ({
          value,
          label: name,
          default: value === selectedLanguage,
        })),
      }),
    ],
  };
}

export function buildAgentSearchModal(session) {
  return {
    custom_id: modalId(session.id, 'search_submit'),
    title: 'Search agents',
    components: [
      label('Name or goal', textInput('agent_search', {
        style: TEXT_INPUT_STYLE_SHORT,
        required: false,
        maxLength: 100,
        value: session.query,
        placeholder: 'Leave blank to show every agent',
      })),
    ],
  };
}

export function buildAgentRunModal(session, agent, mode = 'run') {
  const acceptsFiles = agent.tools.includes(AGENT_TOOLS.FILE_ANALYSIS);
  return {
    custom_id: modalId(session.id, mode === 'test' ? 'test_submit' : 'run_submit'),
    title: `${mode === 'test' ? 'Test' : 'Run'} ${truncate(agent.name, 32)}`,
    components: [
      label('Task', textInput('agent_task', {
        style: TEXT_INPUT_STYLE_PARAGRAPH,
        maxLength: 1500,
        placeholder: 'What should the agent do?',
      })),
      ...(acceptsFiles ? [label('Optional study file', {
        type: COMPONENT_TYPE_FILE_UPLOAD,
        custom_id: 'agent_file',
        min_values: 0,
        max_values: 1,
        required: false,
      }, 'PDF, text, Markdown, CSV, or JSON; one file maximum.')] : []),
    ],
  };
}

export function buildAgentBrowserData(session) {
  const directRun = session.directRun === true;
  const heading = directRun ? '## Run an agent' : '## Browse agents';
  const normalizedQuery = session.query.trim().toLocaleLowerCase();
  const filteredAgents = normalizedQuery
    ? session.agents.filter((agent) =>
      agent.name.toLocaleLowerCase().includes(normalizedQuery) ||
      agent.goal.toLocaleLowerCase().includes(normalizedQuery))
    : session.agents;
  session.page = clampPage(session.page, filteredAgents.length);
  const totalPages = Math.max(1, Math.ceil(filteredAgents.length / AGENT_UI_PAGE_SIZE));
  const start = session.page * AGENT_UI_PAGE_SIZE;
  const pageAgents = filteredAgents.slice(start, start + AGENT_UI_PAGE_SIZE);
  const ownedCount = filteredAgents.filter((agent) => agent.ownerUserId === session.ownerUserId).length;
  const otherCount = filteredAgents.length - ownedCount;

  if (!pageAgents.length) {
    return {
      content: [
        heading,
        session.query
          ? `No agents matched **${truncate(session.query, 80)}**.`
          : 'No agents have been created yet.',
      ].join('\n\n'),
      components: [
        actionRow([
          button(session.id, 'create', 'Create agent', ButtonStyleTypes.PRIMARY),
          button(session.id, 'search', 'Search', ButtonStyleTypes.SECONDARY),
          button(session.id, 'home', 'Back', ButtonStyleTypes.SECONDARY),
        ]),
      ],
    };
  }

  return {
    content: [
      heading,
      `Your agents: **${ownedCount}** · Created by others: **${otherCount}**`,
      session.query
        ? `Search: **${truncate(session.query, 80)}**`
        : directRun
          ? 'Choose an agent to enter its task immediately.'
          : 'Choose an agent to see its details.',
      `Page ${session.page + 1} of ${totalPages}`,
    ].join('\n\n'),
    components: [
      actionRow([{
        type: MessageComponentTypes.STRING_SELECT,
        custom_id: componentId(session.id, 'select'),
        placeholder: 'Choose an agent',
        min_values: 1,
        max_values: 1,
        options: pageAgents.map((agent) => ({
          label: truncate(
            `${agent.ownerUserId === session.ownerUserId ? '★ Your agent' : 'Community'} · ${agent.name}`,
            100,
          ),
          value: agent.id,
          description: truncate(agent.goal, 100),
        })),
      }]),
      actionRow([
        button(session.id, 'previous', 'Previous', ButtonStyleTypes.SECONDARY, {
          disabled: session.page === 0,
        }),
        button(session.id, 'next', 'Next', ButtonStyleTypes.SECONDARY, {
          disabled: session.page >= totalPages - 1,
        }),
        button(session.id, 'search', session.query ? 'Change search' : 'Search', ButtonStyleTypes.SECONDARY),
        button(session.id, 'clear_search', 'Clear', ButtonStyleTypes.SECONDARY, {
          disabled: !session.query,
        }),
        button(session.id, 'home', 'Back', ButtonStyleTypes.SECONDARY),
      ]),
    ],
  };
}

export function buildAgentDetailData(session, agent, summary, notice) {
  const owned = agent.ownerUserId === session.ownerUserId;
  return {
    content: [
      notice ? `> ${notice}` : null,
      '## Agent details',
      summary,
    ].filter(Boolean).join('\n\n'),
    components: [
      actionRow([
        button(session.id, 'run', 'Run', ButtonStyleTypes.PRIMARY),
        ...(owned ? [
          button(session.id, 'test', 'Test privately', ButtonStyleTypes.SECONDARY),
          button(session.id, 'edit', 'Edit', ButtonStyleTypes.SECONDARY),
          button(session.id, 'delete', 'Delete', ButtonStyleTypes.DANGER),
        ] : []),
        button(session.id, 'browse', 'Back', ButtonStyleTypes.SECONDARY),
      ]),
    ],
  };
}

export function buildAgentDraftData(session, summary, notice) {
  const draft = session.draft;
  const webEnabled = draft.tools.includes(AGENT_TOOLS.WEB_SEARCH);
  const fileEnabled = draft.tools.includes(AGENT_TOOLS.FILE_ANALYSIS);
  return {
    content: [
      notice ? `> ${notice}` : null,
      `## ${session.draftMode === 'edit' ? 'Preview changes' : 'Preview your agent'}`,
      summary,
      'Use the controls below to adjust tools, output, and language before saving.',
    ].filter(Boolean).join('\n\n'),
    components: [
      actionRow([{
        type: MessageComponentTypes.STRING_SELECT,
        custom_id: componentId(session.id, 'draft_response'),
        placeholder: 'Response format',
        options: Object.entries(AGENT_RESPONSE_FORMATS).map(([value, name]) => ({
          label: name,
          value,
          default: value === draft.responseFormat,
        })),
      }]),
      actionRow([{
        type: MessageComponentTypes.STRING_SELECT,
        custom_id: componentId(session.id, 'draft_language'),
        placeholder: 'Response language',
        options: Object.entries(AGENT_LANGUAGES).map(([value, name]) => ({
          label: name,
          value,
          default: value === draft.language,
        })),
      }]),
      actionRow([
        button(
          session.id,
          'toggle_web',
          `Web search: ${webEnabled ? 'On' : 'Off'}`,
          webEnabled ? ButtonStyleTypes.SUCCESS : ButtonStyleTypes.SECONDARY,
        ),
        button(
          session.id,
          'toggle_file',
          `File analysis: ${fileEnabled ? 'On' : 'Off'}`,
          fileEnabled ? ButtonStyleTypes.SUCCESS : ButtonStyleTypes.SECONDARY,
        ),
      ]),
      actionRow([
        button(session.id, 'draft_save', 'Save', ButtonStyleTypes.PRIMARY),
        button(session.id, 'draft_edit_profile', 'Edit profile', ButtonStyleTypes.SECONDARY),
        button(session.id, 'draft_cancel', 'Cancel', ButtonStyleTypes.SECONDARY),
      ]),
    ],
  };
}

export function buildAgentDeleteData(session, agent) {
  return {
    content: `## Delete agent\n\nDelete **${agent.name}** permanently? This cannot be undone.`,
    components: [
      actionRow([
        button(session.id, 'delete_confirm', 'Delete permanently', ButtonStyleTypes.DANGER),
        button(session.id, 'detail', 'Cancel', ButtonStyleTypes.SECONDARY),
      ]),
    ],
  };
}
