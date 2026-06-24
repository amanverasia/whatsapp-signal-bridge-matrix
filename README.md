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

### Option A: docker-compose (recommended)

```bash
cp .env.example .env
# Edit .env with your values
docker compose up -d
```

### Option B: plain Docker

1. **Build:**
   ```bash
   docker build -t wa-signal-bridge .
   ```

2. **Create a `.env` file** with all required values (follow steps 3-7 above first to get sessions and group IDs).

3. **Run:**
   ```bash
   docker run -d --name bridge --env-file .env -v $(pwd)/data:/app/data wa-signal-bridge
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
