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
    this.sock = makeWASocket({ auth: state, printQRInTerminal: true, logger: { level: 'silent' } });
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
    this._messageHandlers.forEach(h => h({
      id: msg.key.id, groupJid: jid,
      senderName: msg.pushName || null,
      senderPhone: msg.key.participant || jid,
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
