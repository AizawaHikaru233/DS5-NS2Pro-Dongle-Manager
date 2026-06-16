import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ConfigBody,
  ConfigDecodeError,
  DEFAULT_CONFIG,
  ConfigValidationIssue,
  configsEqual,
  normalizeConfig,
  validateConfig,
} from "../protocol/config";
import {
  Ds5BridgeHidClient,
  NO_DEVICE_SELECTED_ERROR,
  Ns2ProBleState,
  Ns2ProRumbleDebug,
  PicoInputOwner,
  PICO_MANAGER_PRODUCT_ID,
  PICO_MANAGER_VENDOR_ID,
  TauriHidDeviceInfo,
  WEBHID_UNAVAILABLE_ERROR,
  getControllerIconSrc,
  getDeviceLabel,
  isAutoConnectCandidate,
  getDeviceKey,
  getDevicePortKey,
  startDeviceMonitor,
  tauriDeviceInfosToHidDevices,
  webHidAvailable,
} from "../protocol/ds5BridgeHid";
import {
  DEFAULT_DS5_BUTTON_MAPPING,
  DEFAULT_NS2PRO_BUTTON_MAPPING,
  ds5MappingsEqual,
  ns2ProMappingsEqual,
  type ButtonMappingTarget,
  type Ds5ButtonMapping,
  type Ds5MappingInput,
  type Ns2ProButtonMapping,
  type Ns2ProMappingInput,
} from "../protocol/buttonMapping";

type Operation = "connecting" | "reading" | "applying" | "saving" | "reconnecting" | null;
type SaveState = "idle" | "dirty" | "applied" | "saved";
type UsbEffectiveConfig = Pick<ConfigBody, "pollingRateMode" | "controllerMode">;
type PicoInputMode = "DS" | "NS2Pro" | "--";
type PicoInputOwnerState = PicoInputOwner | "--";
type Ns2ProPairingPhase = "inactive" | "waiting" | "paired" | "error";
const BATTERY_REFRESH_INTERVAL_MS = 60_000;
const DEVICE_DISCOVERY_FALLBACK_INTERVAL_MS = 30_000;
const PICO_INFO_REFRESH_INTERVAL_MS = 1_000;
const NS2PRO_PAIRING_STATUS_REFRESH_INTERVAL_MS = 1_000;
const CONNECTED_DEVICE_MISSING_GRACE_MS = 3_000;
const NS2PRO_DISCONNECT_GRACE_MS = 2_000;
const NS2PRO_PAIRING_DISCONNECT_GRACE_MS = 5_000;
const CONTROLLER_CONNECTION_NOTIFICATION_STABLE_MS = 900;
const BATTERY_LISTEN_TIMEOUT_MS = 300;
const AUTHORIZED_DEVICE_INFO_REFRESH_INTERVAL_MS = 5 * 60_000;
const SWITCH_RECONNECT_WINDOW_MS = 30_000;
const LOW_BATTERY_THRESHOLD_PERCENT = 15;
const AUTO_CONNECT_RETRY_COOLDOWN_MS = 10_000;
const NS2PRO_BLE_MANUAL_PAIRING_HOLD_MS = 10_000;
const NS2PRO_STICK_CALIBRATION_PENDING_ERROR = 0x41;
const NS2PRO_STICK_CALIBRATION_FAILED_ERROR = 0x42;
const NS2PRO_BLE_PAIRING_COMMAND_FAILED_ERROR = 253;
const NS2PRO_BLE_PICO_NOT_CONNECTED_ERROR = 254;
const REPORT_SET_CONFIG = 0xf6;
const CMD_NS2PRO_BLE_START_PAIRING = 0x40;

export type ControllerNotificationSound = "connected" | "disconnected" | "lowBattery";

export interface ControllerNotificationSoundVolumes {
  connected: number;
  disconnected: number;
  lowBattery: number;
}

export interface UseDs5BridgeResult {
  supported: boolean;
  client: Ds5BridgeHidClient | null;
  deviceLabel: string;
  deviceSerialNumber: string;
  batteryText: string;
  ns2proBatteryText: string;
  firmwareVersion: string;
  signalStrength: string;
  inputMode: PicoInputMode;
  inputOwner: PicoInputOwnerState;
  inputOwnerPolicy: PicoInputOwnerState;
  ds5Connected: boolean;
  ns2proConnected: boolean;
  ns2proBleState: Ns2ProBleState;
  ns2proBleLastError: number;
  ns2proBleHasBond: boolean;
  ns2proRumbleDebug: Ns2ProRumbleDebug | null;
  ns2ProPhysicalPathPresent: boolean;
  ns2ProPairing: Ns2ProPairingStatus;
  authorizedDeviceSerialNumber: Record<string, string>;
  authorizedDeviceBatteryText: Record<string, string>;
  authorizedDeviceFirmwareVersion: Record<string, string>;
  authorizedDeviceSignalStrength: Record<string, string>;
  authorizedDevices: HIDDevice[];
  config: ConfigBody | null;
  draft: ConfigBody;
  issues: ConfigValidationIssue[];
  saveState: SaveState;
  operation: Operation;
  error: string | null;
  statusText: string;
  shouldReturnHome: boolean;
  shouldReturnHomeRef: RefObject<boolean>;
  isConnected: boolean;
  isDirty: boolean;
  isDefaultConfig: boolean;
  needsUsbReconnect: boolean;
  pendingUsbReconnectPrompt: boolean;
  lowBatteryNotificationEnabled: boolean;
  controllerConnectionPopupEnabled: boolean;
  controllerLowBatteryPopupEnabled: boolean;
  controllerNotificationPopupDurationMs: number;
  controllerNotificationSoundEnabled: boolean;
  controllerNotificationSoundVolumes: ControllerNotificationSoundVolumes;
  switchReadyToken: number;
  connectedControllerProductId: number | null;
  ds5ButtonMapping: Ds5ButtonMapping | null;
  ds5ButtonMappingDraft: Ds5ButtonMapping;
  ns2proButtonMapping: Ns2ProButtonMapping | null;
  ns2proButtonMappingDraft: Ns2ProButtonMapping;
  setDraftField: <Key extends keyof ConfigBody>(field: Key, value: ConfigBody[Key]) => void;
  setDs5ButtonMappingField: (field: Ds5MappingInput, value: ButtonMappingTarget) => void;
  setNs2ProButtonMappingField: (field: Ns2ProMappingInput, value: ButtonMappingTarget) => void;
  setLowBatteryNotificationEnabled: (enabled: boolean) => Promise<void>;
  setControllerConnectionPopupEnabled: (enabled: boolean) => Promise<void>;
  setControllerLowBatteryPopupEnabled: (enabled: boolean) => Promise<void>;
  setControllerNotificationPopupDurationMs: (durationMs: number) => Promise<void>;
  setControllerNotificationSoundEnabled: (enabled: boolean) => Promise<void>;
  setControllerNotificationSoundVolume: (sound: ControllerNotificationSound, volume: number) => Promise<void>;
  setInputOwner: (owner: PicoInputOwner) => Promise<void>;
  resetControllerNotificationSoundVolumes: () => Promise<void>;
  testLowBatteryNotification: () => Promise<void>;
  testControllerNotificationSound: (sound: ControllerNotificationSound) => Promise<void>;
  refreshAuthorizedDevices: () => Promise<void>;
  connect: () => Promise<void>;
  connectAuthorized: (device: HIDDevice) => Promise<void>;
  readConfig: () => Promise<void>;
  saveToFlash: () => Promise<void>;
  reconnectUsb: () => Promise<void>;
  applyPendingUsbReconnect: () => Promise<void>;
  dismissPendingUsbReconnectPrompt: () => void;
  retryNs2ProPairing: () => Promise<void>;
  startNs2ProBlePairing: () => Promise<void>;
  calibrateNs2ProStickCenter: () => Promise<boolean>;
  resetToDefaults: () => Promise<void>;
  clearReturnHome: () => void;
  clearError: () => void;
}

export function useDs5Bridge(): UseDs5BridgeResult {
  const { t, i18n } = useTranslation();
  const supported = webHidAvailable();
  const [client, setClient] = useState<Ds5BridgeHidClient | null>(null);
  const [authorizedDevices, setAuthorizedDevices] = useState<HIDDevice[]>([]);
  const [config, setConfig] = useState<ConfigBody | null>(null);
  const [draft, setDraft] = useState<ConfigBody>(DEFAULT_CONFIG);
  const [operation, setOperation] = useState<Operation>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [needsUsbReconnect, setNeedsUsbReconnect] = useState(false);
  const [pendingUsbReconnectPrompt, setPendingUsbReconnectPrompt] = useState(false);
  const [lowBatteryNotificationEnabled, setLowBatteryNotificationEnabledState] = useState(true);
  const [controllerConnectionPopupEnabled, setControllerConnectionPopupEnabledState] = useState(true);
  const [controllerLowBatteryPopupEnabled, setControllerLowBatteryPopupEnabledState] = useState(true);
  const [controllerNotificationPopupDurationMs, setControllerNotificationPopupDurationMsState] = useState(4_000);
  const [controllerNotificationSoundEnabled, setControllerNotificationSoundEnabledState] = useState(true);
  const [controllerNotificationSoundVolumes, setControllerNotificationSoundVolumes] = useState<ControllerNotificationSoundVolumes>(DEFAULT_CONTROLLER_NOTIFICATION_SOUND_VOLUMES);
  const [shouldReturnHome, setShouldReturnHome] = useState(false);
  const shouldReturnHomeRef = useRef(false);
  const [switchReadyToken, setSwitchReadyToken] = useState(0);
  const [connectedControllerProductId, setConnectedControllerProductId] = useState<number | null>(null);
  const [batteryText, setBatteryText] = useState("--");
  const [ns2proBatteryText, setNs2proBatteryText] = useState("--");
  const [firmwareVersion, setFirmwareVersion] = useState("--");
  const [signalStrength, setSignalStrength] = useState("--");
  const [inputMode, setInputMode] = useState<PicoInputMode>("--");
  const [inputOwner, setInputOwnerState] = useState<PicoInputOwnerState>("--");
  const [inputOwnerPolicy, setInputOwnerPolicyState] = useState<PicoInputOwnerState>("--");
  const [ds5Connected, setDs5Connected] = useState(false);
  const [ns2proConnected, setNs2proConnected] = useState(false);
  const [ns2proBleState, setNs2proBleState] = useState<Ns2ProBleState>("Disabled");
  const [ns2proBleLastError, setNs2proBleLastError] = useState(0);
  const [ns2proBleHasBond, setNs2proBleHasBond] = useState(false);
  const [ns2proRumbleDebug, setNs2proRumbleDebug] = useState<Ns2ProRumbleDebug | null>(null);
  const [ds5ButtonMapping, setDs5ButtonMapping] = useState<Ds5ButtonMapping | null>(null);
  const [ds5ButtonMappingDraft, setDs5ButtonMappingDraft] = useState<Ds5ButtonMapping>(DEFAULT_DS5_BUTTON_MAPPING);
  const [ns2proButtonMapping, setNs2proButtonMapping] = useState<Ns2ProButtonMapping | null>(null);
  const [ns2proButtonMappingDraft, setNs2proButtonMappingDraft] = useState<Ns2ProButtonMapping>(DEFAULT_NS2PRO_BUTTON_MAPPING);
  const [ns2ProPhysicalPathPresent, setNs2ProPhysicalPathPresent] = useState(false);
  const [ns2ProPairing, setNs2ProPairing] = useState<Ns2ProPairingStatus>(inactiveNs2ProPairingStatus());
  const [deviceSerialNumber, setDeviceSerialNumber] = useState("--");
  const [authorizedDeviceSerialNumber, setAuthorizedDeviceSerialNumber] = useState<Record<string, string>>({});
  const [authorizedDeviceBatteryText, setAuthorizedDeviceBatteryText] = useState<Record<string, string>>({});
  const [authorizedDeviceFirmwareVersion, setAuthorizedDeviceFirmwareVersion] = useState<Record<string, string>>({});
  const [authorizedDeviceSignalStrength, setAuthorizedDeviceSignalStrength] = useState<Record<string, string>>({});
  const [settledStatusText, setSettledStatusText] = useState(t("status.ready"));
  const clientRef = useRef<Ds5BridgeHidClient | null>(null);
  const batteryTextRef = useRef("--");
  const firmwareVersionRef = useRef("--");
  const signalStrengthRef = useRef("--");
  const inputModeRef = useRef<PicoInputMode>("--");
  const inputOwnerRef = useRef<PicoInputOwnerState>("--");
  const ns2proConnectedRef = useRef(false);
  const ns2ProPairingRef = useRef<Ns2ProPairingStatus>(inactiveNs2ProPairingStatus());
  const ns2ProPresenceGraceRef = useRef<Ns2ProPairingPresenceGrace>({ picoUntil: 0, ns2proUntil: 0 });
  const deviceSerialNumberRef = useRef("--");
  const configRef = useRef<ConfigBody | null>(null);
  const draftRef = useRef<ConfigBody>(DEFAULT_CONFIG);
  const ds5ButtonMappingRef = useRef<Ds5ButtonMapping | null>(null);
  const ds5ButtonMappingDraftRef = useRef<Ds5ButtonMapping>(DEFAULT_DS5_BUTTON_MAPPING);
  const ns2proButtonMappingRef = useRef<Ns2ProButtonMapping | null>(null);
  const ns2proButtonMappingDraftRef = useRef<Ns2ProButtonMapping>(DEFAULT_NS2PRO_BUTTON_MAPPING);
  const usbEffectiveConfigRef = useRef<UsbEffectiveConfig | null>(null);
  const applyingRef = useRef(false);
  const applyQueuedRef = useRef(false);
  const autoSaveTimerRef = useRef<number | null>(null);
  const mappingApplyQueuedRef = useRef(false);
  const mappingApplyingRef = useRef(false);
  const mappingAutoSaveTimerRef = useRef<number | null>(null);
  const mappingDirtyRef = useRef(false);
  const savedStatusTimerRef = useRef<number | null>(null);
  const expectedUsbDisconnectRef = useRef(false);
  const requireManualSelectionRef = useRef(false);
  const autoConnectDeviceKeyRef = useRef<string | null>(null);
  const reconnectingDevicePortKeyRef = useRef<string | null>(null);
  const reconnectingDeviceTimeoutRef = useRef<number | null>(null);
  const pendingUsbReconnectDevicePortKeyRef = useRef<string | null>(null);
  const autoConnectInFlightKeyRef = useRef<string | null>(null);
  const failedAutoConnectAtRef = useRef<Record<string, number>>({});
  const pendingDisconnectDeviceKeyRef = useRef<string | null>(null);
  const pendingDisconnectTimerRef = useRef<number | null>(null);
  const authorizedDeviceInfoScanIdRef = useRef(0);
  const pendingChangedFieldsRef = useRef<Set<keyof ConfigBody>>(new Set());
  const windowVisibleRef = useRef(typeof document === "undefined" ? true : document.visibilityState === "visible");
  const lowBatteryNotificationEnabledRef = useRef(true);
  const controllerConnectionPopupEnabledRef = useRef(true);
  const controllerLowBatteryPopupEnabledRef = useRef(true);
  const controllerNotificationPopupDurationMsRef = useRef(4_000);
  const lowBatteryNotifiedKeyRef = useRef<Set<string>>(new Set());
  const controllerNotificationSoundEnabledRef = useRef(true);
  const controllerNotificationSoundVolumesRef = useRef<ControllerNotificationSoundVolumes>(DEFAULT_CONTROLLER_NOTIFICATION_SOUND_VOLUMES);
  const suppressNextConnectSoundRef = useRef(false);
  const realControllerConnectedRef = useRef(false);
  const notifiedControllerConnectedRef = useRef(false);
  const controllerNotificationTimerRef = useRef<number | null>(null);
  const ns2ProEverReadyRef = useRef(false);
  const ns2ProBlePairingRequestedUntilRef = useRef(0);
  const ns2ProPhysicalPathPresentRef = useRef(false);
  const lastTrayBatteriesSignatureRef = useRef("");

  const issues = useMemo(() => validateConfig(draft), [draft]);
  const isConnected = Boolean(client?.device.opened);
  const isDirty = !configsEqual(config, draft);
  const isDefaultConfig = configsEqual(draft, DEFAULT_CONFIG);
  const deviceLabel = getDeviceLabel(client?.device ?? null);

  const statusText = useMemo(() => {
    if (!supported) {
      return t("status.webHidUnavailable");
    }
    if (operation) {
      return operationLabel(operation, t);
    }
    if (!client) {
      return t("status.ready");
    }
    if (saveState === "applied") {
      return t("status.applied");
    }
    if (saveState === "saved") {
      return t("status.saved");
    }
    return t("status.connected");
  }, [client, operation, saveState, supported, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSettledStatusText(statusText), 120);
    return () => window.clearTimeout(timer);
  }, [statusText]);

  useEffect(() => {
    batteryTextRef.current = batteryText;
  }, [batteryText]);

  useEffect(() => {
    firmwareVersionRef.current = firmwareVersion;
  }, [firmwareVersion]);

  useEffect(() => {
    signalStrengthRef.current = signalStrength;
  }, [signalStrength]);

  useEffect(() => {
    inputModeRef.current = inputMode;
  }, [inputMode]);

  useEffect(() => {
    inputOwnerRef.current = inputOwner;
  }, [inputOwner]);

  useEffect(() => {
    ns2proConnectedRef.current = ns2proConnected;
  }, [ns2proConnected]);

  const setVisibleNs2proBleState = useCallback((nextState: Ns2ProBleState) => {
    const pairingHoldActive = Date.now() < ns2ProBlePairingRequestedUntilRef.current;
    if (pairingHoldActive && (nextState === "Disabled" || nextState === "Idle")) {
      setNs2proBleState("PairingRequested");
      return;
    }

    if (nextState !== "PairingRequested" && nextState !== "Scanning" && nextState !== "Connecting" && nextState !== "Initializing") {
      ns2ProBlePairingRequestedUntilRef.current = 0;
    }
    setNs2proBleState(nextState);
    if (nextState === "Ready") {
      setError(null);
    }
  }, []);

  useEffect(() => {
    ns2ProPairingRef.current = ns2ProPairing;
  }, [ns2ProPairing]);

  useEffect(() => {
    deviceSerialNumberRef.current = deviceSerialNumber;
  }, [deviceSerialNumber]);

  useEffect(() => {
    ds5ButtonMappingRef.current = ds5ButtonMapping;
  }, [ds5ButtonMapping]);

  useEffect(() => {
    ds5ButtonMappingDraftRef.current = ds5ButtonMappingDraft;
  }, [ds5ButtonMappingDraft]);

  useEffect(() => {
    ns2proButtonMappingRef.current = ns2proButtonMapping;
  }, [ns2proButtonMapping]);

  useEffect(() => {
    ns2proButtonMappingDraftRef.current = ns2proButtonMappingDraft;
  }, [ns2proButtonMappingDraft]);

  const setAuthorizedDevicesIfChanged = useCallback((nextDevices: HIDDevice[]) => {
    setAuthorizedDevices((currentDevices) => devicesEqual(currentDevices, nextDevices) ? currentDevices : nextDevices);
  }, []);

  const refreshAuthorizedDevices = useCallback(async () => {
    if (!supported) {
      setAuthorizedDevicesIfChanged([]);
      return;
    }

    setAuthorizedDevicesIfChanged(await Ds5BridgeHidClient.authorizedDevices());
  }, [setAuthorizedDevicesIfChanged, supported]);

  const scanAuthorizedDeviceInfo = useCallback(async (devices: HIDDevice[]) => {
    const scanId = authorizedDeviceInfoScanIdRef.current + 1;
    authorizedDeviceInfoScanIdRef.current = scanId;

    const entries = devices.map((device) => [
      getDeviceKey(device),
      clientRef.current?.device === device
        ? {
          batteryText: batteryTextRef.current,
          serialNumber: deviceSerialNumberRef.current,
          firmwareVersion: firmwareVersionRef.current,
          signalStrength: signalStrengthRef.current,
        }
        : {
          batteryText: authorizedDeviceBatteryText[getDeviceKey(device)] ?? "--",
          serialNumber: authorizedDeviceSerialNumber[getDeviceKey(device)] ?? device.serialNumber?.trim() ?? "--",
          firmwareVersion: authorizedDeviceFirmwareVersion[getDeviceKey(device)] ?? "--",
          signalStrength: authorizedDeviceSignalStrength[getDeviceKey(device)] ?? "--",
        },
    ] as const);

    if (authorizedDeviceInfoScanIdRef.current !== scanId) {
      return;
    }

    setAuthorizedDeviceBatteryText((current) => replaceRecordIfChanged(current, Object.fromEntries(entries.map(([key, value]) => [key, value.batteryText]))));
    setAuthorizedDeviceSerialNumber((current) => replaceRecordIfChanged(current, Object.fromEntries(entries.map(([key, value]) => [key, value.serialNumber]))));
    setAuthorizedDeviceFirmwareVersion((current) => replaceRecordIfChanged(current, Object.fromEntries(entries.map(([key, value]) => [key, value.firmwareVersion]))));
    setAuthorizedDeviceSignalStrength((current) => replaceRecordIfChanged(current, Object.fromEntries(entries.map(([key, value]) => [key, value.signalStrength]))));
  }, [authorizedDeviceBatteryText, authorizedDeviceFirmwareVersion, authorizedDeviceSerialNumber, authorizedDeviceSignalStrength]);

  const readConfigWithClient = useCallback(async (nextClient: Ds5BridgeHidClient, syncUsbEffectiveConfig = false) => {
    setOperation("reading");
    try {
      const nextConfig = normalizeConfig(await nextClient.readConfig());
      configRef.current = nextConfig;
      draftRef.current = nextConfig;
      if (syncUsbEffectiveConfig) {
        usbEffectiveConfigRef.current = pickUsbEffectiveConfig(nextConfig);
        setNeedsUsbReconnect(false);
      }
      setConfig(nextConfig);
      setDraft(nextConfig);
      setSaveState("idle");
      setError(null);
      return nextConfig;
    } finally {
      setOperation(null);
    }
  }, []);

  const readButtonMappingsWithClient = useCallback(async (nextClient: Ds5BridgeHidClient) => {
    const [nextDs5Mapping, nextNs2ProMapping] = await Promise.all([
      nextClient.readDs5ButtonMapping(),
      nextClient.readNs2ProButtonMapping(),
    ]);

    ds5ButtonMappingRef.current = nextDs5Mapping;
    ds5ButtonMappingDraftRef.current = nextDs5Mapping;
    ns2proButtonMappingRef.current = nextNs2ProMapping;
    ns2proButtonMappingDraftRef.current = nextNs2ProMapping;
    setDs5ButtonMapping(nextDs5Mapping);
    setDs5ButtonMappingDraft(nextDs5Mapping);
    setNs2proButtonMapping(nextNs2ProMapping);
    setNs2proButtonMappingDraft(nextNs2ProMapping);
    mappingDirtyRef.current = false;
  }, []);

  const clearReconnectTracking = useCallback(() => {
    reconnectingDevicePortKeyRef.current = null;
    if (reconnectingDeviceTimeoutRef.current !== null) {
      window.clearTimeout(reconnectingDeviceTimeoutRef.current);
      reconnectingDeviceTimeoutRef.current = null;
    }
  }, []);

  const cancelPendingConnectedDeviceDisconnect = useCallback(() => {
    pendingDisconnectDeviceKeyRef.current = null;
    if (pendingDisconnectTimerRef.current !== null) {
      window.clearTimeout(pendingDisconnectTimerRef.current);
      pendingDisconnectTimerRef.current = null;
    }
  }, []);

  const clearConnectedDevice = useCallback((options: { preserveConfig?: boolean; preserveReconnectTracking?: boolean } = {}) => {
    const preserveNs2ProBridge =
      options.preserveReconnectTracking ||
      ns2ProPhysicalPathPresentRef.current ||
      Boolean(ns2ProPairingRef.current.ns2proPath);

    clientRef.current = null;
    usbEffectiveConfigRef.current = null;
    autoConnectDeviceKeyRef.current = null;
    cancelPendingConnectedDeviceDisconnect();
    setClient(null);
    setConnectedControllerProductId(null);

    if (!preserveNs2ProBridge) {
      clearReconnectTracking();
    }

    if (!options.preserveConfig && !shouldReturnHomeRef.current) {
      configRef.current = null;
      draftRef.current = DEFAULT_CONFIG;
      setConfig(null);
      setDraft(DEFAULT_CONFIG);
      setSaveState("idle");
      ds5ButtonMappingRef.current = null;
      ds5ButtonMappingDraftRef.current = DEFAULT_DS5_BUTTON_MAPPING;
      ns2proButtonMappingRef.current = null;
      ns2proButtonMappingDraftRef.current = DEFAULT_NS2PRO_BUTTON_MAPPING;
      setDs5ButtonMapping(null);
      setDs5ButtonMappingDraft(DEFAULT_DS5_BUTTON_MAPPING);
      setNs2proButtonMapping(null);
      setNs2proButtonMappingDraft(DEFAULT_NS2PRO_BUTTON_MAPPING);
      mappingDirtyRef.current = false;
    }

    setNeedsUsbReconnect(false);
    setPendingUsbReconnectPrompt(false);
    pendingUsbReconnectDevicePortKeyRef.current = null;
    setBatteryText("--");
    setNs2proBatteryText("--");
    setFirmwareVersion("--");
    setSignalStrength("--");
    setInputMode("--");
    setInputOwnerState("--");
    setInputOwnerPolicyState("--");
    setDs5Connected(false);
    setNs2proBleState("Disabled");
    setNs2proBleLastError(0);
    setNs2proBleHasBond(false);
    setNs2proRumbleDebug(null);
    if (!preserveNs2ProBridge) {
      setNs2proConnected(false);
      ns2ProPhysicalPathPresentRef.current = false;
      setNs2ProPhysicalPathPresent(false);
    }
    setDeviceSerialNumber("--");
    if (!preserveNs2ProBridge) {
      void invoke("ds5_stop_ns2pro_pico_bridge").catch(() => undefined);
    }
  }, [cancelPendingConnectedDeviceDisconnect, clearReconnectTracking]);

  const setLowBatteryNotificationEnabled = useCallback(async (enabled: boolean) => {
    lowBatteryNotificationEnabledRef.current = enabled;
    setLowBatteryNotificationEnabledState(enabled);

    if (!enabled) {
      lowBatteryNotifiedKeyRef.current.clear();
    }

    await invoke("ds5_set_low_battery_notification_enabled", { enabled });
  }, []);

  const setControllerConnectionPopupEnabled = useCallback(async (enabled: boolean) => {
    controllerConnectionPopupEnabledRef.current = enabled;
    setControllerConnectionPopupEnabledState(enabled);
    await invoke("ds5_set_controller_connection_popup_enabled", { enabled });
  }, []);

  const setControllerLowBatteryPopupEnabled = useCallback(async (enabled: boolean) => {
    controllerLowBatteryPopupEnabledRef.current = enabled;
    setControllerLowBatteryPopupEnabledState(enabled);
    await invoke("ds5_set_controller_low_battery_popup_enabled", { enabled });
  }, []);

  const setControllerNotificationPopupDurationMs = useCallback(async (durationMs: number) => {
    const normalizedDurationMs = normalizePopupDurationMs(durationMs);
    controllerNotificationPopupDurationMsRef.current = normalizedDurationMs;
    setControllerNotificationPopupDurationMsState(normalizedDurationMs);

    await invoke<number>("ds5_set_controller_notification_popup_duration_ms", { durationMs: normalizedDurationMs })
      .then((nextDurationMs) => {
        const normalizedNextDurationMs = normalizePopupDurationMs(nextDurationMs);
        controllerNotificationPopupDurationMsRef.current = normalizedNextDurationMs;
        setControllerNotificationPopupDurationMsState(normalizedNextDurationMs);
      })
      .catch(() => undefined);
  }, []);

  const setControllerNotificationSoundEnabled = useCallback(async (enabled: boolean) => {
    controllerNotificationSoundEnabledRef.current = enabled;
    setControllerNotificationSoundEnabledState(enabled);
    await invoke("ds5_set_controller_notification_sound_enabled", { enabled });
  }, []);

  const setControllerNotificationSoundVolume = useCallback(async (sound: ControllerNotificationSound, volume: number) => {
    const nextVolumes = {
      ...controllerNotificationSoundVolumesRef.current,
      [sound]: normalizeNotificationVolume(volume),
    };
    controllerNotificationSoundVolumesRef.current = nextVolumes;
    setControllerNotificationSoundVolumes(nextVolumes);

    await invoke<ControllerNotificationSoundVolumes>("ds5_set_controller_notification_sound_volume", { sound, volume: nextVolumes[sound] })
      .then((volumes) => {
        const normalizedVolumes = normalizeNotificationVolumes(volumes);
        controllerNotificationSoundVolumesRef.current = normalizedVolumes;
        setControllerNotificationSoundVolumes(normalizedVolumes);
      })
      .catch(() => undefined);
  }, []);

  const resetControllerNotificationSoundVolumes = useCallback(async () => {
    controllerNotificationSoundVolumesRef.current = DEFAULT_CONTROLLER_NOTIFICATION_SOUND_VOLUMES;
    setControllerNotificationSoundVolumes(DEFAULT_CONTROLLER_NOTIFICATION_SOUND_VOLUMES);

    await invoke<ControllerNotificationSoundVolumes>("ds5_reset_controller_notification_sound_volumes")
      .then((volumes) => {
        const normalizedVolumes = normalizeNotificationVolumes(volumes);
        controllerNotificationSoundVolumesRef.current = normalizedVolumes;
        setControllerNotificationSoundVolumes(normalizedVolumes);
      })
      .catch(() => undefined);
  }, []);

  const playControllerNotificationSound = useCallback(async (sound: ControllerNotificationSound) => {
    if (!controllerNotificationSoundEnabledRef.current || controllerNotificationSoundVolumesRef.current[sound] <= 0) {
      return;
    }

    await invoke("ds5_play_controller_notification_sound", { sound }).catch(() => undefined);
  }, []);

  const showControllerConnectionNotification = useCallback((
    kind: "connected" | "disconnected",
    deviceLabel: string,
    batteryText: string,
    batteryTexts: string[],
  ) => {
    if (!controllerConnectionPopupEnabledRef.current) {
      return;
    }

    void invoke("ds5_show_controller_notification", {
      kind,
      deviceLabel,
      iconSrc: null,
      batteryText,
      batteryTexts,
      durationMs: controllerNotificationPopupDurationMsRef.current,
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const ns2ProReady = ns2proBleState === "Ready" || (ns2proConnected && isNs2ProPairingReady(ns2ProPairing));
    if (ns2ProReady) {
      ns2ProEverReadyRef.current = true;
    }
    const ns2ProPhysicalConnected = ns2ProEverReadyRef.current && ns2ProPhysicalPathPresent;
    if (!ns2ProPhysicalConnected && !ns2ProReady) {
      ns2ProEverReadyRef.current = false;
    }
    const ns2ProRealConnected = ns2ProReady || ns2ProPhysicalConnected;
    const nextRealConnected = ds5Connected || ns2ProRealConnected;
    realControllerConnectedRef.current = nextRealConnected;

    if (controllerNotificationTimerRef.current !== null) {
      window.clearTimeout(controllerNotificationTimerRef.current);
      controllerNotificationTimerRef.current = null;
    }

    if (nextRealConnected === notifiedControllerConnectedRef.current) {
      return;
    }

    const expectedConnected = nextRealConnected;
    const deviceLabel = ns2ProRealConnected ? "NS2Pro Controller" : "DualSense Wireless Controller";
    const battery = ns2ProRealConnected ? ns2proBatteryText : batteryText;

    controllerNotificationTimerRef.current = window.setTimeout(() => {
      controllerNotificationTimerRef.current = null;
      if (realControllerConnectedRef.current !== expectedConnected || notifiedControllerConnectedRef.current === expectedConnected) {
        return;
      }

      notifiedControllerConnectedRef.current = expectedConnected;
      if (expectedConnected) {
        void playControllerNotificationSound("connected");
        showControllerConnectionNotification("connected", deviceLabel, battery, battery !== "--" ? [battery] : []);
        return;
      }

      void playControllerNotificationSound("disconnected");
      showControllerConnectionNotification("disconnected", t("notifications.testDevice"), "--", []);
    }, CONTROLLER_CONNECTION_NOTIFICATION_STABLE_MS);
  }, [batteryText, ds5Connected, ns2ProPairing, ns2ProPhysicalPathPresent, ns2proBatteryText, ns2proBleState, ns2proConnected, playControllerNotificationSound, showControllerConnectionNotification, t]);

  const testControllerNotificationSound = useCallback(async (sound: ControllerNotificationSound) => {
    await playControllerNotificationSound(sound);
  }, [playControllerNotificationSound]);

  const updateLowBatterySoundState = useCallback((device: HIDDevice, nextBatteryText: string) => {
    const deviceKey = getDeviceKey(device);
    const percent = parseBatteryPercent(nextBatteryText);
    if (!lowBatteryNotificationEnabledRef.current || percent === null || percent > LOW_BATTERY_THRESHOLD_PERCENT) {
      lowBatteryNotifiedKeyRef.current.delete(deviceKey);
      return;
    }

    if (!lowBatteryNotifiedKeyRef.current.has(deviceKey)) {
      lowBatteryNotifiedKeyRef.current.add(deviceKey);
      if (controllerLowBatteryPopupEnabledRef.current) {
        void invoke("ds5_show_controller_notification", {
          kind: "lowBattery",
          deviceLabel: getDeviceLabel(device),
          iconSrc: getControllerIconSrc(device),
          batteryText: nextBatteryText,
          batteryTexts: [nextBatteryText],
          durationMs: controllerNotificationPopupDurationMsRef.current,
        }).catch(() => undefined);
      }
      void playControllerNotificationSound("lowBattery");
    }
  }, [playControllerNotificationSound]);

  const testLowBatteryNotification = useCallback(async () => {
    await Promise.all([
      controllerLowBatteryPopupEnabledRef.current
        ? invoke("ds5_show_controller_notification", {
          kind: "lowBattery",
          deviceLabel: t("notifications.testDevice"),
          iconSrc: getControllerIconSrc(null),
          batteryText: "15%",
          batteryTexts: ["15%"],
          durationMs: controllerNotificationPopupDurationMsRef.current,
        }).catch(() => undefined)
        : Promise.resolve(),
      playControllerNotificationSound("lowBattery"),
    ]);
  }, [playControllerNotificationSound, t]);

  const handleConnectedDeviceDisconnected = useCallback((expectedDisconnect = false) => {
    if (!expectedDisconnect) {
      shouldReturnHomeRef.current = false;
      setShouldReturnHome(false);
    }

    expectedUsbDisconnectRef.current = false;
    clearConnectedDevice({
      preserveConfig: expectedDisconnect || shouldReturnHomeRef.current,
      preserveReconnectTracking: expectedDisconnect || shouldReturnHomeRef.current,
    });
  }, [clearConnectedDevice]);

  const scheduleConnectedDeviceDisconnectCheck = useCallback((targetClient?: Ds5BridgeHidClient | null) => {
    const candidateClient = targetClient ?? clientRef.current;
    if (!candidateClient) {
      cancelPendingConnectedDeviceDisconnect();
      return;
    }

    const deviceKey = getDeviceKey(candidateClient.device);
    if (pendingDisconnectDeviceKeyRef.current === deviceKey && pendingDisconnectTimerRef.current !== null) {
      return;
    }

    cancelPendingConnectedDeviceDisconnect();
    pendingDisconnectDeviceKeyRef.current = deviceKey;
    pendingDisconnectTimerRef.current = window.setTimeout(() => {
      pendingDisconnectTimerRef.current = null;
      pendingDisconnectDeviceKeyRef.current = null;

      const currentClient = clientRef.current;
      if (!currentClient || getDeviceKey(currentClient.device) !== deviceKey) {
        return;
      }

      void Ds5BridgeHidClient.authorizedDevices()
        .then((nextDevices) => {
          setAuthorizedDevicesIfChanged(nextDevices);
          const activeClient = clientRef.current;
          if (!activeClient || getDeviceKey(activeClient.device) !== deviceKey) {
            return;
          }
          if (deviceListIncludes(nextDevices, activeClient.device)) {
            return;
          }
          handleConnectedDeviceDisconnected(expectedUsbDisconnectRef.current);
        })
        .catch(() => {
          const activeClient = clientRef.current;
          if (!activeClient || getDeviceKey(activeClient.device) !== deviceKey) {
            return;
          }
          if (!activeClient.device.opened) {
            handleConnectedDeviceDisconnected(expectedUsbDisconnectRef.current);
          }
        });
    }, CONNECTED_DEVICE_MISSING_GRACE_MS);
  }, [cancelPendingConnectedDeviceDisconnect, handleConnectedDeviceDisconnected, setAuthorizedDevicesIfChanged]);

  const reconcileConnectedDevicePresence = useCallback((devices: HIDDevice[]) => {
    const connectedClient = clientRef.current;
    if (!connectedClient) {
      cancelPendingConnectedDeviceDisconnect();
      return;
    }

    if (deviceListIncludes(devices, connectedClient.device)) {
      cancelPendingConnectedDeviceDisconnect();
      return;
    }

    scheduleConnectedDeviceDisconnectCheck(connectedClient);
  }, [cancelPendingConnectedDeviceDisconnect, scheduleConnectedDeviceDisconnectCheck]);

  const attachClient = useCallback(
    async (nextClient: Ds5BridgeHidClient) => {
      const isSwitchReconnect = shouldReturnHomeRef.current || Boolean(reconnectingDevicePortKeyRef.current);
      setOperation("connecting");
      const previousClient = clientRef.current;
      try {
        if (previousClient && previousClient.device !== nextClient.device) {
          await previousClient.close().catch(() => undefined);
        }
        await nextClient.open();
        clientRef.current = nextClient;
        setClient(nextClient);
        cancelPendingConnectedDeviceDisconnect();
        clearReconnectTracking();
        requireManualSelectionRef.current = false;
        setError(null);
      } finally {
        setOperation(null);
      }

      suppressNextConnectSoundRef.current = false;

      try {
        await readConfigWithClient(nextClient, true);
        await readButtonMappingsWithClient(nextClient);
      } catch (cause) {
        if (!isSwitchReconnect) {
          throw cause;
        }
        setError(null);
        setNeedsUsbReconnect(false);
      }

      try {
        setDeviceSerialNumber((await nextClient.readSerialNumber()) || "--");
        setConnectedControllerProductId(nextClient.device.productId ?? null);
      } catch {
        if (!isSwitchReconnect) {
          setDeviceSerialNumber("--");
        }
      }

      const nextBatteryText = await nextClient.readBatteryText(BATTERY_LISTEN_TIMEOUT_MS).catch(() => null);
      if (nextBatteryText) {
        setBatteryText(nextBatteryText);
        updateLowBatterySoundState(nextClient.device, nextBatteryText);
      }
      await refreshPicoInfo(
        nextClient,
        setFirmwareVersion,
        setSignalStrength,
        setInputMode,
        setInputOwnerState,
        setInputOwnerPolicyState,
        setDs5Connected,
        setNs2proConnected,
        setVisibleNs2proBleState,
        setNs2proBleLastError,
        setNs2proBleHasBond,
        setNs2proRumbleDebug,
        setNs2proBatteryText,
        firmwareVersionRef.current,
        signalStrengthRef.current,
      ).catch(() => "--" as PicoInputMode);
      setSwitchReadyToken((token) => token + 1);
    },
    [cancelPendingConnectedDeviceDisconnect, clearReconnectTracking, readConfigWithClient, t, updateLowBatterySoundState],
  );

  const connectDeviceSilently = useCallback(async (device: HIDDevice) => {
    const deviceKey = getDeviceKey(device);
    if (autoConnectInFlightKeyRef.current === deviceKey) {
      return;
    }

    autoConnectInFlightKeyRef.current = deviceKey;
    try {
      await attachClient(new Ds5BridgeHidClient(device));
      delete failedAutoConnectAtRef.current[deviceKey];
    } catch (cause) {
      failedAutoConnectAtRef.current[deviceKey] = Date.now();
      if (autoConnectDeviceKeyRef.current !== deviceKey) {
        autoConnectDeviceKeyRef.current = deviceKey;
      }

      if (!shouldReturnHomeRef.current && !reconnectingDevicePortKeyRef.current) {
        setError(errorMessage(cause, t));
      }
      setOperation(null);
    } finally {
      if (autoConnectInFlightKeyRef.current === deviceKey) {
        autoConnectInFlightKeyRef.current = null;
      }
    }
  }, [attachClient, t]);

  const connect = useCallback(async () => {
    try {
      requireManualSelectionRef.current = false;
      await attachClient(await Ds5BridgeHidClient.requestDevice());
      await refreshAuthorizedDevices();
    } catch (cause) {
      if (isNoDeviceSelectedError(cause)) {
        setOperation(null);
        return;
      }

      if (!shouldReturnHomeRef.current && !reconnectingDevicePortKeyRef.current) {
        setError(errorMessage(cause, t));
      }
      setOperation(null);
    }
  }, [attachClient, refreshAuthorizedDevices, t]);

  const connectAuthorized = useCallback(
    async (device: HIDDevice) => {
      await connectDeviceSilently(device);
    },
    [connectDeviceSilently],
  );

  const ensurePicoClient = useCallback(async (): Promise<Ds5BridgeHidClient | null> => {
    const currentClient = clientRef.current;
    if (currentClient?.device.opened) {
      return currentClient;
    }

    try {
      const nextClient = await Ds5BridgeHidClient.requestDevice();
      await attachClient(nextClient);
      await refreshAuthorizedDevices();
      return clientRef.current?.device.opened ? clientRef.current : nextClient;
    } catch (cause) {
      if (!isNoDeviceSelectedError(cause)) {
        setError(errorMessage(cause, t));
      }
      return null;
    }
  }, [attachClient, refreshAuthorizedDevices, t]);

  const applyLatestDraft = useCallback(async (): Promise<boolean> => {
    if (applyingRef.current) {
      applyQueuedRef.current = true;
      return false;
    }

    applyingRef.current = true;
    setOperation("applying");
    try {
      while (true) {
        applyQueuedRef.current = false;

        const nextClient = clientRef.current;
        if (!nextClient) {
          break;
        }

        const nextDraft = normalizeConfig(draftRef.current);
        if (validateConfig(nextDraft).length > 0 || configsEqual(configRef.current, nextDraft)) {
          pendingChangedFieldsRef.current.clear();
          break;
        }

        const changedFields = new Set(pendingChangedFieldsRef.current);
        await nextClient.applyConfig(nextDraft);
        pendingChangedFieldsRef.current.clear();
        configRef.current = nextDraft;
        setConfig(nextDraft);
        const needsReconnect = changedFields.has("pollingRateMode") || changedFields.has("controllerMode");
        setSaveState("applied");
        setError(null);

        if (configsEqual(draftRef.current, nextDraft)) {
          draftRef.current = nextDraft;
          setDraft(nextDraft);
        }

        if (needsReconnect) {
          pendingUsbReconnectDevicePortKeyRef.current = getDevicePortKey(nextClient.device);
          setNeedsUsbReconnect(true);
          setPendingUsbReconnectPrompt(true);
          break;
          // 先设置 shouldReturnHome（ref 同步 + state 异步）作为 USB 重枚举期间的设置页保活标记，
          // 防止 disconnect 事件中 clearConnectedDevice 将 client 设为 null 后 App.tsx 的 useEffect 提前切换到主页。
          // 设备重新连接成功后会在 attachClient 中清理该标记，不再强制回到主页，避免设置页闪动。
        } else if (!pendingUsbReconnectDevicePortKeyRef.current) {
          setNeedsUsbReconnect(false);
        }

        if (!applyQueuedRef.current && configsEqual(configRef.current, draftRef.current)) {
          break;
        }
      }
    } catch (cause) {
      setError(errorMessage(cause, t));
      return false;
    } finally {
      applyingRef.current = false;
      setOperation(null);
    }

    return true;
  }, [t]);

  const applyLatestMappings = useCallback(async (): Promise<boolean> => {
    if (mappingApplyingRef.current) {
      mappingApplyQueuedRef.current = true;
      return false;
    }

    mappingApplyingRef.current = true;
    try {
      while (true) {
        mappingApplyQueuedRef.current = false;
        const nextClient = clientRef.current;
        if (!nextClient) {
          break;
        }

        const nextDs5 = ds5ButtonMappingDraftRef.current;
        const nextNs2 = ns2proButtonMappingDraftRef.current;
        const ds5Changed = !ds5MappingsEqual(ds5ButtonMappingRef.current, nextDs5);
        const ns2Changed = !ns2ProMappingsEqual(ns2proButtonMappingRef.current, nextNs2);
        if (!ds5Changed && !ns2Changed) {
          mappingDirtyRef.current = false;
          break;
        }

        if (ds5Changed) {
          await nextClient.applyDs5ButtonMapping(nextDs5);
          ds5ButtonMappingRef.current = nextDs5;
          setDs5ButtonMapping(nextDs5);
        }
        if (ns2Changed) {
          await nextClient.applyNs2ProButtonMapping(nextNs2);
          ns2proButtonMappingRef.current = nextNs2;
          setNs2proButtonMapping(nextNs2);
        }
        mappingDirtyRef.current = false;

        if (!mappingApplyQueuedRef.current) {
          break;
        }
      }
    } catch (cause) {
      setError(errorMessage(cause, t));
      return false;
    } finally {
      mappingApplyingRef.current = false;
    }

    return true;
  }, [t]);

  const saveToFlash = useCallback(async () => {
    const nextClient = clientRef.current;
    if (!nextClient || !configsEqual(configRef.current, draftRef.current)) {
      return;
    }

    setOperation("saving");
    try {
      await nextClient.saveToFlash();
      setSaveState("saved");
      if (savedStatusTimerRef.current !== null) {
        window.clearTimeout(savedStatusTimerRef.current);
      }
      savedStatusTimerRef.current = window.setTimeout(() => {
        setSaveState("idle");
        savedStatusTimerRef.current = null;
      }, 900);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause, t));
    } finally {
      setOperation(null);
    }
  }, [t]);

  const scheduleAutoSave = useCallback(() => {
    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
    }

    autoSaveTimerRef.current = window.setTimeout(async () => {
      autoSaveTimerRef.current = null;
      const applied = await applyLatestDraft();
      if (applied && configsEqual(configRef.current, draftRef.current)) {
        await saveToFlash();
      }
    }, 180);
  }, [applyLatestDraft, saveToFlash]);

  const scheduleMappingAutoSave = useCallback(() => {
    if (mappingAutoSaveTimerRef.current !== null) {
      window.clearTimeout(mappingAutoSaveTimerRef.current);
    }

    mappingAutoSaveTimerRef.current = window.setTimeout(async () => {
      mappingAutoSaveTimerRef.current = null;
      const applied = await applyLatestMappings();
      if (applied && !mappingDirtyRef.current) {
        await saveToFlash();
      }
    }, 180);
  }, [applyLatestMappings, saveToFlash]);

  const readConfig = useCallback(async () => {
    const nextClient = clientRef.current;
    if (!nextClient) {
      return;
    }

    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }

    try {
      const applied = await applyLatestDraft();
      if (applied && configsEqual(configRef.current, draftRef.current)) {
        await saveToFlash();
      }
      await readConfigWithClient(nextClient);
    } catch (cause) {
      if (clientRef.current === nextClient) {
        scheduleConnectedDeviceDisconnectCheck(nextClient);
        return;
      }

      setError(errorMessage(cause, t));
      setOperation(null);
    }
  }, [applyLatestDraft, readConfigWithClient, saveToFlash, scheduleConnectedDeviceDisconnectCheck, t]);

  const reconnectUsb = useCallback(async () => {
    if (!client) {
      return;
    }

    setOperation("reconnecting");
    try {
      await client.reconnectUsb();
      usbEffectiveConfigRef.current = pickUsbEffectiveConfig(configRef.current ?? draftRef.current);
      setNeedsUsbReconnect(false);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause, t));
    } finally {
      setOperation(null);
    }
  }, [client, t]);

  const applyPendingUsbReconnect = useCallback(async () => {
    const nextClient = clientRef.current;
    if (!nextClient) {
      return;
    }

    const applied = await applyLatestDraft();
    if (!applied || !configsEqual(configRef.current, draftRef.current)) {
      return;
    }

    await saveToFlash();

    expectedUsbDisconnectRef.current = true;
    suppressNextConnectSoundRef.current = true;
    requireManualSelectionRef.current = false;
    autoConnectDeviceKeyRef.current = null;
    reconnectingDevicePortKeyRef.current = pendingUsbReconnectDevicePortKeyRef.current ?? getDevicePortKey(nextClient.device);
    if (reconnectingDeviceTimeoutRef.current !== null) {
      window.clearTimeout(reconnectingDeviceTimeoutRef.current);
    }
    reconnectingDeviceTimeoutRef.current = window.setTimeout(() => {
      reconnectingDevicePortKeyRef.current = null;
      reconnectingDeviceTimeoutRef.current = null;
    }, SWITCH_RECONNECT_WINDOW_MS);

    shouldReturnHomeRef.current = true;
    setShouldReturnHome(true);
    setPendingUsbReconnectPrompt(false);
    setOperation("reconnecting");
    try {
      await nextClient.reconnectUsb();
    } catch {
      // The device can close immediately after the reconnect command is sent.
    } finally {
      setOperation(null);
    }
    clearConnectedDevice({ preserveConfig: true, preserveReconnectTracking: true });
  }, [applyLatestDraft, clearConnectedDevice, saveToFlash]);

  const dismissPendingUsbReconnectPrompt = useCallback(() => {
    setPendingUsbReconnectPrompt(false);
  }, []);

  const retryNs2ProPairing = useCallback(async () => {
    setOperation("connecting");
    const currentClient = clientRef.current;
    const applyStatus = (status: Ns2ProPicoBridgeStatusDto) => {
      ns2ProPhysicalPathPresentRef.current = Boolean(status.ns2proPath);
      setNs2ProPhysicalPathPresent(Boolean(status.ns2proPath));
      const nextStatus = stabilizeNs2ProPairingStatus(
        ns2ProPairingStatusFromDto(status),
        ns2ProPairingRef.current,
        ns2ProPresenceGraceRef,
      );
      setNs2ProPairing(nextStatus);
      if (isNs2ProPairingReady(nextStatus)) {
        setError(null);
      }
    };
    try {
      if (!currentClient?.device.opened) {
        setNs2ProPairing(waitingNs2ProPairingStatus());
      const status = await invoke<Ns2ProPicoBridgeStatusDto>("ds5_restart_ns2pro_pico_bridge_wired", {
        options: {
          picoPath: null,
          ns2proPath: null,
            readTimeoutMs: 1,
          },
        });
        applyStatus(status);
        return;
      }

      if (inputModeRef.current === "--") {
        await refreshPicoInfo(
          currentClient,
          setFirmwareVersion,
          setSignalStrength,
          setInputMode,
          setInputOwnerState,
          setInputOwnerPolicyState,
          setDs5Connected,
          setNs2proConnected,
          setVisibleNs2proBleState,
          setNs2proBleLastError,
          setNs2proBleHasBond,
          setNs2proRumbleDebug,
          setNs2proBatteryText,
          firmwareVersionRef.current,
          signalStrengthRef.current,
        ).catch(() => "--" as PicoInputMode);
      }

      const picoPath = Ds5BridgeHidClient.devicePath(currentClient.device);
      setNs2ProPairing(waitingNs2ProPairingStatus());
      const status = await invoke<Ns2ProPicoBridgeStatusDto>("ds5_restart_ns2pro_pico_bridge_wired", {
        options: {
          picoPath,
          ns2proPath: null,
          readTimeoutMs: 1,
        },
      });
      applyStatus(status);
    } catch (cause) {
      setNs2ProPairing(ns2ProPairingErrorStatus(errorMessage(cause, t)));
    } finally {
      setOperation(null);
    }
  }, [t]);

  const setInputOwner = useCallback(async (owner: PicoInputOwner) => {
    const currentClient = clientRef.current;
    if (!currentClient?.device.opened) {
      return;
    }

    setInputOwnerState(owner);
    setInputOwnerPolicyState(owner);

    await currentClient.setInputOwner(owner);
    await refreshPicoInfo(
      currentClient,
      setFirmwareVersion,
      setSignalStrength,
      setInputMode,
      setInputOwnerState,
      setInputOwnerPolicyState,
      setDs5Connected,
      setNs2proConnected,
      setVisibleNs2proBleState,
      setNs2proBleLastError,
      setNs2proBleHasBond,
      setNs2proRumbleDebug,
      setNs2proBatteryText,
      firmwareVersionRef.current,
      signalStrengthRef.current,
    ).catch(() => undefined);
  }, []);

  const startNs2ProBlePairing = useCallback(async () => {
    setOperation("connecting");
    try {
      let currentClient = clientRef.current;
      const fallbackManagerPath = currentClient?.device.opened
        ? null
        : (await invoke<TauriHidDeviceInfo[]>("ds5_list_devices"))
          .find((device) => device.vendorId === PICO_MANAGER_VENDOR_ID && device.productId === PICO_MANAGER_PRODUCT_ID)?.path ?? null;

      if (!currentClient?.device.opened && !fallbackManagerPath) {
        currentClient = await ensurePicoClient();
      }

      if (!currentClient?.device.opened && !fallbackManagerPath) {
        ns2ProBlePairingRequestedUntilRef.current = 0;
        setNs2proBleState("Error");
        setNs2proBleLastError(NS2PRO_BLE_PICO_NOT_CONNECTED_ERROR);
        return;
      }

      await invoke("ds5_stop_ns2pro_pico_bridge").catch(() => undefined);
      setNs2ProPairing(inactiveNs2ProPairingStatus());
      setNs2proBleState("PairingRequested");
      ns2ProBlePairingRequestedUntilRef.current = Date.now() + NS2PRO_BLE_MANUAL_PAIRING_HOLD_MS;
      setNs2proBleLastError(0);

      if (currentClient?.device.opened) {
        await currentClient.startNs2ProBlePairing();
        await refreshPicoInfo(
          currentClient,
          setFirmwareVersion,
          setSignalStrength,
          setInputMode,
          setInputOwnerState,
          setInputOwnerPolicyState,
          setDs5Connected,
          setNs2proConnected,
          setVisibleNs2proBleState,
          setNs2proBleLastError,
          setNs2proBleHasBond,
          setNs2proRumbleDebug,
          setNs2proBatteryText,
          firmwareVersionRef.current,
          signalStrengthRef.current,
        ).catch(() => undefined);
      } else if (fallbackManagerPath) {
        await invoke("ds5_send_feature_report", {
          path: fallbackManagerPath,
          reportId: REPORT_SET_CONFIG,
          data: [CMD_NS2PRO_BLE_START_PAIRING],
        });
      }
    } catch {
      ns2ProBlePairingRequestedUntilRef.current = 0;
      setNs2proBleState("Error");
      setNs2proBleLastError(NS2PRO_BLE_PAIRING_COMMAND_FAILED_ERROR);
    } finally {
      setOperation(null);
    }
  }, [ensurePicoClient]);

  const calibrateNs2ProStickCenter = useCallback(async (): Promise<boolean> => {
      const currentClient = clientRef.current;
      if (!currentClient?.device.opened) {
        setError(t("errors.noDeviceSelected"));
        return false;
      }

    try {
      await currentClient.calibrateNs2ProStickCenter();
      let lastStatus = await currentClient.readPicoBridgeStatus();
      for (let attempt = 0; attempt < 24 && lastStatus.lastError === NS2PRO_STICK_CALIBRATION_PENDING_ERROR; attempt += 1) {
        await sleep(60);
        lastStatus = await currentClient.readPicoBridgeStatus();
      }
        if (
          lastStatus.lastError === NS2PRO_STICK_CALIBRATION_PENDING_ERROR ||
          lastStatus.lastError === NS2PRO_STICK_CALIBRATION_FAILED_ERROR ||
          lastStatus.lastError !== 0
        ) {
          setError(null);
          return false;
        }
        await currentClient.saveToFlash();
        await readConfigWithClient(currentClient);
        setSaveState("saved");
        setError(null);
        return true;
      } catch (cause) {
        setError(errorMessage(cause, t));
        return false;
      }
    }, [readConfigWithClient, t]);

  const setDraftField = useCallback(
    <Key extends keyof ConfigBody>(field: Key, value: ConfigBody[Key]) => {
      const nextDraft = { ...draftRef.current, [field]: value };
      pendingChangedFieldsRef.current.add(field);
      draftRef.current = nextDraft;
      setDraft(nextDraft);
      setSaveState("dirty");
      scheduleAutoSave();
    },
    [scheduleAutoSave],
  );

  const setDs5ButtonMappingField = useCallback((field: Ds5MappingInput, value: ButtonMappingTarget) => {
    const nextDraft = { ...ds5ButtonMappingDraftRef.current, [field]: value };
    ds5ButtonMappingDraftRef.current = nextDraft;
    setDs5ButtonMappingDraft(nextDraft);
    mappingDirtyRef.current = true;
    scheduleMappingAutoSave();
  }, [scheduleMappingAutoSave]);

  const setNs2ProButtonMappingField = useCallback((field: Ns2ProMappingInput, value: ButtonMappingTarget) => {
    const nextDraft = { ...ns2proButtonMappingDraftRef.current, [field]: value };
    ns2proButtonMappingDraftRef.current = nextDraft;
    setNs2proButtonMappingDraft(nextDraft);
    mappingDirtyRef.current = true;
    scheduleMappingAutoSave();
  }, [scheduleMappingAutoSave]);

  const resetToDefaults = useCallback(async () => {
    draftRef.current = DEFAULT_CONFIG;
    pendingChangedFieldsRef.current = new Set(Object.keys(DEFAULT_CONFIG) as Array<keyof ConfigBody>);
    setDraft(DEFAULT_CONFIG);
    setSaveState("dirty");

    const applied = await applyLatestDraft();
    if (!applied || !configsEqual(configRef.current, DEFAULT_CONFIG)) {
      return;
    }

    await saveToFlash();
  }, [applyLatestDraft, saveToFlash]);

  useEffect(() => {
    void refreshAuthorizedDevices();
  }, [refreshAuthorizedDevices]);

  useEffect(() => {
    void invoke<boolean>("ds5_get_controller_notification_sound_enabled")
      .then((enabled) => {
        controllerNotificationSoundEnabledRef.current = enabled;
        setControllerNotificationSoundEnabledState(enabled);
      })
      .catch(() => undefined);

    void invoke<ControllerNotificationSoundVolumes>("ds5_get_controller_notification_sound_volumes")
      .then((volumes) => {
        const normalizedVolumes = normalizeNotificationVolumes(volumes);
        controllerNotificationSoundVolumesRef.current = normalizedVolumes;
        setControllerNotificationSoundVolumes(normalizedVolumes);
      })
      .catch(() => undefined);

    void invoke<boolean>("ds5_get_controller_connection_popup_enabled")
      .then((enabled) => {
        controllerConnectionPopupEnabledRef.current = enabled;
        setControllerConnectionPopupEnabledState(enabled);
      })
      .catch(() => undefined);

    void invoke<boolean>("ds5_get_controller_low_battery_popup_enabled")
      .then((enabled) => {
        controllerLowBatteryPopupEnabledRef.current = enabled;
        setControllerLowBatteryPopupEnabledState(enabled);
      })
      .catch(() => undefined);

    void invoke<number>("ds5_get_controller_notification_popup_duration_ms")
      .then((durationMs) => {
        const normalizedDurationMs = normalizePopupDurationMs(durationMs);
        controllerNotificationPopupDurationMsRef.current = normalizedDurationMs;
        setControllerNotificationPopupDurationMsState(normalizedDurationMs);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void invoke<boolean>("ds5_get_low_battery_notification_enabled")
      .then((enabled) => {
        lowBatteryNotificationEnabledRef.current = enabled;
        setLowBatteryNotificationEnabledState(enabled);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!supported) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;

    const handleVisibilityChange = () => {
      windowVisibleRef.current = document.visibilityState === "visible";
      if (windowVisibleRef.current) {
        void refreshAuthorizedDevices();
      }
    };

    windowVisibleRef.current = document.visibilityState === "visible";
    document.addEventListener("visibilitychange", handleVisibilityChange);

    void startDeviceMonitor().catch(() => undefined);
    void listen<TauriHidDeviceInfo[]>("ds5-devices-changed", (event) => {
      if (!disposed) {
        const nextDevices = tauriDeviceInfosToHidDevices(event.payload);
        setAuthorizedDevicesIfChanged(nextDevices);
        reconcileConnectedDevicePresence(nextDevices);
      }
    }).then((nextUnlisten) => {
      if (disposed) {
        nextUnlisten();
      } else {
        unlisten = nextUnlisten;
      }
    });

    const intervalId = window.setInterval(() => {
      if (windowVisibleRef.current) {
        void refreshAuthorizedDevices();
      }
    }, DEVICE_DISCOVERY_FALLBACK_INTERVAL_MS);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.clearInterval(intervalId);
      unlisten?.();
    };
  }, [reconcileConnectedDevicePresence, refreshAuthorizedDevices, setAuthorizedDevicesIfChanged, supported]);

  useEffect(() => {
    reconcileConnectedDevicePresence(authorizedDevices);
  }, [authorizedDevices, reconcileConnectedDevicePresence]);

  useEffect(() => {
    if (authorizedDevices.length === 0) {
      autoConnectDeviceKeyRef.current = null;
      setAuthorizedDeviceBatteryText((current) => replaceRecordIfChanged(current, {}));
      setAuthorizedDeviceSerialNumber((current) => replaceRecordIfChanged(current, {}));
      setAuthorizedDeviceFirmwareVersion((current) => replaceRecordIfChanged(current, {}));
      setAuthorizedDeviceSignalStrength((current) => replaceRecordIfChanged(current, {}));
      return;
    }

    void scanAuthorizedDeviceInfo(authorizedDevices);
    const intervalId = window.setInterval(() => {
      if (windowVisibleRef.current) {
        void scanAuthorizedDeviceInfo(authorizedDevices);
      }
    }, AUTHORIZED_DEVICE_INFO_REFRESH_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [authorizedDevices, scanAuthorizedDeviceInfo]);

  useEffect(() => {
    if (!supported || clientRef.current || operation === "connecting" || operation === "reading") {
      return;
    }

    const reconnectingDevicePortKey = reconnectingDevicePortKeyRef.current;
    if (reconnectingDevicePortKey) {
      const reconnectedDevice = authorizedDevices.find(
        (device) => Ds5BridgeHidClient.isSupportedDevice(device) && getDevicePortKey(device) === reconnectingDevicePortKey,
      );

      if (reconnectedDevice) {
        autoConnectDeviceKeyRef.current = null;
        void connectDeviceSilently(reconnectedDevice);
      }
      return;
    }

    const now = Date.now();
    const nextDevice = authorizedDevices.find((device) => {
      if (!isAutoConnectCandidate(device)) {
        return false;
      }

      const failedAt = failedAutoConnectAtRef.current[getDeviceKey(device)] ?? 0;
      return now - failedAt >= AUTO_CONNECT_RETRY_COOLDOWN_MS;
    });
    if (!nextDevice) {
      autoConnectDeviceKeyRef.current = null;
      return;
    }

    const nextDeviceKey = getDeviceKey(nextDevice);
    if (autoConnectDeviceKeyRef.current === nextDeviceKey || autoConnectInFlightKeyRef.current === nextDeviceKey) {
      return;
    }

    autoConnectDeviceKeyRef.current = nextDeviceKey;
    void connectDeviceSilently(nextDevice);
  }, [authorizedDevices, connectDeviceSilently, operation, supported]);

  useEffect(() => {
    if (!supported || operation === "connecting" || operation === "reading") {
      return;
    }

    const currentClient = clientRef.current;
    if (!currentClient?.device.opened) {
      return;
    }

    const currentDevice = currentClient.device;
    if (!(currentDevice.vendorId === PICO_MANAGER_VENDOR_ID && currentDevice.productId === PICO_MANAGER_PRODUCT_ID)) {
      return;
    }

    const runtimeDevice = authorizedDevices.find((device) =>
      device.vendorId !== PICO_MANAGER_VENDOR_ID && Ds5BridgeHidClient.isSupportedDevice(device),
    );

    if (!runtimeDevice) {
      return;
    }

    const runtimeKey = getDeviceKey(runtimeDevice);
    if (autoConnectInFlightKeyRef.current === runtimeKey) {
      return;
    }

    autoConnectDeviceKeyRef.current = runtimeKey;
    void connectDeviceSilently(runtimeDevice);
  }, [authorizedDevices, connectDeviceSilently, operation, supported]);

  useEffect(() => {
    if (!supported) {
      return;
    }

    const refreshBatteryInfo = () => {
      if (!windowVisibleRef.current) {
        return;
      }

        const connectedClient = clientRef.current;
        if (connectedClient?.device.opened) {
          void connectedClient.readBatteryText(BATTERY_LISTEN_TIMEOUT_MS).then((nextBatteryText) => {
            if (nextBatteryText && clientRef.current === connectedClient) {
              setBatteryText(nextBatteryText);
              updateLowBatterySoundState(connectedClient.device, nextBatteryText);
            }
          }).catch(() => {
          if (clientRef.current === connectedClient) {
            scheduleConnectedDeviceDisconnectCheck(connectedClient);
          }
          });
        }
      };

    const intervalId = window.setInterval(refreshBatteryInfo, BATTERY_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [scheduleConnectedDeviceDisconnectCheck, supported, updateLowBatterySoundState]);

  useEffect(() => {
    const batteries = authorizedDevices.map((device, index) => {
      const deviceKey = getDeviceKey(device);
      return {
        deviceKey,
        label: t("tray.controllerLabel", { index: index + 1 }),
        batteryText: clientRef.current?.device === device ? batteryText : (authorizedDeviceBatteryText[deviceKey] ?? "--"),
      };
    });
    const signature = JSON.stringify(batteries);
    if (lastTrayBatteriesSignatureRef.current === signature) {
      return;
    }
    lastTrayBatteriesSignatureRef.current = signature;

    void invoke("ds5_update_tray_batteries", { batteries }).catch(() => undefined);
  }, [authorizedDeviceBatteryText, authorizedDevices, batteryText, t]);

  useEffect(() => {
    const syncTrayLabels = () => {
      void invoke("ds5_update_tray_labels", {
        labels: {
          openWindow: t("tray.openWindow"),
          quit: t("tray.quit"),
          batteryPrefix: t("tray.batteryPrefix"),
        },
      }).catch(() => undefined);
    };

    syncTrayLabels();
    i18n.on("languageChanged", syncTrayLabels);
    return () => {
      i18n.off("languageChanged", syncTrayLabels);
    };
  }, [i18n, t]);

  useEffect(() => {
    if (!supported) {
      return;
    }

    const refreshConnectedPicoInfo = () => {
      if (!windowVisibleRef.current) {
        return;
      }

      const currentClient = clientRef.current;
      if (currentClient?.device.opened) {
        void refreshPicoInfo(
          currentClient,
          setFirmwareVersion,
          setSignalStrength,
          setInputMode,
          setInputOwnerState,
          setInputOwnerPolicyState,
          setDs5Connected,
          setNs2proConnected,
          setVisibleNs2proBleState,
          setNs2proBleLastError,
          setNs2proBleHasBond,
          setNs2proRumbleDebug,
          setNs2proBatteryText,
          firmwareVersionRef.current,
          signalStrengthRef.current,
        ).catch(() => {
          if (clientRef.current === currentClient) {
            scheduleConnectedDeviceDisconnectCheck(currentClient);
          }
        });
      }
    };

    refreshConnectedPicoInfo();
    const intervalId = window.setInterval(refreshConnectedPicoInfo, PICO_INFO_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [scheduleConnectedDeviceDisconnectCheck, setVisibleNs2proBleState, supported]);

  useEffect(() => {
    if (client && inputMode !== "NS2Pro" && ns2ProPairingRef.current.phase === "inactive") {
      setNs2ProPairing(inactiveNs2ProPairingStatus());
      return;
    }

    let cancelled = false;
    const refreshPairingStatus = async () => {
      try {
        const status = await invoke<Ns2ProPicoBridgeStatusDto>("ds5_get_ns2pro_pico_bridge_status");
        if (!cancelled) {
          ns2ProPhysicalPathPresentRef.current = Boolean(status.ns2proPath);
          setNs2ProPhysicalPathPresent(Boolean(status.ns2proPath));
          const nextPairingStatus = stabilizeNs2ProPairingStatus(
            ns2ProPairingStatusFromDto(status),
            ns2ProPairingRef.current,
            ns2ProPresenceGraceRef,
          );
          if (!clientRef.current) {
            setNs2proConnected(isNs2ProWiredBridgeActive(nextPairingStatus));
          }
          setNs2ProPairing(nextPairingStatus);
        }
      } catch (cause) {
        if (!cancelled) {
          setNs2ProPairing(ns2ProPairingErrorStatus(errorMessage(cause, t)));
        }
      }
    };

    void refreshPairingStatus();
    const intervalId = window.setInterval(refreshPairingStatus, NS2PRO_PAIRING_STATUS_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [client, inputMode, t]);

  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
      }
      if (mappingAutoSaveTimerRef.current !== null) {
        window.clearTimeout(mappingAutoSaveTimerRef.current);
      }
      if (savedStatusTimerRef.current !== null) {
        window.clearTimeout(savedStatusTimerRef.current);
      }
      if (controllerNotificationTimerRef.current !== null) {
        window.clearTimeout(controllerNotificationTimerRef.current);
      }
      if (reconnectingDeviceTimeoutRef.current !== null) {
        window.clearTimeout(reconnectingDeviceTimeoutRef.current);
      }
      if (pendingDisconnectTimerRef.current !== null) {
        window.clearTimeout(pendingDisconnectTimerRef.current);
      }
    };
  }, []);

  return {
    supported,
    client,
    deviceLabel,
    deviceSerialNumber,
    batteryText,
    ns2proBatteryText,
    firmwareVersion,
    signalStrength,
    inputMode,
    inputOwner,
    inputOwnerPolicy,
    ds5Connected,
    ns2proConnected,
    ns2proBleState,
    ns2proBleLastError,
    ns2proBleHasBond,
    ns2proRumbleDebug,
    ns2ProPhysicalPathPresent,
    ns2ProPairing,
    authorizedDeviceSerialNumber,
    authorizedDeviceBatteryText,
    authorizedDeviceFirmwareVersion,
    authorizedDeviceSignalStrength,
    authorizedDevices,
    config,
    draft,
    issues,
    saveState,
    operation,
    error,
    statusText: settledStatusText,
    shouldReturnHome,
    shouldReturnHomeRef,
    isConnected,
    isDirty,
    isDefaultConfig,
    needsUsbReconnect,
    pendingUsbReconnectPrompt,
    lowBatteryNotificationEnabled,
    controllerConnectionPopupEnabled,
    controllerLowBatteryPopupEnabled,
    controllerNotificationPopupDurationMs,
    controllerNotificationSoundEnabled,
    controllerNotificationSoundVolumes,
    switchReadyToken,
    connectedControllerProductId,
    ds5ButtonMapping,
    ds5ButtonMappingDraft,
    ns2proButtonMapping,
    ns2proButtonMappingDraft,
    setDraftField,
    setDs5ButtonMappingField,
    setNs2ProButtonMappingField,
    setLowBatteryNotificationEnabled,
    setControllerConnectionPopupEnabled,
    setControllerLowBatteryPopupEnabled,
    setControllerNotificationPopupDurationMs,
    setControllerNotificationSoundEnabled,
    setControllerNotificationSoundVolume,
    setInputOwner,
    resetControllerNotificationSoundVolumes,
    testLowBatteryNotification,
    testControllerNotificationSound,
    refreshAuthorizedDevices,
    connect,
    connectAuthorized,
    readConfig,
    saveToFlash,
    reconnectUsb,
    applyPendingUsbReconnect,
    dismissPendingUsbReconnectPrompt,
    retryNs2ProPairing,
    startNs2ProBlePairing,
    calibrateNs2ProStickCenter,
    resetToDefaults,
    clearReturnHome: () => {
      shouldReturnHomeRef.current = false;
      setShouldReturnHome(false);
    },
    clearError: () => setError(null),
  };
}

const DEFAULT_CONTROLLER_NOTIFICATION_SOUND_VOLUMES: ControllerNotificationSoundVolumes = {
  connected: 0.65,
  disconnected: 0.65,
  lowBattery: 0.75,
};

function normalizeNotificationVolume(volume: number): number {
  return Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0;
}

function normalizePopupDurationMs(durationMs: number): number {
  return Number.isFinite(durationMs) ? Math.max(2_000, Math.min(15_000, Math.round(durationMs))) : 4_000;
}

function normalizeNotificationVolumes(volumes: Partial<ControllerNotificationSoundVolumes> | null | undefined): ControllerNotificationSoundVolumes {
  return {
    connected: normalizeNotificationVolume(volumes?.connected ?? DEFAULT_CONTROLLER_NOTIFICATION_SOUND_VOLUMES.connected),
    disconnected: normalizeNotificationVolume(volumes?.disconnected ?? DEFAULT_CONTROLLER_NOTIFICATION_SOUND_VOLUMES.disconnected),
    lowBattery: normalizeNotificationVolume(volumes?.lowBattery ?? DEFAULT_CONTROLLER_NOTIFICATION_SOUND_VOLUMES.lowBattery),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function parseBatteryPercent(batteryText: string): number | null {
  const match = batteryText.match(/(\d{1,3})\s*%/);
  if (!match) {
    return null;
  }

  return Math.max(0, Math.min(100, Number(match[1])));
}

async function refreshPicoInfo(
  client: Ds5BridgeHidClient,
  setFirmwareVersion: (value: string) => void,
  setSignalStrength: (value: string) => void,
  setInputMode: (value: PicoInputMode) => void,
  setInputOwner: (value: PicoInputOwnerState) => void,
  setInputOwnerPolicy: (value: PicoInputOwnerState) => void,
  setDs5Connected: (value: boolean) => void,
  setNs2proConnected: (value: boolean) => void,
  setNs2proBleState: (value: Ns2ProBleState) => void,
  setNs2proBleLastError: (value: number) => void,
  setNs2proBleHasBond: (value: boolean) => void,
  setNs2proRumbleDebug: (value: Ns2ProRumbleDebug | null) => void,
  setNs2proBatteryText: (value: string) => void,
  currentFirmwareVersion: string,
  currentSignalStrength: string,
): Promise<PicoInputMode> {
  const [nextFirmwareVersion, nextBridgeStatus, nextPairingStatus] = await Promise.all([
    client.readFirmwareVersion().catch(() => "--"),
    client.readPicoBridgeStatus().catch(() => ({
      inputMode: "--" as PicoInputMode,
      inputOwner: "--" as PicoInputOwnerState,
      inputOwnerPolicy: "--" as PicoInputOwnerState,
      ds5Connected: false,
      ns2proConnected: false,
      lastError: 0,
      ns2proBatteryText: null,
      signalStrength: null,
      ns2proBleState: "Disabled" as Ns2ProBleState,
      ns2proBleLastError: 0,
      ns2proBleHasBond: false,
      ns2proRumbleDebug: null,
    })),
    invoke<Ns2ProPicoBridgeStatusDto>("ds5_get_ns2pro_pico_bridge_status").catch(() => null),
  ]);
  const nextNs2proConnected =
    nextBridgeStatus.ns2proConnected ||
    isNs2ProWiredBridgeActive(nextPairingStatus ?? null);
  const nextFirmwareVersionDisplay = coalesceKnownFirmwareVersion(
    nextFirmwareVersion || "--",
    currentFirmwareVersion,
  );
  const nextSignalStrengthDisplay = coalesceKnownSignalStrength(
    formatSignalStrength(nextBridgeStatus.signalStrength),
    currentSignalStrength,
    nextBridgeStatus.ds5Connected,
    nextBridgeStatus.ns2proBleState,
    nextNs2proConnected,
  );

  setFirmwareVersion(normalizeStatusDisplayValue(nextFirmwareVersionDisplay));
  setSignalStrength(normalizeStatusDisplayValue(nextSignalStrengthDisplay));
  setInputMode(nextBridgeStatus.inputMode);
  setInputOwner(nextBridgeStatus.inputOwner);
  setInputOwnerPolicy(nextBridgeStatus.inputOwnerPolicy);
  setDs5Connected(nextBridgeStatus.ds5Connected);
  setNs2proConnected(nextNs2proConnected);
  setNs2proBleState(nextBridgeStatus.ns2proBleState);
  setNs2proBleLastError(nextBridgeStatus.ns2proBleLastError);
  setNs2proBleHasBond(nextBridgeStatus.ns2proBleHasBond);
  setNs2proRumbleDebug(nextBridgeStatus.ns2proRumbleDebug);
  setNs2proBatteryText(nextBridgeStatus.ns2proBatteryText ?? "--");
  return nextBridgeStatus.inputMode;
}

export interface Ns2ProPairingStatus {
  phase: Ns2ProPairingPhase;
  running: boolean;
  picoPath: string | null;
  ns2proPath: string | null;
  ns2proOutputPath: string | null;
  inputTransport: "serial" | "hidFeature" | null;
  inputTransportPort: string | null;
  inputTransportError: string | null;
  waitingReason: string | null;
  inputReportsReceived: number;
  inputReportsForwarded: number;
  outputReportsReceived: number;
  outputReportsForwarded: number;
  oversizedReports: number;
  writeErrors: number;
  readErrors: number;
  lastSerialOutputReportLen: number;
  lastSerialOutputReportHeadHex: string | null;
  lastOutputReportLen: number;
  lastOutputReportHeadHex: string | null;
  lastOutputWriteLen: number;
  lastOutputError: string | null;
  lastError: string | null;
}

interface Ns2ProPicoBridgeStatusDto {
  running: boolean;
  picoPath?: string | null;
  ns2proPath?: string | null;
  ns2proOutputPath?: string | null;
  inputTransport?: "serial" | "hidFeature" | null;
  inputTransportPort?: string | null;
  inputTransportError?: string | null;
  waitingReason?: string | null;
  inputReportsReceived: number;
  inputReportsForwarded: number;
  outputReportsReceived?: number;
  outputReportsForwarded?: number;
  oversizedReports: number;
  writeErrors: number;
  readErrors: number;
  lastSerialOutputReportLen?: number;
  lastSerialOutputReportHeadHex?: string | null;
  lastOutputReportLen?: number;
  lastOutputReportHeadHex?: string | null;
  lastOutputWriteLen?: number;
  lastOutputError?: string | null;
  lastError?: string | null;
}

interface Ns2ProPairingPresenceGrace {
  picoUntil: number;
  ns2proUntil: number;
}

async function startNs2ProBridgeIfNeeded(
  client: Ds5BridgeHidClient,
  setNs2ProPairing: (value: Ns2ProPairingStatus) => void,
  previousStatus: Ns2ProPairingStatus,
  graceRef: { current: Ns2ProPairingPresenceGrace },
): Promise<void> {
  const picoPath = Ds5BridgeHidClient.devicePath(client.device);
  setNs2ProPairing(waitingNs2ProPairingStatus());
  const status = await invoke<Ns2ProPicoBridgeStatusDto>("ds5_start_ns2pro_pico_bridge", {
    options: {
      picoPath,
      ns2proPath: null,
      readTimeoutMs: 1,
    },
  });
  setNs2ProPairing(stabilizeNs2ProPairingStatus(
    ns2ProPairingStatusFromDto(status),
    previousStatus,
    graceRef,
  ));
}

function formatSignalStrength(rssi: number | null): string {
  return typeof rssi === "number" && rssi <= -1 && rssi >= -127 ? `${rssi} dBm` : "--";
}

function inactiveNs2ProPairingStatus(): Ns2ProPairingStatus {
  return {
    phase: "inactive",
    running: false,
    picoPath: null,
    ns2proPath: null,
    ns2proOutputPath: null,
    inputTransport: null,
    inputTransportPort: null,
    inputTransportError: null,
    waitingReason: null,
    inputReportsReceived: 0,
    inputReportsForwarded: 0,
    outputReportsReceived: 0,
    outputReportsForwarded: 0,
    oversizedReports: 0,
    writeErrors: 0,
    readErrors: 0,
    lastSerialOutputReportLen: 0,
    lastSerialOutputReportHeadHex: null,
    lastOutputReportLen: 0,
    lastOutputReportHeadHex: null,
    lastOutputWriteLen: 0,
    lastOutputError: null,
    lastError: null,
  };
}

function isNs2ProWiredBridgeActive(status: Ns2ProPicoBridgeStatusDto | Ns2ProPairingStatus | null): boolean {
  if (!status) {
    return false;
  }

  const phase = "phase" in status ? status.phase : null;

  return Boolean(
    status.running &&
    status.picoPath &&
    status.ns2proPath &&
    (
      status.waitingReason === "forwarding" ||
      phase === "paired" ||
      status.inputReportsReceived > 0 ||
      status.inputReportsForwarded > 0 ||
      (status.outputReportsReceived ?? 0) > 0 ||
      (status.outputReportsForwarded ?? 0) > 0
    ),
  );
}

function coalesceKnownFirmwareVersion(nextValue: string, previousValue: string): string {
  if (nextValue !== "--") {
    return nextValue;
  }

  return previousValue !== "--" ? previousValue : "--";
}

function coalesceKnownSignalStrength(
  nextValue: string,
  previousValue: string,
  ds5Connected: boolean,
  bleState: Ns2ProBleState,
  ns2proConnected: boolean,
): string {
  if (nextValue !== "--") {
    return nextValue;
  }

  const sourceShouldHaveSignal = ds5Connected || bleState === "Ready";
  if (!sourceShouldHaveSignal || ns2proConnected && bleState !== "Ready") {
    return "--";
  }

  return previousValue !== "--" ? previousValue : "--";
}

function normalizeStatusDisplayValue(value: string | null | undefined): string {
  const normalized = value?.trim();
  return normalized ? normalized : "--";
}

function waitingNs2ProPairingStatus(): Ns2ProPairingStatus {
  return {
    ...inactiveNs2ProPairingStatus(),
    phase: "waiting",
    running: true,
  };
}

function ns2ProPairingErrorStatus(lastError: string): Ns2ProPairingStatus {
  return {
    ...inactiveNs2ProPairingStatus(),
    phase: "error",
    lastError,
  };
}

function ns2ProPairingStatusFromDto(status: Ns2ProPicoBridgeStatusDto): Ns2ProPairingStatus {
  const picoPath = status.picoPath ?? null;
  const ns2proPath = status.ns2proPath ?? null;
  const waitingReason = normalizeNs2ProWaitingReason(status.waitingReason ?? null, picoPath, ns2proPath);
  const lastError = status.lastError ?? null;
  const hasErrors = Boolean(lastError) ||
    status.oversizedReports > 0 ||
    (!status.running && (status.writeErrors > 0 || status.readErrors > 0));
  const paired = Boolean(picoPath) && Boolean(ns2proPath) && status.running && waitingReason === "forwarding";
  const hasDetectedEndpoint = Boolean(picoPath) || Boolean(ns2proPath);
  const phase: Ns2ProPairingPhase = paired ? "paired" : hasErrors ? "error" : status.running || hasDetectedEndpoint ? "waiting" : "inactive";

  return {
    phase,
    running: status.running,
    picoPath,
    ns2proPath,
    ns2proOutputPath: status.ns2proOutputPath ?? null,
    inputTransport: status.inputTransport ?? null,
    inputTransportPort: status.inputTransportPort ?? null,
    inputTransportError: status.inputTransportError ?? null,
    waitingReason,
    inputReportsReceived: status.inputReportsReceived,
    inputReportsForwarded: status.inputReportsForwarded,
    outputReportsReceived: status.outputReportsReceived ?? 0,
    outputReportsForwarded: status.outputReportsForwarded ?? 0,
    oversizedReports: status.oversizedReports,
    writeErrors: status.writeErrors,
    readErrors: status.readErrors,
    lastSerialOutputReportLen: status.lastSerialOutputReportLen ?? 0,
    lastSerialOutputReportHeadHex: status.lastSerialOutputReportHeadHex ?? null,
    lastOutputReportLen: status.lastOutputReportLen ?? 0,
    lastOutputReportHeadHex: status.lastOutputReportHeadHex ?? null,
    lastOutputWriteLen: status.lastOutputWriteLen ?? 0,
    lastOutputError: status.lastOutputError ?? null,
    lastError,
  };
}

function stabilizeNs2ProPairingStatus(
  nextStatus: Ns2ProPairingStatus,
  previousStatus: Ns2ProPairingStatus,
  graceRef: { current: Ns2ProPairingPresenceGrace },
): Ns2ProPairingStatus {
  const now = Date.now();
  const pairingFlow = isNs2ProPairingFlow(previousStatus) || isNs2ProPairingFlow(nextStatus);
  const graceMs = pairingFlow ? NS2PRO_PAIRING_DISCONNECT_GRACE_MS : NS2PRO_DISCONNECT_GRACE_MS;

  if (nextStatus.picoPath) {
    graceRef.current.picoUntil = now + graceMs;
  }
  if (nextStatus.ns2proPath) {
    graceRef.current.ns2proUntil = now + graceMs;
  }

  const canPreserve = previousStatus.phase !== "error" && nextStatus.phase !== "error";
  const preservePico = canPreserve &&
    !nextStatus.picoPath &&
    Boolean(previousStatus.picoPath) &&
    now < graceRef.current.picoUntil;
  const preserveNs2Pro = canPreserve &&
    !nextStatus.ns2proPath &&
    Boolean(previousStatus.ns2proPath) &&
    now < graceRef.current.ns2proUntil;

  if (!preservePico && !preserveNs2Pro) {
    return nextStatus;
  }

  const stabilized: Ns2ProPairingStatus = {
    ...nextStatus,
    picoPath: preservePico ? previousStatus.picoPath : nextStatus.picoPath,
    ns2proPath: preserveNs2Pro ? previousStatus.ns2proPath : nextStatus.ns2proPath,
    inputReportsReceived: Math.max(nextStatus.inputReportsReceived, previousStatus.inputReportsReceived),
    inputReportsForwarded: Math.max(nextStatus.inputReportsForwarded, previousStatus.inputReportsForwarded),
    outputReportsReceived: Math.max(nextStatus.outputReportsReceived, previousStatus.outputReportsReceived),
    outputReportsForwarded: Math.max(nextStatus.outputReportsForwarded, previousStatus.outputReportsForwarded),
    lastSerialOutputReportLen: nextStatus.lastSerialOutputReportLen || previousStatus.lastSerialOutputReportLen,
    lastSerialOutputReportHeadHex: nextStatus.lastSerialOutputReportHeadHex ?? previousStatus.lastSerialOutputReportHeadHex,
    lastOutputReportLen: nextStatus.lastOutputReportLen || previousStatus.lastOutputReportLen,
    lastOutputReportHeadHex: nextStatus.lastOutputReportHeadHex ?? previousStatus.lastOutputReportHeadHex,
    lastOutputWriteLen: nextStatus.lastOutputWriteLen || previousStatus.lastOutputWriteLen,
    lastOutputError: nextStatus.lastOutputError ?? previousStatus.lastOutputError,
    lastError: null,
  };

  stabilized.waitingReason = normalizeNs2ProWaitingReason(
    stabilized.waitingReason,
    stabilized.picoPath,
    stabilized.ns2proPath,
  );

  if (stabilized.phase !== "paired" && stabilized.phase !== "error" && (stabilized.picoPath || stabilized.ns2proPath)) {
    stabilized.phase = "waiting";
  }

  return stabilized;
}

function isNs2ProPairingFlow(status: Ns2ProPairingStatus): boolean {
  if (status.phase === "paired") {
    return true;
  }

  return status.waitingReason === "waitingInput" ||
    status.waitingReason === "waitingNs2ProBridgeStart" ||
    status.waitingReason === "waitingForwarding" ||
    status.waitingReason === "waitingDualSenseReconnect" ||
    status.waitingReason === "forwarding" ||
    (Boolean(status.picoPath) && Boolean(status.ns2proPath));
}

function normalizeNs2ProWaitingReason(
  waitingReason: string | null,
  picoPath: string | null,
  ns2proPath: string | null,
): string | null {
  if (waitingReason) {
    return waitingReason;
  }

  if (picoPath && ns2proPath) {
    return "waitingNs2ProBridgeStart";
  }

  if (picoPath) {
    return "waitingNs2Pro";
  }

  if (ns2proPath) {
    return "waitingPico";
  }

  return null;
}

function isNs2ProPairingReady(status: Ns2ProPairingStatus): boolean {
  return status.phase === "paired" || status.waitingReason === "forwarding";
}

function operationLabel(operation: Exclude<Operation, null>, t: (key: string) => string): string {
  switch (operation) {
    case "connecting":
      return t("status.connecting");
    case "reading":
      return t("status.reading");
    case "applying":
      return t("status.applying");
    case "saving":
      return t("status.saving");
    case "reconnecting":
      return t("status.reconnecting");
  }
}

function pickUsbEffectiveConfig(config: ConfigBody): UsbEffectiveConfig {
  return {
    pollingRateMode: config.pollingRateMode,
    controllerMode: config.controllerMode,
  };
}

function deviceListIncludes(devices: HIDDevice[], target: HIDDevice): boolean {
  const targetKey = getDeviceKey(target);
  return devices.some((device) => getDeviceKey(device) === targetKey);
}

function devicesEqual(left: HIDDevice[], right: HIDDevice[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((device, index) => getDeviceKey(device) === getDeviceKey(right[index]));
}

function replaceRecordIfChanged(current: Record<string, string>, next: Record<string, string>): Record<string, string> {
  const currentKeys = Object.keys(current);
  const nextKeys = Object.keys(next);
  if (currentKeys.length !== nextKeys.length) {
    return next;
  }

  return nextKeys.every((key) => current[key] === next[key]) ? current : next;
}

function usbEffectiveConfigChanged(current: UsbEffectiveConfig | null, next: ConfigBody): boolean {
  if (!current) {
    return false;
  }

  return current.pollingRateMode !== next.pollingRateMode || current.controllerMode !== next.controllerMode;
}

function errorMessage(cause: unknown, t: (key: string, values?: Record<string, unknown>) => string): string {
  if (cause instanceof ConfigDecodeError) {
    if (cause.code === "invalidConfig") {
      const fields = Array.isArray(cause.values.issues) ? cause.values.issues : [];
      const issues = fields.map((field) => t(`validation.${String(field)}`)).join("; ");

      return t("errors.invalidConfig", { issues });
    }

    return t("errors.invalidBytes", cause.values);
  }

  if (cause instanceof Error) {
    if (cause.message === NO_DEVICE_SELECTED_ERROR) {
      return t("errors.noDeviceSelected");
    }

    if (cause.message === WEBHID_UNAVAILABLE_ERROR) {
      return t("errors.webHidUnavailable");
    }

    return cause.message;
  }

  return t("errors.unexpectedWebHid");
}

function isNoDeviceSelectedError(cause: unknown): boolean {
  return cause instanceof Error && cause.message === NO_DEVICE_SELECTED_ERROR;
}
