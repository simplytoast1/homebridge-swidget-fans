import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';

import {
  PLATFORM_NAME,
  PLUGIN_NAME,
  SwidgetDeviceConfig,
  SwidgetPlatformConfig,
  INIT_RETRY_COUNT,
  INIT_RETRY_DELAY,
} from './settings.js';
import { SwidgetApi } from './swidgetApi.js';
import { SwidgetERVAccessory } from './platformAccessory.js';

export class SwidgetERVPlatform implements DynamicPlatformPlugin {
  private readonly accessories: Map<string, PlatformAccessory> = new Map();
  private readonly activeHandlers: Map<string, SwidgetERVAccessory> = new Map();

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.info('Initializing SwidgetERV platform');

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info(`Loading accessory from cache: ${accessory.displayName}`);
    this.accessories.set(accessory.UUID, accessory);
  }

  private async discoverDevices(): Promise<void> {
    const platformConfig = this.config as unknown as SwidgetPlatformConfig;
    const devices = platformConfig.devices ?? [];

    if (devices.length === 0) {
      this.log.warn('No devices configured');
      return;
    }

    const configuredHosts = new Set<string>();

    for (const deviceConfig of devices) {
      if (!deviceConfig.host) {
        this.log.warn(`Skipping device "${deviceConfig.name}" — no host configured`);
        continue;
      }

      configuredHosts.add(deviceConfig.host);
      await this.setupDevice(deviceConfig);
    }

    // Remove accessories whose host is no longer in config. Keep cached
    // accessories for configured-but-unreachable devices so they aren't lost
    // from HomeKit on a transient outage at startup.
    for (const [uuid, accessory] of this.accessories) {
      const cachedHost = accessory.context.deviceConfig?.host;
      if (cachedHost && configuredHosts.has(cachedHost)) {
        continue;
      }
      this.log.info(`Removing accessory no longer in config: ${accessory.displayName}`);
      const handler = this.activeHandlers.get(uuid);
      if (handler) {
        handler.stopPolling();
        this.activeHandlers.delete(uuid);
      }
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.delete(uuid);
    }
  }

  private async setupDevice(deviceConfig: SwidgetDeviceConfig): Promise<void> {
    const swidgetApi = new SwidgetApi(deviceConfig.host, this.log, deviceConfig.accessKey);

    let summary;
    for (let attempt = 1; attempt <= INIT_RETRY_COUNT; attempt++) {
      try {
        summary = await swidgetApi.getSummary();
        break;
      } catch (error) {
        this.log.warn(
          `Failed to reach ${deviceConfig.host} (attempt ${attempt}/${INIT_RETRY_COUNT}): ${error}`,
        );
        if (attempt < INIT_RETRY_COUNT) {
          await new Promise(resolve => setTimeout(resolve, INIT_RETRY_DELAY));
        }
      }
    }

    if (!summary) {
      this.log.error(`Could not reach device at ${deviceConfig.host} after ${INIT_RETRY_COUNT} attempts — keeping cached accessory if present`);
      return;
    }

    const uuid = this.api.hap.uuid.generate(summary.mac);

    let accessory = this.accessories.get(uuid);
    if (accessory) {
      this.log.info(`Restoring accessory: ${deviceConfig.name} (${summary.mac})`);
      accessory.displayName = deviceConfig.name;
    } else {
      this.log.info(`Adding new accessory: ${deviceConfig.name} (${summary.mac})`);
      accessory = new this.api.platformAccessory(deviceConfig.name, uuid);
      this.accessories.set(uuid, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    accessory.context.deviceConfig = deviceConfig;
    accessory.context.summary = summary;

    const handler = new SwidgetERVAccessory(
      this.log,
      accessory,
      this.api,
      deviceConfig,
      summary,
    );
    this.activeHandlers.set(uuid, handler);
  }
}
