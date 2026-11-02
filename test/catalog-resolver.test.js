import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCatalogReference,
  resolveCatalogEntry,
} from '../db/catalog-resolver.js';

const datasets = [
  { id: 'customers', label: 'CUSTOMERS' },
  { id: 'products', label: 'PRODUCTS' },
  { id: 'sales_orders', label: 'SALES_ORDERS' },
];

test('normalizes catalog references consistently', () => {
  assert.equal(normalizeCatalogReference('  Sales Orders  '), 'sales_orders');
  assert.equal(normalizeCatalogReference('SALES-ORDERS'), 'sales_orders');
  assert.equal(normalizeCatalogReference('CUstomers'), 'customers');
});

test('resolves case and separator variants silently', () => {
  assert.equal(resolveCatalogEntry(datasets, 'CUSTOMERS')?.id, 'customers');
  assert.equal(resolveCatalogEntry(datasets, 'CUstomers')?.id, 'customers');
  assert.equal(resolveCatalogEntry(datasets, 'sales orders')?.id, 'sales_orders');
});

test('resolves unique small spelling mistakes', () => {
  assert.equal(resolveCatalogEntry(datasets, 'custmers')?.id, 'customers');
  assert.equal(resolveCatalogEntry(datasets, 'custmoers')?.id, 'customers');
  assert.equal(resolveCatalogEntry(datasets, 'customer')?.id, 'customers');
});

test('does not fuzzy-match short or distant references', () => {
  assert.equal(resolveCatalogEntry(datasets, 'cust'), undefined);
  assert.equal(resolveCatalogEntry(datasets, 'employees'), undefined);
});

test('rejects ambiguous fuzzy matches', () => {
  const similarDatasets = [
    { id: 'orders', label: 'ORDERS' },
    { id: 'owners', label: 'OWNERS' },
  ];

  assert.equal(resolveCatalogEntry(similarDatasets, 'orners'), undefined);
});

test('supports explicit aliases without returning user input as an identifier', () => {
  const aliasedDatasets = [
    { id: 'customers', label: 'CUSTOMERS', aliases: ['clients'] },
  ];

  assert.equal(resolveCatalogEntry(aliasedDatasets, 'Clients')?.id, 'customers');
});
