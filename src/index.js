import 'dotenv/config';
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

  const wa = new WhatsAppClient({ authDir: config.whatsappAuthDir, groupJid: config.whatsappGroupJid, log });
  await wa.start();

  const signalCli = new SignalCliSpawn({ socketPath: config.signalSocketPath, signalDataDir: config.signalDataDir, log });
  await signalCli.start();

  const sig = new SignalClient({ socketPath: config.signalSocketPath, account: config.botPhone, groupId: config.signalGroupId, log });
  await sig.start();

  // Allow time for connections to stabilize
  await new Promise(r => setTimeout(r, 3000));

  console.log('WhatsApp groups you are in:');
  const waGroups = await wa.listGroups();
  for (const g of waGroups) console.log(`  - "${g.subject}"  JID: ${g.id}`);

  console.log('\nSignal groups you are in:');
  const sigGroups = await sig.listGroups();
  for (const g of sigGroups) console.log(`  - "${g.name || JSON.stringify(g)}"  ID: ${g.id || g}`);

  console.log('\nCopy the relevant group IDs into your .env file.');
  wa.stop();
  sig.stop();
  signalCli.stop();
  process.exit(0);
}

async function main() {
  if (process.argv.includes('--discover')) {
    if (!process.env.WHATSAPP_GROUP_JID) process.env.WHATSAPP_GROUP_JID = 'discover-mode';
    if (!process.env.SIGNAL_GROUP_ID) process.env.SIGNAL_GROUP_ID = 'discover-mode';
  }

  const config = loadConfig();
  const log = createLogger(config.logLevel);

  if (process.argv.includes('--discover')) {
    await discover(config, log);
    return;
  }

  log.info('[main] starting WhatsApp-Signal bridge');

  const signalCli = new SignalCliSpawn({ socketPath: config.signalSocketPath, signalDataDir: config.signalDataDir, log });
  await signalCli.start();

  const sig = new SignalClient({ socketPath: config.signalSocketPath, account: config.botPhone, groupId: config.signalGroupId, log });
  await sig.start();

  const wa = new WhatsAppClient({ authDir: config.whatsappAuthDir, groupJid: config.whatsappGroupJid, log });
  await wa.start();

  const idMap = new IdMap(config.idMapTtlMin);
  const dedup = new DedupStore(config.dedupTtlMin);
  const breaker = new CircuitBreaker(config.circuitBreakerThreshold, config.circuitBreakerWindowSec);

  const bridge = new BridgeCore({
    whatsappClient: wa, signalClient: sig,
    botPhone: config.botPhone,
    whatsappGroupJid: config.whatsappGroupJid,
    signalGroupId: config.signalGroupId,
    idMap, dedup, circuitBreaker: breaker, log,
  });
  bridge.start();

  log.info('[main] bridge is running');

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
