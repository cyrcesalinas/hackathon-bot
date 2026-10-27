import 'dotenv/config';
import oracledb from 'oracledb';

const ADB_POOL_ALIAS = 'discord-bot-adb';
let poolPromise;

export function isAdbConfigured() {
  return Boolean(
    process.env.ADB_USER?.trim() &&
    process.env.ADB_PASSWORD &&
    process.env.ADB_CONNECT_STRING?.trim() &&
    process.env.ADB_WALLET_DIR?.trim() &&
    process.env.ADB_WALLET_PASSWORD,
  );
}

export async function getAdbPool() {
  if (!isAdbConfigured()) {
    throw new Error('ADB_NOT_CONFIGURED');
  }

  if (!poolPromise) {
    const walletDir = process.env.ADB_WALLET_DIR.trim();
    poolPromise = oracledb.createPool({
      poolAlias: ADB_POOL_ALIAS,
      user: process.env.ADB_USER.trim(),
      password: process.env.ADB_PASSWORD,
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

export async function executeAdbRead(sql, binds, maxRows) {
  if (
    typeof sql !== 'string' ||
    !/^\s*SELECT\b/i.test(sql) ||
    sql.includes(';') ||
    /\/\*|--/.test(sql)
  ) {
    throw new Error('ADB_READ_ONLY_SQL_REQUIRED');
  }

  const pool = await getAdbPool();
  const connection = await pool.getConnection();

  try {
    connection.callTimeout = 10_000;
    return await connection.execute(sql, binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      maxRows,
    });
  } finally {
    await connection.close();
  }
}

export async function checkAdbConnection() {
  const pool = await getAdbPool();
  const connection = await pool.getConnection();

  try {
    connection.callTimeout = 10_000;
    await connection.execute('SELECT 1 FROM DUAL');
  } finally {
    await connection.close();
  }
}

export async function closeAdbPool() {
  if (!poolPromise) return;

  const pool = await poolPromise;
  poolPromise = undefined;
  await pool.close(10);
}
