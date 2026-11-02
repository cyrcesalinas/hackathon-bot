import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import oracledb from 'oracledb';

let poolPromise;
export const hashText = (text) => createHash('sha256').update(text).digest('hex');

export function memoryConfig(env = process.env) {
  const user = env.USER_MEMORY_USER?.trim() || env.AGENT_STORE_USER?.trim() || env.ADB_USER?.trim() || '';
  const owner = (env.USER_MEMORY_OWNER?.trim() || env.AGENT_STORE_OWNER?.trim() || user).toUpperCase();
  if (!/^[A-Z][A-Z0-9_$#]{0,127}$/.test(owner)) throw new Error('MEMORY_OWNER_INVALID');
  return {
    user, owner,
    password: env.USER_MEMORY_PASSWORD || env.AGENT_STORE_PASSWORD || env.ADB_PASSWORD,
    connectString: env.ADB_CONNECT_STRING?.trim(),
    configDir: env.ADB_WALLET_DIR?.trim(),
    walletLocation: env.ADB_WALLET_DIR?.trim(),
    walletPassword: env.ADB_WALLET_PASSWORD,
  };
}

export function validateScope(scope) {
  if (!scope || [scope.userId, scope.guild, scope.channel].some((value) => typeof value !== 'string')
      || !/^\d{1,32}$/.test(scope.userId) || !/^\d{1,32}$/.test(scope.channel)
      || !/^(?:\d{1,32}|@dm)$/.test(scope.guild)) throw new Error('MEMORY_SCOPE_INVALID');
  return { userId: scope.userId, guild: scope.guild, channel: scope.channel };
}

export function scopeId(scope) {
  const { guild, userId, channel } = validateScope(scope);
  return hashText(`${guild}:${userId}:${channel}`);
}

async function getPool() {
  if (!poolPromise) {
    const { owner: _owner, ...config } = memoryConfig();
    poolPromise = oracledb.createPool({ ...config, poolAlias: 'discord-bot-person-notes', poolMin: 0, poolMax: 2, poolIncrement: 1, queueTimeout: 5000 })
      .catch((error) => { poolPromise = undefined; throw error; });
  }
  return poolPromise;
}

function checkDeadline(deadline) {
  if (deadline && Date.now() >= deadline) throw new Error('MEMORY_DEADLINE');
}

export function createPersonNoteStore({ acquire, owner } = {}) {
  async function withConnection(work, deadline) {
    checkDeadline(deadline);
    const schema = owner || memoryConfig().owner;
    if (!/^[A-Z][A-Z0-9_$#]{0,127}$/.test(schema)) throw new Error('MEMORY_OWNER_INVALID');
    const connection = await (acquire ? acquire() : (await getPool()).getConnection());
    try {
      checkDeadline(deadline);
      connection.callTimeout = Math.max(1, Math.min(5000, (deadline || Infinity) - Date.now()));
      return await work(connection, `"${schema}"."PERSON_NOTES"`, `"${schema}"."PERSON_NOTE_SCOPES"`);
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      await connection.close();
    }
  }

  async function lockScope(connection, scopes, scope) {
    const result = await connection.execute(
      `SELECT REVISION_NO FROM ${scopes} WHERE SCOPE_ID = :scopeId FOR UPDATE WAIT 3`,
      { scopeId: scopeId(scope) }, { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    if (!result.rows?.length) throw new Error('MEMORY_SCOPE_MISSING');
    return Number(result.rows[0].REVISION_NO);
  }

  const bindsFor = (scope) => ({ ...validateScope(scope), scopeId: scopeId(scope) });
  const where = 'SCOPE_ID = :scopeId AND GUILD = :guild AND USER_ID = :userId AND CHANNEL = :channel';
  const mapRow = (row) => ({ id: row.NOTE_ID, note: row.NOTE, createdAt: row.CREATED_AT });
  return {
    async getRevision(scope, deadline) {
      return withConnection(async (connection, _notes, scopes) => {
        try {
          await connection.execute(`INSERT INTO ${scopes} (SCOPE_ID)
            SELECT :scopeId FROM DUAL WHERE NOT EXISTS
            (SELECT 1 FROM ${scopes} WHERE SCOPE_ID = :scopeId)`, { scopeId: scopeId(scope) });
          await connection.commit();
        } catch (error) {
          if (error.errorNum !== 1) throw error;
          await connection.rollback();
        }
        const result = await connection.execute(`SELECT REVISION_NO FROM ${scopes} WHERE SCOPE_ID = :scopeId`,
          { scopeId: scopeId(scope) }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
        return Number(result.rows[0].REVISION_NO);
      }, deadline);
    },
    async list(scope, deadline) {
      return withConnection(async (connection, notes) => {
        const result = await connection.execute(`SELECT NOTE_ID, NOTE, CREATED_AT FROM ${notes}
          WHERE ${where} ORDER BY CREATED_AT DESC, NOTE_ID DESC FETCH FIRST 40 ROWS ONLY`,
        bindsFor(scope), { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: 40 });
        return result.rows.map(mapRow);
      }, deadline);
    },
    async remember(scope, note, source, expectedRevision, deadline) {
      if (typeof note !== 'string' || !note.trim() || Array.from(note).length > 499) throw new Error('MEMORY_NOTE_INVALID');
      if (!['interaction', 'message'].includes(source?.kind) || typeof source.id !== 'string' || !/^\d{1,32}$/.test(source.id)) throw new Error('MEMORY_SOURCE_INVALID');
      return withConnection(async (connection, notes, scopes) => {
        if (await lockScope(connection, scopes, scope) !== expectedRevision) throw new Error('MEMORY_SCOPE_CHANGED');
        const noteHash = hashText(note.normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/g, ' ').trim());
        const existing = await connection.execute(`SELECT NOTE_ID, NOTE, CREATED_AT FROM ${notes}
          WHERE ${where} AND NOTE_HASH = :noteHash AND SOURCE_KIND = :sourceKind AND SOURCE_ID = :sourceId`,
        { ...bindsFor(scope), noteHash, sourceKind: source.kind, sourceId: source.id },
        { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: 1 });
        if (existing.rows.length) return { status: 'already_saved', ...mapRow(existing.rows[0]) };
        checkDeadline(deadline);
        const id = randomUUID();
        await connection.execute(`INSERT INTO ${notes}
          (NOTE_ID, SCOPE_ID, GUILD, USER_ID, CHANNEL, NOTE, NOTE_HASH, SOURCE_KIND, SOURCE_ID)
          VALUES (:id, :scopeId, :guild, :userId, :channel, :note, :noteHash, :sourceKind, :sourceId)`,
        { ...bindsFor(scope), id, note, noteHash, sourceKind: source.kind, sourceId: source.id });
        checkDeadline(deadline);
        try { await connection.commit(); } catch { throw new Error('MEMORY_WRITE_UNCERTAIN'); }
        return { status: 'saved', id };
      }, deadline);
    },
    async remove(scope, id) {
      if (id !== undefined && !/^[\da-f-]{36}$/i.test(id)) throw new Error('MEMORY_ID_INVALID');
      return withConnection(async (connection, notes, scopes) => {
        await lockScope(connection, scopes, scope);
        const result = await connection.execute(`DELETE FROM ${notes} WHERE ${where}${id ? ' AND NOTE_ID = :id' : ''}`,
          { ...bindsFor(scope), ...(id ? { id } : {}) });
        await connection.execute(`UPDATE ${scopes} SET REVISION_NO = REVISION_NO + 1 WHERE SCOPE_ID = :scopeId`,
          { scopeId: scopeId(scope) });
        await connection.commit();
        return result.rowsAffected;
      });
    },
  };
}

export const personNotes = createPersonNoteStore();
export async function closePersonNotesPool() {
  if (!poolPromise) return;
  const pool = await poolPromise;
  poolPromise = undefined;
  await pool.close(10);
}
