import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/logging.js';

test('createLogger respects level filtering and stream routing', () => {
  const logs = [];
  const original = { out: process.stdout.write, err: process.stderr.write };

  try {
    process.stdout.write = (chunk) => { logs.push(['out', String(chunk)]); return true; };
    process.stderr.write = (chunk) => { logs.push(['err', String(chunk)]); return true; };

    const logger = createLogger('warn');
    logger.debug('debug msg');
    logger.info('info msg');
    logger.warn('warn msg');
    logger.error('error msg');

    const messages = logs.map(([, msg]) => msg);
    assert.equal(messages.length, 2);
    assert.match(messages[0], /WARN.*warn msg/);
    assert.match(messages[1], /ERROR.*error msg/);

    const streams = logs.map(([stream]) => stream);
    assert.equal(streams[0], 'err');
    assert.equal(streams[1], 'err');
  } finally {
    process.stdout.write = original.out;
    process.stderr.write = original.err;
  }
});

test('createLogger includes ISO timestamp', () => {
  const logs = [];
  const original = process.stdout.write;

  try {
    process.stdout.write = (chunk) => { logs.push(String(chunk)); return true; };

    const logger = createLogger('info');
    logger.info('hello');

    assert.match(logs[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  } finally {
    process.stdout.write = original;
  }
});

test('createLogger falls back to info on invalid level', () => {
  const logs = [];
  const original = { out: process.stdout.write, err: process.stderr.write };

  try {
    process.stdout.write = (chunk) => { logs.push(String(chunk)); return true; };
    process.stderr.write = (chunk) => { logs.push(String(chunk)); return true; };

    const logger = createLogger('nonexistent');
    logger.debug('debug');
    logger.info('info');
    logger.warn('warn');
    logger.error('error');

    assert.equal(logs.length, 3);
    assert.match(logs[0], /INFO.*info/);
    assert.match(logs[1], /WARN.*warn/);
    assert.match(logs[2], /ERROR.*error/);
  } finally {
    process.stdout.write = original.out;
    process.stderr.write = original.err;
  }
});
