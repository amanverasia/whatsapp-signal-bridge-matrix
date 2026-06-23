import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMessage } from '../../src/bridge/format.js';

test('formatMessage with name and phone', () => {
  assert.equal(
    formatMessage('Rahul', '+91 98765 43210', 'hey everyone'),
    'Rahul (+91 98765 43210): hey everyone'
  );
});

test('formatMessage with empty name falls back to phone only', () => {
  assert.equal(formatMessage('', '+91 98765 43210', 'hi'), '+91 98765 43210: hi');
});

test('formatMessage with whitespace name falls back to phone only', () => {
  assert.equal(formatMessage('   ', '+91 98765 43210', 'hi'), '+91 98765 43210: hi');
});

test('formatMessage with null phone falls back to name only', () => {
  assert.equal(formatMessage('Rahul', null, 'hi'), 'Rahul: hi');
});

test('formatMessage with empty phone falls back to name only', () => {
  assert.equal(formatMessage('Rahul', '', 'hi'), 'Rahul: hi');
});

test('formatMessage with emoji name uses phone only', () => {
  assert.equal(formatMessage('🔥', '+91 98765 43210', 'hi'), '+91 98765 43210: hi');
});

test('formatMessage with neither name nor phone', () => {
  assert.equal(formatMessage(null, null, 'hi'), 'Unknown: hi');
});
