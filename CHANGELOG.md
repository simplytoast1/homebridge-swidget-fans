# Changelog

## 1.0.11 (2026-07-05)

Stability, correctness, and packaging release based on a full code audit.

### Fixed

- Fan speed reporting: the lowest speed (50 CFM) reported 0% to HomeKit, so a running fan looked off and the lowest speed could not be selected from the slider. The mapping now uses one 10% step per supported speed (10% = 50 CFM up to 100% = 150 CFM), exactly as the README documents.
- The speed slider now moves in 10% steps that match the supported speeds, so it no longer visibly snaps to a different value a couple of seconds after each adjustment.
- A device that is offline when Homebridge starts is now retried once a minute and recovers automatically. Previously it stayed unavailable until Homebridge was restarted.
- Rapid commands (scenes, slider drags) could leak poll timers and permanently multiply the polling rate against the device. Timers are now tracked and cleaned up correctly.
- Last fan speed and the Always On setting now persist across Homebridge restarts: "turn the fan on" resumes at your last chosen speed, and Always On stays armed.
- Accessory data is now persisted immediately after setup, so an unclean shutdown can no longer cause a cached accessory to be wrongly removed on the next boot (which lost room, scene, and automation assignments).
- Invalid config entries (missing name, bad polling interval) and malformed device responses are now skipped with a warning instead of crashing Homebridge.
- Duplicate config entries pointing at the same physical device no longer leak a second poll loop.
- Renaming a device in the config now actually propagates the new name to HomeKit.
- The fan reports Off instead of Idle when stopped, and HomeKit clients no longer offer a nonfunctional Auto mode toggle.
- Status polls time out after 10 seconds (commands keep 15) so a stalled poll cannot delay a user command queued behind it for long.
- Naming a device "Boost", "Light", "Always On", or "Condensation" no longer collides with the plugin's switch and sensor services.
- Fan speeds reported by the device that are not in the supported table are snapped to the nearest supported speed instead of being dropped silently.

### Changed

- Devices are set up in parallel at startup, so one offline device no longer delays the others.
- Poll timers are stopped cleanly on Homebridge shutdown.
- The Homebridge UI now allows only one platform block (use the devices array for multiple fans), preventing accessory removal fights between multiple blocks.
- The npm package now ships only the compiled plugin and config schema, cutting the download size by about 90%.
- Added a unit test suite for the speed mapping, run in CI on every push.

## 1.0.10 (2026-05-03)

- Fix: cached accessories were unregistered when a device was unreachable at plugin startup, causing HomeKit to lose room/scene/automation assignments. Cleanup now keys off the configured host instead of the discovered UUID, so configured-but-unreachable devices keep their cached accessory.

## 1.0.9 (2026-03-15)

- Tolerate transient poll failures: a device is only marked unreachable after 3 consecutive failed polls instead of on the first failure.

## 1.0.8 (2026-03-14)

- Breaking: the condensation sensor changed from a leak sensor to a contact sensor. HomeKit automations tied to the old leak sensor need to be recreated against the new contact sensor.

## 1.0.7 (2026-03-14)

- Serialize all HTTP requests to the device so the ESP32 never handles more than one at a time.

## 1.0.6 (2026-03-13)

- Republish of 1.0.5 with no code changes.

## 1.0.5 (2026-03-13)

- Fix config schema: required fields are declared at the object level so the Homebridge UI validates them correctly.

## 1.0.4 (2026-03-13)

- Add Always On switch: automatically re-activates boost if the fan is detected off.

## 1.0.3 (2026-03-13)

- Rename plugin display name to Swidget ERV Fans.

## 1.0.2 (2026-03-13)

- Increase API timeout from 5s to 15s.
- Add enableFan option to hide the fan control from HomeKit.
- Remove the extra poll immediately after commands; the polling interval handles state updates.

## 1.0.1 (2026-03-13)

- Fix TypeScript build errors and the homebridge devDependency version range.

## 1.0.0 (2026-03-13)

Initial release.

- Fan speed control via HomeKit Fanv2 service with 10-step CFM mapping (50-150 CFM)
- Boost mode switch (full power on/off)
- Optional light switch (for installations with a wired light)
- Optional condensation leak sensor (triggers when condensation module activates)
- Configurable polling interval (5-300 seconds)
- Automatic device recovery when network connectivity is restored
- Homebridge Plugin Settings GUI support via config.schema.json
- Multi-device support
