import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_TOOLS } from '../agents/agent-config.js';
import { resolveAgentStoreConfig } from '../db/agent-store.js';
import {
  AgentCommandError,
  buildUserAgentRequest,
  resolveAgentProviderPolicy,
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

test('agent storage falls back to the generic ADB credentials', () => {
  const config = resolveAgentStoreConfig({
    ADB_USER: 'bot_app',
    ADB_PASSWORD: 'generic-password',
    ADB_CONNECT_STRING: 'discordadb_low',
    ADB_WALLET_DIR: '/wallet',
    ADB_WALLET_PASSWORD: 'wallet-password',
  });

  assert.equal(config.user, 'bot_app');
  assert.equal(config.password, 'generic-password');
  assert.equal(config.owner, 'BOT_APP');
});

test('dedicated agent-store credentials override generic credentials', () => {
  const config = resolveAgentStoreConfig({
    ADB_USER: 'bot_readonly',
    ADB_PASSWORD: 'generic-password',
    AGENT_STORE_USER: 'bot_agent_app',
    AGENT_STORE_PASSWORD: 'agent-password',
    AGENT_STORE_OWNER: 'bot_agent_owner',
  });

  assert.equal(config.user, 'bot_agent_app');
  assert.equal(config.password, 'agent-password');
  assert.equal(config.owner, 'BOT_AGENT_OWNER');
});

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

test('agent provider data collection is denied by default and can be explicitly allowed', () => {
  assert.deepEqual(resolveAgentProviderPolicy({}), { data_collection: 'deny' });
  assert.deepEqual(
    resolveAgentProviderPolicy({ OPENROUTER_AGENT_DATA_COLLECTION: 'allow' }),
    { data_collection: 'allow' },
  );
  assert.deepEqual(
    resolveAgentProviderPolicy({ OPENROUTER_AGENT_DATA_COLLECTION: 'unexpected' }),
    { data_collection: 'deny' },
  );
});

test('markdown attachments are sent to OpenRouter as plain text', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('# Notes\n\nA test document.');

  try {
    const request = await buildUserAgentRequest(
      makeAgent({ tools: [AGENT_TOOLS.FILE_ANALYSIS] }),
      'Summarize these notes.',
      'attachment-1',
      {
        'attachment-1': {
          filename: 'notes.md',
          size: 27,
          url: 'https://cdn.discordapp.com/attachments/1/2/notes.md',
        },
      },
    );

    assert.equal(typeof request.userContent, 'string');
    assert.match(request.userContent, /Attached file: notes\.md/);
    assert.match(request.userContent, /# Notes/);
    assert.equal(request.tools, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('attachments are rejected when file analysis is not enabled', async () => {
  await assert.rejects(
    () => buildUserAgentRequest(makeAgent(), 'Analyze this file.', 'attachment-1', {}),
    (error) => error instanceof AgentCommandError && /does not have the study-file analysis tool/.test(error.userMessage),
  );
});
