import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';

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
      logger: {
        child: () => ({ level: 'silent', info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, trace: () => {}, fatal: () => {}, silent: () => {} }),
        level: 'silent',
        info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, trace: () => {}, fatal: () => {}, silent: () => {}
      }
    });
    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        console.log('\nScan this QR code in WhatsApp (Linked Devices > Link a Device):');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'open') {
        this.log.info('[whatsapp] connected');
      } else if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = !(lastDisconnect?.error instanceof Boom) || statusCode !== DisconnectReason.loggedOut;
        this.log.warn(`[whatsapp] closed (status=${statusCode}, reconnect=${shouldReconnect})`);
        if (!shouldReconnect) {
          this.log.error('[whatsapp] logged out! Session invalid.');
          process.exit(1);
        }
        this.log.info('[whatsapp] reconnecting in 5s...');
        setTimeout(() => this.start().catch(err => this.log.error(`[whatsapp] reconnect failed: ${err.message}`)), 5000);
      }
    });

    this.sock.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) this._handleIncomingMessage(msg);
    });

    this.sock.ev.on('messages.update', (updates) => {
      for (const update of updates) this._handleMessageUpdate(update);
    });
  }
  _handleIncomingMessage(msg) {
    if (!msg.message) return;
    const jid = msg.key.remoteJid;
    if (!jid || !jid.endsWith('@g.us')) return;
    if (msg.key.fromMe) return;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || null;
    if (!text) return;

    let senderPhone = String(msg.key.participantAlt || msg.key.participant || jid).replace(/@.*$/, '');
    if (!senderPhone.startsWith('+')) senderPhone = '+' + senderPhone;

    this._messageHandlers.forEach(h => h({
      id: msg.key.id, groupJid: jid,
      senderName: msg.pushName || null,
      senderPhone,
      text, timestamp: msg.messageTimestamp,
    }));
  }

  _handleMessageUpdate(update) {
    const isDelete = update.update?.status === 6 || update.update?.messageStubType === 'REVOKE';
    if (!isDelete) return;
    const jid = update.key?.remoteJid;
    if (!jid || !jid.endsWith('@g.us')) return;
    this._deleteHandlers.forEach(h => h({ groupJid: jid, messageId: update.key.id }));
  }

  async send(groupJid, text) {
    const result = await this.sock.sendMessage(groupJid, { text });
    return { id: result.key.id };
  }

  async deleteMessage(groupJid, messageId) {
    await this.sock.sendMessage(groupJid, { delete: { remoteJid: groupJid, id: messageId, fromMe: true } });
  }

  async listGroups() {
    const groups = await this.sock.groupFetchAllParticipating();
    return Object.values(groups).map(g => ({ id: g.id, subject: g.subject }));
  }

  stop() {
    if (this.sock) this.sock.end();
  }
}
