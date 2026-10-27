import { ADB_QUERY_CATALOG } from './catalog.js';
import { executeAdbRead } from './connection.js';

const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_$#]{0,127}$/;
const MAX_METADATA_ROWS = 201;
const MAX_VISIBLE_VIEWS = 10;
const MAX_VISIBLE_COLUMNS = 8;

const TEXT_TYPES = new Set(['CHAR', 'NCHAR', 'VARCHAR', 'VARCHAR2', 'NVARCHAR2', 'CLOB', 'NCLOB']);
const NUMBER_TYPES = new Set(['NUMBER', 'FLOAT', 'INTEGER', 'BINARY_FLOAT', 'BINARY_DOUBLE']);

export class AdbCatalogScanError extends Error {
  constructor(userMessage, code = 'ADB_CATALOG_SCAN_FAILED') {
    super(code);
    this.name = 'AdbCatalogScanError';
    this.userMessage = userMessage;
    this.code = code;
  }
}

function getScanScope() {
  const owner = (process.env.ADB_CATALOG_OWNER || process.env.ADB_USER || '').trim().toUpperCase();
  const prefix = (process.env.ADB_CATALOG_PREFIX || 'BOT_').trim().toUpperCase();

  if (!IDENTIFIER_PATTERN.test(owner)) {
    throw new AdbCatalogScanError(
      'Configure ADB_CATALOG_OWNER with the Oracle schema that owns the approved views.',
      'ADB_CATALOG_OWNER_INVALID',
    );
  }
  if (!IDENTIFIER_PATTERN.test(prefix)) {
    throw new AdbCatalogScanError(
      'ADB_CATALOG_PREFIX must be a non-empty Oracle identifier prefix, such as BOT_.',
      'ADB_CATALOG_PREFIX_INVALID',
    );
  }

  return { owner, prefix };
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, '\\$&');
}

function getCatalogType(oracleType) {
  const normalized = String(oracleType ?? '').toUpperCase();
  if (TEXT_TYPES.has(normalized)) return 'text';
  if (NUMBER_TYPES.has(normalized)) return 'number';
  if (normalized === 'DATE' || normalized.startsWith('TIMESTAMP')) return 'date';
  return 'unsupported';
}

function getActiveSources() {
  return new Set(ADB_QUERY_CATALOG.map((dataset) => {
    const owner = dataset.source?.owner?.toUpperCase() ?? '';
    const name = dataset.source?.name?.toUpperCase() ?? '';
    return `${owner}.${name}`;
  }));
}

export async function scanAdbCatalog() {
  const { owner, prefix } = getScanScope();
  const result = await executeAdbRead(
    `SELECT o.OWNER AS "owner",
            o.OBJECT_NAME AS "viewName",
            c.COLUMN_ID AS "columnPosition",
            c.COLUMN_NAME AS "columnName",
            c.DATA_TYPE AS "dataType"
       FROM ALL_OBJECTS o
       JOIN ALL_TAB_COLUMNS c
         ON c.OWNER = o.OWNER
        AND c.TABLE_NAME = o.OBJECT_NAME
      WHERE o.OBJECT_TYPE = 'VIEW'
        AND o.OWNER = :owner
        AND o.OBJECT_NAME LIKE :prefix ESCAPE '\\'
      ORDER BY o.OBJECT_NAME, c.COLUMN_ID
      FETCH FIRST ${MAX_METADATA_ROWS} ROWS ONLY`,
    { owner, prefix: `${escapeLike(prefix)}%` },
    MAX_METADATA_ROWS,
  );

  const rows = result.rows ?? [];
  const metadataTruncated = rows.length === MAX_METADATA_ROWS;
  const visibleMetadata = rows.slice(0, MAX_METADATA_ROWS - 1);
  const views = new Map();

  for (const row of visibleMetadata) {
    const key = `${row.owner}.${row.viewName}`;
    if (!views.has(key)) {
      views.set(key, { owner: row.owner, name: row.viewName, columns: [] });
    }
    views.get(key).columns.push({
      name: row.columnName,
      type: getCatalogType(row.dataType),
    });
  }

  if (!views.size) {
    return `No accessible views matched ${owner}.${prefix}*. This scan does not inspect tables or views outside the configured scope.`;
  }

  const activeSources = getActiveSources();
  const candidates = [...views.values()];
  const lines = [`Catalog scan: ${owner}.${prefix}*`];

  for (const view of candidates.slice(0, MAX_VISIBLE_VIEWS)) {
    const status = activeSources.has(`${view.owner}.${view.name}`) ? 'active' : 'pending';
    const visibleColumns = view.columns
      .slice(0, MAX_VISIBLE_COLUMNS)
      .map((column) => `${column.name}:${column.type}`);
    const remaining = view.columns.length - visibleColumns.length;
    lines.push(`• ${view.name} [${status}] — ${visibleColumns.join(', ')}${remaining > 0 ? `, +${remaining} more` : ''}`);
  }

  if (candidates.length > MAX_VISIBLE_VIEWS) {
    lines.push(`Showing ${MAX_VISIBLE_VIEWS} of ${candidates.length} matching views.`);
  }
  if (metadataTruncated) {
    lines.push('Metadata was truncated. Use a narrower ADB_CATALOG_PREFIX to inspect fewer views.');
  }
  lines.push('Pending views are discovery results only and cannot be queried until explicitly added to the approved catalog.');
  return lines.join('\n');
}
