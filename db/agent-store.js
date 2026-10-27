import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import oracledb from 'oracledb';

const AGENT_POOL_ALIAS = 'discord-bot-agent-store';
const AGENT_TABLE_NAME = 'AGENT_PROFILES';
const MAX_AGENTS_PER_USER = 20;
let poolPromise;

export class AgentStoreConflictError extends Error {
  constructor() {
    super('AGENT_NAME_CONFLICT');
    this.name = 'AgentStoreConflictError';
  }
}

export function isAgentStoreConfigured() {
  return Boolean(
    process.env.AGENT_STORE_USER?.trim() &&
    process.env.AGENT_STORE_PASSWORD &&
    process.env.AGENT_STORE_OWNER?.trim() &&
    process.env.ADB_CONNECT_STRING?.trim() &&
    process.env.ADB_WALLET_DIR?.trim() &&
    process.env.ADB_WALLET_PASSWORD,
  );
}

function getQualifiedAgentTable() {
  const owner = process.env.AGENT_STORE_OWNER?.trim().toUpperCase();
  if (!owner || !/^[A-Z][A-Z0-9_$#]{0,127}$/.test(owner)) {
    throw new Error('AGENT_STORE_OWNER_INVALID');
  }
  return `"${owner}"."${AGENT_TABLE_NAME}"`;
}

async function getAgentPool() {
  if (!isAgentStoreConfigured()) throw new Error('AGENT_STORE_NOT_CONFIGURED');

  if (!poolPromise) {
    const walletDir = process.env.ADB_WALLET_DIR.trim();
    poolPromise = oracledb.createPool({
      poolAlias: AGENT_POOL_ALIAS,
      user: process.env.AGENT_STORE_USER.trim(),
      password: process.env.AGENT_STORE_PASSWORD,
      connectString: process.env.ADB_CONNECT_STRING.trim(),
      configDir: walletDir,
      walletLocation: walletDir,
      walletPassword: process.env.ADB_WALLET_PASSWORD,
      poolMin: 0,
      poolMax: 4,
      poolIncrement: 1,
    }).catch((error) => {
      poolPromise = undefined;
      throw error;
    });
  }

  return poolPromise;
}

async function withConnection(callback) {
  const pool = await getAgentPool();
  const connection = await pool.getConnection();
  try {
    connection.callTimeout = 10_000;
    return await callback(connection, getQualifiedAgentTable());
  } finally {
    await connection.close();
  }
}

function mapAgent(row) {
  if (!row) return null;
  return {
    id: row.AGENT_ID,
    ownerUserId: row.OWNER_USER_ID,
    name: row.NAME,
    goal: row.GOAL,
    style: row.STYLE,
    capability: row.CAPABILITY,
    createdAt: row.CREATED_AT,
    updatedAt: row.UPDATED_AT,
  };
}

async function findAgent(connection, table, ownerUserId, name) {
  const result = await connection.execute(
    `SELECT AGENT_ID, OWNER_USER_ID, NAME, GOAL, STYLE, CAPABILITY, CREATED_AT, UPDATED_AT
       FROM ${table}
      WHERE OWNER_USER_ID = :ownerUserId AND UPPER(NAME) = UPPER(:name)`,
    { ownerUserId, name },
    { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: 1 },
  );
  return mapAgent(result.rows[0]);
}

function throwStoreError(error) {
  if (error?.errorNum === 1) throw new AgentStoreConflictError();
  throw error;
}

export async function listAgents(ownerUserId) {
  return withConnection(async (connection, table) => {
    const result = await connection.execute(
      `SELECT AGENT_ID, OWNER_USER_ID, NAME, GOAL, STYLE, CAPABILITY, CREATED_AT, UPDATED_AT
         FROM ${table}
        WHERE OWNER_USER_ID = :ownerUserId
        ORDER BY CREATED_AT DESC
        FETCH FIRST ${MAX_AGENTS_PER_USER} ROWS ONLY`,
      { ownerUserId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    return result.rows.map(mapAgent);
  });
}

export async function getAgent(ownerUserId, name) {
  return withConnection((connection, table) => findAgent(connection, table, ownerUserId, name));
}

export async function createAgent(agent) {
  try {
    return await withConnection(async (connection, table) => {
      const countResult = await connection.execute(
        `SELECT COUNT(*) AS AGENT_COUNT FROM ${table} WHERE OWNER_USER_ID = :ownerUserId`,
        { ownerUserId: agent.ownerUserId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );
      if (Number(countResult.rows[0]?.AGENT_COUNT ?? 0) >= MAX_AGENTS_PER_USER) {
        return { limitReached: true };
      }

      const id = randomUUID();
      await connection.execute(
        `INSERT INTO ${table} (AGENT_ID, OWNER_USER_ID, NAME, GOAL, STYLE, CAPABILITY)
         VALUES (:id, :ownerUserId, :name, :goal, :style, :capability)`,
        { ...agent, id },
        { autoCommit: true },
      );
      return { agent: await findAgent(connection, table, agent.ownerUserId, agent.name) };
    });
  } catch (error) {
    throwStoreError(error);
  }
}

export async function updateAgent(ownerUserId, oldName, patch) {
  try {
    return await withConnection(async (connection, table) => {
      const current = await findAgent(connection, table, ownerUserId, oldName);
      if (!current) return null;
      const next = { ...current, ...patch };
      const result = await connection.execute(
        `UPDATE ${table}
            SET NAME = :name,
                GOAL = :goal,
                STYLE = :style,
                CAPABILITY = :capability,
                UPDATED_AT = SYSTIMESTAMP
          WHERE OWNER_USER_ID = :ownerUserId AND AGENT_ID = :id`,
        {
          ownerUserId,
          id: current.id,
          name: next.name,
          goal: next.goal,
          style: next.style,
          capability: next.capability,
        },
        { autoCommit: true },
      );
      if (!result.rowsAffected) return null;
      return findAgent(connection, table, ownerUserId, next.name);
    });
  } catch (error) {
    throwStoreError(error);
  }
}

export async function deleteAgent(ownerUserId, name) {
  return withConnection(async (connection, table) => {
    const result = await connection.execute(
      `DELETE FROM ${table} WHERE OWNER_USER_ID = :ownerUserId AND UPPER(NAME) = UPPER(:name)`,
      { ownerUserId, name },
      { autoCommit: true },
    );
    return result.rowsAffected > 0;
  });
}

export async function closeAgentStorePool() {
  if (!poolPromise) return;
  const pool = await poolPromise;
  poolPromise = undefined;
  await pool.close(10);
}
