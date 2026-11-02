import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { personNotes, closePersonNotesPool } from '../db/person-notes.js';
import { refreshAdbCatalog } from '../db/catalog-scan.js';
import { getPublicAdbCatalog } from '../db/query.js';
import { closeAdbPool } from '../db/connection.js';
import { PRIVATE_TABLES } from '../db/protected-tables.js';

// A fresh synthetic scope, never a real Discord person's notes.
const scope = { guild: '0', userId: `0${Date.now()}${randomInt(100000, 999999)}`, channel: '0' };
try {
  const revision = await personNotes.getRevision(scope);
  const concurrent = await Promise.all([0, 1].map(() => personNotes.remember(scope, 'The user is a synthetic memory persistence check.',
    { kind: 'interaction', id: '0' }, revision)));
  assert.deepEqual(concurrent.map((result) => result.status).sort(), ['already_saved', 'saved']);
  assert.equal((await personNotes.remember(scope, 'The user is a synthetic memory persistence check.',
    { kind: 'interaction', id: '0' }, revision)).status, 'already_saved');
  assert.equal((await personNotes.list(scope)).length, 1);
  for (const other of [{ ...scope, userId: '0' }, { ...scope, channel: '1' }, { ...scope, guild: '@dm' }]) {
    assert.deepEqual(await personNotes.list(other), []);
  }
  const firstId = concurrent.find((result) => result.status === 'saved').id;
  for (let index = 1; index <= 40; index++) {
    await personNotes.remember(scope, `The user stores synthetic test fact ${index}.`,
      { kind: 'interaction', id: String(index) }, revision);
  }
  const recent = await personNotes.list(scope);
  assert.equal(recent.length, 40);
  assert.equal(recent.some((note) => note.id === firstId), false);
  assert.equal(await personNotes.remove(scope), 41);
  assert.deepEqual(await personNotes.list(scope), []);
  await assert.rejects(personNotes.remember(scope, 'The user is a synthetic memory persistence check.',
    { kind: 'interaction', id: '0' }, revision), /MEMORY_SCOPE_CHANGED/);
  await refreshAdbCatalog({ force: true });
  assert.equal(getPublicAdbCatalog().some((dataset) => PRIVATE_TABLES.includes(dataset.label)), false);
  console.log('ADB memory check passed: persistence, concurrent deduplication, isolation, latest-40 retrieval with full history, deletion, stale-write rejection, and /db catalog protection.');
} catch (error) {
  console.error('ADB memory check failed:', error.code || error.name);
  process.exitCode = 1;
} finally {
  // Retain the scope revision tombstone so an interrupted check cannot recreate notes.
  await personNotes.remove(scope).catch(() => {});
  await closePersonNotesPool();
  await closeAdbPool();
}
