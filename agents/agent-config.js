export const AGENT_TOOLS = Object.freeze({
  WEB_SEARCH: 'web_search',
  FILE_ANALYSIS: 'file_analysis',
});

export const AGENT_TOOL_DEFINITIONS = Object.freeze({
  [AGENT_TOOLS.WEB_SEARCH]: Object.freeze({
    id: AGENT_TOOLS.WEB_SEARCH,
    name: 'Web research',
    description: 'Search the web for current information and return direct sources.',
  }),
  [AGENT_TOOLS.FILE_ANALYSIS]: Object.freeze({
    id: AGENT_TOOLS.FILE_ANALYSIS,
    name: 'Study-file analysis',
    description: 'Read an attached study file for the current request.',
  }),
});

export const AGENT_PRESET_DEFINITIONS = Object.freeze({
  general: Object.freeze({
    id: 'general',
    name: 'General assistant',
    style: 'Be clear, practical, and concise. Ask a focused question when important context is missing.',
    tools: Object.freeze([]),
    responseFormat: 'balanced',
  }),
  tutor: Object.freeze({
    id: 'tutor',
    name: 'Tutor',
    style: 'Teach step by step, check assumptions, and include a short example when useful.',
    tools: Object.freeze([AGENT_TOOLS.FILE_ANALYSIS]),
    responseFormat: 'step_by_step',
  }),
  researcher: Object.freeze({
    id: 'researcher',
    name: 'Researcher',
    style: 'Separate sourced facts from inference, compare evidence, and state uncertainty clearly.',
    tools: Object.freeze([AGENT_TOOLS.WEB_SEARCH]),
    responseFormat: 'report',
  }),
  study_coach: Object.freeze({
    id: 'study_coach',
    name: 'Study coach',
    style: 'Be encouraging and rigorous. Break material into manageable explanations and review questions.',
    tools: Object.freeze([AGENT_TOOLS.FILE_ANALYSIS]),
    responseFormat: 'structured',
  }),
  custom: Object.freeze({
    id: 'custom',
    name: 'Custom',
    style: 'Follow the configured goal and communicate clearly.',
    tools: Object.freeze([]),
    responseFormat: 'balanced',
  }),
});

export const AGENT_RESPONSE_FORMATS = Object.freeze({
  balanced: 'Balanced',
  concise: 'Concise',
  detailed: 'Detailed',
  step_by_step: 'Step by step',
  structured: 'Structured sections',
  report: 'Research report',
});

export const AGENT_LANGUAGES = Object.freeze({
  auto: 'Match the user',
  en: 'English',
  es: 'Spanish',
});

export const AGENT_VISIBILITIES = Object.freeze({
  global: 'Available to everyone',
});

export function getAgentPreset(presetId) {
  return AGENT_PRESET_DEFINITIONS[presetId] ?? null;
}

export function normalizeAgentTools(tools) {
  if (!Array.isArray(tools)) return [];
  const supported = new Set(Object.keys(AGENT_TOOL_DEFINITIONS));
  return [...new Set(tools.filter((tool) => supported.has(tool)))].sort();
}

export function getLegacyCapability(tools) {
  const normalized = normalizeAgentTools(tools);
  if (normalized.length === 1 && normalized[0] === AGENT_TOOLS.WEB_SEARCH) return 'research';
  if (normalized.length === 1 && normalized[0] === AGENT_TOOLS.FILE_ANALYSIS) return 'study';
  return normalized.length ? 'custom' : 'chat';
}

export function getToolsFromLegacyCapability(capability) {
  if (capability === 'research') return [AGENT_TOOLS.WEB_SEARCH];
  if (capability === 'study') return [AGENT_TOOLS.FILE_ANALYSIS];
  return [];
}
