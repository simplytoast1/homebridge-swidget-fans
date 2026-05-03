# Changelog

## 1.0.10 (2026-05-03)

- Fix: cached accessories were unregistered when a device was unreachable at plugin startup, causing HomeKit to lose room/scene/automation assignments. Cleanup now keys off the configured host instead of the discovered UUID, so configured-but-unreachable devices keep their cached accessory.

## 1.0.0 (2026-03-13)

Initial release.

- Fan speed control via HomeKit Fanv2 service with 10-step CFM mapping (50–150 CFM)
- Boost mode switch (full power on/off)
- Optional light switch (for installations with a wired light)
- Optional condensation leak sensor (triggers when condensation module activates)
- Configurable polling interval (5–300 seconds)
- Automatic device recovery when network connectivity is restored
- Homebridge Plugin Settings GUI support via config.schema.json
- Multi-device support
