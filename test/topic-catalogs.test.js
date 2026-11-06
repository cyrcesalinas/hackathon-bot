import test from 'node:test';
import assert from 'node:assert/strict';
import { OCI_TOPICS, getOciTopic } from '../agents/oci.js';
import { AI_DB_TOPICS, getAiDbTopic } from '../agents/ai-db.js';
import { getAiDbSystemPrompt, getOciSystemPrompt } from '../prompts.js';

test('OCI topic catalog includes core, AI, serverless, streaming, operations, and security topics', () => {
  for (const value of [
    'compute', 'networking', 'iam', 'object-storage', 'kubernetes-oke', 'goldengate',
    'generative-ai-agents', 'serverless-events', 'streaming-messaging', 'observability', 'security-secrets',
  ]) {
    const topic = getOciTopic(value);
    assert.ok(topic, `${value} should be available`);
    assert.ok(topic.sources.length > 0);
    assert.ok(topic.sources.every((source) => source.startsWith('https://docs.oracle.com/')));
  }
  assert.equal(OCI_TOPICS.length, 11);
  assert.equal(getOciTopic('not-a-topic'), undefined);
});

test('AI database catalog includes vector search and Select AI with focused source guidance', () => {
  for (const value of ['oracle-ai-database', 'autonomous-ai-lakehouse', 'deep-trust-ai-architecture', 'ai-vector-search-rag', 'select-ai']) {
    const topic = getAiDbTopic(value);
    assert.ok(topic, `${value} should be available`);
    assert.ok(topic.sources.length > 0);
  }
  assert.match(getAiDbSystemPrompt(getAiDbTopic('select-ai')), /generated SQL and its execution require appropriate permissions and review/);
  assert.match(getOciSystemPrompt(getOciTopic('serverless-events')), /Functions and Events/);
  assert.equal(getAiDbTopic('not-a-topic'), undefined);
});
