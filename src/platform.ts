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
  SwidgetSummary,
  INIT_RETRY_COUNT,
  INIT_RETRY_DELAY,
  RECOVERY_RETRY_DELAY,
} from './settings.js';
import { SwidgetApi } from './swidgetApi.js';
import { SwidgetERVAccessory } from './platformAccessory.js';

export class SwidgetERVPlatform implements DynamicPlatformPlugin {
  private readonly accessories: Map<string, PlatformAccessory> = new Map();
  private readonly activeHandlers: Map<string, SwidgetERVAccessory> = new Map();
  private readonly retryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private shuttingDown = false;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.info('Initializing SwidgetERV platform');

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices().catch((error) => {
        this.log.error(`Device discovery failed: ${error}`);
      });
    });

    this.api.on('shutdown', () => {
      this.shuttingDown = true;
      for (const timer of this.retryTimers.values()) {
        clearTimeout(timer);
      }
      this.retryTimers.clear();
      for (const handler of this.activeHandlers.values()) {
        handler.stopPolling();
      }
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info(`Loading accessory from cache: ${accessory.displayName}`);

    // Apply current characteristic props to cached services now, before the
    // bridge is published, so upgrading users get the new constraints (10%
    // speed detents, no Auto mode) on their first boot instead of serving
    // the stale cached props until a later cache rewrite.
    const fanService = accessory.getService(this.api.hap.Service.Fanv2);
    if (fanService) {
      fanService.getCharacteristic(this.api.hap.Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 100, minStep: 10 });
      fanService.getCharacteristic(this.api.hap.Characteristic.TargetFanState)
        .setProps({ validValues: [this.api.hap.Characteristic.TargetFanState.MANUAL] });
    }

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
    const validDevices: SwidgetDeviceConfig[] = [];

    for (const deviceConfig of devices) {
      if (typeof deviceConfig.host !== 'string' || deviceConfig.host.trim() === '') {
        this.log.warn(`Skipping device "${deviceConfig.name}": no host configured`);
        continue;
      }
      // Record the host even for entries that fail further validation, so the
      // cleanup loop treats them as configured-but-invalid and keeps their
      // cached accessory instead of unregistering it over a config typo.
      const duplicate = configuredHosts.has(deviceConfig.host);
      configuredHosts.add(deviceConfig.host);
      if (duplicate) {
        this.log.warn(`Skipping duplicate config entry for host ${deviceConfig.host}`);
        continue;
      }
      if (typeof deviceConfig.name !== 'string' || deviceConfig.name.trim() === '') {
        this.log.warn(`Skipping device at ${deviceConfig.host}: no name configured (keeping any cached accessory)`);
        continue;
      }
      validDevices.push(deviceConfig);
    }

    // Set devices up concurrently so one offline device can't delay the
    // others; per-device request serialization lives inside SwidgetApi.
    const results = await Promise.allSettled(validDevices.map((d) => this.setupDevice(d)));
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.log.error(`Failed to set up ${validDevices[index].name}: ${result.reason}`);
      }
    });

    // Remove accessories whose host is no longer in config. Keep cached
    // accessories for configured-but-unreachable devices so they aren't lost
    // from HomeKit on a transient outage at startup.
    for (const [uuid, accessory] of this.accessories) {
      const cachedHost = accessory.context.deviceConfig?.host;
      if (cachedHost && configuredHosts.has(cachedHost)) {
        continue;
      }
      if (!cachedHost) {
        // Context was never persisted (for example an unclean shutdown right
        // after first install). Removing would wipe the user's room, scene,
        // and automation assignments, so keep it and let setup repair it.
        this.log.warn(`Keeping cached accessory with no stored host: ${accessory.displayName}`);
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

    let summary: SwidgetSummary | undefined;
    for (let attempt = 1; attempt <= INIT_RETRY_COUNT; attempt++) {
      try {
        const response = await swidgetApi.getSummary();
        if (typeof response?.mac !== 'string' || response.mac === '') {
          throw new Error('Malformed summary response (missing mac)');
        }
        summary = response;
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
      if (this.shuttingDown) {
        return;
      }
      this.log.error(
        `Could not reach device at ${deviceConfig.host} after ${INIT_RETRY_COUNT} attempts. ` +
        `Keeping cached accessory if present, retrying in ${RECOVERY_RETRY_DELAY / 1000}s`,
      );
      const timer = setTimeout(() => {
        this.retryTimers.delete(deviceConfig.host);
        if (this.shuttingDown) {
          return;
        }
        this.setupDevice(deviceConfig).catch((error) => {
          this.log.error(`Retry for ${deviceConfig.host} failed: ${error}`);
        });
      }, RECOVERY_RETRY_DELAY);
      this.retryTimers.set(deviceConfig.host, timer);
      return;
    }

    if (this.shuttingDown) {
      return; // don't construct a polling handler while Homebridge is tearing down
    }

    const uuid = this.api.hap.uuid.generate(summary.mac);

    // Two config entries can resolve to the same physical device (same MAC).
    // Stop the previous handler so its poll timers don't leak.
    const previousHandler = this.activeHandlers.get(uuid);
    if (previousHandler) {
      this.log.warn(
        `Device ${summary.mac} at ${deviceConfig.host} already has a handler; replacing it. ` +
        'Check the config for entries that point at the same device.',
      );
      previousHandler.stopPolling();
      this.activeHandlers.delete(uuid);
    }

    let accessory = this.accessories.get(uuid);
    if (accessory) {
      this.log.info(`Restoring accessory: ${deviceConfig.name} (${summary.mac})`);
      if (accessory.displayName !== deviceConfig.name) {
        accessory.updateDisplayName(deviceConfig.name);
      }
      accessory.context.deviceConfig = deviceConfig;
      accessory.context.summary = summary;
      this.api.updatePlatformAccessories([accessory]);
    } else {
      this.log.info(`Adding new accessory: ${deviceConfig.name} (${summary.mac})`);
      accessory = new this.api.platformAccessory(deviceConfig.name, uuid);
      accessory.context.deviceConfig = deviceConfig;
      accessory.context.summary = summary;
      this.accessories.set(uuid, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

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
