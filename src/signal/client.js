import { createConnection } from 'node:net';

export class SignalClient {
  constructor({ socketPath, account, groupId, log }) {
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

  onMessage(handler) { this._messageHandlers.push(handler); }
  onDelete(handler) { this._deleteHandlers.push(handler); }

  async start() {
    this.socket = createConnection(this.socketPath);
    this.socket.on('data', (chunk) => this._onData(chunk));
    this.socket.on('error', (err) => this.log.error(`[signal] socket error: ${err.message}`));
    this.socket.on('close', () => this.log.warn('[signal] socket closed'));
    await new Promise((resolve, reject) => {
      this.socket.on('connect', resolve);
      this.socket.on('error', reject);
    });
    this.log.info('[signal] connected to signal-cli daemon');
  }

  async send(groupId, text) {
    const result = await this._call('send', { account: this.account, groupId, message: text });
    return { timestamp: result.timestamp };
  }

  async deleteMessage(groupId, targetSentTimestamp) {
    await this._call('sendRemoteDeleteMessage', { account: this.account, groupId, targetSentTimestamp });
  }

  async listGroups() {
    const result = await this._call('listGroups', { account: this.account });
    return Array.isArray(result) ? result : (result.groups || result);
  }

  _call(method, params) {
    const id = this.nextId++;
    const request = JSON.stringify({ jsonrpc: '2.0', method, params, id });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(request + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`JSON-RPC timeout: ${method}`)); }
      }, 30000);
    });
  }

  _onData(chunk) {
    this.buffer += chunk.toString();
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim()) this._handleLine(line);
    }
  }

  _handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { this.log.debug(`[signal] unparseable: ${line}`); return; }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'receive' && msg.params?.envelope) {
      this._handleEnvelope(msg.params.envelope);
    }
  }

  _handleEnvelope(envelope) {
    const dm = envelope.dataMessage;
    if (!dm) return;
    if (dm.remoteDelete) {
      if (dm.groupInfo?.groupId === this.groupId) {
        this._deleteHandlers.forEach(h => h({ groupId: dm.groupInfo.groupId, timestamp: dm.remoteDelete.targetSentTimestamp }));
      }
      return;
    }
    if (dm.message && dm.groupInfo) {
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
    if (this.socket) this.socket.end();
  }
}
