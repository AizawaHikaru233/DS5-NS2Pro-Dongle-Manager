# Frontend Change Notes (2026-07-04)

## Summary

This update focuses on stabilizing the desktop manager's runtime device behavior, persisting button mappings to Pico flash, and normalizing Windows MSI artifact names.

## Changes

### Runtime device role split

- The frontend now treats the `DualSense runtime` device as the only editable configuration target.
- The `Pico management` device is now reserved for bridge/bootstrap tasks and no longer attempts to read or edit firmware config and button mappings during normal attachment.
- Auto-connect behavior now prefers the runtime `DualSense` path instead of opening the management device first.
- Settings actions and editable controls are gated to runtime-capable connections so the UI reflects whether the current connection can actually modify on-device state.

### Button mapping persistence

- DS5 and NS2Pro button mapping writes are now saved to Pico flash independently instead of being lost after app exit, device disconnect, or controller reconnect.
- The frontend now re-reads button mappings when attaching to a supported runtime device and during manual config refresh so the UI reflects the real persisted mapping state.

### Error notification cleanup

- The generic connection-time unknown error toast was traced to configuration and mapping reads being attempted on the wrong device role during runtime switching.
- Attachment flow now avoids unsupported config and mapping reads on the management device, reducing false error notifications during startup and controller connection events.

### MSI artifact naming

- Added a local packaging helper script at `scripts/build-msi.ps1`.
- Added `pnpm build:msi` to build the frontend, build the Tauri MSI bundle, and then normalize MSI filenames by removing locale suffixes such as `_en-US` and `_zh-CN`.
- Updated repository build instructions to use the new MSI packaging script.

## Touched areas

- `src/protocol/ds5BridgeHid.ts`
- `src/hooks/useDs5Bridge.ts`
- `src/components/ConfigPanel.tsx`
- `src/components/ButtonMappingPanel.tsx`
- `src/components/config/*`
- `src/App.tsx`
- `scripts/build-msi.ps1`
- `package.json`
- `README.md`
- `README.zh-CN.md`
