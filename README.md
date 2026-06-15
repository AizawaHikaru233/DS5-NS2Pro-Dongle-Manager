# DS5 NS2Pro Dongle Manager

[简体中文](README.zh-CN.md)

Desktop manager for [DS5_NS2Pro_Dongle](https://github.com/AizawaHikaru233/DS5_NS2Pro_Dongle). It is a Tauri + React application used to configure the Pico firmware, inspect connection status, manage NS2Pro pairing, and forward wired NS2Pro input when the firmware needs a PC-side bridge.

## Install

1. Download the latest `DS5 NS2Pro Dongle Manager_*.msi` from [Releases](https://github.com/AizawaHikaru233/DS5-NS2Pro-Dongle-Manager/releases).
2. Install the MSI.
3. Flash the matching firmware from the firmware repository.
4. Connect the Pico dongle and open the manager.

## What This App Does

- Shows Pico firmware version, signal and controller connection state.
- Sends firmware configuration through the Pico manager HID protocol.
- Starts NS2Pro wired pairing and NS2Pro Bluetooth pairing flows.
- Keeps NS2Pro-specific settings separated from DS5 settings where the firmware exposes separate behavior.
- Provides a minimal PC-side bridge for wired NS2Pro input when needed.

## Difference From DS5Dongle

This repository is not a replacement frontend for upstream DS5Dongle. It is a manager for the DS5 + NS2Pro fork:

- Upstream DS5Dongle focuses on making a DualSense controller appear as a wired DualSense through a Pico.
- This project also supports NS2Pro input translated to a DualSense-compatible USB device.
- NS2Pro input, gyro, rumble style, pairing and profile behavior are managed separately from the original DS5 path as much as the firmware allows.
- The desktop app stays lightweight; DS5 report generation, NS2Pro translation, gyro calibration and haptic conversion are handled in firmware.

## Build Requirements

- Windows 10/11
- Node.js 24
- pnpm 11
- Rust stable MSVC toolchain
- Visual Studio Build Tools or Visual Studio with C++ build tools
- WebView2 Runtime

## Build

```powershell
pnpm install
pnpm build
pnpm tauri build --bundles msi
```

The MSI is written to:

```text
src-tauri/target/release/bundle/msi/
```

## One-Click Release

GitHub Actions includes `Release manager`.

1. Open Actions.
2. Select `Release manager`.
3. Run workflow.
4. Enter a version such as `1.0.0`.

The workflow creates or updates release tag `v1.0.0`, builds the Windows MSI, and uploads it to the GitHub Release.

## References

- Firmware: [AizawaHikaru233/DS5_NS2Pro_Dongle](https://github.com/AizawaHikaru233/DS5_NS2Pro_Dongle)
- Original manager base: [GooGuJiang/ds5dongle-manager](https://github.com/GooGuJiang/ds5dongle-manager)
- Original firmware base: [awalol/DS5Dongle](https://github.com/awalol/DS5Dongle)
- NS2Pro bridge reference: [LeonChrome/y700-switch2-pro-bridge](https://github.com/LeonChrome/y700-switch2-pro-bridge)

## License

MIT. Attribution is kept for code derived from upstream projects.
