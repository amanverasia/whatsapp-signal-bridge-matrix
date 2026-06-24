import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

export class SignalCliSpawn {
  constructor({ socketPath, signalDataDir, log, noSpawn = false }) {
    this.socketPath = socketPath;
    this.signalDataDir = signalDataDir;
    this.log = log;
    this.noSpawn = noSpawn;
    this.child = null;
    this.failures = [];
    this.maxFailures = 5;
    this.failureWindowMs = 5 * 60 * 1000;
  }

  async start() {
    if (this.noSpawn) {
      this.log.info('[signalCli] skipping spawn (noSpawn mode), waiting for external daemon');
      await this._waitForSocket();
      return;
    }
    await this._spawn();
    await this._waitForSocket();
  }

  _spawn() {
    return new Promise((resolve, reject) => {
      const args = ['--config', this.signalDataDir, 'daemon', '--socket', this.socketPath, '--receive-mode', 'on-connection'];
      this.log.info(`[signalCli] spawning: signal-cli ${args.join(' ')}`);
      this.child = spawn('signal-cli', args, { stdio: ['ignore', 'pipe', 'pipe'] });

      this.child.stdout.on('data', (chunk) => {
        this.log.debug(`[signalCli] stdout: ${chunk.toString().trim()}`);
      });
      this.child.stderr.on('data', (chunk) => {
        this.log.warn(`[signalCli] stderr: ${chunk.toString().trim()}`);
      });

      this.child.on('error', (err) => {
        this.log.error(`[signalCli] spawn error: ${err.message}`);
        reject(err);
      });

      this.child.on('exit', (code, signal) => {
        this.log.warn(`[signalCli] child exited code=${code} signal=${signal}`);
        this._recordFailure();
        if (code !== 0 && this._shouldRetry()) {
          this._scheduleRestart();
        } else if (!this._shouldRetry()) {
          this.log.error('[signalCli] max failures reached, giving up');
          process.exit(1);
        }
      });

      resolve();
    });
  }

  async _waitForSocket(maxAttempts = 50, delayMs = 200) {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        await new Promise((resolve, reject) => {
          const conn = createConnection(this.socketPath);
          conn.on('connect', () => { conn.end(); resolve(); });
          conn.on('error', reject);
        });
        this.log.info('[signalCli] socket is ready');
        return;
      } catch {
        await sleep(delayMs);
      }
    }
    throw new Error(`signal-cli socket not available at ${this.socketPath} after ${maxAttempts * delayMs}ms`);
  }

  _recordFailure() {
    const now = Date.now();
    this.failures.push(now);
    this.failures = this.failures.filter(t => now - t < this.failureWindowMs);
  }

  _shouldRetry() {
    return this.failures.length < this.maxFailures;
  }

  _scheduleRestart() {
    const count = this.failures.length;
    const delay = Math.min(1000 * Math.pow(2, count - 1), 60000);
    this.log.info(`[signalCli] restarting in ${delay}ms (attempt ${count})`);
    setTimeout(async () => {
      try {
        await this._spawn();
        await this._waitForSocket();
        this.log.info('[signalCli] restarted successfully');
      } catch (err) {
        this.log.error(`[signalCli] restart failed: ${err.message}`);
      }
    }, delay);
  }

  stop() {
    if (this.child) {
      this.log.info('[signalCli] sending SIGTERM');
      this.child.kill('SIGTERM');
      setTimeout(() => {
        if (this.child && !this.child.killed) {
          this.log.warn('[signalCli] child did not exit, sending SIGKILL');
          this.child.kill('SIGKILL');
        }
      }, 10000);
    }
  }
}
