export const PLATFORM_NAME = 'SwidgetERV';
export const PLUGIN_NAME = 'homebridge-swidget-fans';

export const DEFAULT_POLLING_INTERVAL = 30;
export const API_TIMEOUT = 15000;
export const COMMAND_SETTLE_DELAY = 500;
export const INIT_RETRY_COUNT = 3;
export const INIT_RETRY_DELAY = 3000;

export interface SwidgetDeviceConfig {
  name: string;
  host: string;
  accessKey?: string;
  pollingInterval?: number;
  enableFan?: boolean;
  enableLight?: boolean;
  enableBoostSwitch?: boolean;
  enableAlwaysOn?: boolean;
  enableCondensationSensor?: boolean;
}

export interface SwidgetPlatformConfig {
  platform: string;
  name?: string;
  devices?: SwidgetDeviceConfig[];
}

export interface SwidgetSummary {
  model: string;
  mac: string;
  version: string;
  firmware: {
    tag: string;
  };
  insert: {
    type: string;
    components: unknown[];
  };
  host: {
    id: string;
    type: string;
    error: number;
    components: Array<{
      id: string;
      functions: string[];
      modules: string[];
      maxCFM: number;
      code: string;
    }>;
  };
}

export interface SwidgetComponentState {
  power: {
    current: number;
    avg: number;
    avgOn: number;
  };
  exhaust: {
    cfm: number;
    allowed: number[];
  };
  boost: {
    mode: string;
  };
  error: Record<string, unknown>;
  light: {
    on: boolean;
  };
  modules: {
    condensation: string;
  };
}

export interface SwidgetState {
  insert: {
    components: Record<string, unknown>;
    errors: {
      self_diag: number;
    };
  };
  host: {
    components: {
      [key: string]: SwidgetComponentState;
    };
  };
  connection: {
    rssi: number;
    ip: string;
    type: string;
    mac: string;
  };
}
