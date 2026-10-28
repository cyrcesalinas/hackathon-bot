import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_TOOLS } from '../agents/agent-config.js';
import {
  AgentCommandError,
  buildUserAgentRequest,
  validateNewAgent,
} from '../agents/user-agent.js';

function makeAgent(overrides = {}) {
  return {
    ownerUserId: '123',
    name: 'Atlas',
    goal: 'Help students investigate technical topics carefully.',
    style: 'Be practical and evidence-focused.',
    preset: 'custom',
    tools: [],
    responseFormat: 'balanced',
    language: 'auto',
    version: 1,
    ...overrides,
  };
}

test('researcher preset enables web research and report output', () => {
  const agent = validateNewAgent({
    ownerUserId: '123',
    name: 'Atlas',
    goal: 'Research current AI topics.',
    preset: 'researcher',
  });

  assert.deepEqual(agent.tools, [AGENT_TOOLS.WEB_SEARCH]);
  assert.equal(agent.responseFormat, 'report');
  assert.equal(agent.language, 'auto');
  assert.equal(agent.version, 1);
});

test('tool overrides can combine web research and file analysis', () => {
  const agent = validateNewAgent({
    ownerUserId: '123',
    name: 'Atlas',
    goal: 'Compare uploaded material with current sources.',
    preset: 'general',
    webSearch: true,
    fileAnalysis: true,
    responseFormat: 'structured',
    language: 'en',
  });

  assert.deepEqual(agent.tools, [AGENT_TOOLS.FILE_ANALYSIS, AGENT_TOOLS.WEB_SEARCH]);
  assert.equal(agent.capability, 'custom');
  assert.equal(agent.responseFormat, 'structured');
  assert.equal(agent.language, 'en');
});

test('an explicit false override removes a preset tool', () => {
  const agent = validateNewAgent({
    ownerUserId: '123',
    name: 'Offline Researcher',
    goal: 'Analyze only information supplied by the student.',
    preset: 'researcher',
    webSearch: false,
  });

  assert.deepEqual(agent.tools, []);
  assert.equal(agent.capability, 'chat');
});

test('web-enabled agents receive only the approved OpenRouter search tool', async () => {
  const request = await buildUserAgentRequest(
    makeAgent({
      tools: [AGENT_TOOLS.WEB_SEARCH],
      responseFormat: 'report',
      language: 'en',
    }),
    'Compare two current approaches and cite sources.',
  );

  assert.deepEqual(request.tools, [{ type: 'openrouter:web_search' }]);
  assert.deepEqual(request.provider, { data_collection: 'deny' });
  assert.match(request.systemPrompt, /Respond in English/);
  assert.match(request.systemPrompt, /research report/);
});

test('attachments are rejected when file analysis is not enabled', async () => {
  await assert.rejects(
    () => buildUserAgentRequest(makeAgent(), 'Analyze this file.', 'attachment-1', {}),
    (error) => error instanceof AgentCommandError && /does not have the study-file analysis tool/.test(error.userMessage),
  );
});
