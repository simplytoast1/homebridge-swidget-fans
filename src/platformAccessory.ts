import {
  Service,
  PlatformAccessory,
  CharacteristicValue,
  HAPStatus,
  Logger,
  API,
  HAP,
} from 'homebridge';

import { SwidgetApi } from './swidgetApi.js';
import {
  SwidgetDeviceConfig,
  SwidgetComponentState,
  SwidgetSummary,
  COMMAND_SETTLE_DELAY,
  DEFAULT_POLLING_INTERVAL,
} from './settings.js';
import { percentToCFM, cfmToPercent } from './speedMapping.js';

export class SwidgetERVAccessory {
  private readonly api: SwidgetApi;
  private readonly hap: HAP;

  private fanService!: Service;
  private boostService?: Service;
  private lightService?: Service;
  private condensationService?: Service;

  private state: SwidgetComponentState | null = null;
  private lastCfm = 50;
  private pollTimer?: ReturnType<typeof setInterval>;
  private reachable = false;

  constructor(
    private readonly log: Logger,
    private readonly accessory: PlatformAccessory,
    private readonly homebridgeApi: API,
    private readonly config: SwidgetDeviceConfig,
    private readonly summary: SwidgetSummary,
  ) {
    this.hap = homebridgeApi.hap;
    this.api = new SwidgetApi(config.host, log, config.accessKey);

    this.setupAccessoryInfo();
    this.setupFanService();
    this.setupOptionalServices();
    this.startPolling();
  }

  private setupAccessoryInfo(): void {
    const infoService = this.accessory.getService(this.hap.Service.AccessoryInformation)!;
    infoService
      .setCharacteristic(this.hap.Characteristic.Manufacturer, 'Swidget')
      .setCharacteristic(this.hap.Characteristic.Model, this.summary.model)
      .setCharacteristic(this.hap.Characteristic.SerialNumber, this.summary.mac)
      .setCharacteristic(this.hap.Characteristic.FirmwareRevision, this.summary.version);
  }

  private setupFanService(): void {
    this.fanService =
      this.accessory.getService(this.hap.Service.Fanv2) ||
      this.accessory.addService(this.hap.Service.Fanv2, this.config.name);

    this.fanService.getCharacteristic(this.hap.Characteristic.Active)
      .onGet(() => this.handleGetActive())
      .onSet((value) => this.handleSetActive(value));

    this.fanService.getCharacteristic(this.hap.Characteristic.RotationSpeed)
      .onGet(() => this.handleGetRotationSpeed())
      .onSet((value) => this.handleSetRotationSpeed(value));

    this.fanService.getCharacteristic(this.hap.Characteristic.CurrentFanState)
      .onGet(() => this.handleGetCurrentFanState());

    this.fanService.getCharacteristic(this.hap.Characteristic.TargetFanState)
      .onGet(() => this.hap.Characteristic.TargetFanState.MANUAL)
      .onSet(() => { /* always manual */ });
  }

  private setupOptionalServices(): void {
    const functions = this.summary.host.components[0]?.functions ?? [];
    const modules = this.summary.host.components[0]?.modules ?? [];

    // Boost switch
    const enableBoost = this.config.enableBoostSwitch !== false;
    if (enableBoost && functions.includes('boost')) {
      this.boostService =
        this.accessory.getService('Boost') ||
        this.accessory.addService(this.hap.Service.Switch, 'Boost', 'boost');
      this.boostService.setCharacteristic(this.hap.Characteristic.Name, 'Boost');

      this.boostService.getCharacteristic(this.hap.Characteristic.On)
        .onGet(() => this.handleGetBoost())
        .onSet((value) => this.handleSetBoost(value));

      this.fanService.addLinkedService(this.boostService);
    } else {
      const existing = this.accessory.getService('Boost');
      if (existing) {
        this.accessory.removeService(existing);
      }
    }

    // Light switch
    if (this.config.enableLight && functions.includes('light')) {
      this.lightService =
        this.accessory.getService('Light') ||
        this.accessory.addService(this.hap.Service.Switch, 'Light', 'light');
      this.lightService.setCharacteristic(this.hap.Characteristic.Name, 'Light');

      this.lightService.getCharacteristic(this.hap.Characteristic.On)
        .onGet(() => this.handleGetLight())
        .onSet((value) => this.handleSetLight(value));

      this.fanService.addLinkedService(this.lightService);
    } else {
      const existing = this.accessory.getService('Light');
      if (existing) {
        this.accessory.removeService(existing);
      }
    }

    // Condensation leak sensor
    if (this.config.enableCondensationSensor && modules.includes('condensation')) {
      this.condensationService =
        this.accessory.getService(this.hap.Service.LeakSensor) ||
        this.accessory.addService(this.hap.Service.LeakSensor, 'Condensation', 'condensation');
      this.condensationService.setCharacteristic(this.hap.Characteristic.Name, 'Condensation');

      this.condensationService.getCharacteristic(this.hap.Characteristic.LeakDetected)
        .onGet(() => this.handleGetCondensation());

      this.fanService.addLinkedService(this.condensationService);
    } else {
      const existing = this.accessory.getService(this.hap.Service.LeakSensor);
      if (existing) {
        this.accessory.removeService(existing);
      }
    }
  }

  // -- GET handlers --

  private handleGetActive(): CharacteristicValue {
    this.ensureReachable();
    const cfm = this.state?.exhaust?.cfm ?? 0;
    return cfm > 0
      ? this.hap.Characteristic.Active.ACTIVE
      : this.hap.Characteristic.Active.INACTIVE;
  }

  private handleGetRotationSpeed(): CharacteristicValue {
    this.ensureReachable();
    return cfmToPercent(this.state?.exhaust?.cfm ?? 0);
  }

  private handleGetCurrentFanState(): CharacteristicValue {
    this.ensureReachable();
    const cfm = this.state?.exhaust?.cfm ?? 0;
    return cfm > 0
      ? this.hap.Characteristic.CurrentFanState.BLOWING_AIR
      : this.hap.Characteristic.CurrentFanState.IDLE;
  }

  private handleGetBoost(): CharacteristicValue {
    this.ensureReachable();
    return this.state?.boost?.mode === 'on';
  }

  private handleGetLight(): CharacteristicValue {
    this.ensureReachable();
    return this.state?.light?.on ?? false;
  }

  private handleGetCondensation(): CharacteristicValue {
    this.ensureReachable();
    const condensation = this.state?.modules?.condensation ?? 'dormant';
    return condensation !== 'dormant'
      ? this.hap.Characteristic.LeakDetected.LEAK_DETECTED
      : this.hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED;
  }

  // -- SET handlers --

  private async handleSetActive(value: CharacteristicValue): Promise<void> {
    try {
      const active = value === this.hap.Characteristic.Active.ACTIVE;
      if (active) {
        const cfm = this.lastCfm > 0 ? this.lastCfm : 50;
        this.log.info(`Turning fan on to ${cfm} CFM`);
        await this.api.setExhaustCFM(cfm);
      } else {
        this.log.info('Turning fan off');
        await this.api.setExhaustCFM(0);
      }
      await this.delayedPoll();
    } catch (error) {
      this.log.error(`Failed to set active state: ${error}`);
      throw new this.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private async handleSetRotationSpeed(value: CharacteristicValue): Promise<void> {
    try {
      const percent = value as number;
      const cfm = percentToCFM(percent);
      this.log.info(`Setting fan speed: ${percent}% → ${cfm} CFM`);
      if (cfm > 0) {
        this.lastCfm = cfm;
      }
      await this.api.setExhaustCFM(cfm);
      await this.delayedPoll();
    } catch (error) {
      this.log.error(`Failed to set rotation speed: ${error}`);
      throw new this.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private async handleSetBoost(value: CharacteristicValue): Promise<void> {
    try {
      const on = value as boolean;
      this.log.info(`Setting boost: ${on ? 'on' : 'off'}`);
      await this.api.setBoost(on);
      await this.delayedPoll();
    } catch (error) {
      this.log.error(`Failed to set boost: ${error}`);
      throw new this.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private async handleSetLight(value: CharacteristicValue): Promise<void> {
    try {
      const on = value as boolean;
      this.log.info(`Setting light: ${on ? 'on' : 'off'}`);
      await this.api.setLight(on);
      await this.delayedPoll();
    } catch (error) {
      this.log.error(`Failed to set light: ${error}`);
      throw new this.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  // -- Polling --

  private startPolling(): void {
    const interval = (this.config.pollingInterval ?? DEFAULT_POLLING_INTERVAL) * 1000;
    this.log.info(`Polling ${this.config.host} every ${interval / 1000}s`);
    this.pollState();
    this.pollTimer = setInterval(() => this.pollState(), interval);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async pollState(): Promise<void> {
    try {
      const fullState = await this.api.getState();
      this.state = fullState.host.components['0'];
      this.reachable = true;

      if (this.state.exhaust.cfm > 0) {
        this.lastCfm = this.state.exhaust.cfm;
      }

      this.updateCharacteristics();

      this.log.debug(
        `Poll: cfm=${this.state.exhaust.cfm}, boost=${this.state.boost.mode}, ` +
        `power=${this.state.power.current}W, rssi=${fullState.connection.rssi}dBm`,
      );
    } catch (error) {
      this.reachable = false;
      this.log.warn(`Failed to poll ${this.config.host}: ${error}`);
    }
  }

  private updateCharacteristics(): void {
    if (!this.state) return;

    const cfm = this.state.exhaust.cfm;
    const active = cfm > 0
      ? this.hap.Characteristic.Active.ACTIVE
      : this.hap.Characteristic.Active.INACTIVE;
    const fanState = cfm > 0
      ? this.hap.Characteristic.CurrentFanState.BLOWING_AIR
      : this.hap.Characteristic.CurrentFanState.IDLE;

    this.fanService.updateCharacteristic(this.hap.Characteristic.Active, active);
    this.fanService.updateCharacteristic(this.hap.Characteristic.RotationSpeed, cfmToPercent(cfm));
    this.fanService.updateCharacteristic(this.hap.Characteristic.CurrentFanState, fanState);

    if (this.boostService) {
      this.boostService.updateCharacteristic(
        this.hap.Characteristic.On,
        this.state.boost.mode === 'on',
      );
    }

    if (this.lightService) {
      this.lightService.updateCharacteristic(
        this.hap.Characteristic.On,
        this.state.light.on,
      );
    }

    if (this.condensationService) {
      const condensation = this.state.modules?.condensation ?? 'dormant';
      this.condensationService.updateCharacteristic(
        this.hap.Characteristic.LeakDetected,
        condensation !== 'dormant'
          ? this.hap.Characteristic.LeakDetected.LEAK_DETECTED
          : this.hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED,
      );
    }
  }

  private async delayedPoll(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, COMMAND_SETTLE_DELAY));
    await this.pollState();
  }

  private ensureReachable(): void {
    if (!this.reachable || !this.state) {
      throw new this.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }
}
