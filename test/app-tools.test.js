import test from 'node:test';
import assert from 'node:assert/strict';
import { runAppToolLoop } from '../app-tools.js';
import { getOpenRouterAnswer } from '../openrouter.js';

const toolCall = (id = '1', name = 'remember', args = '{}') => ({ id, type: 'function', function: { name, arguments: args } });
const response = (message, finish_reason = 'stop') => ({ choices: [{ message, finish_reason }] });
const definition = { type: 'function', function: { name: 'remember', parameters: { type: 'object', properties: {} } } };

test('null tool_calls is an ordinary final answer', async () => {
  const result = await runAppToolLoop({ messages: [] }, {}, async () => response({ content: 'ok', tool_calls: null }), { deadline: Date.now() + 10000 });
  assert.equal(result.choices[0].message.content, 'ok');
});

test('tool results preserve matching IDs and reasoning; text alongside calls is not treated as final', async () => {
  const body = { messages: [] };
  let executed = 0;
  let round = 0;
  const result = await runAppToolLoop(body, { remember: { run: async () => { executed++; return { status: 'saved' }; } } }, async () => ++round === 1
    ? response({ content: 'Before execution', tool_calls: [toolCall()], reasoning_details: [{ type: 'opaque', data: 'preserve' }] })
    : response({ content: 'After execution' }), { deadline: Date.now() + 10000 });
  assert.equal(executed, 1);
  assert.equal(result.choices[0].message.content, 'After execution');
  assert.deepEqual(body.messages[0].reasoning_details, [{ type: 'opaque', data: 'preserve' }]);
  assert.equal(body.messages[1].tool_call_id, '1');
  assert.equal(JSON.parse(body.messages[1].content).status, 'saved');
});

test('unknown, malformed, and repeated calls cannot repeat side effects', async () => {
  let writes = 0;
  let round = 0;
  const body = { messages: [] };
  const batches = [[toolCall('a'), toolCall('b', 'unknown'), toolCall('c', 'remember', '{')], [toolCall('a'), toolCall('a', 'remember', '{"changed":true}')]];
  await runAppToolLoop(body, { remember: { run: async () => { writes++; return { ok: true }; } } }, async () => round < batches.length
    ? response({ tool_calls: batches[round++] }) : response({ content: 'done' }), { deadline: Date.now() + 10000 });
  assert.equal(writes, 1);
  assert.equal(JSON.parse(body.messages.at(-1).content).error, 'duplicate_id_mismatch');
});

test('round limits stop execution and ask for a final answer with tools disabled', async () => {
  let count = 0;
  const body = { messages: [] };
  await runAppToolLoop(body, { remember: { run: async () => ++count } }, async () => body.tool_choice === 'none'
    ? response({ content: 'done' }) : response({ tool_calls: [toolCall(String(count))] }), { deadline: Date.now() + 10000 });
  assert.equal(count, 4);
  await assert.rejects(runAppToolLoop({ messages: [] }, {}, async () => response({}), { deadline: Date.now() - 1 }), /DEADLINE/);
});

test('uncertain writes produce safe tool errors and never report a successful save', async () => {
  const body = { messages: [] };
  let round = 0;
  await runAppToolLoop(body, { remember: { run: async () => { throw new Error('MEMORY_WRITE_UNCERTAIN'); } } }, async () => ++round === 1
    ? response({ tool_calls: [toolCall()] }) : response({ content: 'Could not confirm.' }), { deadline: Date.now() + 10000 });
  assert.match(body.messages[1].content, /uncertain_do_not_claim_success/);
});

test('OpenRouter retains native tools and transcript; length retry never reexecutes memory', async (t) => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  t.after(() => {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
  });
  const bodies = [];
  let writes = 0;
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    const payload = bodies.length === 1 ? response({ content: null, tool_calls: [toolCall()] })
      : bodies.length === 2 ? response({ content: null, tool_calls: null }, 'length') : response({ content: 'Saved.' });
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  const answer = await getOpenRouterAnswer({ systemPrompt: 'System', userContent: 'I prefer brief answers.', model: 'test/model',
    tools: [{ type: 'openrouter:datetime' }], appTools: { remember: { definition, run: async () => { writes++; return { status: 'saved' }; } } } });
  assert.equal(answer, 'Saved.');
  assert.equal(writes, 1);
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0].parallel_tool_calls, undefined);
  assert.equal(bodies[0].tools.length, 2);
  assert.equal(bodies[2].tool_choice, 'none');
  assert.equal(bodies[2].messages.at(-1).role, 'tool');
  assert.equal(bodies[2].provider.data_collection, 'deny');
  assert.deepEqual(bodies[2].tools, bodies[0].tools);
});

test('a dedicated memory model uses only original text and preserves the answer model file/JSON/native-tool request', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalKey;
  });
  const bodies = [];
  let memoryRound = 0;
  const richInput = [{ type: 'text', text: 'Generate an exam from this file.' }, { type: 'file', file: { filename: 'test.pdf', file_data: 'synthetic' } }];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    const payload = body.model === 'memory/model'
      ? (++memoryRound === 1 ? response({ tool_calls: [toolCall('recall', 'about_person')] }) : response({ content: 'Memory phase done.' }))
      : response({ content: '{"questions":[]}' });
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  const format = { type: 'json_object' };
  await getOpenRouterAnswer({ systemPrompt: 'Exam prompt', userContent: richInput, model: 'exam/model', responseFormat: format,
    tools: [{ type: 'openrouter:datetime' }], appToolModel: 'memory/model', appToolInput: 'My exam topic.', appToolSystemPrompt: 'Manage memory.',
    appTools: { about_person: { definition: { type: 'function', function: { name: 'about_person' } }, run: async () => ({ notes: [{ note: 'The user prefers concise explanations.' }] }) } },
  });
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0].messages[1].content, 'My exam topic.');
  assert.equal(bodies[0].response_format, undefined);
  const final = bodies.at(-1);
  assert.deepEqual(final.messages[1].content, richInput);
  assert.deepEqual(final.response_format, format);
  assert.deepEqual(final.tools, [{ type: 'openrouter:datetime' }]);
  assert.match(final.messages.at(-1).content, /The user prefers concise explanations/);
  assert.doesNotMatch(final.messages.at(-1).content, /Memory phase done/);
});

test('a later memory-phase provider failure preserves confirmed writes and still permits an answer', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalKey;
  });
  let requests = 0;
  let writes = 0;
  globalThis.fetch = async (_url, options) => {
    requests++;
    if (requests === 1) return new Response(JSON.stringify(response({ tool_calls: [toolCall()] })), { status: 200 });
    if (requests === 2) return new Response('{}', { status: 503 });
    const body = JSON.parse(options.body);
    assert.match(body.messages.at(-1).content, /"available":false/);
    assert.match(body.messages.at(-1).content, /"status":"saved"/);
    return new Response(JSON.stringify(response({ content: 'Confirmed.' })), { status: 200 });
  };
  assert.equal(await getOpenRouterAnswer({ systemPrompt: 'System', userContent: 'I prefer brief answers.', model: 'answer/model',
    appToolModel: 'memory/model', appToolInput: 'I prefer brief answers.', appTools: { remember: { definition, run: async () => { writes++; return { status: 'saved' }; } } } }), 'Confirmed.');
  assert.equal(writes, 1);
  assert.equal(requests, 3);
});
