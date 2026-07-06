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
  DEFAULT_POLLING_INTERVAL,
  MIN_POLLING_INTERVAL,
  MAX_POLLING_INTERVAL,
} from './settings.js';
import { percentToCFM, cfmToPercent, nearestAllowedCFM } from './speedMapping.js';

export class SwidgetERVAccessory {
  private readonly api: SwidgetApi;
  private readonly hap: HAP;

  private fanService?: Service;
  private boostService?: Service;
  private lightService?: Service;
  private condensationService?: Service;
  private alwaysOnService?: Service;

  private state: SwidgetComponentState | null = null;
  private lastCfm: number;
  private alwaysOn: boolean;
  private pollTimer?: ReturnType<typeof setInterval>;
  private verifyTimer?: ReturnType<typeof setTimeout>;
  private reachable = false;
  private polling = false;
  private stopped = false;
  private consecutiveFailures = 0;
  private static readonly FAILURE_THRESHOLD = 3;

  constructor(
    private readonly log: Logger,
    private readonly accessory: PlatformAccessory,
    private readonly homebridgeApi: API,
    private readonly config: SwidgetDeviceConfig,
    private readonly summary: SwidgetSummary,
  ) {
    this.hap = homebridgeApi.hap;
    this.api = new SwidgetApi(config.host, log, config.accessKey);

    // Restore persisted state so restarts don't lose the resume speed or
    // disarm the Always On automation. The alwaysOn restore is gated on the
    // config flag so disabling the feature also disarms the automation.
    const savedCfm = this.accessory.context.lastCfm;
    this.lastCfm = typeof savedCfm === 'number' && savedCfm > 0 ? nearestAllowedCFM(savedCfm) : 50;
    this.alwaysOn = (this.config.enableAlwaysOn ?? false) && this.accessory.context.alwaysOn === true;

    this.setupAccessoryInfo();
    this.setupFanService();
    this.setupOptionalServices();
    this.startPolling();
  }

  private setupAccessoryInfo(): void {
    const infoService = this.accessory.getService(this.hap.Service.AccessoryInformation)!;
    infoService
      .setCharacteristic(this.hap.Characteristic.Name, this.config.name)
      .setCharacteristic(this.hap.Characteristic.Manufacturer, 'Swidget')
      .setCharacteristic(this.hap.Characteristic.Model, this.summary.model ?? 'ERV')
      .setCharacteristic(this.hap.Characteristic.SerialNumber, this.summary.mac)
      .setCharacteristic(this.hap.Characteristic.FirmwareRevision, this.summary.version ?? '0.0.0');
  }

  private setupFanService(): void {
    const enableFan = this.config.enableFan !== false;
    if (enableFan) {
      this.fanService =
        this.accessory.getService(this.hap.Service.Fanv2) ||
        this.accessory.addService(this.hap.Service.Fanv2, this.config.name);

      this.fanService.getCharacteristic(this.hap.Characteristic.Active)
        .onGet(() => this.handleGetActive())
        .onSet((value) => this.handleSetActive(value));

      // One 10% detent per supported speed, so slider positions map 1:1 to
      // CFM values and never snap to a different number after the poll.
      this.fanService.getCharacteristic(this.hap.Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 100, minStep: 10 })
        .onGet(() => this.handleGetRotationSpeed())
        .onSet((value) => this.handleSetRotationSpeed(value));

      this.fanService.getCharacteristic(this.hap.Characteristic.CurrentFanState)
        .onGet(() => this.handleGetCurrentFanState());

      // The device has no auto mode; restrict the characteristic so HomeKit
      // clients never offer an Auto toggle that would silently revert.
      this.fanService.getCharacteristic(this.hap.Characteristic.TargetFanState)
        .setProps({ validValues: [this.hap.Characteristic.TargetFanState.MANUAL] })
        .onGet(() => this.hap.Characteristic.TargetFanState.MANUAL)
        .onSet(() => { /* always manual */ });
    } else {
      const existing = this.accessory.getService(this.hap.Service.Fanv2);
      if (existing) {
        this.accessory.removeService(existing);
      }
    }
  }

  private setupOptionalServices(): void {
    const components = this.summary.host?.components ?? [];
    const functions = components[0]?.functions ?? [];
    const modules = components[0]?.modules ?? [];

    // Boost switch
    const enableBoost = this.config.enableBoostSwitch !== false;
    if (enableBoost && functions.includes('boost')) {
      this.boostService =
        this.accessory.getServiceById(this.hap.Service.Switch, 'boost') ||
        this.accessory.addService(this.hap.Service.Switch, 'Boost', 'boost');
      this.boostService.setCharacteristic(this.hap.Characteristic.Name, 'Boost');

      this.boostService.getCharacteristic(this.hap.Characteristic.On)
        .onGet(() => this.handleGetBoost())
        .onSet((value) => this.handleSetBoost(value));

      this.fanService?.addLinkedService(this.boostService);
    } else {
      const existing = this.accessory.getServiceById(this.hap.Service.Switch, 'boost');
      if (existing) {
        this.accessory.removeService(existing);
      }
    }

    // Light switch
    if (this.config.enableLight && functions.includes('light')) {
      this.lightService =
        this.accessory.getServiceById(this.hap.Service.Switch, 'light') ||
        this.accessory.addService(this.hap.Service.Switch, 'Light', 'light');
      this.lightService.setCharacteristic(this.hap.Characteristic.Name, 'Light');

      this.lightService.getCharacteristic(this.hap.Characteristic.On)
        .onGet(() => this.handleGetLight())
        .onSet((value) => this.handleSetLight(value));

      this.fanService?.addLinkedService(this.lightService);
    } else {
      const existing = this.accessory.getServiceById(this.hap.Service.Switch, 'light');
      if (existing) {
        this.accessory.removeService(existing);
      }
    }

    // Always On switch
    const enableAlwaysOn = this.config.enableAlwaysOn ?? false;
    if (enableAlwaysOn) {
      this.alwaysOnService =
        this.accessory.getServiceById(this.hap.Service.Switch, 'always-on') ||
        this.accessory.addService(this.hap.Service.Switch, 'Always On', 'always-on');
      this.alwaysOnService.setCharacteristic(this.hap.Characteristic.Name, 'Always On');

      this.alwaysOnService.getCharacteristic(this.hap.Characteristic.On)
        .onGet(() => this.alwaysOn)
        .onSet((value) => {
          this.alwaysOn = value === true;
          this.accessory.context.alwaysOn = this.alwaysOn;
          this.homebridgeApi.updatePlatformAccessories([this.accessory]);
          this.log.info(`Always On mode: ${this.alwaysOn ? 'enabled' : 'disabled'}`);
        });

      this.fanService?.addLinkedService(this.alwaysOnService);
    } else {
      const existing = this.accessory.getServiceById(this.hap.Service.Switch, 'always-on');
      if (existing) {
        this.accessory.removeService(existing);
      }
      // Feature disabled in config: fully disarm so a stale persisted flag
      // can't keep re-activating boost with no switch left to turn it off.
      if (this.accessory.context.alwaysOn !== undefined) {
        delete this.accessory.context.alwaysOn;
        this.homebridgeApi.updatePlatformAccessories([this.accessory]);
      }
    }

    // Condensation contact sensor
    // Remove old LeakSensor if upgrading from previous version
    const oldLeakSensor = this.accessory.getService(this.hap.Service.LeakSensor);
    if (oldLeakSensor) {
      this.accessory.removeService(oldLeakSensor);
    }

    if (this.config.enableCondensationSensor && modules.includes('condensation')) {
      this.condensationService =
        this.accessory.getServiceById(this.hap.Service.ContactSensor, 'condensation') ||
        this.accessory.addService(this.hap.Service.ContactSensor, 'Condensation', 'condensation');
      this.condensationService.setCharacteristic(this.hap.Characteristic.Name, 'Condensation');

      this.condensationService.getCharacteristic(this.hap.Characteristic.ContactSensorState)
        .onGet(() => this.handleGetCondensation());

      this.fanService?.addLinkedService(this.condensationService);
    } else {
      const existing = this.accessory.getServiceById(this.hap.Service.ContactSensor, 'condensation');
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
      : this.hap.Characteristic.CurrentFanState.INACTIVE;
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
      ? this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      : this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED;
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
      this.schedulePoll();
    } catch (error) {
      this.log.error(`Failed to set active state: ${error}`);
      throw new this.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private async handleSetRotationSpeed(value: CharacteristicValue): Promise<void> {
    try {
      const percent = value as number;
      const cfm = percentToCFM(percent);
      this.log.info(`Setting fan speed: ${percent}% (${cfm} CFM)`);
      if (cfm > 0) {
        this.rememberCfm(cfm);
      }
      await this.api.setExhaustCFM(cfm);
      this.schedulePoll();
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
      this.schedulePoll();
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
      this.schedulePoll();
    } catch (error) {
      this.log.error(`Failed to set light: ${error}`);
      throw new this.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * Remember the last running speed (snapped to the supported table) and
   * persist it so a Homebridge restart resumes at the user's chosen speed.
   */
  private rememberCfm(cfm: number): void {
    const snapped = nearestAllowedCFM(cfm);
    if (snapped > 0 && snapped !== this.lastCfm) {
      this.lastCfm = snapped;
      this.accessory.context.lastCfm = snapped;
      this.homebridgeApi.updatePlatformAccessories([this.accessory]);
    }
  }

  // -- Polling --

  private pollIntervalMs(): number {
    const raw = Number(this.config.pollingInterval);
    const seconds = Number.isFinite(raw) && raw > 0
      ? Math.min(MAX_POLLING_INTERVAL, Math.max(MIN_POLLING_INTERVAL, raw))
      : DEFAULT_POLLING_INTERVAL;
    return seconds * 1000;
  }

  private startPolling(): void {
    const interval = this.pollIntervalMs();
    this.log.info(`Polling ${this.config.host} every ${interval / 1000}s`);
    this.pollState();
    this.pollTimer = setInterval(() => this.pollState(), interval);
  }

  /**
   * Reset the poll timer and poll soon after a command.
   * This avoids stacking an extra request on top of the command;
   * the serialized queue in SwidgetApi ensures only one request at a time.
   */
  private schedulePoll(): void {
    if (this.stopped) {
      return; // a set handler resolving after stopPolling must not restart timers
    }
    if (this.verifyTimer) {
      clearTimeout(this.verifyTimer);
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    // Poll 2 seconds after command to verify, then resume normal interval
    this.verifyTimer = setTimeout(() => {
      this.verifyTimer = undefined;
      this.pollState();
      this.pollTimer = setInterval(() => this.pollState(), this.pollIntervalMs());
    }, 2000);
  }

  stopPolling(): void {
    this.stopped = true;
    if (this.verifyTimer) {
      clearTimeout(this.verifyTimer);
      this.verifyTimer = undefined;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async pollState(): Promise<void> {
    if (this.polling || this.stopped) {
      return; // skip if previous poll is still in-flight or handler is retired
    }
    this.polling = true;

    try {
      const fullState = await this.api.getState();
      const component = fullState.host?.components?.['0'];
      if (!component || typeof component.exhaust?.cfm !== 'number') {
        throw new Error('Malformed state response');
      }
      this.state = component;

      // Successful poll: reset failure counter
      if (this.consecutiveFailures > 0) {
        this.log.debug(`Device ${this.config.host} recovered after ${this.consecutiveFailures} failed poll(s)`);
      }
      this.consecutiveFailures = 0;

      if (!this.reachable) {
        this.log.info(`Device ${this.config.host} is now reachable`);
      }
      this.reachable = true;

      if (this.state.exhaust.cfm > 0) {
        this.rememberCfm(this.state.exhaust.cfm);
      }

      this.updateCharacteristics();

      // Always On: if fan is off and always-on is enabled, turn on boost
      if (this.alwaysOn && this.state.exhaust.cfm === 0 && this.state.boost?.mode !== 'on') {
        this.log.info('Always On: fan is off, activating boost');
        this.api.setBoost(true).catch((err) => {
          this.log.warn(`Always On: failed to activate boost: ${err}`);
        });
      }

      this.log.debug(
        `Poll: cfm=${this.state.exhaust.cfm}, boost=${this.state.boost?.mode}, ` +
        `power=${this.state.power?.current}W, rssi=${fullState.connection?.rssi}dBm`,
      );
    } catch (error) {
      this.consecutiveFailures++;
      this.log.debug(`Poll failed for ${this.config.host} (${this.consecutiveFailures}/${SwidgetERVAccessory.FAILURE_THRESHOLD}): ${error}`);

      if (this.consecutiveFailures >= SwidgetERVAccessory.FAILURE_THRESHOLD && this.reachable) {
        this.log.warn(`Device ${this.config.host} is unreachable after ${this.consecutiveFailures} consecutive failures`);
        this.reachable = false;
      }
      // State is preserved from last successful poll; HomeKit keeps showing last known values
    } finally {
      this.polling = false;
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
      : this.hap.Characteristic.CurrentFanState.INACTIVE;

    if (this.fanService) {
      this.fanService.updateCharacteristic(this.hap.Characteristic.Active, active);
      this.fanService.updateCharacteristic(this.hap.Characteristic.RotationSpeed, cfmToPercent(cfm));
      this.fanService.updateCharacteristic(this.hap.Characteristic.CurrentFanState, fanState);
    }

    if (this.boostService) {
      this.boostService.updateCharacteristic(
        this.hap.Characteristic.On,
        this.state.boost?.mode === 'on',
      );
    }

    if (this.lightService) {
      this.lightService.updateCharacteristic(
        this.hap.Characteristic.On,
        this.state.light?.on ?? false,
      );
    }

    if (this.condensationService) {
      const condensation = this.state.modules?.condensation ?? 'dormant';
      this.condensationService.updateCharacteristic(
        this.hap.Characteristic.ContactSensorState,
        condensation !== 'dormant'
          ? this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED,
      );
    }
  }

  private ensureReachable(): void {
    if (!this.reachable || !this.state) {
      throw new this.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }
}
