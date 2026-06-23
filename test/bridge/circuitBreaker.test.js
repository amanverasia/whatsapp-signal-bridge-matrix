import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from '../../src/bridge/circuitBreaker.js';

test('isTripped is false under threshold', () => {
  const cb = new CircuitBreaker(50, 60);
  for (let i = 0; i < 49; i++) cb.recordSend();
  assert.equal(cb.isTripped(), false);
});

test('isTripped is true over threshold', () => {
  const cb = new CircuitBreaker(50, 60);
  for (let i = 0; i < 51; i++) cb.recordSend();
  assert.equal(cb.isTripped(), true);
});

test('count returns current window count', () => {
  const cb = new CircuitBreaker(50, 60);
  for (let i = 0; i < 10; i++) cb.recordSend();
  assert.equal(cb.count(), 10);
});

test('old sends are pruned from window', async () => {
  const cb = new CircuitBreaker(50, 1);
  cb.recordSend();
  cb.recordSend();
  await new Promise(r => setTimeout(r, 1100));
  assert.equal(cb.count(), 0);
  assert.equal(cb.isTripped(), false);
});

test('threshold boundary: exactly threshold does not trip', () => {
  const cb = new CircuitBreaker(50, 60);
  for (let i = 0; i < 50; i++) cb.recordSend();
  assert.equal(cb.isTripped(), false);
});
