import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DedupStore } from '../../src/bridge/dedup.js';

test('has returns false for unseen key', () => {
  const store = new DedupStore(5);
  assert.equal(store.has('wa:msgA'), false);
});

test('has returns true after add', () => {
  const store = new DedupStore(5);
  store.add('wa:msgA');
  assert.equal(store.has('wa:msgA'), true);
});

test('has returns false after TTL expiry', async () => {
  const store = new DedupStore(0);
  store.add('wa:msgA');
  await new Promise(r => setTimeout(r, 10));
  assert.equal(store.has('wa:msgA'), false);
});

test('stop clears the sweep interval', () => {
  const store = new DedupStore(5);
  assert.doesNotThrow(() => store.stop());
});
