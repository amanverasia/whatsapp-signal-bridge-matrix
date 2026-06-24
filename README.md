# WhatsApp ↔ Signal Bridge

A single-process Node.js bridge that forwards text messages and deletes between a WhatsApp group and a Signal group, bidirectionally.

Messages appear as `Sender Name (+phone): message text`.

Supports `linux/amd64` and `linux/arm64` (aarch64) — see [Architecture](#architecture) for details.

## Prerequisites

- Docker (recommended) or Node.js 20+ for local dev
- A dedicated phone number with:
  - A WhatsApp account
  - A Signal account (linked as a secondary device)
- The bot number added to both groups you want to bridge

## Quick Start (Docker)

```bash
cp .env.example .env
# Edit .env: set BOT_PHONE (E.164 format, e.g. +919999999999)
# Leave WHATSAPP_GROUP_JID and SIGNAL_GROUP_ID empty for now
```

### 1. Link Signal

```bash
docker compose run --rm bridge signal-cli --config /app/data/signal link -n "bridge"
# Shows sgnl:// link — open on your phone, or scan via QR
# Signal → Settings → Linked Devices → Link New Device
```

### 2. Link WhatsApp

```bash
docker compose run --rm bridge node src/index.js
# Shows QR code in terminal
# WhatsApp → Linked Devices → Link a Device
# Press Ctrl+C after scanning. Session saves to the data volume.
```

### 3. Discover group IDs

```bash
docker compose run --rm bridge node src/index.js --discover
# Lists WhatsApp + Signal groups with IDs. Copy into .env.
```

### 4. Deploy

```bash
# Edit .env with real WHATSAPP_GROUP_JID and SIGNAL_GROUP_ID
docker compose up -d
```

### 5. Monitor

```bash
docker compose logs -f      # Follow logs
docker compose ps            # Container status
docker compose restart       # Restart after config changes
docker compose down          # Stop
```

## Setup (local dev)

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Install signal-cli:**
   - Download from https://github.com/AsamK/signal-cli/releases
   - Requires Java 21+

3. **Create config:**
   ```bash
   cp .env.example .env
   ```
   Set `BOT_PHONE` to your bridge number (E.164 format, e.g. `+919999999999`).

4. **Link WhatsApp:**
   Run `npm start` once — Baileys will print a QR code. Scan it with WhatsApp. Press Ctrl+C to stop.

5. **Link Signal as secondary device:**
   ```bash
   signal-cli link -n "bridge"
   ```
   Scan the QR from Signal → Settings → Linked Devices.

6. **Discover group IDs:**
   ```bash
   npm run discover
   ```
   Copy the two group IDs into `.env` as `WHATSAPP_GROUP_JID` and `SIGNAL_GROUP_ID`.

7. **Run the bridge:**
   ```bash
   npm start
   ```

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `BOT_PHONE` | yes | — | Bridge phone number (E.164) |
| `WHATSAPP_GROUP_JID` | yes | — | WhatsApp group JID |
| `SIGNAL_GROUP_ID` | yes | — | Signal group base64 ID |
| `LOG_LEVEL` | no | `info` | `error`/`warn`/`info`/`debug` |
| `SIGNAL_SOCKET_PATH` | no | `/tmp/signald.sock` | Unix socket path for signal-cli |
| `SIGNAL_DATA_DIR` | no | `./data/signal` | signal-cli account data directory |
| `WHATSAPP_AUTH_DIR` | no | `./data/auth_info` | Baileys session directory |
| `SIGNAL_NO_SPAWN` | no | `false` | Set to `true` if signal-cli runs in a separate container |
| `CIRCUIT_BREAKER_THRESHOLD` | no | `50` | Max sends per window before pausing |
| `CIRCUIT_BREAKER_WINDOW_SEC` | no | `60` | Sliding window for circuit breaker |
| `ID_MAP_TTL_MIN` | no | `60` | How long delete mappings are kept |
| `DEDUP_TTL_MIN` | no | `5` | Duplicate message detection window |

## Architecture

The Docker build supports both `linux/amd64` and `linux/arm64`:

- **amd64**: Uses signal-cli's pre-built GraalVM native image.
- **arm64 (aarch64)**: Uses signal-cli's Java distribution with a pre-built `libsignal_jni.so` injected into the JAR (sourced from [exquo/signal-libs-build](https://github.com/exquo/signal-libs-build)). Java 25 is installed from Eclipse Temurin.

```
WhatsApp group  <--->  [Baileys]  <--->  Bridge Core  <--->  [signal-cli]  <--->  Signal group
                                         (formatting,
                                          ID mapping,
                                          anti-loop,
                                          circuit breaker)
```

## How it works

The bridge forwards messages bidirectionally. Each forwarded message is stored in a 1-hour TTL ID map so that deletes can propagate. Multiple anti-loop defenses prevent the bot from echoing its own messages (see design spec for details).

## Testing

```bash
npm test           # 47 tests via node:test
```

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
