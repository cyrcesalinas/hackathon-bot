import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceAdbQueryCatalog } from '../db/catalog.js';
import { validateAdbQueryPlan } from '../db/query.js';

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
