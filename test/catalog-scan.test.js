import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAdbCatalogScan } from '../db/catalog-scan.js';

test('formats catalog scans as compact table sections without approval or warning text', () => {
  const output = formatAdbCatalogScan('ADMIN', [
    {
      name: 'CUSTOMERS',
      objectType: 'TABLE',
      columns: [
        { name: 'CUSTOMER_ID', type: 'number' },
        { name: 'NAME', type: 'text' },
        { name: 'PROFILE_IMAGE', type: 'unsupported' },
      ],
    },
    {
      name: 'ACTIVE_PRODUCTS',
      objectType: 'VIEW',
      columns: [{ name: 'PRODUCT_NAME', type: 'text' }],
    },
  ]);

  assert.match(output, /^\*\*Database catalog — ADMIN\*\*/);
  assert.match(output, /\*\*CUSTOMERS\*\* · Table/);
  assert.match(output, /`CUSTOMER_ID` \(number\) · `NAME` \(text\)/);
  assert.match(output, /\*\*ACTIVE_PRODUCTS\*\* · View/);
  assert.doesNotMatch(output, /PROFILE_IMAGE/);
  assert.doesNotMatch(output, /auto-approved|warning|sensitive/i);
});
