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

test('formats a single selected column as a clean bullet list', () => {
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
    '• SQL Fundamentals',
    '• Build Your First APEX App',
    '• OCI Foundations',
    '• Intro to Generative AI',
  ].join('\n'));
  assert.doesNotMatch(answer, /TITLE:/);
});

test('formats two selected columns with the adaptive aligned table', () => {
  const answer = formatAdbQueryAnswer({
    kind: 'list',
    dataset: { label: 'WORKSHOPS' },
    columns: [
      { id: 'workshop_id', label: 'WORKSHOP_ID', type: 'number' },
      { id: 'title', label: 'TITLE', type: 'text' },
    ],
    limit: 10,
  }, [
    { workshop_id: 1, title: 'Getting Started with Oracle Database' },
    { workshop_id: 2, title: 'Building Apps with AI Vector Search' },
  ]);

  assert.match(answer, /```text/);
  assert.match(answer, /Workshop\s+│\s+Title/);
  assert.match(answer, /#1\s+│\s+Getting Started with Oracle/);
  assert.doesNotMatch(answer, /Workshop ID — Title/);
});

test('formats wider results as an aligned Discord table with compact units', () => {
  const answer = formatAdbQueryAnswer({
    kind: 'list',
    dataset: { label: 'WORKSHOP_LABS' },
    columns: [
      { id: 'title', label: 'LAB_TITLE', type: 'text' },
      { id: 'workshop_id', label: 'WORKSHOP_ID', type: 'number' },
      { id: 'duration', label: 'DURATION_MINUTES', type: 'number' },
    ],
    limit: 10,
  }, [
    { title: 'Connect and Explore the Database', workshop_id: 1, duration: 30 },
    { title: 'Prepare Data for Vector Search', workshop_id: 2, duration: 40 },
  ]);

  assert.match(answer, /```text/);
  assert.match(answer, /LAB Title\s+│\s+Workshop\s+│\s+Duration/);
  assert.match(answer, /Connect and Explore the Database\s+│\s+#1\s+│\s+30 min/);
  assert.doesNotMatch(answer, /\| ---/);
  assert.match(answer, /```$/);
});

test('adaptive tables wrap long text and keep every rendered line within the width budget', () => {
  const answer = formatAdbQueryAnswer({
    kind: 'list',
    dataset: { label: 'WORKSHOP_LABS' },
    columns: [
      { id: 'title', label: 'LAB_TITLE', type: 'text' },
      { id: 'description', label: 'DESCRIPTION', type: 'text' },
      { id: 'duration', label: 'DURATION_MINUTES', type: 'number' },
    ],
    limit: 10,
  }, [{
    title: 'Vector Search Fundamentals',
    description: 'Learn how embeddings and semantic similarity queries work with relational filters.',
    duration: 40,
  }]);

  const tableLines = answer.split('\n').slice(
    answer.split('\n').indexOf('```text') + 1,
    answer.split('\n').lastIndexOf('```'),
  );
  assert.ok(tableLines.every((line) => Array.from(line).length <= 86));
  assert.match(answer, /Learn how embeddings/);
  assert.match(answer, /semantic similarity/);
});

test('adaptive tables close the code block and omit only complete rows when the message budget is reached', () => {
  const rows = Array.from({ length: 25 }, (_unused, index) => ({
    title: `Extremely descriptive workshop lab title number ${index + 1}`,
    description: 'A long description that needs several wrapped lines while preserving the complete table row.',
    duration: 45,
  }));
  const answer = formatAdbQueryAnswer({
    kind: 'list',
    dataset: { label: 'WORKSHOP_LABS' },
    columns: [
      { id: 'title', label: 'LAB_TITLE', type: 'text' },
      { id: 'description', label: 'DESCRIPTION', type: 'text' },
      { id: 'duration', label: 'DURATION_MINUTES', type: 'number' },
    ],
    limit: 25,
  }, rows);

  assert.ok(Array.from(answer).length <= 1850);
  assert.match(answer, /```\n\n> Showing \d+ of 25 returned rows/);
  assert.equal((answer.match(/```/g) ?? []).length, 2);
});

test('formats grouped counts as a two-column table and keeps the truncation notice', () => {
  const answer = formatAdbQueryAnswer({
    kind: 'count',
    dataset: { label: 'WORKSHOPS' },
    groupBy: [{ id: 'level', label: 'LEVEL' }],
    limit: 2,
  }, [
    { level: 'Beginner', value: 12 },
    { level: 'Advanced', value: 4 },
  ], { truncated: true });

  assert.match(answer, /Level\s+│\s+Count/);
  assert.match(answer, /Beginner\s+│\s+12/);
  assert.match(answer, /> Showing the first 2 results/);
});
