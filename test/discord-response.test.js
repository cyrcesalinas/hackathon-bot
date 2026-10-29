import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareDiscordResponse } from '../discord-response.js';

test('short responses remain inline', () => {
  assert.deepEqual(prepareDiscordResponse('A short answer.'), {
    content: 'A short answer.',
  });
});

test('long responses become a title and complete Markdown attachment', () => {
  const answer = `# Full answer\n\n${'Detailed content. '.repeat(140)}`;
  const response = prepareDiscordResponse(answer, {
    title: 'Lakshmi completed your request',
    filename: 'Lakshmi response.md',
    description: 'Complete response from Lakshmi in Markdown format',
  });

  assert.equal(
    response.content,
    '**Lakshmi completed your request**\n\nThe complete response is attached below.',
  );
  assert.deepEqual(response.components, []);
  assert.equal(response.attachment.filename, 'lakshmi-response.md');
  assert.equal(response.attachment.description, 'Complete response from Lakshmi in Markdown format');
  assert.equal(response.attachment.content, answer);
});

test('attachment titles escape Discord formatting and filenames are safe', () => {
  const response = prepareDiscordResponse('x'.repeat(1901), {
    title: '*Research* [Agent] completed your request',
    filename: 'Investigación / 2026.md',
  });

  assert.equal(
    response.content,
    '**\\*Research\\* \\[Agent\\] completed your request**\n\nThe complete response is attached below.',
  );
  assert.equal(response.attachment.filename, 'investigacion-2026.md');
});
