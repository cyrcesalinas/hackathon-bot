import { ADB_QUERY_CATALOG, replaceAdbQueryCatalog } from './catalog.js';
import { executeAdbRead } from './connection.js';

const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_$#]{0,127}$/;
const MAX_METADATA_ROWS = 5001;
const MAX_VISIBLE_OBJECTS = 10;
const MAX_VISIBLE_COLUMNS = 8;
const CATALOG_CACHE_MS = 5 * 60 * 1000;

const TEXT_TYPES = new Set(['CHAR', 'NCHAR', 'VARCHAR', 'VARCHAR2', 'NVARCHAR2', 'CLOB', 'NCLOB']);
const NUMBER_TYPES = new Set(['NUMBER', 'FLOAT', 'INTEGER', 'BINARY_FLOAT', 'BINARY_DOUBLE']);
let catalogRefreshPromise;
let catalogRefreshedAt = 0;

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
  if (!IDENTIFIER_PATTERN.test(owner)) {
    throw new AdbCatalogScanError(
      'Configure ADB_CATALOG_OWNER with the Oracle schema that owns the tables and views.',
      'ADB_CATALOG_OWNER_INVALID',
    );
  }
  return { owner };
}

function getCatalogType(oracleType) {
  const normalized = String(oracleType ?? '').toUpperCase();
  if (TEXT_TYPES.has(normalized)) return 'text';
  if (NUMBER_TYPES.has(normalized)) return 'number';
  if (normalized === 'DATE' || normalized.startsWith('TIMESTAMP')) return 'date';
  return 'unsupported';
}

function toCatalogId(value, fallback) {
  const normalized = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_$#]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  if (!normalized) return fallback;
  return /^[a-z]/.test(normalized) ? normalized : `${fallback}_${normalized}`;
}

function getUniqueId(base, usedIds) {
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base.slice(0, 115)}_${suffix++}`;
  }
  usedIds.add(candidate);
  return candidate;
}

function getFilterOperators(type) {
  return type === 'text'
    ? ['eq', 'contains']
    : ['eq', 'gt', 'gte', 'lt', 'lte'];
}

function buildAutoCatalog(objects) {
  const datasetIds = new Set();
  const catalog = [];

  for (const object of objects) {
    if (!IDENTIFIER_PATTERN.test(object.name)) continue;
    const columnIds = new Set();
    const columns = object.columns
      .filter((column) => column.type !== 'unsupported' && IDENTIFIER_PATTERN.test(column.name))
      .map((column) => {
        const id = getUniqueId(toCatalogId(column.name, 'column'), columnIds);
        return {
          id,
          sqlName: column.name,
          label: column.name,
          description: `${column.name} column in ${object.name}.`,
          type: column.type,
          selectable: true,
          filterOperators: getFilterOperators(column.type),
          sortable: true,
          groupable: true,
          aggregateFunctions: column.type === 'number' ? ['sum', 'avg'] : [],
        };
      });

    if (!columns.length) continue;
    const id = getUniqueId(toCatalogId(object.name, 'dataset'), datasetIds);
    catalog.push({
      id,
      label: object.name,
      description: `${object.objectType.toLowerCase()} ${object.owner}.${object.name}.`,
      source: { owner: object.owner, name: object.name },
      allowUnfilteredList: true,
      allowUnfilteredCount: true,
      allowUnfilteredAggregate: true,
      columns,
    });
  }

  return catalog;
}

async function loadCatalogMetadata() {
  const { owner } = getScanScope();
  const result = await executeAdbRead(
    `SELECT o.OWNER AS "owner",
            o.OBJECT_NAME AS "objectName",
            o.OBJECT_TYPE AS "objectType",
            c.COLUMN_ID AS "columnPosition",
            c.COLUMN_NAME AS "columnName",
            c.DATA_TYPE AS "dataType"
       FROM ALL_OBJECTS o
       JOIN ALL_TAB_COLUMNS c
         ON c.OWNER = o.OWNER
        AND c.TABLE_NAME = o.OBJECT_NAME
      WHERE o.OBJECT_TYPE IN ('TABLE', 'VIEW')
        AND o.OWNER = :owner
      ORDER BY o.OBJECT_TYPE, o.OBJECT_NAME, c.COLUMN_ID
      FETCH FIRST ${MAX_METADATA_ROWS} ROWS ONLY`,
    { owner },
    MAX_METADATA_ROWS,
  );

  const rows = result.rows ?? [];
  if (rows.length === MAX_METADATA_ROWS) {
    throw new AdbCatalogScanError(
      'The schema contains more than 5,000 table/view columns, so the bot refused to create an incomplete automatic catalog.',
      'ADB_CATALOG_TOO_LARGE',
    );
  }

  const objects = new Map();
  for (const row of rows) {
    const key = `${row.owner}.${row.objectName}`;
    if (!objects.has(key)) {
      objects.set(key, {
        owner: row.owner,
        name: row.objectName,
        objectType: row.objectType,
        columns: [],
      });
    }
    objects.get(key).columns.push({
      name: row.columnName,
      type: getCatalogType(row.dataType),
    });
  }
  return { owner, objects: [...objects.values()] };
}

export async function refreshAdbCatalog({ force = false } = {}) {
  if (!force && ADB_QUERY_CATALOG.length && Date.now() - catalogRefreshedAt < CATALOG_CACHE_MS) {
    return { owner: getScanScope().owner, objects: [], cached: true };
  }

  if (!catalogRefreshPromise) {
    catalogRefreshPromise = loadCatalogMetadata()
      .then(({ owner, objects }) => {
        replaceAdbQueryCatalog(buildAutoCatalog(objects));
        catalogRefreshedAt = Date.now();
        return { owner, objects, cached: false };
      })
      .finally(() => {
        catalogRefreshPromise = undefined;
      });
  }
  return catalogRefreshPromise;
}

export async function scanAdbCatalog() {
  const { owner, objects } = await refreshAdbCatalog({ force: true });
  if (!objects.length) {
    return `No tables or views were found in the ${owner} schema.`;
  }

  return formatAdbCatalogScan(owner, objects);
}

export function formatAdbCatalogScan(owner, objects) {
  const visibleObjects = objects.slice(0, MAX_VISIBLE_OBJECTS);
  const lines = [`**Database catalog — ${owner}**`];

  for (const object of visibleObjects) {
    const supportedColumns = object.columns.filter((column) => column.type !== 'unsupported');
    const visibleColumns = supportedColumns
      .slice(0, MAX_VISIBLE_COLUMNS)
      .map((column) => `\`${column.name}\` (${column.type})`);
    const remaining = supportedColumns.length - visibleColumns.length;
    const objectType = object.objectType === 'VIEW' ? 'View' : 'Table';

    lines.push('', `**${object.name}** · ${objectType}`);
    lines.push(
      visibleColumns.length
        ? `${visibleColumns.join(' · ')}${remaining > 0 ? ` · +${remaining} more` : ''}`
        : '_No supported columns_'
    );
  }

  if (objects.length > MAX_VISIBLE_OBJECTS) {
    lines.push('', `_Showing ${MAX_VISIBLE_OBJECTS} of ${objects.length} tables and views._`);
  }
  lines.push('', '_Catalog refreshes automatically every five minutes during lookups._');
  return lines.join('\n');
}
