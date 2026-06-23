# AGENTS.md — WhatsApp ↔ Signal Bridge

Instructions for AI agents setting up or deploying this project.

## Project Summary

Bidirectional text bridge between a WhatsApp group and a Signal group. Messages appear as `Sender Name (+phone): text`. Deletes propagate within a 1-hour window.

**Stack:** Node.js 20+ (ES modules), Baileys v7.x (WhatsApp), signal-cli 0.14.x (Signal, Java), libphonenumber-js, dotenv.

## File Structure

```
src/
├── index.js                  # Entrypoint. --discover flag to list groups
├── config.js                 # Loads/validates .env, normalizes BOT_PHONE
├── logging.js                # Timestamped stdout/stderr logger
├── whatsapp/client.js        # Baileys wrapper (QR pairing, message events)
├── signal/client.js          # signal-cli JSON-RPC wrapper (Unix socket)
├── signalCli/spawn.js        # Spawns signal-cli daemon as child process
├── bridge/
│   ├── core.js               # Routes messages, anti-loop, delete prop
│   ├── idMap.js              # Bidirectional TTL map (1hr, in-memory)
│   ├── format.js             # "Name (+phone): text" formatting
│   ├── phone.js              # E.164 normalization via libphonenumber-js
│   ├── dedup.js              # Duplicate message detection (5min TTL)
│   └── circuitBreaker.js     # Rate-limiting send breaker (50/60s)
test/                         # 47 tests using node:test
data/                         # Runtime state (gitignored): auth_info/, signal/
```

## Quick Start (Local)

```bash
npm install
cp .env.example .env
# Edit .env: set BOT_PHONE (E.164 format, e.g. +919999999999)
# Leave WHATSAPP_GROUP_JID and SIGNAL_GROUP_ID empty for now
```

**Link Signal as secondary device:**
```bash
signal-cli link -n "bridge"
# Shows QR or sgnl:// link. Scan from phone: Settings > Linked Devices > Link New Device
```

**Link WhatsApp (first run only):**
```bash
npm start
# Shows QR in terminal. Scan from WhatsApp: Linked Devices > Link a Device
# Session saves to data/auth_info/. Ctrl+C after scanning.
```

**Discover group IDs:**
```bash
npm run discover
# Lists WhatsApp + Signal groups with IDs. Copy into .env.
```

**Run the bridge:**
```bash
npm start
```

## Docker Deployment

### Build
```bash
docker build -t wa-signal-bridge .
```
The Dockerfile installs signal-cli from GitHub releases. If the version in the Dockerfile (`SIGNAL_CLI_VERSION`) is outdated, check https://github.com/AsamK/signal-cli/releases and update it.

### Pre-deployment (one-time)

Before deploying, you MUST link both WhatsApp and Signal from a machine that has a display/terminal (QR scanning required):

1. **Signal linking:**
   ```bash
   # Run this on a machine with terminal access
   docker run -it --rm -v signal-data:/app/data wa-signal-bridge signal-cli link -n "bridge"
   # Scan QR from phone's Signal app
   # This stores the linked device in the signal-data volume
   ```

2. **WhatsApp linking:**
   ```bash
   # Run this on a machine with terminal access
   docker run -it --rm -v signal-data:/app/data wa-signal-bridge node src/index.js
   # Scan QR from WhatsApp. Ctrl+C after scanning.
   # Session saves to data/auth_info/ in the volume
   ```

3. **Discover group IDs:**
   ```bash
   # With .env containing BOT_PHONE
   docker run -it --rm --env-file .env -v signal-data:/app/data wa-signal-bridge node src/index.js --discover
   # Copy the group IDs into .env
   ```

### Deploy (production)

```bash
docker run -d --name bridge \
  --env-file .env \
  -v signal-data:/app/data \
  --restart unless-stopped \
  wa-signal-bridge
```

Check logs: `docker logs -f bridge`

### Required .env for production

```bash
BOT_PHONE=+91...           # Bridge phone number, E.164 format
WHATSAPP_GROUP_JID=123@g.us  # From npm run discover
SIGNAL_GROUP_ID=abc123=      # From npm run discover
# Optional: LOG_LEVEL, CIRCUIT_BREAKER_THRESHOLD, ID_MAP_TTL_MIN
```

## Configuration Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `BOT_PHONE` | yes | — | E.164 phone number |
| `WHATSAPP_GROUP_JID` | yes | — | WhatsApp group JID |
| `SIGNAL_GROUP_ID` | yes | — | Signal group base64 ID |
| `LOG_LEVEL` | no | `info` | `error`/`warn`/`info`/`debug` |
| `CIRCUIT_BREAKER_THRESHOLD` | no | `50` | Max sends per 60s before pausing |
| `CIRCUIT_BREAKER_WINDOW_SEC` | no | `60` | Sliding window for circuit breaker |
| `ID_MAP_TTL_MIN` | no | `60` | How long delete mappings are kept |
| `SIGNAL_SOCKET_PATH` | no | `/tmp/signald.sock` | Unix socket path |
| `SIGNAL_DATA_DIR` | no | `./data/signal` | signal-cli data (default location is fine) |
| `WHATSAPP_AUTH_DIR` | no | `./data/auth_info` | Baileys session |

## signal-cli Notes

- Installed at Docker build time from GitHub releases. Version in Dockerfile.
- The daemon runs as a child process of the Node app (spawned via `src/signalCli/spawn.js`).
- Default data directory: `~/.local/share/signal-cli/data/` (contains `accounts.json`).
- Registered as a **secondary/linked device**, not primary. The phone is the primary.
- If link expires or breaks: delete `data/` volume, re-link via `signal-cli link -n "bridge"`.

## Testing

```bash
npm test           # Runs all 47 tests via node:test
npm run discover   # Lists groups the bot is a member of
```

## Troubleshooting

**"Config file is in use by another instance":**
Kill stale daemon: `pkill -f "org.asamk.signal.Main"` then `rm -f /tmp/signald.sock`

**WhatsApp won't connect / reconnect loop:**
Delete corrupted session: `rm -rf data/auth_info/*` then re-scan QR.

**Signal "Method not implemented":**
Check signal-cli version. This project requires v0.14.x. JSON-RPC methods may differ across versions.

**"Fatal error: Missing required config":**
The `.env` file is missing or incomplete. Ensure BOT_PHONE, WHATSAPP_GROUP_JID, and SIGNAL_GROUP_ID are set.

## Design Spec

See `docs/superpowers/specs/2026-06-23-whatsapp-signal-bridge-design.md` for the full design.
See `docs/superpowers/plans/2026-06-23-whatsapp-signal-bridge.md` for the implementation plan.

## Privacy

- `.env` is gitignored — never commit phone numbers or group IDs.
- `data/` is gitignored — contains session keys and credentials.
- Test files use fake phone numbers (`+919999999999`) — no real numbers in committed code.
