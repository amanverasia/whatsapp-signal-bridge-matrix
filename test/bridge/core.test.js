import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeCore } from '../../src/bridge/core.js';
import { IdMap } from '../../src/bridge/idMap.js';
import { DedupStore } from '../../src/bridge/dedup.js';
import { CircuitBreaker } from '../../src/bridge/circuitBreaker.js';
import { MockWhatsAppClient, MockSignalClient } from '../helpers/mockClient.js';

function createSilentLogger() {
  return { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
}

function setupBridge(overrides = {}) {
  const wa = new MockWhatsAppClient();
  const sig = new MockSignalClient();
  const idMap = overrides.idMap || new IdMap(60);
  const dedup = overrides.dedup || new DedupStore(5);
  const breaker = overrides.breaker || new CircuitBreaker(50, 60);
  const log = overrides.log || createSilentLogger();
  const botPhone = overrides.botPhone || '+919999999999';
  const waGroupJid = overrides.waGroupJid || '120363xxx@g.us';
  const sigGroupId = overrides.sigGroupId || 'abc123=';

  const bridge = new BridgeCore({
    whatsappClient: wa, signalClient: sig,
    botPhone, whatsappGroupJid: waGroupJid, signalGroupId: sigGroupId,
    idMap, dedup, circuitBreaker: breaker, log,
    pauseDurationMs: overrides.pauseDurationMs || 100
  });
  bridge.start();
  return { bridge, wa, sig, idMap, dedup, breaker };
}

test('WA message is forwarded to Signal with formatting', async () => {
  const { wa, sig } = setupBridge();
  wa.emitMessage({ id: 'msgABC', groupJid: '120363xxx@g.us', senderName: 'Rahul', senderPhone: '+91 98765 43210', text: 'hey everyone', timestamp: 1719554400000 });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(sig.sentMessages.length, 1);
  assert.equal(sig.sentMessages[0].text, 'Rahul (+91 98765 43210): hey everyone');
});

test('Signal message is forwarded to WhatsApp with formatting', async () => {
  const { wa, sig } = setupBridge();
  sig.emitMessage({ timestamp: 1719554400000, groupId: 'abc123=', senderName: 'Priya', senderPhone: '+91 9111122233', text: 'good morning' });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(wa.sentMessages.length, 1);
  assert.equal(wa.sentMessages[0].text, 'Priya (+91 9111122233): good morning');
});

test('message from BOT_PHONE on WA is dropped (anti-loop)', async () => {
  const { wa, sig } = setupBridge();
  wa.emitMessage({ id: 'msg1', groupJid: '120363xxx@g.us', senderName: 'Bridge', senderPhone: '+91 9999999999', text: 'no', timestamp: 1 });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(sig.sentMessages.length, 0);
});

test('message from BOT_PHONE on Signal is dropped (anti-loop)', async () => {
  const { wa, sig } = setupBridge();
  sig.emitMessage({ timestamp: 1719554400000, groupId: 'abc123=', senderName: 'Bridge', senderPhone: '919999999999@s.whatsapp.net', text: 'no' });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(wa.sentMessages.length, 0);
});

test('message with null senderPhone is dropped (fail-safe)', async () => {
  const { wa, sig } = setupBridge();
  wa.emitMessage({ id: 'msg1', groupJid: '120363xxx@g.us', senderName: 'Rahul', senderPhone: null, text: 'no', timestamp: 1 });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(sig.sentMessages.length, 0);
});

test('message from wrong group is dropped', async () => {
  const { wa, sig } = setupBridge();
  wa.emitMessage({ id: 'msg1', groupJid: 'wrong-group@g.us', senderName: 'Rahul', senderPhone: '+91 98765 43210', text: 'hi', timestamp: 1 });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(sig.sentMessages.length, 0);
});

test('delete on WA within TTL deletes on Signal', async () => {
  const { wa, sig, idMap } = setupBridge();
  idMap.set('whatsapp', 'msgABC', 'signal', 1719554400000);
  wa.emitDelete({ groupJid: '120363xxx@g.us', messageId: 'msgABC' });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(sig.deletedMessages.length, 1);
  assert.equal(sig.deletedMessages[0].timestamp, 1719554400000);
});

test('after delete, idMap entry is removed (delete-echo defense)', async () => {
  const { wa, idMap } = setupBridge();
  idMap.set('whatsapp', 'msgABC', 'signal', 1719554400000);
  wa.emitDelete({ groupJid: '120363xxx@g.us', messageId: 'msgABC' });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(idMap.lookup('whatsapp', 'msgABC'), null);
  assert.equal(idMap.lookup('signal', 1719554400000), null);
});

test('delete after TTL expiry is silently skipped', async () => {
  const { wa, sig } = setupBridge();
  wa.emitDelete({ groupJid: '120363xxx@g.us', messageId: 'never-stored' });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(sig.deletedMessages.length, 0);
});

test('circuit breaker trips after threshold sends', async () => {
  const { wa, sig } = setupBridge({ breaker: new CircuitBreaker(3, 60) });
  for (let i = 0; i < 4; i++) {
    wa.emitMessage({ id: `msg${i}`, groupJid: '120363xxx@g.us', senderName: 'Rahul', senderPhone: '+91 98765 43210', text: `msg ${i}`, timestamp: i });
  }
  await new Promise(r => setTimeout(r, 50));
  assert.equal(sig.sentMessages.length, 3);
});

test('duplicate message ID is forwarded only once', async () => {
  const { wa, sig } = setupBridge();
  const msg = { id: 'msgABC', groupJid: '120363xxx@g.us', senderName: 'Rahul', senderPhone: '+91 98765 43210', text: 'hey', timestamp: 1 };
  wa.emitMessage(msg);
  wa.emitMessage(msg);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(sig.sentMessages.length, 1);
});

test('delete from wrong group is ignored', async () => {
  const { wa, sig, idMap } = setupBridge();
  idMap.set('whatsapp', 'msgABC', 'signal', 1719554400000);
  wa.emitDelete({ groupJid: 'wrong-group@g.us', messageId: 'msgABC' });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(sig.deletedMessages.length, 0);
});
