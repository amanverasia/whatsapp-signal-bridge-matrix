import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('loadConfig throws on missing required fields', () => {
  assert.throws(
    () => loadConfig({}),
    /Missing required config: BOT_PHONE, WHATSAPP_GROUP_JID, SIGNAL_GROUP_ID/
  );
});

test('loadConfig throws on invalid BOT_PHONE', () => {
  assert.throws(
    () => loadConfig({
      BOT_PHONE: 'not-a-number',
      WHATSAPP_GROUP_JID: '123@g.us',
      SIGNAL_GROUP_ID: 'abc='
    }),
    /BOT_PHONE is not a valid phone number/
  );
});

test('loadConfig normalizes BOT_PHONE to E.164', () => {
  const config = loadConfig({
    BOT_PHONE: '+91 9999999999',
    WHATSAPP_GROUP_JID: '120363xxx@g.us',
    SIGNAL_GROUP_ID: 'abc123='
  });
  assert.equal(config.botPhone, '+919999999999');
  assert.equal(config.whatsappGroupJid, '120363xxx@g.us');
  assert.equal(config.signalGroupId, 'abc123=');
});

test('loadConfig applies defaults for optional fields', () => {
  const config = loadConfig({
    BOT_PHONE: '+919999999999',
    WHATSAPP_GROUP_JID: '120363xxx@g.us',
    SIGNAL_GROUP_ID: 'abc123='
  });
  assert.equal(config.signalSocketPath, '/tmp/signald.sock');
  assert.equal(config.signalDataDir, './data/signal');
  assert.equal(config.whatsappAuthDir, './data/auth_info');
  assert.equal(config.logLevel, 'info');
  assert.equal(config.circuitBreakerThreshold, 50);
  assert.equal(config.circuitBreakerWindowSec, 60);
  assert.equal(config.idMapTtlMin, 60);
  assert.equal(config.dedupTtlMin, 5);
});

test('loadConfig respects provided optional fields', () => {
  const config = loadConfig({
    BOT_PHONE: '+919999999999',
    WHATSAPP_GROUP_JID: '120363xxx@g.us',
    SIGNAL_GROUP_ID: 'abc123=',
    LOG_LEVEL: 'debug',
    CIRCUIT_BREAKER_THRESHOLD: '30',
    ID_MAP_TTL_MIN: '30'
  });
  assert.equal(config.logLevel, 'debug');
  assert.equal(config.circuitBreakerThreshold, 30);
  assert.equal(config.idMapTtlMin, 30);
});
