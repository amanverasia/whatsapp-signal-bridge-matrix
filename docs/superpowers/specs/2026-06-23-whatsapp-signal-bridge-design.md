# WhatsApp ↔ Signal Bridge — Design Spec

**Date:** 2026-06-23
**Status:** Approved (pending written-spec review)
**Project:** `whatsapp-signal-bridge-matrix`

## Problem

Bridge two community chat groups — "estudely #general" on WhatsApp and "estudely #general" on Signal — so that text messages sent in one appear in the other, formatted as:

```
Sender Name (+phone): message text
```

Messages flow bidirectionally. Deletes propagate within a 1-hour window. The bridge runs as a single process on an Oracle Cloud VPS, eventually packaged as one Docker container.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Architecture | Custom direct bridge (no Matrix middle layer) | Single-process, simpler ops, matches single-container deployment goal |
| Stack | Node.js (ES modules, Node 20+) + Baileys + signal-cli | Baileys is the de facto WhatsApp library (used by OpenClaw, Hermes Agent); signal-cli is the de facto Signal CLI |
| Message format | `Name (+phone): message` | Maximum clarity; user accepts the privacy tradeoff |
| Event scope | New messages + deletes (1-hour TTL on ID mapping) | Minimal v1; edits/reactions/media out of scope |
| History | Live only, no catch-up on restart | Simplicity; no persistent state |
| Process model | Node spawns signal-cli as a managed child daemon | One container, one entrypoint, one log stream |
| Test groups | "estudely on-hold #1" (Signal), "testing bot" (WhatsApp) | Isolated testing before pointing at production groups |

## Architecture

A single Node.js process. On startup it spawns `signal-cli` as a daemon child process (JSON-RPC over a Unix socket) and connects Baileys to WhatsApp. Both sides run concurrently inside the one process. The bridge forwards messages bidirectionally, with deletes propagated within a 1-hour window.

```
                  ┌─────────────────────────────────────────┐
                  │           Node.js bridge process         │
                  │                                         │
   WhatsApp  ←──→ │  Baileys (in-process)    Bridge Core    │ ←──→ Signal
  (estudely       │                          (routing,      │     (estudely
   #general)      │  signal-cli client       ID map,        │      #general)
                  │  (JSON-RPC over          formatting)    │
                  │   Unix socket)                          │
                  │            │                            │
                  │            ▼                            │
                  │  signal-cli daemon (child process)      │
                  │  (JVM, manages Signal session)          │
                  └─────────────────────────────────────────┘
                              │
                              ▼
                       Signal servers
```

### Process lifecycle

1. Node starts → reads config (env vars + gitignored `.env`).
2. Node spawns `signal-cli daemon --socket /tmp/signald.sock` as a child.
3. Node waits for the socket to accept connections, then connects.
4. Node initializes Baileys and connects to WhatsApp (restores session, or shows QR for first-time pairing).
5. Once both sides are connected, the bridge begins forwarding.
6. If the signal-cli child crashes, Node restarts it. If Baileys disconnects, Baileys auto-reconnects.
7. If either side can't be restored after repeated retries, Node exits non-zero so Docker restarts the container.

## Components

Plain JavaScript (ES modules, Node 20+) — no build step, keeps v1 simple. Each module has one clear responsibility and a small interface.

```
whatsapp-signal-bridge-matrix/
├── package.json
├── .gitignore                   # ignores config.local.json, data/, node_modules
├── .env.example                 # template, committed
├── Dockerfile
├── src/
│   ├── index.js                 # entrypoint: wire everything, lifecycle
│   ├── config.js                # load + validate config
│   ├── logging.js               # timestamped console logging
│   ├── whatsapp/
│   │   └── client.js            # Baileys wrapper
│   ├── signal/
│   │   └── client.js            # signal-cli JSON-RPC wrapper
│   ├── signalCli/
│   │   └── spawn.js             # manages signal-cli daemon child process
│   └── bridge/
│       ├── core.js              # routing, anti-loop, delete lookup
│       ├── idMap.js             # 1-hour TTL message ID mapping
│       ├── format.js            # sender formatting: "Name (+phone): text"
│       ├── phone.js             # E.164 normalization
│       └── circuitBreaker.js    # send-rate circuit breaker
├── test/
│   ├── bridge/
│   │   ├── format.test.js
│   │   ├── idMap.test.js
│   │   ├── core.test.js
│   │   ├── phone.test.js
│   │   └── circuitBreaker.test.js
│   └── config.test.js
├── data/                        # gitignored runtime state
│   ├── auth_info/               # Baileys session
│   └── signal/                  # signal-cli data dir
└── docs/superpowers/specs/      # design docs
```

### Module interfaces

**`whatsapp/client.js`** — wraps Baileys
- `start()` — connect, restore session, or print QR for first-time pairing
- `onMessage(handler)` — handler receives `{ id, groupJid, senderName, senderPhone, text, timestamp }`
- `onDelete(handler)` — handler receives `{ groupJid, messageId }`
- `send(groupJid, text)` → returns `{ id }` of the message just sent
- `deleteMessage(groupJid, messageId)` — best-effort

**`signal/client.js`** — wraps signal-cli JSON-RPC
- `start()` — connect to the Unix socket
- `onMessage(handler)` — handler receives `{ timestamp, groupId, senderName, senderPhone, text }` (Signal uses timestamps as message IDs)
- `onDelete(handler)` — handler receives `{ groupId, timestamp }`
- `send(groupId, text)` → returns `{ timestamp }`
- `deleteMessage(groupId, timestamp)` — best-effort

**`bridge/core.js`** — the router
- Subscribes to both clients
- On a message from either side: format sender, send to the other side, store ID mapping (both directions)
- On a delete: look up the paired ID in `idMap`, remove the entry, call the other side's delete (silently skip if not found / expired)
- Anti-loop: drop any message where `senderPhone` is missing OR equals `BOT_PHONE`
- Group filter: drop any message not from the configured bridged group

**`bridge/idMap.js`** — in-memory bidirectional TTL map
- `set(srcPlatform, srcId, dstPlatform, dstId)` — stores both `src→dst` and `dst→src` entries
- `lookup(srcPlatform, srcId)` → `{ dstPlatform, dstId }` or `null`
- `remove(srcPlatform, srcId)` — removes both directions (called after handling a delete)
- Periodic sweep every 5 minutes evicts entries older than 1 hour

**`bridge/format.js`**
- `formatMessage(senderName, senderPhone, text)` → `Rahul (+91 98765 43210): hello`
- Edge cases: empty/emoji name → phone-only (`+91 98765 43210: hello`); missing phone → name-only (`Rahul: hello`)

**`bridge/phone.js`**
- `normalize(input)` → E.164 string (e.g. `+919999999999`)
- Handles `91xxxxxxxxxx`, `+91 xxx xxx xxxx`, `+91xxxxxxxxxx`, etc.
- Used for anti-loop comparison so format differences don't cause false negatives

**`bridge/circuitBreaker.js`**
- `recordSend()` — logs a send timestamp
- `isTripped()` → boolean — true if sends in the last `CIRCUIT_BREAKER_WINDOW_SEC` exceed `CIRCUIT_BREAKER_THRESHOLD`
- Sliding window implementation

**`signalCli/spawn.js`** — child process manager
- `start()` — spawns `signal-cli daemon --socket /tmp/signald.sock`
- Emits `ready` when the socket accepts connections
- Restarts the child on crash with exponential backoff (1s → 2s → 4s → 8s → max 60s)
- After 5 consecutive failures within 5 minutes, exits the parent (Docker restarts the container)

**`index.js`** — orchestrator
- Load config → spawn signal-cli → connect Baileys → start bridge core
- `--discover` mode: connect both sides, list groups + IDs, exit
- Graceful shutdown on SIGTERM/SIGINT (cleanly close both clients, kill child)
- On unrecoverable failure of either side, exit non-zero so Docker restarts the container

## Data Flow

### Message: WhatsApp → Signal

```
1. Rahul sends "hey everyone" in WhatsApp estudely #general
2. Baileys fires message event
3. whatsapp/client.js filters:
     - groupJid === WHATSAPP_GROUP_JID ?  yes
     - key.fromMe === true ?              no
     - senderPhone === BOT_PHONE ?        no  → proceed
     - senderPhone missing/unparseable?   no  → proceed
4. Emits { id: "msgABC", senderName: "Rahul",
           senderPhone: "+91 98765 43210", text: "hey everyone" }
5. bridge/core.js calls format.formatMessage(...)
     → "Rahul (+91 98765 43210): hey everyone"
6. Circuit breaker check: isTripped()?  no → proceed
7. signal.send(SIGNAL_GROUP_ID, formattedText)
     → returns { timestamp: 1719554400000 }
8. idMap.set("whatsapp", "msgABC", "signal", 1719554400000)
     (stores both: wa:msgABC→sig:1719... AND sig:1719...→wa:msgABC)
9. dedup set: add "wa:msgABC" with 5-min TTL
10. Signal group now displays:
      Rahul (+91 98765 43210): hey everyone
```

### Message: Signal → WhatsApp

Symmetric. A Signal user sends → `signal/client.js` emits → bridge formats → `whatsapp.send(...)` → store bidirectional mapping `"signal", <timestamp> → "whatsapp", <newMsgId>`.

### Delete: WhatsApp → Signal (within 1 hour)

```
1. Rahul deletes "hey everyone" in WhatsApp
2. Baileys fires revoke event with original messageId "msgABC"
3. whatsapp/client.js emits onDelete({ groupJid, messageId: "msgABC" })
4. bridge/core.js: idMap.lookup("whatsapp", "msgABC")
     → { dstPlatform: "signal", dstId: 1719554400000 }
5. idMap.remove("whatsapp", "msgABC")   ← removes BOTH directions
6. signal.deleteMessage(SIGNAL_GROUP_ID, 1719554400000)
7. Forwarded message disappears from Signal group
```

When Signal fires the echo delete event for the bot's own deletion:
```
8. signal/client.js emits onDelete({ groupId, timestamp: 1719554400000 })
9. bridge/core.js: idMap.lookup("signal", 1719554400000)
     → null  (entry was removed in step 5)
10. Silently skip. Loop broken.
```

If the original lookup returns null (entry expired after 1 hour, or bot restarted since the original), the delete is **silently skipped**. The forwarded message stays visible on the other side — accepted tradeoff.

### Delete: Signal → WhatsApp

Symmetric.

### Anti-loop (critical)

The bot is a member of both groups, so every message it forwards arrives back at it from the other side. Without protection this creates an infinite loop. Multiple defenses are layered:

| Scenario | Defense |
|---|---|
| Message echo (bot receives its own forwarded message) | `senderPhone === BOT_PHONE` → drop |
| Delete echo (bot receives its own deletion event) | Remove idMap entry before calling delete; null lookup on echo → skip |
| Missing or unparseable senderPhone | Fail safe — drop the message |
| Phone format mismatch across platforms | Normalize both sides to E.164 before comparison (`bridge/phone.js`) |
| Baileys outgoing message echo | `key.fromMe === true` → drop (belt-and-suspenders with phone check) |
| Duplicate delivery after reconnect | LRU dedup set of incoming message IDs, 5-min TTL |
| Unanticipated loop | Circuit breaker: >50 sends in 60s → pause 60s + log error |

The circuit breaker is the last-resort kill switch. Even if a loop scenario was missed, it trips within ~60 seconds and logs a loud warning.

### Other filters (at the client wrapper level)

- **Wrong group:** if `groupJid` / `groupId` doesn't match the configured bridged group, drop. (The bot might be in other groups; we ignore them.)
- **Wrong message type:** media, voice notes, stickers, system messages, etc. — drop (v1 is text-only). Optionally log a one-line notice so you can see when something was skipped.
- **Empty/emoji display name:** `format.js` falls back to phone-only, e.g. `+91 98765 43210: hello`.

## Configuration

### Config values

All deployment-specific values live in a single `.env` file (gitignored). Committed `.env.example` is the template.

```bash
# .env.example (committed)
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

### Loading

- `src/config.js` reads `.env` via `dotenv`, validates required fields are present and non-empty, normalizes `BOT_PHONE` to E.164.
- If required fields are missing → print a clear error ("Set WHATSAPP_GROUP_JID in .env — run `npm run discover` to find it") and exit non-zero.

### Group ID discovery (one-time)

Group IDs aren't visible in the app UI — they're internal identifiers. The entrypoint has a `--discover` mode:

```bash
npm run discover
# or: node src/index.js --discover
```

This connects to both platforms (using the linked sessions) and prints:

```
WhatsApp groups you're in:
  - "estudely #general"  JID: 120363xxxxxxxxxx@g.us
  - "Family"             JID: 120363yyyyyyyyyy@g.us

Signal groups you're in:
  - "estudely #general"  ID:  abc123def456=
  - "Work"               ID:  xyz789ghi012=
```

You copy the two `estudely #general` IDs into `.env` and restart in normal mode.

### One-time setup checklist (documented in README)

1. Install signal-cli on the host (or rely on the Docker image to bundle it).
2. Link WhatsApp: run the bot once, scan the QR Baileys prints. Session saves to `WHATSAPP_AUTH_DIR`.
3. Register signal-cli as the **primary device** for the bot number (since the number is dedicated to the bridge):
   ```bash
   signal-cli -u +91... register
   signal-cli -u +91... verify <code>
   ```
   This replaces any existing Signal app on that number — fine, since it's a dedicated bridge number.
4. From your personal WhatsApp and Signal accounts, add the bot number to both `estudely #general` groups.
5. Run `npm run discover` → copy the two group IDs into `.env`.
6. Run `npm start`.

### `.gitignore`

```
node_modules/
.env
data/                  # Baileys session + signal-cli data (contains keys)
*.log
```

## Error Handling & Logging

### Reconnection

**WhatsApp (Baileys):**
- Baileys has built-in reconnection. On `connection.update` with `state: 'close'`, it auto-reconnects unless the disconnect is fatal (e.g., session invalidated / logged out).
- If logged out: log `error`, exit non-zero. User must re-scan the QR. (Cannot auto-recover.)
- Messages arriving during a disconnect window are missed — accepted per Option A.

**Signal (signal-cli daemon):**
- The daemon maintains its own connection to Signal servers and reconnects internally.
- If the daemon **process** crashes, Node's child manager restarts it (see below).
- If the daemon is running but `send()` fails (e.g., transient socket error or mid-restart): log and drop the message.

### signal-cli child process management

- Node spawns signal-cli as a child; watches it.
- On unexpected child exit: log `warn`, restart with exponential backoff (1s → 2s → 4s → 8s → … max 60s).
- After **5 consecutive failures within 5 minutes**: log `error` "signal-cli won't start, giving up" and exit non-zero (Docker restarts the container).
- On graceful Node shutdown: send SIGTERM to child, wait up to 10s for clean exit, then SIGKILL if needed.

### Send / delete failures

| Failure | Behavior |
|---|---|
| `whatsapp.send()` fails | Log `warn` with destination + content, drop message. No retry. |
| `signal.send()` fails | Same. |
| Delete lookup returns null | Silently skip (entry expired or unknown). Optional `debug` log. |
| `deleteMessage()` fails | Log `warn`, continue. Forwarded message stays visible. |

### Graceful shutdown (SIGTERM / SIGINT)

1. Stop accepting new events from both clients.
2. Wait for in-flight sends to complete (up to 5s).
3. Close Baileys connection.
4. Send SIGTERM to signal-cli child, wait up to 10s.
5. Exit 0.

This makes `docker stop` clean — no orphaned processes or half-sent messages.

### Logging

**Format** (single line, stdout — Docker-friendly):
```
2026-06-23T14:32:01.123Z [INFO] [whatsapp] connected, session restored
2026-06-23T14:32:02.456Z [INFO] [bridge] WA→Signal: "Rahul (+91 98765 43210): hey everyone"
2026-06-23T14:32:03.789Z [INFO] [bridge] dropped: sender is bot (anti-loop)
2026-06-23T14:32:04.012Z [WARN] [signal] send failed: socket EPIPE, message dropped
```

**Levels:**
- `error` — bridge can't function (signal-cli won't start, Baileys logged out, circuit breaker tripped).
- `warn` — recoverable (send/delete failed and dropped, child crashed and restarted).
- `info` — normal operation (connections, forwarded messages, deletes, drops with reason).
- `debug` — verbose (every raw event, idMap operations, dedup hits, normalization).

**What gets logged at `info`:** forwarded messages (with formatted text), deletes (with ID mapping), dropped messages with reason, reconnections, startup milestones, circuit breaker events.

**Privacy note:** message text appears in `info` logs. If you ever share logs, set `LOG_LEVEL=warn` first to redact message content. Phone numbers always appear (they're part of the formatted message) — inherent to the chosen message format.

### Circuit breaker

- Sliding window of send timestamps.
- If sends in last `CIRCUIT_BREAKER_WINDOW_SEC` (default 60) exceed `CIRCUIT_BREAKER_THRESHOLD` (default 50):
  - Log `error`: "Circuit breaker tripped: N sends in 60s. Pausing 60s."
  - Pause forwarding for 60s (incoming events still received but not forwarded — effectively dropped).
  - Resume after 60s, log `info`: "Circuit breaker reset, resuming."

## Testing

Three layers, prioritized by value. Test framework: **Node's built-in `node:test`** (Node 20+, zero dependencies).

### Layer 1 — Unit tests (pure logic, no mocks needed)

Fast, deterministic, high value. Cover the fiddly pieces where bugs hide.

```
test/bridge/format.test.js       — formatMessage edge cases
test/bridge/idMap.test.js         — set, lookup, TTL expiry, bidirectional, post-delete removal
test/bridge/phone.test.js         — E.164 normalization across input formats
test/bridge/circuitBreaker.test.js — under threshold, at threshold, window expiry, resume
test/config.test.js              — validation, normalization, missing-field errors
```

Specific cases that must pass:
- `formatMessage("", "+91...", "hi")` → `"+91...: hi"` (empty name falls back to phone)
- `formatMessage("Rahul", null, "hi")` → `"Rahul: hi"` (missing phone)
- `formatMessage("Rahul", "+91 98765 43210", "hi")` → `"Rahul (+91 98765 43210): hi"`
- `idMap.set("wa", "A", "sig", 123)` then `lookup("sig", 123)` → returns `("wa", "A")` (bidirectional)
- `idMap.set(...)` then entry evicted after TTL → `lookup` returns null
- `normalize("+91 9999999999") === normalize("919999999999") === normalize("+919999999999")`

### Layer 2 — Integration tests (bridge core with mock clients)

This is where the **loop defenses are proven**. The bridge core is instantiated with fake WhatsApp and Signal clients that record sends and let tests inject incoming events.

```
test/bridge/core.test.js
```

**Critical tests (must pass before shipping):**

| Test | What it proves |
|---|---|
| WA message → Signal receives formatted text | Basic forwarding, WA→Signal |
| Signal message → WA receives formatted text | Basic forwarding, Signal→WA |
| Message from `BOT_PHONE` on WA → nothing sent to Signal | Anti-loop |
| Message from `BOT_PHONE` on Signal → nothing sent to WA | Anti-loop (other direction) |
| Message with null `senderPhone` → dropped | Fail-safe on missing sender |
| Delete on WA within TTL → Signal delete called | Delete propagation |
| After delete handled, idMap entry gone → echo delete is skipped | Delete-echo loop defense |
| Delete after TTL expired → no delete sent, no error | Silent skip |
| 51st send in 60s → circuit breaker pauses, no more sends | Circuit breaker trips |
| After 60s pause → sends resume | Circuit breaker resets |
| Message from unconfigured group → dropped | Group filter |
| Same message ID delivered twice → forwarded once | Dedup |

### Layer 3 — Manual end-to-end checklist (documented in README)

Can't be automated without burning real accounts. Uses the dedicated test groups:
- WhatsApp: **"testing bot"**
- Signal: **"estudely on-hold #1"**

Each test group contains the bot number + one personal test account. Once the checklist passes, repoint the group IDs in `.env` to the production `estudely #general` groups and restart — no code changes needed.

Checklist:
- [ ] Send "hello" from WhatsApp test account → appears in Signal as `Name (+phone): hello`
- [ ] Send "hi" from Signal test account → appears in WhatsApp
- [ ] Send a message as the bot directly → does NOT echo back
- [ ] Delete a forwarded message within 1 hour → disappears on the other side
- [ ] Wait 1 hour, delete → no error, message stays on other side
- [ ] Send 60 messages quickly → circuit breaker trips, see warning in logs
- [ ] Kill signal-cli mid-run → Node restarts it, bridge recovers
- [ ] `docker stop` → clean shutdown, no orphan processes

### What we're NOT testing

- Baileys' internal reconnection (trust the library)
- signal-cli's protocol compliance (trust the tool)
- Real network failures (too hard to simulate reliably; covered by manual checklist)

Run command: `npm test` → `node --test test/`.

## Out of Scope (v1)

- Media (photos, voice notes, stickers, documents)
- Message edits
- Reactions
- Reply threading
- Catch-up on restart / missed messages
- Retry queue for failed sends
- Multi-group bridging (one pair only)
- Persistent message ID mapping (survives restart)

## Future Considerations

- Adding a 3rd platform (Telegram, Discord, IRC) would favor re-evaluating a Matrix-based architecture (Option A from the brainstorming), since N×N direct bridges don't scale.
- Scaling to multiple group pairs would require config restructuring.
- Persistent ID map (SQLite) if delete reliability becomes important.
- Media support if text-only proves insufficient.
