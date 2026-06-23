import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdMap } from '../../src/bridge/idMap.js';

test('set stores bidirectional entries', () => {
  const map = new IdMap(60);
  map.set('whatsapp', 'msgABC', 'signal', 1719554400000);
  assert.deepEqual(map.lookup('whatsapp', 'msgABC'), { dstPlatform: 'signal', dstId: 1719554400000 });
  assert.deepEqual(map.lookup('signal', 1719554400000), { dstPlatform: 'whatsapp', dstId: 'msgABC' });
});

test('lookup returns null for missing entry', () => {
  const map = new IdMap(60);
  assert.equal(map.lookup('whatsapp', 'nonexistent'), null);
});

test('lookup returns null for expired entry', async () => {
  const map = new IdMap(0);
  map.set('whatsapp', 'msgA', 'signal', 123);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(map.lookup('whatsapp', 'msgA'), null);
});

test('remove deletes both directions', () => {
  const map = new IdMap(60);
  map.set('whatsapp', 'msgABC', 'signal', 1719554400000);
  map.remove('whatsapp', 'msgABC');
  assert.equal(map.lookup('whatsapp', 'msgABC'), null);
  assert.equal(map.lookup('signal', 1719554400000), null);
});

test('remove is safe for non-existent entry', () => {
  const map = new IdMap(60);
  assert.doesNotThrow(() => map.remove('whatsapp', 'nonexistent'));
});

test('stop clears the sweep interval', () => {
  const map = new IdMap(60);
  assert.doesNotThrow(() => map.stop());
});
