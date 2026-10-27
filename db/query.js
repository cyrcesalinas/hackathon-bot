import { ADB_QUERY_CATALOG } from './catalog.js';
import { executeAdbRead } from './connection.js';

const MAX_FILTERS = 5;
const MAX_COLUMNS = 8;
const MAX_GROUPS = 4;
const MAX_ROWS = 25;
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_$#]*$/;
const SIMPLE_OPERATORS = {
  eq: '=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};
const SUPPORTED_FILTER_OPERATORS = new Set([...Object.keys(SIMPLE_OPERATORS), 'contains']);

function assertOnlyKeys(value, allowedKeys, label) {
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length) throw new Error(`Unexpected ${label} field`);
}

function assertUniqueIds(ids, label) {
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${label}`);
}

export class AdbQueryPlanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AdbQueryPlanError';
  }
}

export function hasAdbQueryCatalog() {
  return ADB_QUERY_CATALOG.length > 0;
}

export function getPublicAdbCatalog() {
  return ADB_QUERY_CATALOG.map((dataset) => ({
    id: dataset.id,
    label: dataset.label,
    description: dataset.description,
    allowUnfilteredList: dataset.allowUnfilteredList === true,
    allowUnfilteredCount: dataset.allowUnfilteredCount === true,
    allowUnfilteredAggregate: dataset.allowUnfilteredAggregate === true,
    columns: dataset.columns.map((column) => ({
      id: column.id,
      label: column.label,
      description: column.description,
      type: column.type,
      selectable: column.selectable === true,
      filterOperators: column.filterOperators ?? [],
      sortable: column.sortable === true,
      groupable: column.groupable === true,
      aggregateFunctions: column.aggregateFunctions ?? [],
    })),
  }));
}

function quoteIdentifier(value) {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error('Invalid identifier in ADB query catalog');
  }
  return `"${value}"`;
}

function getDataset(datasetId) {
  const dataset = ADB_QUERY_CATALOG.find((item) => item.id === datasetId);
  if (!dataset) throw new Error('The requested dataset is not approved');
  if (!Array.isArray(dataset.columns) || !dataset.columns.length) {
    throw new Error('The approved dataset has no queryable columns');
  }
  return dataset;
}

function getColumn(dataset, columnId) {
  const column = dataset.columns.find((item) => item.id === columnId);
  if (!column) throw new Error('The requested column is not approved');
  return column;
}

function normalizeValue(column, value) {
  if (column.type === 'text') {
    if (typeof value !== 'string' || !value.trim() || value.length > 200) {
      throw new Error('Invalid text filter value');
    }
    return value.trim();
  }

  if (column.type === 'number') {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) {
      throw new Error('Invalid numeric filter value');
    }
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) throw new Error('Invalid numeric filter value');
    return number;
  }

  if (column.type === 'date') {
    if (typeof value !== 'string' || value.length > 40) {
      throw new Error('Invalid date filter value');
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error('Invalid date filter value');
    return date;
  }

  throw new Error('Unsupported column type in ADB query catalog');
}

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('Invalid query plan');
  }

  if (plan.kind === 'clarify') {
    assertOnlyKeys(plan, new Set(['kind', 'message']), 'clarification');
    if (typeof plan.message !== 'string' || !plan.message.trim()) {
      throw new Error('Invalid clarification request');
    }
    return { kind: 'clarify', message: plan.message.trim().slice(0, 500) };
  }

  if (!['list', 'count', 'sum', 'avg'].includes(plan.kind)) {
    throw new Error('Unsupported query kind');
  }

  const allowedPlanKeys = {
    list: new Set(['kind', 'dataset', 'columns', 'filters', 'orderBy', 'limit']),
    count: new Set(['kind', 'dataset', 'groupBy', 'filters', 'limit']),
    sum: new Set(['kind', 'dataset', 'measure', 'groupBy', 'filters', 'limit']),
    avg: new Set(['kind', 'dataset', 'measure', 'groupBy', 'filters', 'limit']),
  };
  assertOnlyKeys(plan, allowedPlanKeys[plan.kind], 'query plan');

  const dataset = getDataset(plan.dataset);
  if (plan.filters !== undefined && !Array.isArray(plan.filters)) {
    throw new Error('Invalid query filters');
  }
  const filters = Array.isArray(plan.filters) ? plan.filters : [];
  if (filters.length > MAX_FILTERS) throw new Error('Too many query filters');

  const normalizedFilters = filters.map((filter) => {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
      throw new Error('Invalid query filter');
    }
    assertOnlyKeys(filter, new Set(['column', 'operator', 'value']), 'filter');
    const column = getColumn(dataset, filter.column);
    if (
      !SUPPORTED_FILTER_OPERATORS.has(filter.operator) ||
      !Array.isArray(column.filterOperators) ||
      !column.filterOperators.includes(filter.operator)
    ) {
      throw new Error('The requested filter is not approved');
    }
    if (filter.operator === 'contains' && column.type !== 'text') {
      throw new Error('Contains is only allowed for text columns');
    }
    if (column.type === 'text' && !['eq', 'contains'].includes(filter.operator)) {
      throw new Error('This comparison is not supported for text columns');
    }
    return {
      column,
      operator: filter.operator,
      value: normalizeValue(column, filter.value),
    };
  });

  if (plan.kind === 'list' && !normalizedFilters.length && dataset.allowUnfilteredList !== true) {
    throw new Error('Please add a filter before listing records');
  }
  if (plan.kind === 'count' && !normalizedFilters.length && dataset.allowUnfilteredCount !== true) {
    throw new Error('Please add a filter before counting records');
  }
  if (['sum', 'avg'].includes(plan.kind) && !normalizedFilters.length && dataset.allowUnfilteredAggregate !== true) {
    throw new Error('Please add a filter before aggregating records');
  }

  let columns = [];
  let measure;
  let groupBy = [];
  let orderBy;

  if (plan.kind === 'list') {
    if (!Array.isArray(plan.columns) || plan.columns.length < 1 || plan.columns.length > MAX_COLUMNS) {
      throw new Error('Invalid selected columns');
    }
    assertUniqueIds(plan.columns, 'selected columns');
    columns = plan.columns.map((id) => {
      const column = getColumn(dataset, id);
      if (column.selectable !== true) throw new Error('The requested column is not selectable');
      return column;
    });

    if (plan.orderBy) {
      if (typeof plan.orderBy !== 'object' || Array.isArray(plan.orderBy)) {
        throw new Error('Invalid ordering');
      }
      assertOnlyKeys(plan.orderBy, new Set(['column', 'direction']), 'ordering');
      const column = getColumn(dataset, plan.orderBy.column);
      if (column.sortable !== true || !['asc', 'desc'].includes(plan.orderBy.direction)) {
        throw new Error('The requested ordering is not approved');
      }
      orderBy = { column, direction: plan.orderBy.direction };
    }
  } else {
    if (plan.groupBy !== undefined && !Array.isArray(plan.groupBy)) {
      throw new Error('Invalid grouping columns');
    }
    const groupIds = Array.isArray(plan.groupBy) ? plan.groupBy : [];
    if (groupIds.length > MAX_GROUPS) throw new Error('Too many grouping columns');
    assertUniqueIds(groupIds, 'grouping columns');
    groupBy = groupIds.map((id) => {
      const column = getColumn(dataset, id);
      if (column.groupable !== true) throw new Error('The requested group is not approved');
      return column;
    });

    if (plan.kind === 'sum' || plan.kind === 'avg') {
      measure = getColumn(dataset, plan.measure);
      if (
        measure.type !== 'number' ||
        !Array.isArray(measure.aggregateFunctions) ||
        !measure.aggregateFunctions.includes(plan.kind)
      ) {
        throw new Error('The requested aggregation is not approved');
      }
    }
  }

  if (
    plan.limit !== undefined &&
    (!Number.isInteger(plan.limit) || plan.limit < 1 || plan.limit > MAX_ROWS)
  ) {
    throw new Error('Invalid row limit');
  }
  const limit = plan.limit ?? 10;
  return {
    kind: plan.kind,
    dataset,
    columns,
    filters: normalizedFilters,
    groupBy,
    measure,
    orderBy,
    limit,
  };
}

function buildQuery(plan) {
  const source = plan.dataset.source;
  if (!source || typeof source !== 'object' || !source.name) {
    throw new Error('Missing source view in ADB query catalog');
  }

  const sourceSql = source.owner
    ? `${quoteIdentifier(source.owner)}.${quoteIdentifier(source.name)}`
    : quoteIdentifier(source.name);
  const binds = {};
  let bindIndex = 0;

  const addBind = (value) => {
    const name = `b${bindIndex++}`;
    binds[name] = value;
    return `:${name}`;
  };

  const selected = [];
  if (plan.kind === 'list') {
    for (const column of plan.columns) {
      selected.push(`${quoteIdentifier(column.sqlName)} AS ${quoteIdentifier(column.id)}`);
    }
  } else {
    for (const column of plan.groupBy) {
      selected.push(`${quoteIdentifier(column.sqlName)} AS ${quoteIdentifier(column.id)}`);
    }
    if (plan.kind === 'count') {
      selected.push('COUNT(*) AS "value"');
    } else {
      selected.push(`${plan.kind.toUpperCase()}(${quoteIdentifier(plan.measure.sqlName)}) AS "value"`);
    }
  }

  const conditions = plan.filters.map(({ column, operator, value }) => {
    const sqlColumn = quoteIdentifier(column.sqlName);
    if (operator === 'contains') {
      const escaped = value.replace(/[\\%_]/g, '\\$&');
      return `${sqlColumn} LIKE ${addBind(`%${escaped}%`)} ESCAPE '\\'`;
    }
    const sqlOperator = SIMPLE_OPERATORS[operator];
    if (!sqlOperator) throw new Error('Unsupported query operator');
    return `${sqlColumn} ${sqlOperator} ${addBind(value)}`;
  });

  const groupSql = plan.groupBy.length
    ? ` GROUP BY ${plan.groupBy.map((column) => quoteIdentifier(column.sqlName)).join(', ')}`
    : '';
  const orderSql = plan.orderBy
    ? ` ORDER BY ${quoteIdentifier(plan.orderBy.column.sqlName)} ${plan.orderBy.direction.toUpperCase()}`
    : '';
  const whereSql = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const rowLimit = plan.limit + 1;

  return {
    sql: `SELECT ${selected.join(', ')} FROM ${sourceSql}${whereSql}${groupSql}${orderSql} FETCH FIRST ${rowLimit} ROWS ONLY`,
    binds,
    fetchLimit: rowLimit,
  };
}

export async function executeAdbQuery(rawPlan) {
  let plan;
  try {
    plan = validatePlan(rawPlan);
  } catch (error) {
    throw new AdbQueryPlanError(error.message);
  }
  if (plan.kind === 'clarify') return { answer: plan.message };

  const query = buildQuery(plan);
  const result = await executeAdbRead(query.sql, query.binds, query.fetchLimit);
  const rows = result.rows ?? [];
  const truncated = rows.length > plan.limit;
  const visibleRows = rows.slice(0, plan.limit);

  if (visibleRows.length === 0) {
    return { answer: 'No matching records were found.' };
  }

  const lines = [`Results for ${plan.dataset.label}:`];
  for (const row of visibleRows) {
    if (plan.kind === 'list') {
      lines.push(`• ${plan.columns.map((column) => `${column.label}: ${formatValue(row[column.id])}`).join(' | ')}`);
      continue;
    }

    const groupLabels = plan.groupBy.map((column) => `${column.label}: ${formatValue(row[column.id])}`);
    const measureLabel = plan.kind === 'count' ? 'Count' : `${plan.kind.toUpperCase()} ${plan.measure.label}`;
    groupLabels.push(`${measureLabel}: ${formatValue(row.value)}`);
    lines.push(`• ${groupLabels.join(' | ')}`);
  }

  if (truncated) lines.push(`Showing the first ${plan.limit} results. Add filters to narrow the query.`);
  return { answer: lines.join('\n') };
}

function formatValue(value) {
  if (value === null || value === undefined) return '—';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 160);
  return String(value).replace(/[\r\n]+/g, ' ').slice(0, 160);
}
