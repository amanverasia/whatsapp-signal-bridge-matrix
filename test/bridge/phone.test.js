import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, phonesMatch } from '../../src/bridge/phone.js';

test('normalize handles various formats', () => {
  assert.equal(normalize('+91 9999999999'), '+919999999999');
  assert.equal(normalize('919999999999'), '+919999999999');
  assert.equal(normalize('+919999999999'), '+919999999999');
  assert.equal(normalize('+91 99999 99999'), '+919999999999');
});

test('normalize strips WhatsApp JID suffix', () => {
  assert.equal(normalize('919999999999@s.whatsapp.net'), '+919999999999');
});

test('normalize returns null for invalid input', () => {
  assert.equal(normalize(null), null);
  assert.equal(normalize(''), null);
  assert.equal(normalize('not a number'), null);
});

test('phonesMatch compares normalized forms', () => {
  assert.equal(phonesMatch('+91 9999999999', '919999999999@s.whatsapp.net'), true);
  assert.equal(phonesMatch('+91 9999999999', '+91 9876543210'), false);
  assert.equal(phonesMatch(null, '+91 9999999999'), false);
});
