# WhatsApp ↔ Signal Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-process Node.js bridge that forwards text messages and deletes between a WhatsApp group and a Signal group, bidirectionally, with anti-loop defenses.

**Architecture:** Node.js process wraps Baileys (WhatsApp) and spawns signal-cli as a child daemon (Signal). A bridge core routes messages between the two, with a 1-hour TTL ID map for delete propagation, a dedup store, a circuit breaker, and multi-layered anti-loop checks.

**Tech Stack:** Node.js 20+ (ES modules), `@whiskeysockets/baileys`, `signal-cli` (Java, spawned as child), `libphonenumber-js`, `dotenv`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-06-23-whatsapp-signal-bridge-design.md`

---

## File Structure

```
whatsapp-signal-bridge-matrix/
├── package.json
├── .gitignore                    # exists
├── .env.example
├── Dockerfile
├── README.md
├── src/
│   ├── index.js                  # entrypoint + --discover mode + lifecycle
│   ├── config.js                 # load + validate .env
│   ├── logging.js                # timestamped logger
│   ├── whatsapp/
│   │   └── client.js            # Baileys wrapper
│   ├── signal/
│   │   └── client.js            # signal-cli JSON-RPC wrapper
│   ├── signalCli/
│   │   └── spawn.js             # child process manager
│   └── bridge/
│       ├── core.js              # routing, anti-loop, delete lookup
│       ├── idMap.js             # bidirectional TTL map
│       ├── format.js            # "Name (+phone): text"
│       ├── phone.js             # E.164 normalization
│       ├── dedup.js             # recent-message-ID dedup
│       └── circuitBreaker.js    # send-rate breaker
├── test/
│   ├── helpers/
│   │   └── mockClient.js        # mock WA/Signal client for bridge tests
│   ├── bridge/
│   │   ├── format.test.js
│   │   ├── idMap.test.js
│   │   ├── phone.test.js
│   │   ├── dedup.test.js
│   │   ├── circuitBreaker.test.js
│   │   └── core.test.js
│   ├── config.test.js
│   └── logging.test.js
└── data/                         # gitignored runtime state
```

**Build order (bottom-up, testable units first):**
1. Scaffolding → 2. Logging → 3. Phone → 4. Config → 5. Format → 6. IdMap → 7. Dedup → 8. CircuitBreaker → 9. BridgeCore → 10. signalCli/spawn → 11. Signal client → 12. WhatsApp client → 13. Entrypoint → 14. Dockerfile → 15. README

Tasks 1–9 are strict TDD (pure logic, fully testable). Tasks 10–13 are I/O code (implementation + manual verification — these wrap external libraries that can't be meaningfully unit-tested without real accounts). Task 14–15 are packaging/docs.

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `.env.example`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "whatsapp-signal-bridge",
  "version": "1.0.0",
  "type": "module",
  "description": "Bidirectional text bridge between WhatsApp and Signal groups",
  "scripts": {
    "start": "node src/index.js",
    "discover": "node src/index.js --discover",
    "test": "node --test test/"
  },
  "dependencies": {
    "@whiskeysockets/baileys": "^6.7.0",
    "@hapi/boom": "^10.0.1",
    "dotenv": "^16.4.5",
    "libphonenumber-js": "^1.11.4",
    "p-queue": "^8.0.1"
  }
}
```

- [ ] **Step 2: Create `.env.example`**

```bash
# Required
BOT_PHONE=+910000000000
WHATSAPP_GROUP_JID=
SIGNAL_GROUP_ID=

# Optional overrides (defaults shown)
SIGNAL_SOCKET_PATH=/tmp/signald.sock
SIGNAL_DATA_DIR=./data/signal
WHATSAPP_AUTH_DIR=./data/auth_info
LOG_LEVEL=info
CIRCUIT_BREAKER_THRESHOLD=50
CIRCUIT_BREAKER_WINDOW_SEC=60
ID_MAP_TTL_MIN=60
DEDUP_TTL_MIN=5
```

- [ ] **Step 3: Create directory structure**

```bash
mkdir -p src/bridge src/whatsapp src/signal src/signalCli test/bridge test/helpers data/auth_info data/signal
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` generated.

- [ ] **Step 5: Verify test runner works**

Run: `node --test test/`
Expected: `# tests 0` and exit code 0 (no tests yet, but no errors).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .env.example src/ test/ data/
git commit -m "chore: scaffold project structure and dependencies"
```

---

### Task 2: Logging module

**Files:**
- Create: `src/logging.js`
- Test: `test/logging.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/logging.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/logging.js';

test('createLogger respects level filtering', () => {
  const logs = [];
  const original = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (chunk) => { logs.push(['out', String(chunk)]); return true; };
  process.stderr.write = (chunk) => { logs.push(['err', String(chunk)]); return true; };

  const logger = createLogger('warn');
  logger.debug('debug msg');
  logger.info('info msg');
  logger.warn('warn msg');
  logger.error('error msg');

  process.stdout.write = original.out;
  process.stderr.write = original.err;

  const messages = logs.map(([, msg]) => msg);
  assert.equal(messages.length, 2);
  assert.match(messages[0], /WARN.*warn msg/);
  assert.match(messages[1], /ERROR.*error msg/);
});

test('createLogger includes ISO timestamp', () => {
  const logs = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { logs.push(String(chunk)); return true; };

  const logger = createLogger('info');
  logger.info('hello');

  process.stdout.write = original;
  assert.match(logs[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/logging.test.js`
Expected: FAIL with "Cannot find module '../src/logging.js'"

- [ ] **Step 3: Write minimal implementation**

```js
// src/logging.js
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

export function createLogger(level = 'info') {
  const maxLevel = LEVELS[level] ?? LEVELS.info;

  function log(levelName, msg) {
    if (LEVELS[levelName] > maxLevel) return;
    const ts = new Date().toISOString();
    const line = `${ts} [${levelName.toUpperCase()}] ${msg}\n`;
    if (levelName === 'error' || levelName === 'warn') {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  }

  return {
    error: (msg) => log('error', msg),
    warn: (msg) => log('warn', msg),
    info: (msg) => log('info', msg),
    debug: (msg) => log('debug', msg),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/logging.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/logging.js test/logging.test.js
git commit -m "feat: add timestamped logger with level filtering"
```

---

### Task 3: Phone normalization

**Files:**
- Create: `src/bridge/phone.js`
- Test: `test/bridge/phone.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/bridge/phone.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/bridge/phone.test.js`
Expected: FAIL with "Cannot find module '../../src/bridge/phone.js'"

- [ ] **Step 3: Write minimal implementation**

```js
// src/bridge/phone.js
import { parsePhoneNumberFromString } from 'libphonenumber-js';

export function normalize(phone) {
  if (!phone) return null;
  const cleaned = String(phone).replace(/@s\.whatsapp\.net$/, '');
  const parsed = parsePhoneNumberFromString(cleaned);
  return parsed && parsed.isValid() ? parsed.number : null;
}

export function phonesMatch(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  return na !== null && na === nb;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/bridge/phone.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/bridge/phone.js test/bridge/phone.test.js
git commit -m "feat: add E.164 phone normalization with JID stripping"
```

---

### Task 4: Config module

**Files:**
- Create: `src/config.js`
- Test: `test/config.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/config.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/config.test.js`
Expected: FAIL with "Cannot find module '../src/config.js'"

- [ ] **Step 3: Write minimal implementation**

```js
// src/config.js
import { parsePhoneNumberFromString } from 'libphonenumber-js';

const REQUIRED = ['BOT_PHONE', 'WHATSAPP_GROUP_JID', 'SIGNAL_GROUP_ID'];

function normalizePhone(phone) {
  const parsed = parsePhoneNumberFromString(phone);
  return parsed && parsed.isValid() ? parsed.number : null;
}

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter(k => !env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required config: ${missing.join(', ')}. ` +
      `Set them in .env. Run 'npm run discover' to find group IDs.`
    );
  }

  const botPhone = normalizePhone(env.BOT_PHONE);
  if (!botPhone) {
    throw new Error(`BOT_PHONE is not a valid phone number: ${env.BOT_PHONE}`);
  }

  return {
    botPhone,
    whatsappGroupJid: env.WHATSAPP_GROUP_JID,
    signalGroupId: env.SIGNAL_GROUP_ID,
    signalSocketPath: env.SIGNAL_SOCKET_PATH || '/tmp/signald.sock',
    signalDataDir: env.SIGNAL_DATA_DIR || './data/signal',
    whatsappAuthDir: env.WHATSAPP_AUTH_DIR || './data/auth_info',
    logLevel: env.LOG_LEVEL || 'info',
    circuitBreakerThreshold: parseInt(env.CIRCUIT_BREAKER_THRESHOLD || '50', 10),
    circuitBreakerWindowSec: parseInt(env.CIRCUIT_BREAKER_WINDOW_SEC || '60', 10),
    idMapTtlMin: parseInt(env.ID_MAP_TTL_MIN || '60', 10),
    dedupTtlMin: parseInt(env.DEDUP_TTL_MIN || '5', 10),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/config.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "feat: add config loading with validation and E.164 normalization"
```

---

### Task 5: Message formatting

**Files:**
- Create: `src/bridge/format.js`
- Test: `test/bridge/format.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/bridge/format.test.js
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
  assert.equal(
    formatMessage('', '+91 98765 43210', 'hi'),
    '+91 98765 43210: hi'
  );
});

test('formatMessage with whitespace name falls back to phone only', () => {
  assert.equal(
    formatMessage('   ', '+91 98765 43210', 'hi'),
    '+91 98765 43210: hi'
  );
});

test('formatMessage with null phone falls back to name only', () => {
  assert.equal(
    formatMessage('Rahul', null, 'hi'),
    'Rahul: hi'
  );
});

test('formatMessage with empty phone falls back to name only', () => {
  assert.equal(
    formatMessage('Rahul', '', 'hi'),
    'Rahul: hi'
  );
});

test('formatMessage with emoji name uses phone only', () => {
  assert.equal(
    formatMessage('🔥', '+91 98765 43210', 'hi'),
    '+91 98765 43210: hi'
  );
});

test('formatMessage with neither name nor phone', () => {
  assert.equal(
    formatMessage(null, null, 'hi'),
    'Unknown: hi'
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/bridge/format.test.js`
Expected: FAIL with "Cannot find module '../../src/bridge/format.js'"

- [ ] **Step 3: Write minimal implementation**

```js
// src/bridge/format.js
export function formatMessage(senderName, senderPhone, text) {
  const name = senderName && senderName.trim();
  const phone = senderPhone && senderPhone.trim();

  // Treat emoji-only names as empty (no meaningful identifier)
  const hasName = name && !/^\p{Extended_Pictographic}+$/u.test(name);

  if (hasName && phone) {
    return `${name} (${phone}): ${text}`;
  }
  if (phone) {
    return `${phone}: ${text}`;
  }
  if (hasName) {
    return `${name}: ${text}`;
  }
  return `Unknown: ${text}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/bridge/format.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/bridge/format.js test/bridge/format.test.js
git commit -m "feat: add message formatting with name/phone fallback handling"
```

---

### Task 6: ID map (bidirectional TTL)

**Files:**
- Create: `src/bridge/idMap.js`
- Test: `test/bridge/idMap.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/bridge/idMap.test.js
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
  // Use ttlMin=0 to simulate immediate expiry (0 minutes = 0ms TTL)
  const map = new IdMap(0);
  map.set('whatsapp', 'msgA', 'signal', 123);
  // Entry is now expired (TTL is 0ms)
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/bridge/idMap.test.js`
Expected: FAIL with "Cannot find module '../../src/bridge/idMap.js'"

- [ ] **Step 3: Write minimal implementation**

```js
// src/bridge/idMap.js
export class IdMap {
  constructor(ttlMin = 60) {
    this.ttlMs = ttlMin * 60 * 1000;
    this.entries = new Map();
    this.sweepInterval = setInterval(() => this.sweep(), 5 * 60 * 1000);
    if (this.sweepInterval.unref) this.sweepInterval.unref();
  }

  _key(platform, id) {
    return `${platform}:${id}`;
  }

  set(srcPlatform, srcId, dstPlatform, dstId) {
    const now = Date.now();
    this.entries.set(this._key(srcPlatform, srcId), { dstPlatform, dstId, timestamp: now });
    this.entries.set(this._key(dstPlatform, dstId), { dstPlatform: srcPlatform, dstId: srcId, timestamp: now });
  }

  lookup(srcPlatform, srcId) {
    const key = this._key(srcPlatform, srcId);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.ttlMs > 0 && Date.now() - entry.timestamp > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return { dstPlatform: entry.dstPlatform, dstId: entry.dstId };
  }

  remove(srcPlatform, srcId) {
    const entry = this.entries.get(this._key(srcPlatform, srcId));
    if (!entry) return;
    this.entries.delete(this._key(srcPlatform, srcId));
    this.entries.delete(this._key(entry.dstPlatform, entry.dstId));
  }

  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (this.ttlMs > 0 && now - entry.timestamp > this.ttlMs) {
        this.entries.delete(key);
      }
    }
  }

  stop() {
    clearInterval(this.sweepInterval);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/bridge/idMap.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/bridge/idMap.js test/bridge/idMap.test.js
git commit -m "feat: add bidirectional TTL id map for delete propagation"
```

---

### Task 7: Dedup store

**Files:**
- Create: `src/bridge/dedup.js`
- Test: `test/bridge/dedup.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/bridge/dedup.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/bridge/dedup.test.js`
Expected: FAIL with "Cannot find module '../../src/bridge/dedup.js'"

- [ ] **Step 3: Write minimal implementation**

```js
// src/bridge/dedup.js
export class DedupStore {
  constructor(ttlMin = 5) {
    this.ttlMs = ttlMin * 60 * 1000;
    this.entries = new Map();
    this.sweepInterval = setInterval(() => this.sweep(), 60 * 1000);
    if (this.sweepInterval.unref) this.sweepInterval.unref();
  }

  has(key) {
    const ts = this.entries.get(key);
    if (!ts) return false;
    if (this.ttlMs > 0 && Date.now() - ts > this.ttlMs) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  add(key) {
    this.entries.set(key, Date.now());
  }

  sweep() {
    const now = Date.now();
    for (const [key, ts] of this.entries) {
      if (this.ttlMs > 0 && now - ts > this.ttlMs) {
        this.entries.delete(key);
      }
    }
  }

  stop() {
    clearInterval(this.sweepInterval);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/bridge/dedup.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/bridge/dedup.js test/bridge/dedup.test.js
git commit -m "feat: add dedup store for duplicate message detection"
```

---

### Task 8: Circuit breaker

**Files:**
- Create: `src/bridge/circuitBreaker.js`
- Test: `test/bridge/circuitBreaker.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/bridge/circuitBreaker.test.js
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
  const cb = new CircuitBreaker(50, 1); // 1 second window
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/bridge/circuitBreaker.test.js`
Expected: FAIL with "Cannot find module '../../src/bridge/circuitBreaker.js'"

- [ ] **Step 3: Write minimal implementation**

```js
// src/bridge/circuitBreaker.js
export class CircuitBreaker {
  constructor(threshold = 50, windowSec = 60) {
    this.threshold = threshold;
    this.windowMs = windowSec * 1000;
    this.sends = [];
  }

  recordSend() {
    this.sends.push(Date.now());
    this._prune();
  }

  isTripped() {
    this._prune();
    return this.sends.length > this.threshold;
  }

  count() {
    this._prune();
    return this.sends.length;
  }

  _prune() {
    const cutoff = Date.now() - this.windowMs;
    while (this.sends.length > 0 && this.sends[0] < cutoff) {
      this.sends.shift();
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/bridge/circuitBreaker.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/bridge/circuitBreaker.js test/bridge/circuitBreaker.test.js
git commit -m "feat: add sliding-window circuit breaker for loop prevention"
```

---

### Task 9: Bridge core (router with anti-loop defenses)

**Files:**
- Create: `test/helpers/mockClient.js`
- Create: `src/bridge/core.js`
- Test: `test/bridge/core.test.js`

- [ ] **Step 1: Write the mock client helper**

```js
// test/helpers/mockClient.js
export class MockWhatsAppClient {
  constructor() {
    this.sentMessages = [];
    this.deletedMessages = [];
    this._messageHandlers = [];
    this._deleteHandlers = [];
  }
  onMessage(h) { this._messageHandlers.push(h); }
  onDelete(h) { this._deleteHandlers.push(h); }
  async send(groupJid, text) {
    const id = `wa-msg-${this.sentMessages.length + 1}`;
    this.sentMessages.push({ groupJid, text, id });
    return { id };
  }
  async deleteMessage(groupJid, messageId) {
    this.deletedMessages.push({ groupJid, messageId });
  }
  emitMessage(msg) { this._messageHandlers.forEach(h => h(msg)); }
  emitDelete(del) { this._deleteHandlers.forEach(h => h(del)); }
}

export class MockSignalClient {
  constructor() {
    this.sentMessages = [];
    this.deletedMessages = [];
    this._messageHandlers = [];
    this._deleteHandlers = [];
  }
  onMessage(h) { this._messageHandlers.push(h); }
  onDelete(h) { this._deleteHandlers.push(h); }
  async send(groupId, text) {
    const timestamp = Date.now() + this.sentMessages.length;
    this.sentMessages.push({ groupId, text, timestamp });
    return { timestamp };
  }
  async deleteMessage(groupId, timestamp) {
    this.deletedMessages.push({ groupId, timestamp });
  }
  emitMessage(msg) { this._messageHandlers.forEach(h => h(msg)); }
  emitDelete(del) { this._deleteHandlers.forEach(h => h(del)); }
}
```

- [ ] **Step 2: Write the failing tests**

```js
// test/bridge/core.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeCore } from '../../src/bridge/core.js';
import { IdMap } from '../../src/bridge/idMap.js';
import { DedupStore } from '../../src/bridge/dedup.js';
import { CircuitBreaker } from '../../src/bridge/circuitBreaker.js';
import { MockWhatsAppClient, MockSignalClient } from '../helpers/mockClient.js';

function createSilentLogger() {
  return {
    error: () => {}, warn: () => {}, info: () => {}, debug: () => {}
  };
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
  wa.emitMessage({
    id: 'msgABC', groupJid: '120363xxx@g.us',
    senderName: 'Rahul', senderPhone: '+91 98765 43210',
    text: 'hey everyone', timestamp: 1719554400000
  });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(sig.sentMessages.length, 1);
  assert.equal(sig.sentMessages[0].text, 'Rahul (+91 98765 43210): hey everyone');
  assert.equal(sig.sentMessages[0].groupId, 'abc123=');
});

test('Signal message is forwarded to WhatsApp with formatting', async () => {
  const { wa, sig } = setupBridge();
  sig.emitMessage({
    timestamp: 1719554400000, groupId: 'abc123=',
    senderName: 'Priya', senderPhone: '+91 9111122233',
    text: 'good morning'
  });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(wa.sentMessages.length, 1);
  assert.equal(wa.sentMessages[0].text, 'Priya (+91 9111122233): good morning');
});

test('message from BOT_PHONE on WA is dropped (anti-loop)', async () => {
  const { wa, sig } = setupBridge();
  wa.emitMessage({
    id: 'msg1', groupJid: '120363xxx@g.us',
    senderName: 'Bridge', senderPhone: '+91 9999999999',
    text: 'should not forward', timestamp: 1
  });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(sig.sentMessages.length, 0);
});

test('message from BOT_PHONE on Signal is dropped (anti-loop)', async () => {
  const { wa, sig } = setupBridge();
  sig.emitMessage({
    timestamp: 1719554400000, groupId: 'abc123=',
    senderName: 'Bridge', senderPhone: '919999999999@s.whatsapp.net',
    text: 'should not forward'
  });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(wa.sentMessages.length, 0);
});

test('message with null senderPhone is dropped (fail-safe)', async () => {
  const { wa, sig } = setupBridge();
  wa.emitMessage({
    id: 'msg1', groupJid: '120363xxx@g.us',
    senderName: 'Rahul', senderPhone: null,
    text: 'should not forward', timestamp: 1
  });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(sig.sentMessages.length, 0);
});

test('message from wrong group is dropped', async () => {
  const { wa, sig } = setupBridge();
  wa.emitMessage({
    id: 'msg1', groupJid: 'wrong-group@g.us',
    senderName: 'Rahul', senderPhone: '+91 98765 43210',
    text: 'hi', timestamp: 1
  });
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
  wa.emitDelete({ groupJid: '120363xxx@g.us', messageId: 'expired' });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(sig.deletedMessages.length, 0);
});

test('circuit breaker trips after threshold sends', async () => {
  const { wa, sig } = setupBridge({ breaker: new CircuitBreaker(3, 60) });
  for (let i = 0; i < 4; i++) {
    wa.emitMessage({
      id: `msg${i}`, groupJid: '120363xxx@g.us',
      senderName: 'Rahul', senderPhone: '+91 98765 43210',
      text: `msg ${i}`, timestamp: i
    });
  }
  await new Promise(r => setTimeout(r, 50));
  assert.equal(sig.sentMessages.length, 3);
});

test('duplicate message ID is forwarded only once', async () => {
  const { wa, sig } = setupBridge();
  const msg = {
    id: 'msgABC', groupJid: '120363xxx@g.us',
    senderName: 'Rahul', senderPhone: '+91 98765 43210',
    text: 'hey', timestamp: 1
  };
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/bridge/core.test.js`
Expected: FAIL with "Cannot find module '../../src/bridge/core.js'"

- [ ] **Step 4: Write minimal implementation**

```js
// src/bridge/core.js
import { formatMessage } from './format.js';
import { phonesMatch } from './phone.js';

export class BridgeCore {
  constructor({
    whatsappClient, signalClient, botPhone,
    whatsappGroupJid, signalGroupId,
    idMap, dedup, circuitBreaker, log,
    pauseDurationMs = 60000
  }) {
    this.wa = whatsappClient;
    this.sig = signalClient;
    this.botPhone = botPhone;
    this.waGroupJid = whatsappGroupJid;
    this.sigGroupId = signalGroupId;
    this.idMap = idMap;
    this.dedup = dedup;
    this.breaker = circuitBreaker;
    this.log = log;
    this.paused = false;
    this.pauseDurationMs = pauseDurationMs;
  }

  start() {
    this.wa.onMessage(msg => this._handleWaMessage(msg));
    this.wa.onDelete(del => this._handleWaDelete(del));
    this.sig.onMessage(msg => this._handleSignalMessage(msg));
    this.sig.onDelete(del => this._handleSignalDelete(del));
  }

  async _handleWaMessage(msg) {
    const dedupKey = `wa:${msg.id}`;
    if (this.dedup.has(dedupKey)) {
      this.log.info('[bridge] dropped: duplicate message (dedup)');
      return;
    }
    this.dedup.add(dedupKey);

    if (msg.groupJid !== this.waGroupJid) {
      this.log.debug(`[bridge] dropped: wrong group ${msg.groupJid}`);
      return;
    }
    if (!msg.senderPhone || phonesMatch(msg.senderPhone, this.botPhone)) {
      this.log.info('[bridge] dropped: sender is bot or unknown (anti-loop)');
      return;
    }
    if (this.paused || this.breaker.isTripped()) {
      this._tripBreaker();
      this.log.warn('[bridge] dropped: circuit breaker tripped');
      return;
    }

    const formatted = formatMessage(msg.senderName, msg.senderPhone, msg.text);
    try {
      const result = await this.sig.send(this.sigGroupId, formatted);
      this.breaker.recordSend();
      this.idMap.set('whatsapp', msg.id, 'signal', result.timestamp);
      this.log.info(`[bridge] WA\u2192Signal: "${formatted}"`);
    } catch (err) {
      this.log.warn(`[bridge] send to Signal failed: ${err.message}, message dropped`);
    }
  }

  async _handleSignalMessage(msg) {
    const dedupKey = `sig:${msg.timestamp}`;
    if (this.dedup.has(dedupKey)) {
      this.log.info('[bridge] dropped: duplicate message (dedup)');
      return;
    }
    this.dedup.add(dedupKey);

    if (msg.groupId !== this.sigGroupId) {
      this.log.debug(`[bridge] dropped: wrong group ${msg.groupId}`);
      return;
    }
    if (!msg.senderPhone || phonesMatch(msg.senderPhone, this.botPhone)) {
      this.log.info('[bridge] dropped: sender is bot or unknown (anti-loop)');
      return;
    }
    if (this.paused || this.breaker.isTripped()) {
      this._tripBreaker();
      this.log.warn('[bridge] dropped: circuit breaker tripped');
      return;
    }

    const formatted = formatMessage(msg.senderName, msg.senderPhone, msg.text);
    try {
      const result = await this.wa.send(this.waGroupJid, formatted);
      this.breaker.recordSend();
      this.idMap.set('signal', msg.timestamp, 'whatsapp', result.id);
      this.log.info(`[bridge] Signal\u2192WA: "${formatted}"`);
    } catch (err) {
      this.log.warn(`[bridge] send to WhatsApp failed: ${err.message}, message dropped`);
    }
  }

  async _handleWaDelete(del) {
    if (del.groupJid !== this.waGroupJid) return;
    const mapping = this.idMap.lookup('whatsapp', del.messageId);
    if (!mapping) {
      this.log.debug(`[bridge] delete skipped: no mapping for wa:${del.messageId}`);
      return;
    }
    this.idMap.remove('whatsapp', del.messageId);
    try {
      await this.sig.deleteMessage(this.sigGroupId, mapping.dstId);
      this.log.info(`[bridge] WA\u2192Signal delete: ${del.messageId} \u2192 ${mapping.dstId}`);
    } catch (err) {
      this.log.warn(`[bridge] delete on Signal failed: ${err.message}`);
    }
  }

  async _handleSignalDelete(del) {
    if (del.groupId !== this.sigGroupId) return;
    const mapping = this.idMap.lookup('signal', del.timestamp);
    if (!mapping) {
      this.log.debug(`[bridge] delete skipped: no mapping for sig:${del.timestamp}`);
      return;
    }
    this.idMap.remove('signal', del.timestamp);
    try {
      await this.wa.deleteMessage(this.waGroupJid, mapping.dstId);
      this.log.info(`[bridge] Signal\u2192WA delete: ${del.timestamp} \u2192 ${mapping.dstId}`);
    } catch (err) {
      this.log.warn(`[bridge] delete on WhatsApp failed: ${err.message}`);
    }
  }

  _tripBreaker() {
    if (this.paused) return;
    this.paused = true;
    this.log.error(`[bridge] Circuit breaker tripped: ${this.breaker.count()} sends in window. Pausing ${this.pauseDurationMs / 1000}s.`);
    setTimeout(() => {
      this.paused = false;
      this.log.info('[bridge] Circuit breaker reset, resuming.');
    }, this.pauseDurationMs);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/bridge/core.test.js`
Expected: PASS (12 tests)

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All tests pass (36+ tests total across all modules).

- [ ] **Step 7: Commit**

```bash
git add test/helpers/mockClient.js src/bridge/core.js test/bridge/core.test.js
git commit -m "feat: add bridge core with anti-loop, delete propagation, circuit breaker"
```

---

### Task 10: signal-cli child process manager

**Files:**
- Create: `src/signalCli/spawn.js`

This module wraps external I/O (spawning a Java process). It is verified manually — unit testing process spawning requires integration infrastructure.

- [ ] **Step 1: Write the implementation**

```js
// src/signalCli/spawn.js
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

export class SignalCliSpawn {
  constructor({ socketPath, signalDataDir, log, account }) {
    this.socketPath = socketPath;
    this.signalDataDir = signalDataDir;
    this.log = log;
    this.account = account;
    this.child = null;
    this.failures = [];
    this.maxFailures = 5;
    this.failureWindowMs = 5 * 60 * 1000;
  }

  async start() {
    await this._spawn();
    await this._waitForSocket();
  }

  _spawn() {
    return new Promise((resolve, reject) => {
      const args = [
        'daemon',
        '--socket', this.socketPath,
        '--config', this.signalDataDir,
      ];
      this.log.info(`[signalCli] spawning: signal-cli ${args.join(' ')}`);
      this.child = spawn('signal-cli', args, { stdio: ['ignore', 'pipe', 'pipe'] });

      this.child.stdout.on('data', (chunk) => {
        this.log.debug(`[signalCli] stdout: ${chunk.toString().trim()}`);
      });
      this.child.stderr.on('data', (chunk) => {
        this.log.warn(`[signalCli] stderr: ${chunk.toString().trim()}`);
      });

      this.child.on('error', (err) => {
        this.log.error(`[signalCli] spawn error: ${err.message}`);
        reject(err);
      });

      this.child.on('exit', (code, signal) => {
        this.log.warn(`[signalCli] child exited with code=${code} signal=${signal}`);
        this._recordFailure();
        if (code !== 0 && this._shouldRetry()) {
          this._scheduleRestart();
        } else if (!this._shouldRetry()) {
          this.log.error('[signalCli] max failures reached, giving up');
          process.exit(1);
        }
      });

      resolve();
    });
  }

  async _waitForSocket(maxAttempts = 50, delayMs = 200) {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const conn = createConnection(this.socketPath);
        await new Promise((resolve, reject) => {
          conn.on('connect', () => { conn.end(); resolve(); });
          conn.on('error', reject);
        });
        this.log.info('[signalCli] socket is ready');
        return;
      } catch {
        await sleep(delayMs);
      }
    }
    throw new Error(`signal-cli socket not available at ${this.socketPath} after ${maxAttempts * delayMs}ms`);
  }

  _recordFailure() {
    const now = Date.now();
    this.failures.push(now);
    this.failures = this.failures.filter(t => now - t < this.failureWindowMs);
  }

  _shouldRetry() {
    return this.failures.length < this.maxFailures;
  }

  _scheduleRestart() {
    const count = this.failures.length;
    const delay = Math.min(1000 * Math.pow(2, count - 1), 60000);
    this.log.info(`[signalCli] restarting in ${delay}ms (attempt ${count})`);
    setTimeout(async () => {
      try {
        await this._spawn();
        await this._waitForSocket();
        this.log.info('[signalCli] restarted successfully');
      } catch (err) {
        this.log.error(`[signalCli] restart failed: ${err.message}`);
      }
    }, delay);
  }

  stop() {
    if (this.child) {
      this.log.info('[signalCli] sending SIGTERM to child');
      this.child.kill('SIGTERM');
      setTimeout(() => {
        if (this.child && !this.child.killed) {
          this.log.warn('[signalCli] child did not exit, sending SIGKILL');
          this.child.kill('SIGKILL');
        }
      }, 10000);
    }
  }
}
```

- [ ] **Step 2: Manual verification**

Prerequisites: signal-cli installed on the host (`sudo apt install signal-cli` or from [GitHub releases](https://github.com/AsamK/signal-cli)).

Run this one-liner to verify the module loads and can spawn:
```bash
node -e "
import('./src/signalCli/spawn.js').then(async ({ SignalCliSpawn }) => {
  const log = { info: console.log, warn: console.warn, error: console.error, debug: console.log };
  const s = new SignalCliSpawn({ socketPath: '/tmp/test-signald.sock', signalDataDir: './data/signal', log });
  await s.start();
  console.log('OK: signal-cli spawned and socket ready');
  s.stop();
  process.exit(0);
});
"
```
Expected: "OK: signal-cli spawned and socket ready" — if signal-cli is installed. If not, install it first.

- [ ] **Step 3: Commit**

```bash
git add src/signalCli/spawn.js
git commit -m "feat: add signal-cli child process manager with restart backoff"
```

---

### Task 11: Signal client (JSON-RPC over Unix socket)

**Files:**
- Create: `src/signal/client.js`

This module wraps signal-cli's JSON-RPC protocol. Manual verification with a registered signal-cli account.

- [ ] **Step 1: Write the implementation**

```js
// src/signal/client.js
import { createConnection } from 'node:net';
import { EventEmitter } from 'node:events';

export class SignalClient extends EventEmitter {
  constructor({ socketPath, account, groupId, log }) {
    super();
    this.socketPath = socketPath;
    this.account = account;
    this.groupId = groupId;
    this.log = log;
    this.socket = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this._messageHandlers = [];
    this._deleteHandlers = [];
  }

  async start() {
    this.socket = createConnection(this.socketPath);
    this.socket.on('data', (chunk) => this._onData(chunk));
    this.socket.on('error', (err) => {
      this.log.error(`[signal] socket error: ${err.message}`);
    });
    this.socket.on('close', () => {
      this.log.warn('[signal] socket closed');
    });
    await new Promise((resolve, reject) => {
      this.socket.on('connect', resolve);
      this.socket.on('error', reject);
    });
    this.log.info('[signal] connected to signal-cli daemon');

    // Subscribe to incoming messages
    await this._call('subscribe', { account: this.account });
    this.log.info('[signal] subscribed to incoming messages');
  }

  onMessage(handler) { this._messageHandlers.push(handler); }
  onDelete(handler) { this._deleteHandlers.push(handler); }

  async send(groupId, text) {
    const result = await this._call('sendGroupMessage', {
      account: this.account,
      groupId,
      message: text,
    });
    return { timestamp: result.timestamp };
  }

  async deleteMessage(groupId, targetSentTimestamp) {
    await this._call('sendRemoteDeleteMessage', {
      account: this.account,
      groupId,
      targetSentTimestamp,
    });
  }

  async listGroups() {
    const result = await this._call('getGroups', { account: this.account });
    return result.groups || result;
  }

  _call(method, params) {
    const id = this.nextId++;
    const request = JSON.stringify({ jsonrpc: '2.0', method, params, id });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(request + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`JSON-RPC timeout: ${method}`));
        }
      }, 30000);
    });
  }

  _onData(chunk) {
    this.buffer += chunk.toString();
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim()) {
        this._handleLine(line);
      }
    }
  }

  _handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log.debug(`[signal] unparseable line: ${line}`);
      return;
    }

    // Response to a request
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }

    // Notification (incoming message/event)
    if (msg.method === 'receive' && msg.params && msg.params.envelope) {
      this._handleEnvelope(msg.params.envelope);
    }
  }

  _handleEnvelope(envelope) {
    const dm = envelope.dataMessage;
    if (!dm) return;

    if (dm.remoteDelete) {
      // Delete event
      if (dm.groupInfo && dm.groupInfo.groupId === this.groupId) {
        this._deleteHandlers.forEach(h => h({
          groupId: dm.groupInfo.groupId,
          timestamp: dm.remoteDelete.targetSentTimestamp,
        }));
      }
      return;
    }

    if (dm.message && dm.groupInfo) {
      // Group text message
      this._messageHandlers.forEach(h => h({
        timestamp: envelope.timestamp,
        groupId: dm.groupInfo.groupId,
        senderName: envelope.sourceName || envelope.source,
        senderPhone: envelope.source,
        text: dm.message,
      }));
    }
  }

  stop() {
    if (this.socket) {
      this.socket.end();
    }
  }
}
```

- [ ] **Step 2: Manual verification**

Requires signal-cli registered with the bot number. From the project root:
```bash
node -e "
import('./src/signal/client.js').then(async ({ SignalClient }) => {
  const log = { info: console.log, warn: console.warn, error: console.error, debug: console.log };
  const client = new SignalClient({ socketPath: '/tmp/signald.sock', account: process.env.BOT_PHONE, groupId: 'test', log });
  await client.start();
  console.log('Groups:', await client.listGroups());
  client.stop();
  process.exit(0);
});
"
```
Expected: prints the list of Signal groups the bot is in. If the socket isn't running, start signal-cli daemon first via Task 10's verification snippet.

- [ ] **Step 3: Commit**

```bash
git add src/signal/client.js
git commit -m "feat: add signal-cli JSON-RPC client wrapper"
```

---

### Task 12: WhatsApp client (Baileys wrapper)

**Files:**
- Create: `src/whatsapp/client.js`

This module wraps Baileys. Manual verification with a real WhatsApp QR pairing.

- [ ] **Step 1: Write the implementation**

```js
// src/whatsapp/client.js
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';

export class WhatsAppClient {
  constructor({ authDir, groupJid, log }) {
    this.authDir = authDir;
    this.groupJid = groupJid;
    this.log = log;
    this.sock = null;
    this._messageHandlers = [];
    this._deleteHandlers = [];
  }

  onMessage(handler) { this._messageHandlers.push(handler); }
  onDelete(handler) { this._deleteHandlers.push(handler); }

  async start() {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: { level: 'silent' },
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'open') {
        this.log.info('[whatsapp] connected');
      } else if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
          : true;
        this.log.warn(`[whatsapp] connection closed, reconnect=${shouldReconnect}`);
        if (!shouldReconnect) {
          this.log.error('[whatsapp] logged out! Session invalid. Re-scan QR.');
          process.exit(1);
        }
        this.start();
      }
    });

    this.sock.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) {
        this._handleIncomingMessage(msg);
      }
    });

    this.sock.ev.on('messages.update', (updates) => {
      for (const update of updates) {
        this._handleMessageUpdate(update);
      }
    });
  }

  _handleIncomingMessage(msg) {
    if (!msg.message) return;
    const jid = msg.key.remoteJid;
    if (!jid || !jid.endsWith('@g.us')) return;
    if (msg.key.fromMe) return;

    const text = msg.message.conversation
      || msg.message.extendedTextMessage?.text
      || null;
    if (!text) return;

    this._messageHandlers.forEach(h => h({
      id: msg.key.id,
      groupJid: jid,
      senderName: msg.pushName || null,
      senderPhone: msg.key.participant || jid,
      text,
      timestamp: msg.messageTimestamp,
    }));
  }

  _handleMessageUpdate(update) {
    const isDelete = update.update?.status === 6 // STATUS_DELETION
      || update.update?.messageStubType === 'REVOKE';
    if (!isDelete) return;

    const jid = update.key?.remoteJid;
    if (!jid || !jid.endsWith('@g.us')) return;

    this._deleteHandlers.forEach(h => h({
      groupJid: jid,
      messageId: update.key.id,
    }));
  }

  async send(groupJid, text) {
    const result = await this.sock.sendMessage(groupJid, { text });
    return { id: result.key.id };
  }

  async deleteMessage(groupJid, messageId) {
    await this.sock.sendMessage(groupJid, {
      delete: { remoteJid: groupJid, id: messageId, fromMe: true },
    });
  }

  async listGroups() {
    const groups = await this.sock.groupFetchAllParticipating();
    return Object.values(groups).map(g => ({
      id: g.id,
      subject: g.subject,
    }));
  }

  stop() {
    if (this.sock) {
      this.sock.end();
    }
  }
}
```

- [ ] **Step 2: Manual verification**

Create a `.env` with `BOT_PHONE` set. Then:
```bash
node -e "
import('dotenv').then(() => {
  import('./src/config.js').then(({ loadConfig }) => {
    import('./src/logging.js').then(({ createLogger }) => {
      import('./src/whatsapp/client.js').then(async ({ WhatsAppClient }) => {
        const config = loadConfig();
        const log = createLogger(config.logLevel);
        const client = new WhatsAppClient({ authDir: config.whatsappAuthDir, groupJid: config.whatsappGroupJid, log });
        await client.start();
        // Scan the QR on first run, then:
        setTimeout(async () => {
          console.log('Groups:', await client.listGroups());
          client.stop();
          process.exit(0);
        }, 5000);
      });
    });
  });
});
"
```
Expected: QR code prints in terminal (first run). After scanning with WhatsApp, after 5s it prints the list of groups. Session is saved to `data/auth_info/`.

- [ ] **Step 3: Commit**

```bash
git add src/whatsapp/client.js
git commit -m "feat: add Baileys WhatsApp client wrapper with QR pairing"
```

---

### Task 13: Entrypoint (orchestrator + --discover mode)

**Files:**
- Create: `src/index.js`

- [ ] **Step 1: Write the implementation**

```js
// src/index.js
import { loadConfig } from './config.js';
import { createLogger } from './logging.js';
import { IdMap } from './bridge/idMap.js';
import { DedupStore } from './bridge/dedup.js';
import { CircuitBreaker } from './bridge/circuitBreaker.js';
import { BridgeCore } from './bridge/core.js';
import { SignalCliSpawn } from './signalCli/spawn.js';
import { SignalClient } from './signal/client.js';
import { WhatsAppClient } from './whatsapp/client.js';

async function discover(config, log) {
  log.info('[discover] starting discovery mode');

  const wa = new WhatsAppClient({
    authDir: config.whatsappAuthDir,
    groupJid: config.whatsappGroupJid,
    log,
  });
  await wa.start();

  const signalCli = new SignalCliSpawn({
    socketPath: config.signalSocketPath,
    signalDataDir: config.signalDataDir,
    log,
    account: config.botPhone,
  });
  await signalCli.start();

  const sig = new SignalClient({
    socketPath: config.signalSocketPath,
    account: config.botPhone,
    groupId: config.signalGroupId,
    log,
  });
  await sig.start();

  // Wait for data to settle
  await new Promise(r => setTimeout(r, 3000));

  console.log('\nWhatsApp groups you are in:');
  const waGroups = await wa.listGroups();
  for (const g of waGroups) {
    console.log(`  - "${g.subject}"  JID: ${g.id}`);
  }

  console.log('\nSignal groups you are in:');
  const sigGroups = await sig.listGroups();
  for (const g of sigGroups) {
    console.log(`  - "${g.name || g}"  ID: ${g.id || g}`);
  }

  console.log('\nCopy the relevant group IDs into your .env file.');
  wa.stop();
  sig.stop();
  signalCli.stop();
  process.exit(0);
}

async function main() {
  const config = loadConfig();
  const log = createLogger(config.logLevel);

  if (process.argv.includes('--discover')) {
    await discover(config, log);
    return;
  }

  log.info('[main] starting WhatsApp-Signal bridge');

  // 1. Spawn signal-cli daemon
  const signalCli = new SignalCliSpawn({
    socketPath: config.signalSocketPath,
    signalDataDir: config.signalDataDir,
    log,
    account: config.botPhone,
  });
  await signalCli.start();

  // 2. Connect Signal client
  const sig = new SignalClient({
    socketPath: config.signalSocketPath,
    account: config.botPhone,
    groupId: config.signalGroupId,
    log,
  });
  await sig.start();

  // 3. Connect WhatsApp client
  const wa = new WhatsAppClient({
    authDir: config.whatsappAuthDir,
    groupJid: config.whatsappGroupJid,
    log,
  });
  await wa.start();

  // 4. Initialize bridge components
  const idMap = new IdMap(config.idMapTtlMin);
  const dedup = new DedupStore(config.dedupTtlMin);
  const breaker = new CircuitBreaker(config.circuitBreakerThreshold, config.circuitBreakerWindowSec);

  // 5. Start bridge core
  const bridge = new BridgeCore({
    whatsappClient: wa,
    signalClient: sig,
    botPhone: config.botPhone,
    whatsappGroupJid: config.whatsappGroupJid,
    signalGroupId: config.signalGroupId,
    idMap, dedup, circuitBreaker: breaker, log,
  });
  bridge.start();

  log.info('[main] bridge is running');

  // 6. Graceful shutdown
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('[main] shutting down...');
    idMap.stop();
    dedup.stop();
    wa.stop();
    sig.stop();
    signalCli.stop();
    setTimeout(() => process.exit(0), 2000);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Manual verification — discover mode**

Ensure `.env` has `BOT_PHONE` set (other fields can be empty for discover):
```bash
cp .env.example .env
# Edit .env: set BOT_PHONE=+919999999999
npm run discover
```
Expected: Lists all WhatsApp and Signal groups with their IDs. Copy the two test group IDs into `.env`.

- [ ] **Step 3: Manual verification — bridge mode**

Ensure `.env` has all three required fields filled in. Then:
```bash
npm start
```
Expected: Logs show `[main] bridge is running`. Send a test message from your personal WhatsApp in the "testing bot" group → it should appear in the Signal "estudely on-hold #1" group formatted as `Name (+phone): text`.

- [ ] **Step 4: Commit**

```bash
git add src/index.js
git commit -m "feat: add entrypoint with discover mode and graceful shutdown"
```

---

### Task 14: Dockerfile

**Files:**
- Create: `Dockerfile`

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
FROM node:20-slim

# Install Java (for signal-cli) and curl (to download signal-cli)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      default-jre-headless curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Download and install signal-cli
ARG SIGNAL_CLI_VERSION=0.13.0
RUN curl -fsSL "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}.tar.gz" \
      -o /tmp/signal-cli.tar.gz && \
    tar -xzf /tmp/signal-cli.tar.gz -C /opt && \
    ln -s "/opt/signal-cli-${SIGNAL_CLI_VERSION}/bin/signal-cli" /usr/local/bin/signal-cli && \
    rm /tmp/signal-cli.tar.gz

# App setup
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/ src/

# Data directory for sessions (mount as volume in production)
RUN mkdir -p data/auth_info data/signal
VOLUME ["/app/data"]

# Load env vars at runtime
CMD ["node", "src/index.js"]
```

- [ ] **Step 2: Build the image**

Run: `docker build -t wa-signal-bridge .`
Expected: Image builds successfully. If signal-cli download fails, check the latest version at https://github.com/AsamK/signal-cli/releases and update `SIGNAL_CLI_VERSION`.

- [ ] **Step 3: Verify signal-cli works inside the container**

Run: `docker run --rm wa-signal-bridge signal-cli --version`
Expected: Prints `signal-cli 0.13.0` (or whichever version was installed).

- [ ] **Step 4: Commit**

```bash
git add Dockerfile
git commit -m "feat: add Dockerfile bundling Node 20 + signal-cli"
```

---

### Task 15: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write the README**

```markdown
# WhatsApp ↔ Signal Bridge

A single-process Node.js bridge that forwards text messages and deletes between a WhatsApp group and a Signal group, bidirectionally.

Messages appear as `Sender Name (+phone): message text`.

## Prerequisites

- Node.js 20+
- signal-cli installed on the host (for local dev) OR Docker (for containerized deployment)
- A dedicated phone number with:
  - A WhatsApp account
  - A Signal account (will be registered as primary device via signal-cli)
- The bot number added to both groups you want to bridge

## Setup (local dev)

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Install signal-cli** (if not using Docker):
   - Download from https://github.com/AsamK/signal-cli/releases
   - Requires Java (JRE 17+)

3. **Create config:**
   ```bash
   cp .env.example .env
   ```
   Set `BOT_PHONE` to your bridge number (E.164 format, e.g. `+919999999999`).

4. **Link WhatsApp:**
   Run `npm start` once — Baileys will print a QR code. Scan it with WhatsApp on the bot's phone. Session saves to `data/auth_info/`. Press Ctrl+C to stop.

5. **Register signal-cli as primary device:**
   ```bash
   signal-cli -u +91... register
   signal-cli -u +91... verify <code-from-SMS>
   ```
   This replaces any existing Signal app on that number.

6. **Add the bot to both groups** from your personal accounts.

7. **Discover group IDs:**
   ```bash
   npm run discover
   ```
   This lists all groups the bot is in, with their internal IDs. Copy the two group IDs into `.env` as `WHATSAPP_GROUP_JID` and `SIGNAL_GROUP_ID`.

8. **Run the bridge:**
   ```bash
   npm start
   ```

## Setup (Docker)

1. **Build:**
   ```bash
   docker build -t wa-signal-bridge .
   ```

2. **Create a `.env` file** with all required values (follow steps 3-7 above first to get sessions and group IDs).

3. **Run:**
   ```bash
   docker run -d --name bridge \
     --env-file .env \
     -v $(pwd)/data:/app/data \
     wa-signal-bridge
   ```

4. **Check logs:**
   ```bash
   docker logs -f bridge
   ```

## Testing

Run unit + integration tests:
```bash
npm test
```

### Manual end-to-end checklist

Use dedicated test groups (not production):
- WhatsApp: "testing bot"
- Signal: "estudely on-hold #1"

- [ ] Send "hello" from WhatsApp test account → appears in Signal as `Name (+phone): hello`
- [ ] Send "hi" from Signal test account → appears in WhatsApp
- [ ] Send a message as the bot directly → does NOT echo back
- [ ] Delete a forwarded message within 1 hour → disappears on the other side
- [ ] Wait 1 hour, delete → no error, message stays on other side
- [ ] Send 60 messages quickly → circuit breaker trips, see warning in logs
- [ ] Kill signal-cli mid-run → Node restarts it, bridge recovers
- [ ] `docker stop` → clean shutdown, no orphan processes

Once all checks pass, update the group IDs in `.env` to the production `estudely #general` groups and restart.

## How it works

```
WhatsApp group  <--->  [Baileys]  <--->  Bridge Core  <--->  [signal-cli]  <--->  Signal group
                                         (formatting,
                                          ID mapping,
                                          anti-loop,
                                          circuit breaker)
```

The bridge forwards messages bidirectionally. Each forwarded message is stored in a 1-hour TTL ID map so that deletes can propagate. Multiple anti-loop defenses prevent the bot from echoing its own messages (see design spec for details).

## Configuration

See `.env.example` for all options. Key settings:

| Variable | Required | Default | Description |
|---|---|---|---|
| `BOT_PHONE` | yes | — | Bridge phone number (E.164) |
| `WHATSAPP_GROUP_JID` | yes | — | WhatsApp group ID (from `npm run discover`) |
| `SIGNAL_GROUP_ID` | yes | — | Signal group ID (from `npm run discover`) |
| `LOG_LEVEL` | no | `info` | `error`/`warn`/`info`/`debug` |
| `CIRCUIT_BREAKER_THRESHOLD` | no | `50` | Max sends per window before pausing |
| `ID_MAP_TTL_MIN` | no | `60` | How long delete mappings are kept |

## Limitations (v1)

- Text messages only (no media, voice notes, stickers)
- No message edits or reactions
- No reply threading
- Messages sent while the bot is offline are not bridged
- No retry queue for failed sends
- One group pair only

## Design spec

See `docs/superpowers/specs/2026-06-23-whatsapp-signal-bridge-design.md`.

## Privacy note

Using Baileys to bridge WhatsApp technically violates WhatsApp's Terms of Service. The bridge number could be banned. Use a dedicated number, not your personal one. Members' phone numbers are visible across platforms (by design — the message format includes them).
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README with setup, testing, and configuration guide"
```

---

## Self-Review

### 1. Spec coverage

| Spec section | Covered by task(s) |
|---|---|
| Architecture (single process, child daemon) | Tasks 10, 13 |
| Components (all modules) | Tasks 2–13 |
| Data flow (WA→Signal, Signal→WA, deletes) | Task 9 (bridge core) |
| Loop defenses (all 7) | Task 9 (anti-loop, fail-safe, dedup, circuit breaker); Task 3 (phone normalization); Task 12 (`fromMe` check) |
| Configuration (.env, discovery, setup) | Tasks 1, 4, 13 |
| Error handling (reconnection, child crashes, send failures, graceful shutdown) | Tasks 10, 11, 12, 13 |
| Logging (format, levels) | Task 2 |
| Circuit breaker | Tasks 8, 9 |
| Testing (unit, integration, manual E2E) | Tasks 2–9 (unit+integration), Task 15 (manual checklist) |
| Dockerfile | Task 14 |

No gaps found.

### 2. Placeholder scan

- No "TBD", "TODO", "fill in" patterns found.
- All code steps contain complete implementations.
- Manual verification steps reference real commands with expected outputs.

### 3. Type consistency

- `IdMap.set(srcPlatform, srcId, dstPlatform, dstId)` — consistent across Task 6 (implementation), Task 9 (bridge core usage).
- `IdMap.lookup(srcPlatform, srcId)` returns `{ dstPlatform, dstId }` or `null` — consistent in tests and bridge core.
- `IdMap.remove(srcPlatform, srcId)` — consistent.
- `CircuitBreaker.recordSend()`, `.isTripped()`, `.count()` — consistent across Task 8 and Task 9.
- `DedupStore.has(key)`, `.add(key)` — consistent across Task 7 and Task 9.
- `WhatsAppClient.onMessage/onDelete/send/deleteMessage` — consistent across Task 12 and Task 9 (mock).
- `SignalClient.onMessage/onDelete/send/deleteMessage` — consistent across Task 11 and Task 9 (mock).
- `BridgeCore` constructor params match between Task 9 and Task 13.

No inconsistencies found.
