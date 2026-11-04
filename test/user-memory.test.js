import test from 'node:test';
import assert from 'node:assert/strict';
import { attachUserMemory, eligibleMemoryInput, memoryContext, validateMemoryNote, verifyMemoryNote } from '../user-memory.js';
import { runMemoryCommand, MEMORY_COMMAND, isMemoryCommand } from '../memory-command.js';

const event = { id: '99', guild_id: '10', channel_id: '20', member: { user: { id: '30' } } };
const raw = 'Prefiero respuestas en español y trabajo con Oracle.';
const note = 'La persona prefiere respuestas en español.';
const request = { systemPrompt: 'Assistant', userContent: `${raw}\nFile: another person lives in Paris.` };

test('Discord scope uses the actual caller and exact channel for interactions and messages', () => {
  assert.deepEqual(memoryContext(event), { userId: '30', guild: '10', channel: '20', source: { kind: 'interaction', id: '99' } });
  const dm = memoryContext({ id: '98', user: { id: '31' }, channel_id: '22' });
  assert.equal(dm.guild, '@dm');
  assert.equal(dm.channel, '22');
  assert.notDeepEqual(dm, memoryContext({ id: '97', user: { id: '31' }, channel_id: '23' }));
  assert.equal(memoryContext({ id: '88', guildId: '10', channelId: '20', author: { id: '32' } }, 'message').userId, '32');
  assert.throws(() => memoryContext({ ...event, channel_id: undefined }), /SCOPE/);
});

test('only original typed command input is eligible; database planning and file contents are excluded', () => {
  for (const [name, field] of [['ask', 'prompt'], ['research', 'query'], ['study', 'input'], ['oci', 'question']]) {
    assert.equal(eligibleMemoryInput({ data: { name, options: [{ name: field, value: raw }, { name: 'file', value: 'File content' }] } }), raw);
  }
  assert.equal(eligibleMemoryInput({ data: { name: 'db', options: [{ name: 'question', value: raw }] } }), '');
  assert.equal(eligibleMemoryInput({ data: { name: 'study', options: [{ name: 'file', value: '99' }] } }), '');
});

test('notes allow third-person paraphrases but reject 500 code points, secrets, questions, and other people', () => {
  assert.equal(validateMemoryNote(note, raw), note);
  const prefix = 'The user prefers ';
  assert.equal(Array.from(validateMemoryNote(prefix + '😀'.repeat(499 - prefix.length), 'I prefer emoji.')).length, 499);
  assert.throws(() => validateMemoryNote(prefix + '😀'.repeat(500 - prefix.length), 'I prefer emoji.'));
  for (const input of ['My password is not-a-real-secret', 'Mi contraseña es un secreto', 'My friend said I prefer short answers.', '¿Qué es Oracle?', 'I like "a quoted statement"']) {
    assert.throws(() => validateMemoryNote(note, input));
  }
  assert.throws(() => validateMemoryNote('Yo prefiero respuestas breves.', raw));
});

test('memory tools hide identity arguments, verify original evidence, and bound writes per turn', async () => {
  const saved = [];
  const verifications = [];
  const context = memoryContext(event);
  const enriched = await attachUserMemory(request, context, raw, {
    store: { getRevision: async () => 7, remember: async (...args) => { saved.push(args); return { status: 'saved' }; }, list: async () => [] },
    verify: async (...args) => { verifications.push(args); return true; },
  });
  assert.deepEqual(enriched.provider, { data_collection: 'deny', require_parameters: true });
  assert.deepEqual(Object.keys(enriched.appTools.remember.definition.function.parameters.properties), ['note']);
  const meta = { deadline: Date.now() + 30000 };
  assert.equal((await enriched.appTools.remember.run({ note, user_id: 'attacker' }, meta)).error, 'invalid_arguments');
  assert.equal((await enriched.appTools.about_person.run({ channel: 'other' }, meta)).error, 'invalid_arguments');
  await enriched.appTools.remember.run({ note }, meta);
  await enriched.appTools.remember.run({ note }, meta);
  assert.equal((await enriched.appTools.remember.run({ note }, meta)).error, 'write_limit');
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[0], [context, note, context.source, 7, meta.deadline]);
  assert.equal(verifications[0][1], raw);
  assert.equal(verifications[0][1].includes('File:'), false);
});

test('unverified claims never reach the database; unavailable storage preserves normal answers', async () => {
  let writes = 0;
  const store = { getRevision: async () => 0, remember: async () => { writes++; } };
  const enriched = await attachUserMemory(request, memoryContext(event), raw, { store, verify: async () => false });
  assert.equal((await enriched.appTools.remember.run({ note }, {})).error, 'note_not_supported_or_not_safe');
  assert.equal(writes, 0);
  const unavailable = await attachUserMemory(request, memoryContext(event), raw, { store: { getRevision: async () => { throw new Error('private database diagnostic'); } } });
  assert.equal(unavailable.appTools, undefined);
  assert.match(unavailable.systemPrompt, /unavailable/);
  assert.doesNotMatch(unavailable.systemPrompt, /private database/);
});

test('private memory management derives scope from Discord, validates IDs, and never accepts another owner', async () => {
  assert.equal(isMemoryCommand({ name: 'memory' }), true);
  assert.deepEqual(MEMORY_COMMAND.contexts, [0, 1, 2]);
  let deleted;
  const store = { getRevision: async () => 0, list: async () => [], remove: async (...args) => { deleted = args; return 2; } };
  const call = (action, id) => ({ ...event, data: { name: 'memory', options: [{ name: 'action', value: action }, { name: 'id', value: id }] } });
  assert.match(await runMemoryCommand(call('list'), { store }), /no personal notes/);
  assert.match(await runMemoryCommand(call('delete', 'invalid'), { store }), /valid note ID/);
  assert.equal(deleted, undefined);
  assert.match(await runMemoryCommand(call('clear'), { store }), /Deleted 2/);
  assert.deepEqual(deleted[0], memoryContext(event));
  assert.equal(deleted[1], undefined);
});

test('grounding validation is tool-free, requires all four booleans, and sends only the original evidence', async (t) => {
  const originalFetch = globalThis.fetch;
  const oldKey = process.env.OPENROUTER_API_KEY;
  const oldModel = process.env.OPENROUTER_MODEL;
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.OPENROUTER_MODEL = 'test/model';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey;
    if (oldModel === undefined) delete process.env.OPENROUTER_MODEL; else process.env.OPENROUTER_MODEL = oldModel;
  });
  let body;
  let safe = false;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ supported: true, durable: true, third_person: true, safe }) } }] }), { status: 200 });
  };
  assert.equal(await verifyMemoryNote(note, raw), false);
  safe = true;
  assert.equal(await verifyMemoryNote(note, raw), true);
  assert.equal(body.tools, undefined);
  assert.equal(body.provider.data_collection, 'deny');
  assert.equal(body.max_tokens, 1024);
  assert.equal(body.response_format, undefined);
  assert.equal(body.reasoning, undefined);
  assert.deepEqual(JSON.parse(body.messages[1].content), { source: raw, note });
});
