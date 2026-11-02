import test from 'node:test';
import assert from 'node:assert/strict';
import { InteractionType } from 'discord-interactions';
import { keepsInteractionPrivate } from '../interaction-privacy.js';
import { isPrivateTable, assertPublicSql } from '../db/protected-tables.js';
import { executeAdbRead } from '../db/connection.js';
import { ADB_QUERY_CATALOG, replaceAdbQueryCatalog } from '../db/catalog.js';
import { getPublicAdbCatalog, validateAdbQueryPlan } from '../db/query.js';
import { formatAdbCatalogScan } from '../db/catalog-scan.js';

test('/memory bypasses the public-reply middleware just like private agent management', () => {
  assert.equal(keepsInteractionPrivate({ type: InteractionType.APPLICATION_COMMAND, data: { name: 'memory' } }), true);
  assert.equal(keepsInteractionPrivate({ type: InteractionType.APPLICATION_COMMAND, data: { name: 'agent' } }), true);
  assert.equal(keepsInteractionPrivate({ type: InteractionType.APPLICATION_COMMAND, data: { name: 'study' } }), false);
  assert.equal(keepsInteractionPrivate({ type: InteractionType.MESSAGE_COMPONENT, data: { custom_id: 'agent_ui:session:action' } }), true);
});

test('memory tables are excluded from catalog rendering, stale plans and SQL execution', async (t) => {
  const previous = [...ADB_QUERY_CATALOG];
  t.after(() => replaceAdbQueryCatalog(previous));
  for (const name of ['person_notes', 'PERSON_NOTE_SCOPES', '"OWNER"."PERSON_NOTES"']) assert.equal(isPrivateTable(name), true);
  assert.throws(() => assertPublicSql('SELECT NOTE FROM "OWNER"."PERSON_NOTES"'), /PRIVATE_TABLE/);
  await assert.rejects(executeAdbRead('SELECT NOTE FROM PERSON_NOTES', {}, 40), /PRIVATE_TABLE/);
  replaceAdbQueryCatalog([{ id: 'notes', label: 'Notes', source: { owner: 'ADMIN', name: 'PERSON_NOTES' },
    allowUnfilteredList: true, columns: [{ id: 'note', sqlName: 'NOTE', selectable: true, type: 'text' }] }]);
  assert.deepEqual(getPublicAdbCatalog(), []);
  assert.throws(() => validateAdbQueryPlan({ kind: 'list', dataset: 'notes', columns: ['note'] }), /private/);
  assert.doesNotMatch(formatAdbCatalogScan('ADMIN', [{ name: 'PERSON_NOTES', columns: [] }]), /PERSON_NOTES/);
});
