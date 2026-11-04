import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceAdbQueryCatalog } from '../db/catalog.js';
import { formatAdbQueryAnswer, validateAdbQueryPlan } from '../db/query.js';

const customersDataset = {
  id: 'customers',
  label: 'CUSTOMERS',
  source: { owner: 'ADMIN', name: 'CUSTOMERS' },
  allowUnfilteredList: true,
  allowUnfilteredCount: true,
  allowUnfilteredAggregate: true,
  columns: [
    {
      id: 'name',
      sqlName: 'NAME',
      label: 'NAME',
      type: 'text',
      selectable: true,
      filterOperators: ['eq', 'contains'],
      sortable: true,
      groupable: true,
      aggregateFunctions: [],
    },
  ],
};

test.beforeEach(() => replaceAdbQueryCatalog([customersDataset]));
test.after(() => replaceAdbQueryCatalog([]));

test('accepts an unfiltered customer-name list and caps all-style limits', () => {
  const plan = validateAdbQueryPlan({
    kind: 'list',
    dataset: 'CUSTOMERS',
    columns: ['NAME'],
    filters: [],
    limit: 100,
  });

  assert.equal(plan.dataset.id, 'customers');
  assert.deepEqual(plan.columns.map((column) => column.id), ['name']);
  assert.equal(plan.limit, 25);
});

test('accepts a uniquely identifiable dataset typo', () => {
  const plan = validateAdbQueryPlan({
    kind: 'list',
    dataset: 'custmers',
    columns: ['name'],
    filters: [],
    limit: 10,
  });

  assert.equal(plan.dataset.id, 'customers');
});

test('treats null optional fields as omitted', () => {
  const plan = validateAdbQueryPlan({
    kind: 'list',
    dataset: 'customers',
    columns: ['name'],
    filters: null,
    orderBy: null,
    limit: null,
  });

  assert.deepEqual(plan.filters, []);
  assert.equal(plan.orderBy, undefined);
  assert.equal(plan.limit, 10);
});

test('still rejects zero, negative, and non-integer limits', () => {
  for (const limit of [0, -1, 2.5, '25']) {
    assert.throws(
      () => validateAdbQueryPlan({
        kind: 'list',
        dataset: 'customers',
        columns: ['name'],
        filters: [],
        limit,
      }),
      /Invalid row limit/,
    );
  }
});

test('formats a single selected column as a clean numbered list', () => {
  const answer = formatAdbQueryAnswer({
    kind: 'list',
    dataset: { label: 'WORKSHOPS' },
    columns: [{ id: 'title', label: 'TITLE' }],
    limit: 10,
  }, [
    { title: 'SQL Fundamentals' },
    { title: 'Build Your First APEX App' },
    { title: 'OCI Foundations' },
    { title: 'Intro to Generative AI' },
  ]);

  assert.equal(answer, [
    '### Workshops',
    '',
    '4 results',
    '',
    '1. SQL Fundamentals',
    '2. Build Your First APEX App',
    '3. OCI Foundations',
    '4. Intro to Generative AI',
  ].join('\n'));
  assert.doesNotMatch(answer, /TITLE:/);
});

test('formats two selected columns as compact labeled rows', () => {
  const answer = formatAdbQueryAnswer({
    kind: 'list',
    dataset: { label: 'WORKSHOPS' },
    columns: [
      { id: 'title', label: 'TITLE' },
      { id: 'level', label: 'LEVEL' },
    ],
    limit: 10,
  }, [
    { title: 'SQL Fundamentals', level: 'Beginner' },
    { title: 'Advanced SQL', level: 'Advanced' },
  ]);

  assert.match(answer, /\*Title — Level\*/);
  assert.match(answer, /1\. \*\*SQL Fundamentals\*\* — Beginner/);
  assert.doesNotMatch(answer, /TITLE: SQL Fundamentals/);
});

test('formats wider results as a table with labels shown once', () => {
  const answer = formatAdbQueryAnswer({
    kind: 'list',
    dataset: { label: 'WORKSHOPS' },
    columns: [
      { id: 'title', label: 'TITLE' },
      { id: 'level', label: 'LEVEL' },
      { id: 'duration', label: 'DURATION' },
    ],
    limit: 10,
  }, [
    { title: 'SQL Fundamentals', level: 'Beginner', duration: '60 min' },
  ]);

  assert.match(answer, /\| Title \| Level \| Duration \|/);
  assert.match(answer, /\| SQL Fundamentals \| Beginner \| 60 min \|/);
  assert.equal((answer.match(/Title/g) ?? []).length, 1);
});

test('formats grouped counts compactly and keeps the truncation notice', () => {
  const answer = formatAdbQueryAnswer({
    kind: 'count',
    dataset: { label: 'WORKSHOPS' },
    groupBy: [{ id: 'level', label: 'LEVEL' }],
    limit: 2,
  }, [
    { level: 'Beginner', value: 12 },
    { level: 'Advanced', value: 4 },
  ], { truncated: true });

  assert.match(answer, /\*Level — Count\*/);
  assert.match(answer, /1\. \*\*Beginner\*\* — 12/);
  assert.match(answer, /> Showing the first 2 results/);
});
