export class MockWhatsAppClient {
  constructor() {
    this.sentMessages = [];
    this.deletedMessages = [];
    this._messageHandlers = [];
    this._deleteHandlers = [];
  }
  onMessage(h) { this._messageHandlers.push(h); }
  onDelete(h) { this._deleteHandlers.push(h); }
  async send(groupJid, text) {
    const id = `wa-msg-${this.sentMessages.length + 1}`;
    this.sentMessages.push({ groupJid, text, id });
    return { id };
  }
  async deleteMessage(groupJid, messageId) {
    this.deletedMessages.push({ groupJid, messageId });
  }
  emitMessage(msg) { this._messageHandlers.forEach(h => h(msg)); }
  emitDelete(del) { this._deleteHandlers.forEach(h => h(del)); }
}

export class MockSignalClient {
  constructor() {
    this.sentMessages = [];
    this.deletedMessages = [];
    this._messageHandlers = [];
    this._deleteHandlers = [];
  }
  onMessage(h) { this._messageHandlers.push(h); }
  onDelete(h) { this._deleteHandlers.push(h); }
  async send(groupId, text) {
    const timestamp = Date.now() + this.sentMessages.length;
    this.sentMessages.push({ groupId, text, timestamp });
    return { timestamp };
  }
  async deleteMessage(groupId, timestamp) {
    this.deletedMessages.push({ groupId, timestamp });
  }
  emitMessage(msg) { this._messageHandlers.forEach(h => h(msg)); }
  emitDelete(del) { this._deleteHandlers.forEach(h => h(del)); }
}
