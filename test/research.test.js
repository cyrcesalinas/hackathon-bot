import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildResearchRequest,
  ensureCompleteResearch,
  ResearchResponseError,
  validateResearchMarkdown,
} from '../research.js';

const complete = `# Result

Verified finding.

## Sources

- [Oracle](https://www.oracle.com/)`;

test('research requests have enough output and bounded continuations', () => {
  const request = buildResearchRequest('Larry Ellison');
  assert.equal(request.maxTokens, 2500);
  assert.equal(request.maxContinuations, 2);
  assert.deepEqual(request.tools, [{ type: 'openrouter:web_search' }]);
});

test('research validation requires clean output and linked sources', () => {
  assert.deepEqual(validateResearchMarkdown(complete), { valid: true, errors: [] });
  assert.ok(validateResearchMarkdown('# Result\n\nCut off (m.').errors.includes('missing_sources_heading'));
  assert.ok(validateResearchMarkdown(`${complete}\n<tool_call>openrouter_web_datetime</tool_call>`).errors.includes('leaked_tool_call'));
  assert.ok(validateResearchMarkdown(`${complete}\n\\<tool_call>unfinished`).errors.includes('leaked_tool_call'));
  assert.ok(validateResearchMarkdown('# Result\n\nDone.\n\n## Sources\n\nNo links.').errors.includes('missing_source_links'));
});

test('invalid research is regenerated once with tools kept and memory writes disabled', async () => {
  let received;
  const startedAt = Date.now();
  const request = buildResearchRequest('Larry Ellison');
  request.appTools = { remember: {} };
  const result = await ensureCompleteResearch('# Partial\n\nCut off', request, async (retryRequest) => {
    received = retryRequest;
    return complete;
  });
  assert.equal(result, complete);
  assert.equal(received.appTools, undefined);
  assert.deepEqual(received.tools, request.tools);
  assert.deepEqual(received.reasoning, { enabled: false });
  assert.ok(received.deadline >= startedAt + 119_000);
  assert.match(received.systemPrompt, /never print tool-call tags/);
});

test('research fails safely when the repair is still incomplete', async () => {
  await assert.rejects(
    ensureCompleteResearch('Partial', buildResearchRequest('Topic'), async () => '<tool_call>bad</tool_call>'),
    ResearchResponseError,
  );
});
