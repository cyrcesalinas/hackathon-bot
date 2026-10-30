import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_CONVERSATION_TTL_MS,
  buildAgentFollowUpRequest,
  getAgentConversation,
  storeAgentConversation,
} from '../agent-conversation.js';

function makeAgent(overrides = {}) {
  return {
    id: 'agent-1',
    ownerUserId: 'creator',
    name: 'Atlas',
    goal: 'Analyze supplied material.',
    style: 'Be clear.',
    preset: 'custom',
    tools: [],
    responseFormat: 'balanced',
    language: 'auto',
    visibility: 'global',
    version: 1,
    ...overrides,
  };
}

test('agent conversation context expires and refreshes from a response message', () => {
  const stored = storeAgentConversation('message-1', {
    ownerUserId: 'runner',
    channelId: 'channel-1',
    agent: makeAgent(),
    originalTask: 'Summarize the file.',
    previousAnswer: 'Initial answer.',
  }, 1_000);

  assert.equal(getAgentConversation('message-1', 2_000), stored);
  assert.equal(
    getAgentConversation('message-1', 2_000 + AGENT_CONVERSATION_TTL_MS + 1),
    null,
  );
});

test('agent follow-up request includes the earlier task and answer', async () => {
  const conversation = storeAgentConversation('message-2', {
    ownerUserId: 'runner',
    channelId: 'channel-1',
    agent: makeAgent(),
    originalTask: 'Summarize the file.',
    previousTask: 'Summarize the file.',
    previousAnswer: 'The document describes three phases.',
  });

  const request = await buildAgentFollowUpRequest(
    conversation,
    'Explain the second phase in more detail.',
  );

  assert.match(request.userContent, /Original task: Summarize the file/);
  assert.match(request.userContent, /document describes three phases/);
  assert.match(request.userContent, /Explain the second phase/);
  assert.deepEqual(request.reasoning, { enabled: false });
});
