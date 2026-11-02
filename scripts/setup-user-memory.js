import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import oracledb from 'oracledb';
import { memoryConfig } from '../db/person-notes.js';

const config = memoryConfig();
let connection;
try {
  if (config.user.toUpperCase() !== config.owner) throw new Error('RUN_SETUP_WITH_MEMORY_OWNER_CREDENTIALS');
  const { owner: _owner, ...connectionConfig } = config;
  connection = await oracledb.getConnection(connectionConfig);
  connection.callTimeout = 15_000;
  const source = await readFile(new URL('../db/person-notes-schema.sql', import.meta.url), 'utf8');
  for (const statement of source.split(/^\/\s*$/m).map((part) => part.trim()).filter(Boolean)) {
    await connection.execute(statement);
  }
  const expected = {
    PERSON_NOTES: ['NOTE_ID', 'SCOPE_ID', 'GUILD', 'USER_ID', 'CHANNEL', 'NOTE', 'NOTE_HASH', 'SOURCE_KIND', 'SOURCE_ID', 'CREATED_AT'],
    PERSON_NOTE_SCOPES: ['SCOPE_ID', 'REVISION_NO'],
  };
  const result = await connection.execute(`SELECT TABLE_NAME, COLUMN_NAME FROM USER_TAB_COLUMNS
    WHERE TABLE_NAME IN ('PERSON_NOTES', 'PERSON_NOTE_SCOPES')`, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
  for (const [table, columns] of Object.entries(expected)) {
    if (columns.some((name) => !result.rows.some((row) => row.TABLE_NAME === table && row.COLUMN_NAME === name))) {
      throw new Error('MEMORY_SCHEMA_INCOMPATIBLE');
    }
  }
  console.log('Memory tables and recent-notes index are installed. Run npm run memory:check with runtime credentials.');
} catch (error) {
  console.error('Memory setup failed:', error.code || (error.message?.startsWith('MEMORY_') || error.message?.startsWith('RUN_SETUP_') ? error.message : error.name));
  process.exitCode = 1;
} finally {
  if (connection) await connection.close();
}
