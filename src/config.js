import { normalize } from './bridge/phone.js';

const REQUIRED = ['BOT_PHONE', 'WHATSAPP_GROUP_JID', 'SIGNAL_GROUP_ID'];

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter(k => !env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required config: ${missing.join(', ')}. ` +
      `Set them in .env. Run 'npm run discover' to find group IDs.`
    );
  }

  const botPhone = normalize(env.BOT_PHONE);
  if (!botPhone) {
    throw new Error(`BOT_PHONE is not a valid phone number: ${env.BOT_PHONE}`);
  }

  return {
    botPhone,
    whatsappGroupJid: env.WHATSAPP_GROUP_JID,
    signalGroupId: env.SIGNAL_GROUP_ID,
    signalSocketPath: env.SIGNAL_SOCKET_PATH || '/tmp/signald.sock',
    signalDataDir: env.SIGNAL_DATA_DIR || './data/signal',
    signalNoSpawn: env.SIGNAL_NO_SPAWN === 'true',
    whatsappAuthDir: env.WHATSAPP_AUTH_DIR || './data/auth_info',
    logLevel: env.LOG_LEVEL || 'info',
    circuitBreakerThreshold: parseInt(env.CIRCUIT_BREAKER_THRESHOLD || '50', 10),
    circuitBreakerWindowSec: parseInt(env.CIRCUIT_BREAKER_WINDOW_SEC || '60', 10),
    idMapTtlMin: parseInt(env.ID_MAP_TTL_MIN || '60', 10),
    dedupTtlMin: parseInt(env.DEDUP_TTL_MIN || '5', 10),
  };
}
