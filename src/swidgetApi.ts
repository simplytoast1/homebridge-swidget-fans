import { Logger } from 'homebridge';
import { API_TIMEOUT, POLL_TIMEOUT, SwidgetState, SwidgetSummary } from './settings.js';
import { nearestAllowedCFM } from './speedMapping.js';

export class SwidgetApi {
  private readonly baseUrl: string;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    host: string,
    private readonly log: Logger,
    private readonly accessKey?: string,
  ) {
    this.baseUrl = `http://${host}/api/v1`;
  }

  async getSummary(): Promise<SwidgetSummary> {
    return this.enqueue(() => this.get('/summary', API_TIMEOUT)) as Promise<SwidgetSummary>;
  }

  async getState(): Promise<SwidgetState> {
    // Short timeout: a stalled poll should fail fast instead of holding up
    // user commands queued behind it.
    return this.enqueue(() => this.get('/state', POLL_TIMEOUT)) as Promise<SwidgetState>;
  }

  async setExhaustCFM(cfm: number): Promise<void> {
    const target = nearestAllowedCFM(cfm);
    if (target !== cfm) {
      this.log.debug(`Requested ${cfm} CFM is not a supported speed, snapping to ${target}`);
    }
    await this.enqueue(() => this.post({ host: { components: { '0': { exhaust: { cfm: target } } } } }));
  }

  async setBoost(on: boolean): Promise<void> {
    await this.enqueue(() => this.post({ host: { components: { '0': { boost: { mode: on ? 'on' : 'off' } } } } }));
  }

  async setLight(on: boolean): Promise<void> {
    await this.enqueue(() => this.post({ host: { components: { '0': { light: { on } } } } }));
  }

  /**
   * Serialize all HTTP requests so only one is in-flight at a time.
   * Prevents overwhelming the ESP32 device.
   */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.pending.catch(() => {/* ignore prior errors */}).then(() => fn());
    this.pending = next;
    return next;
  }

  private async post(command: object): Promise<unknown> {
    const url = `${this.baseUrl}/command`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.accessKey) {
        headers['Authorization'] = `Bearer ${this.accessKey}`;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(command),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  private async get(path: string, timeoutMs: number): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = {};
      if (this.accessKey) {
        headers['Authorization'] = `Bearer ${this.accessKey}`;
      }

      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}
