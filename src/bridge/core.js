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
    if (this.dedup.has(dedupKey)) { this.log.info('[bridge] dropped: duplicate message (dedup)'); return; }
    this.dedup.add(dedupKey);

    if (msg.groupJid !== this.waGroupJid) { this.log.debug(`[bridge] dropped: wrong group ${msg.groupJid}`); return; }
    if (!msg.senderPhone || phonesMatch(msg.senderPhone, this.botPhone)) { this.log.info('[bridge] dropped: sender is bot or unknown (anti-loop)'); return; }
    if (this.paused || this.breaker.count() >= this.breaker.threshold) { this._tripBreaker(); this.log.warn('[bridge] dropped: circuit breaker tripped'); return; }

    const formatted = formatMessage(msg.senderName, msg.senderPhone, msg.text);
    this.breaker.recordSend();
    try {
      const result = await this.sig.send(this.sigGroupId, formatted);
      this.idMap.set('whatsapp', msg.id, 'signal', result.timestamp);
      this.log.info(`[bridge] WA→Signal: "${formatted}"`);
    } catch (err) {
      this.log.warn(`[bridge] send to Signal failed: ${err.message}, message dropped`);
    }
  }

  async _handleSignalMessage(msg) {
    const dedupKey = `sig:${msg.timestamp}`;
    if (this.dedup.has(dedupKey)) { this.log.info('[bridge] dropped: duplicate message (dedup)'); return; }
    this.dedup.add(dedupKey);

    if (msg.groupId !== this.sigGroupId) { this.log.debug(`[bridge] dropped: wrong group ${msg.groupId}`); return; }
    if (!msg.senderPhone || phonesMatch(msg.senderPhone, this.botPhone)) { this.log.info('[bridge] dropped: sender is bot or unknown (anti-loop)'); return; }
    if (this.paused || this.breaker.count() >= this.breaker.threshold) { this._tripBreaker(); this.log.warn('[bridge] dropped: circuit breaker tripped'); return; }

    const formatted = formatMessage(msg.senderName, msg.senderPhone, msg.text);
    this.breaker.recordSend();
    try {
      const result = await this.wa.send(this.waGroupJid, formatted);
      this.idMap.set('signal', msg.timestamp, 'whatsapp', result.id);
      this.log.info(`[bridge] Signal→WA: "${formatted}"`);
    } catch (err) {
      this.log.warn(`[bridge] send to WhatsApp failed: ${err.message}, message dropped`);
    }
  }

  async _handleWaDelete(del) {
    if (del.groupJid !== this.waGroupJid) return;
    const mapping = this.idMap.lookup('whatsapp', del.messageId);
    if (!mapping) { this.log.debug(`[bridge] delete skipped: no mapping for wa:${del.messageId}`); return; }
    this.idMap.remove('whatsapp', del.messageId);
    try {
      await this.sig.deleteMessage(this.sigGroupId, mapping.dstId);
      this.log.info(`[bridge] WA→Signal delete: ${del.messageId} → ${mapping.dstId}`);
    } catch (err) {
      this.log.warn(`[bridge] delete on Signal failed: ${err.message}`);
    }
  }

  async _handleSignalDelete(del) {
    if (del.groupId !== this.sigGroupId) return;
    const mapping = this.idMap.lookup('signal', del.timestamp);
    if (!mapping) { this.log.debug(`[bridge] delete skipped: no mapping for sig:${del.timestamp}`); return; }
    this.idMap.remove('signal', del.timestamp);
    try {
      await this.wa.deleteMessage(this.waGroupJid, mapping.dstId);
      this.log.info(`[bridge] Signal→WA delete: ${del.timestamp} → ${mapping.dstId}`);
    } catch (err) {
      this.log.warn(`[bridge] delete on WhatsApp failed: ${err.message}`);
    }
  }

  _tripBreaker() {
    if (this.paused) return;
    this.paused = true;
    this.log.error(`[bridge] Circuit breaker tripped: ${this.breaker.count()} sends in window. Pausing ${this.pauseDurationMs / 1000}s.`);
    setTimeout(() => { this.paused = false; this.log.info('[bridge] Circuit breaker reset, resuming.'); }, this.pauseDurationMs);
  }
}
