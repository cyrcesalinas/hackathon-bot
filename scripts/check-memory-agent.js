import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { attachUserMemory } from '../user-memory.js';
import { getOpenRouterAnswer, getOpenRouterModel, withOpenRouterDateTimeTool } from '../openrouter.js';
import { personNotes, closePersonNotesPool } from '../db/person-notes.js';

const userId = `0${Date.now()}${randomInt(100000, 999999)}`;
const scopes = [];
try {
  for (const [index, model] of [...new Set([getOpenRouterModel(), getOpenRouterModel('study')])].entries()) {
    const context = { guild: '0', userId, channel: String(index), source: { kind: 'interaction', id: '0' } };
    scopes.push(context);
    const calls = { remember: 0, about_person: 0 };
    async function ask(input) {
      const request = await attachUserMemory({ systemPrompt: 'You are a helpful assistant. Use available tools to satisfy the user.', userContent: input,
        model, maxTokens: 2500 }, context, input, { enabled: true });
      if (!request.appTools) throw new Error('MEMORY_TOOLS_UNAVAILABLE');
      for (const [name, tool] of Object.entries(request.appTools)) {
        const original = tool.run;
        tool.run = async (...args) => {
          calls[name]++;
          try {
            const result = await original(...args);
            console.log(JSON.stringify({ tool: name, status: result.status || null, error: result.error || null }));
            return result;
          } catch (error) {
            console.log(JSON.stringify({ tool: name, failure: /^(?:MEMORY_|OPENROUTER_|OpenRouter returned HTTP)/.test(error.message) ? error.message : error.name }));
            throw error;
          }
        };
      }
      return getOpenRouterAnswer({ ...request, tools: withOpenRouterDateTimeTool() });
    }
    await ask('I prefer concise responses in Spanish. Please remember this preference for future conversations.');
    const savedNotes = await personNotes.list(context);
    if (savedNotes.length < 1 || savedNotes.length > 2) throw new Error('MEMORY_SAVE_NOT_CONFIRMED');
    await ask('What do you remember about my response preferences? Consult your personal notes before answering.');
    assert.ok(calls.remember >= 1 && calls.about_person >= 1, 'MEMORY_RECALL_NOT_CALLED');
    console.log(`Configured model ${index + 1} passed real remember/about_person calls with ADB and datetime enabled.`);
  }
} catch (error) {
  console.error('Memory agent check failed:', error.code || (/^(?:MEMORY_|OPENROUTER_|APP_TOOL_|INVALID_TOOL_|OpenRouter returned HTTP)/.test(error.message) ? error.message : error.name));
  process.exitCode = 1;
} finally {
  for (const scope of scopes) await personNotes.remove(scope).catch(() => {});
  await closePersonNotesPool();
}
