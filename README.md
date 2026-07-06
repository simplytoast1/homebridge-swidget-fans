<p align="center">
  <img src="branding/logo.png" width="300">
</p>

# homebridge-swidget-fans

Control your Swidget ERV Fans (Energy Recovery Ventilator) through Apple HomeKit using Homebridge. Everything runs locally over your LAN — no cloud, no account required.

## What This Plugin Does

This plugin talks directly to your Swidget ERV controller (pesna_fv05) over your local network and exposes it to HomeKit as a fan with speed control. You get:

- **Fan speed control** with a slider that maps to the device's supported CFM values
- **Boost mode** as a switch you can toggle from the Home app or with Siri
- **Always On mode** — a switch that automatically re-activates boost if it detects the fan has turned off
- **Light control** (if your installation has a light wired up)
- **Condensation alerts** via a contact sensor (if you want to know when the condensation module activates)

All of these are optional and can be shown or hidden in your config.

## Before You Start

You'll need to know the local IP address of your Swidget device. The easiest way to find this is through your router's admin page — look for a device with a hostname starting with "swidget" or a MAC address starting with `24:58:7C`.

Consider giving the device a static IP or DHCP reservation so the address doesn't change on you.

## Installation

### Homebridge UI (Recommended)

Search for **homebridge-swidget-fans** in the Homebridge UI plugin search and click install.

### Command Line

```
npm install -g homebridge-swidget-fans
```

## Configuration

### Using the Homebridge UI

After installing, go to the plugin settings in the Homebridge UI and add your device. The only required fields are a name and the IP address.

### Manual Configuration

Add this to the `platforms` array in your `config.json`:

```json
{
  "platform": "SwidgetERV",
  "name": "Swidget ERV",
  "devices": [
    {
      "name": "Bathroom ERV",
      "host": "192.168.1.100"
    }
  ]
}
```

### Configuration Options

| Option | Required | Default | Description |
|---|---|---|---|
| `name` | Yes | — | What you want to call this fan in HomeKit |
| `host` | Yes | — | Local IP address of the Swidget device |
| `accessKey` | No | — | Access key, if you set one during device provisioning |
| `pollingInterval` | No | `30` | How often (in seconds) to check the device for status updates. Range: 5–300 |
| `enableFan` | No | `true` | Show the fan speed control in HomeKit |
| `enableBoostSwitch` | No | `true` | Show the boost mode switch in HomeKit |
| `enableAlwaysOn` | No | `false` | Show an Always On switch — when on, automatically activates boost if the fan turns off |
| `enableLight` | No | `false` | Show the light switch in HomeKit. Only turn this on if your ERV actually has a light wired to it |
| `enableCondensationSensor` | No | `false` | Show a contact sensor that opens when the condensation module activates. Works well with HomeKit automations |

### Multiple Devices

You can add as many devices as you have. Each one gets its own entry in the `devices` array:

```json
{
  "platform": "SwidgetERV",
  "name": "Swidget ERV",
  "devices": [
    {
      "name": "Bathroom ERV",
      "host": "192.168.1.100"
    },
    {
      "name": "Laundry ERV",
      "host": "192.168.1.101",
      "pollingInterval": 15,
      "enableCondensationSensor": true
    }
  ]
}
```

## How Fan Speed Works

The Swidget ERV only supports specific airflow speeds (in CFM): 0, 50, 60, 70, 80, 90, 100, 110, 120, 130, and 150.

HomeKit gives you a 0–100% slider. The plugin maps the slider to the closest supported speed:

| Slider | Airflow |
|---|---|
| Off | 0 CFM |
| 10% | 50 CFM |
| 20% | 60 CFM |
| 30% | 70 CFM |
| 40% | 80 CFM |
| 50% | 90 CFM |
| 60% | 100 CFM |
| 70% | 110 CFM |
| 80% | 120 CFM |
| 90% | 130 CFM |
| 100% | 150 CFM |

You don't need to land exactly on these percentages — the plugin rounds to the nearest supported speed.

## Troubleshooting

**Fan shows "Not Responding" in the Home app**

The plugin can't reach the device. Check that:
- The IP address in your config is correct
- The device is powered on and connected to your network
- Your Homebridge server can reach the device (`ping 192.168.1.100` from the server)
- There's no firewall or VLAN isolation blocking the connection

The plugin keeps retrying and recovers automatically once the device is reachable again. If the device was already offline when Homebridge started, the plugin retries about once a minute until it comes online.

**Fan speed slider feels "sticky" or moves in steps**

This is normal. The slider moves in 10% steps, one for each of the ERV's 10 supported speeds. Automations can still request in-between values like 45%, which round to the nearest step (50%, 90 CFM).

**Light switch does nothing**

The light function is reported by the device hardware but may not be physically connected in your installation. If toggling the switch has no visible effect, set `enableLight` to `false` to hide it.

**What does the Boost switch do?**

Boost turns the fan on at full power (150 CFM). When you turn boost off, the fan turns off completely. Think of it as a "max power" button — useful for quickly clearing steam or odors. The fan speed slider will update to reflect the actual speed during the next poll.

**What does the Always On switch do?**

When Always On is enabled, the plugin monitors the fan on each poll. If it detects the fan has turned off (0 CFM), it automatically sends a boost command to turn it back on at full power. This is useful if you want the ERV running continuously and don't want it to stay off if someone or something turns it off. Toggle the switch off in HomeKit to disable this behavior. The Always On setting is remembered across Homebridge restarts.

## Supported Hardware

This plugin is built for the Swidget ERV controller:

- **Model:** FAN_PICO_S3 (ESP32-S3 based)
- **Host type:** pesna_fv05
- **Insert type:** control

Other Swidget devices (dimmers, outlets, etc.) are not supported by this plugin.

## License

MIT
