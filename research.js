import { RESEARCH_SYSTEM_PROMPT } from './prompts.js';

const RESEARCH_REPAIR_DEADLINE_MS = 120_000;
const LEAKED_TOOL_CALL = /\\?<\/?tool_call(?:\s[^>]*)?>/iu;
const SOURCES_HEADING = /^#{1,6}\s+Sources\s*$/imu;
const MARKDOWN_LINK = /\[[^\]\r\n]+\]\(https?:\/\/[^\s)]+(?:\s+"[^"]*")?\)/iu;

export class ResearchResponseError extends Error {
  constructor(message = "The research response was incomplete or didn't include verifiable sources. Please try again.") {
    super('RESEARCH_RESPONSE_INVALID');
    this.name = 'ResearchResponseError';
    this.userMessage = message;
  }
}

export function buildResearchRequest(query) {
  return {
    systemPrompt: RESEARCH_SYSTEM_PROMPT,
    userContent: query,
    maxTokens: 2500,
    maxContinuations: 2,
    tools: [{ type: 'openrouter:web_search' }],
  };
}

export function validateResearchMarkdown(answer) {
  const errors = [];
  if (typeof answer !== 'string' || !answer.trim()) return { valid: false, errors: ['empty'] };
  const markdown = answer.trim();
  if (LEAKED_TOOL_CALL.test(markdown)) errors.push('leaked_tool_call');

  const heading = SOURCES_HEADING.exec(markdown);
  if (!heading) errors.push('missing_sources_heading');
  else if (!MARKDOWN_LINK.test(markdown.slice(heading.index + heading[0].length))) errors.push('missing_source_links');

  const fenceCount = (markdown.match(/^\s*```/gmu) || []).length;
  if (fenceCount % 2 === 1) errors.push('open_code_fence');
  const finalLine = markdown.slice(markdown.lastIndexOf('\n') + 1).trim();
  if (!/[.!?\])>]$/u.test(finalLine)) errors.push('incomplete_ending');

  return { valid: errors.length === 0, errors };
}

export async function ensureCompleteResearch(answer, request, retry) {
  if (validateResearchMarkdown(answer).valid) return answer.trim();
  const repaired = await retry({
    ...request,
    appTools: undefined,
    reasoning: { enabled: false },
    deadline: Date.now() + RESEARCH_REPAIR_DEADLINE_MS,
    systemPrompt: `${request.systemPrompt}\n\nThe previous research response was incomplete or malformed. Start over and produce a shorter, self-contained report that finishes cleanly. Use available tools through their structured API only; never print tool-call tags or internal tool names. End with a Sources section containing direct Markdown links to the pages actually used. Memory tools are disabled during this repair; do not claim to save new notes.`,
  });
  if (!validateResearchMarkdown(repaired).valid) throw new ResearchResponseError();
  return repaired.trim();
}
