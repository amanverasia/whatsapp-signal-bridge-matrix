export class CircuitBreaker {
  constructor(threshold = 50, windowSec = 60) {
    this.threshold = threshold;
    this.windowMs = windowSec * 1000;
    this.sends = [];
  }

  recordSend() {
    this.sends.push(Date.now());
    this._prune();
  }

  isTripped() {
    this._prune();
    return this.sends.length > this.threshold;
  }

  count() {
    this._prune();
    return this.sends.length;
  }

  _prune() {
    const cutoff = Date.now() - this.windowMs;
    while (this.sends.length > 0 && this.sends[0] < cutoff) {
      this.sends.shift();
    }
  }
}
