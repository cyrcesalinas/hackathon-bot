import test from 'node:test';
import assert from 'node:assert/strict';
import { getOpenRouterAnswer } from '../openrouter.js';

test('OpenRouter requests omit tools unless the caller enables them', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalModel = process.env.OPENROUTER_MODEL;
  let body;

  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.OPENROUTER_MODEL = 'test/model';
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const answer = await getOpenRouterAnswer({
      systemPrompt: 'System prompt',
      userContent: 'Hello',
    });

    assert.equal(answer, 'ok');
    assert.equal(body.tools, undefined);
    assert.equal(body.messages[0].content, 'System prompt');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = originalModel;
  }
});

test('OpenRouter requests include only caller-provided tools', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalModel = process.env.OPENROUTER_MODEL;
  let body;

  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.OPENROUTER_MODEL = 'test/model';
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await getOpenRouterAnswer({
      systemPrompt: 'System prompt',
      userContent: 'Search this',
      tools: [{ type: 'openrouter:web_search' }],
    });

    assert.deepEqual(body.tools, [{ type: 'openrouter:web_search' }]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = originalModel;
  }
});

test('OpenRouter retries a length-limited empty response once with reasoning disabled', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalModel = process.env.OPENROUTER_MODEL;
  const originalWarn = console.warn;
  const bodies = [];

  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.OPENROUTER_MODEL = 'openrouter/free';
  console.warn = () => {};
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    const payload = bodies.length === 1
      ? {
        id: 'generation-1',
        model: 'reasoning/model',
        choices: [{
          finish_reason: 'length',
          message: { role: 'assistant', content: null, reasoning: 'hidden reasoning' },
        }],
        usage: {
          completion_tokens: 1400,
          completion_tokens_details: { reasoning_tokens: 1400 },
        },
      }
      : {
        id: 'generation-2',
        model: 'reasoning/model',
        choices: [{ finish_reason: 'stop', message: { content: 'Recovered answer' } }],
      };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const answer = await getOpenRouterAnswer({
      systemPrompt: 'System prompt',
      userContent: 'Analyze this',
      maxTokens: 1400,
    });

    assert.equal(answer, 'Recovered answer');
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].reasoning, undefined);
    assert.deepEqual(bodies[1].reasoning, { enabled: false });
    assert.deepEqual(bodies[1].messages, bodies[0].messages);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = originalModel;
  }
});

test('OpenRouter does not retry an empty response unless it ended because of length', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalModel = process.env.OPENROUTER_MODEL;
  const originalError = console.error;
  let requests = 0;

  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.OPENROUTER_MODEL = 'test/model';
  console.error = () => {};
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: null } }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await assert.rejects(
      () => getOpenRouterAnswer({ systemPrompt: 'System prompt', userContent: 'Hello' }),
      /OpenRouter returned an empty answer/,
    );
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = originalModel;
  }
});
