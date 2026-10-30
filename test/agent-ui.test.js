import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageComponentTypes } from 'discord-interactions';
import { AGENT_TOOLS } from '../agents/agent-config.js';
import {
  AGENT_UI_MODAL_PREFIX,
  buildAgentBrowserData,
  buildAgentHomeData,
  buildAgentProfileModal,
  buildAgentRunModal,
  createAgentUiSession,
  getAgentUiSession,
  getModalValue,
  parseAgentUiCustomId,
  setAgentUiAgents,
} from '../agent-ui.js';

function makeAgent(id, overrides = {}) {
  return {
    id,
    ownerUserId: 'other-user',
    name: `Agent ${id}`,
    goal: `Help with task ${id}`,
    style: 'Be clear.',
    preset: 'general',
    tools: [],
    responseFormat: 'balanced',
    language: 'auto',
    visibility: 'global',
    version: 1,
    ...overrides,
  };
}

test('Agent Center sessions are private to their creator', () => {
  const session = createAgentUiSession('owner-1');
  const home = buildAgentHomeData(session);

  assert.match(home.content, /Agent Center/);
  assert.deepEqual(
    home.components[0].components.map((component) => component.label),
    ['Create agent', 'Browse agents', 'Close'],
  );
  assert.equal(getAgentUiSession(session.id, 'owner-1'), session);
  assert.equal(getAgentUiSession(session.id, 'different-user'), null);
});

test('agent profile modal uses labels and a preset radio group', () => {
  const session = createAgentUiSession('owner-2');
  const modal = buildAgentProfileModal(session);

  assert.equal(modal.components.length, 4);
  assert.ok(modal.components.every((component) => component.type === 18));
  assert.equal(modal.components[0].component.type, MessageComponentTypes.INPUT_TEXT);
  assert.equal(modal.components[3].component.type, 21);
  assert.ok(modal.components[3].component.options.length >= 2);
  assert.deepEqual(
    parseAgentUiCustomId(modal.custom_id, AGENT_UI_MODAL_PREFIX),
    { sessionId: session.id, action: 'create_submit' },
  );
});

test('modal values are read from Discord label components', () => {
  const data = {
    components: [
      {
        type: 18,
        component: { type: 4, custom_id: 'agent_name', value: 'Atlas' },
      },
      {
        type: 18,
        component: { type: 21, custom_id: 'agent_preset', values: ['researcher'] },
      },
    ],
  };

  assert.equal(getModalValue(data, 'agent_name'), 'Atlas');
  assert.deepEqual(getModalValue(data, 'agent_preset'), ['researcher']);
});

test('browser lists owned agents first and paginates at 25 options', () => {
  const session = createAgentUiSession('owner-3');
  const agents = Array.from({ length: 26 }, (_, index) => makeAgent(String(index + 1)));
  agents.push(makeAgent('owned', { ownerUserId: 'owner-3', name: 'My Agent' }));
  setAgentUiAgents(session, agents);

  const browser = buildAgentBrowserData(session);
  const select = browser.components[0].components[0];

  assert.equal(select.options.length, 25);
  assert.match(select.options[0].label, /^★ Your agent/);
  assert.match(browser.content, /Page 1 of 2/);
  assert.equal(browser.components[1].components[1].disabled, false);
});

test('run modal accepts a file only when file analysis is enabled', () => {
  const session = createAgentUiSession('owner-4');
  const withoutFile = buildAgentRunModal(session, makeAgent('plain'));
  const withFile = buildAgentRunModal(
    session,
    makeAgent('file', { tools: [AGENT_TOOLS.FILE_ANALYSIS] }),
  );

  assert.equal(withoutFile.components.length, 1);
  assert.equal(withFile.components.length, 2);
  assert.equal(withFile.components[1].component.type, 19);
  assert.equal(withFile.components[1].component.required, false);
});
