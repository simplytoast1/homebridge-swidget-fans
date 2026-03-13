import { Logger } from 'homebridge';
import { API_TIMEOUT, SwidgetState, SwidgetSummary } from './settings.js';
import { ALLOWED_CFM } from './speedMapping.js';

export class SwidgetApi {
  private readonly baseUrl: string;

  constructor(
    host: string,
    private readonly log: Logger,
    private readonly accessKey?: string,
  ) {
    this.baseUrl = `http://${host}/api/v1`;
  }

  async getSummary(): Promise<SwidgetSummary> {
    return this.get('/summary') as Promise<SwidgetSummary>;
  }

  async getState(): Promise<SwidgetState> {
    return this.get('/state') as Promise<SwidgetState>;
  }

  async sendCommand(command: object): Promise<unknown> {
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

  async setExhaustCFM(cfm: number): Promise<void> {
    if (!ALLOWED_CFM.includes(cfm as typeof ALLOWED_CFM[number])) {
      this.log.warn(`Invalid CFM value ${cfm}, ignoring command`);
      return;
    }
    await this.sendCommand({
      host: { components: { '0': { exhaust: { cfm } } } },
    });
  }

  async setBoost(on: boolean): Promise<void> {
    await this.sendCommand({
      host: { components: { '0': { boost: { mode: on ? 'on' : 'off' } } } },
    });
  }

  async setLight(on: boolean): Promise<void> {
    await this.sendCommand({
      host: { components: { '0': { light: { on } } } },
    });
  }

  private async get(path: string): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT);

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
