import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonNoteStore, scopeId } from '../db/person-notes.js';

const scope = { userId: '1', guild: '2', channel: '3' };
const source = { kind: 'message', id: '4' };
function harness(responses, { commitError } = {}) {
  const calls = [];
  const connection = {
    execute: async (sql, binds) => { calls.push({ sql, binds }); return responses.shift() ?? {}; },
    commit: async () => { calls.push({ commit: true }); if (commitError) throw new Error('connection lost'); },
    rollback: async () => { calls.push({ rollback: true }); }, close: async () => { calls.push({ close: true }); },
  };
  return { store: createPersonNoteStore({ acquire: async () => connection, owner: 'MEMORY_OWNER' }), calls };
}

test('recent-note query binds all three scope coordinates and caps retrieval at 40', async () => {
  const { store, calls } = harness([{ rows: [{ NOTE_ID: 'id', NOTE: 'note', CREATED_AT: new Date(0) }] }]);
  assert.equal((await store.list(scope))[0].note, 'note');
  assert.match(calls[0].sql, /GUILD = :guild AND USER_ID = :userId AND CHANNEL = :channel/);
  assert.match(calls[0].sql, /ORDER BY CREATED_AT DESC, NOTE_ID DESC FETCH FIRST 40/);
  assert.deepEqual(calls[0].binds, { ...scope, scopeId: scopeId(scope) });
  for (const other of [{ ...scope, guild: '@dm' }, { ...scope, channel: '4' }, { ...scope, userId: '4' }]) {
    assert.notEqual(scopeId(scope), scopeId(other));
  }
});

test('inserts are parameterized, committed, and use the locked scope revision', async () => {
  const { store, calls } = harness([{ rows: [{ REVISION_NO: 9 }] }, { rows: [] }, {}]);
  const note = "The user prefers Oracle's documentation.";
  assert.equal((await store.remember(scope, note, source, 9, Date.now() + 10000)).status, 'saved');
  assert.match(calls[0].sql, /FOR UPDATE WAIT 3/);
  assert.match(calls[2].sql, /INSERT INTO/);
  assert.equal(calls[2].binds.note, note);
  assert.match(calls[1].sql, /SOURCE_KIND = :sourceKind AND SOURCE_ID = :sourceId/);
  assert.equal(calls[1].binds.sourceId, source.id);
  assert.equal(calls[2].sql.includes(note), false);
  assert.equal(calls.filter((call) => call.commit).length, 1);
  assert.ok(calls.at(-1).close);
});

test('repeated notes return existing records without inserting', async () => {
  const { store, calls } = harness([{ rows: [{ REVISION_NO: 0 }] }, { rows: [{ NOTE_ID: 'existing', NOTE: 'The user prefers Oracle.', CREATED_AT: new Date(0) }] }]);
  const result = await store.remember(scope, 'The user prefers Oracle.', source, 0);
  assert.equal(result.status, 'already_saved');
  assert.equal(result.id, 'existing');
  assert.equal(calls.some((call) => call.sql?.includes('INSERT INTO')), false);
});

test('deletion invalidates in-flight saves; mismatched revisions roll back before insertion', async () => {
  const deletion = harness([{ rows: [{ REVISION_NO: 1 }] }, { rowsAffected: 3 }, {}]);
  assert.equal(await deletion.store.remove(scope), 3);
  assert.match(deletion.calls[1].sql, /DELETE FROM.*WHERE SCOPE_ID/s);
  assert.deepEqual(deletion.calls[1].binds, { ...scope, scopeId: scopeId(scope) });
  assert.match(deletion.calls[2].sql, /REVISION_NO = REVISION_NO \+ 1/);
  const stale = harness([{ rows: [{ REVISION_NO: 2 }] }]);
  await assert.rejects(stale.store.remember(scope, 'The user prefers Oracle.', source, 1), /SCOPE_CHANGED/);
  assert.equal(stale.calls.some((call) => call.sql?.includes('INSERT')), false);
  assert.ok(stale.calls.some((call) => call.rollback));
});

test('commit failures are reported as uncertain and expired requests never acquire a connection', async () => {
  const { store, calls } = harness([{ rows: [{ REVISION_NO: 0 }] }, { rows: [] }, {}], { commitError: true });
  await assert.rejects(store.remember(scope, 'The user prefers Oracle.', source, 0), /MEMORY_WRITE_UNCERTAIN/);
  assert.ok(calls.some((call) => call.rollback));
  const expired = harness([]);
  await assert.rejects(expired.store.remember(scope, 'The user prefers Oracle.', source, 0, Date.now() - 1), /DEADLINE/);
  assert.deepEqual(expired.calls, []);
});
