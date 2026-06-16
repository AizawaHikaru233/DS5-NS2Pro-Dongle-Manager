import { invoke } from "@tauri-apps/api/core";
import {
  ConfigBody,
  ConfigDecodeError,
  FEATURE_REPORT_PAYLOAD_SIZE,
  decodeConfigBody,
  encodeConfigBody,
} from "./config";
import {
  CMD_SAVE_BUTTON_MAPPING,
  CMD_UPDATE_DS5_BUTTON_MAPPING,
  CMD_UPDATE_NS2PRO_BUTTON_MAPPING,
  DS5_MAPPING_REPORT_ID,
  NS2PRO_MAPPING_REPORT_ID,
  decodeDs5ButtonMapping,
  decodeNs2ProButtonMapping,
  encodeDs5ButtonMapping,
  encodeNs2ProButtonMapping,
  type Ds5ButtonMapping,
  type Ns2ProButtonMapping,
} from "./buttonMapping";

export const SONY_VENDOR_ID = 0x054c;
export const DUALSENSE_PRODUCT_ID = 0x0ce6;
export const DUALSENSE_EDGE_PRODUCT_ID = 0x0df2;
export const PICO_MANAGER_VENDOR_ID = 0x2e8a;
export const PICO_MANAGER_PRODUCT_ID = 0x00d5;
export const SUPPORTED_PRODUCT_IDS = [DUALSENSE_PRODUCT_ID, DUALSENSE_EDGE_PRODUCT_ID] as const;
export const NO_DEVICE_SELECTED_ERROR = "noDeviceSelected";
export const WEBHID_UNAVAILABLE_ERROR = "webHidUnavailable";

const REPORT_SET_CONFIG = 0xf6;
const REPORT_GET_CONFIG = 0xf7;
const REPORT_GET_FIRMWARE_VERSION = 0xf8;
const REPORT_GET_SIGNAL_STRENGTH = 0xf9;
const REPORT_COMMAND = 0x80;
const REPORT_RESULT = 0x81;
const CMD_UPDATE_CONFIG = 0x01;
const CMD_SAVE_TO_FLASH = 0x02;
const CMD_RECONNECT_USB = 0x03;
const DEVICE_SYSTEM = 0x01;
const ACTION_READ_SERIAL_NUMBER = 0x13;
const SERIAL_NUMBER_SIZE = 32;
const FEATURE_REPORT_DEFAULT_PAYLOAD_SIZE = FEATURE_REPORT_PAYLOAD_SIZE;
const FEATURE_REPORT_CHECKSUM_SIZE = 4;
const FEATURE_REPORT_CHECKSUM_PREFIX = 0x53;
const BRIDGE_STATUS_MIN_VERSION = 1;
const BRIDGE_STATUS_MAX_VERSION = 3;
const BRIDGE_BACKEND_BT_DS5 = 0;
const BRIDGE_BACKEND_NS2PRO = 1;
const BRIDGE_INPUT_OWNER_AUTO = 0;
const BRIDGE_INPUT_OWNER_DS5 = 1;
const BRIDGE_INPUT_OWNER_NS2PRO = 2;
const CMD_SET_INPUT_OWNER = 0x11;
const CMD_NS2PRO_BLE_START_PAIRING = 0x40;
const CMD_NS2PRO_BLE_CLEAR_BOND = 0x41;
const CMD_NS2PRO_CALIBRATE_STICK_CENTER = 0x42;
const deviceSessionKeyByPath = new Map<string, string>();
let nextDeviceSessionId = 1;

export interface TauriHidDeviceInfo {
  path: string;
  vendorId: number;
  productId: number;
  serialNumber?: string | null;
  manufacturerString?: string | null;
  productName?: string | null;
  releaseNumber?: number;
  interfaceNumber?: number;
  usagePage?: number;
  usage?: number;
}

export type PicoInputMode = "DS" | "NS2Pro";
export type PicoInputOwner = "Auto" | "DS5" | "NS2Pro";
export type Ns2ProBleState =
  | "Disabled"
  | "Idle"
  | "PairingRequested"
  | "Scanning"
  | "Connecting"
  | "Initializing"
  | "Ready"
  | "Error"
  | "Unsupported";

export interface PicoBridgeStatus {
  inputMode: PicoInputMode;
  lastError: number;
  inputOwner: PicoInputOwner;
  inputOwnerPolicy: PicoInputOwner;
  ds5Connected: boolean;
  ns2proConnected: boolean;
  ns2proBatteryText: string | null;
  signalStrength: number | null;
  ns2proBleState: Ns2ProBleState;
  ns2proBleLastError: number;
  ns2proBleHasBond: boolean;
  ns2proRumbleDebug: Ns2ProRumbleDebug | null;
}

export interface Ns2ProRumbleDebug {
  sequence: number;
  low: number;
  high: number;
  source: "none" | "rumble" | "haptics" | "mixed";
  bleSentCount: number;
  usbQueuedCount: number;
}

class TauriHidDevice extends EventTarget {
  opened = false;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly serialNumber?: string;
  readonly collections: HIDCollectionInfo[] = [];

  constructor(readonly info: TauriHidDeviceInfo) {
    super();
    this.vendorId = info.vendorId;
    this.productId = info.productId;
    this.productName = info.productName || "DS5 Bridge";
    this.serialNumber = info.serialNumber || undefined;
  }

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  async sendFeatureReport(reportId: number, data: BufferSource): Promise<void> {
    const bytes = data instanceof DataView
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    await invoke("ds5_send_feature_report", { path: this.info.path, reportId, data: Array.from(bytes) });
  }

  async receiveFeatureReport(reportId: number, length = FEATURE_REPORT_PAYLOAD_SIZE + 1): Promise<DataView> {
    const bytes = await invoke<number[]>("ds5_read_feature_report", {
      path: this.info.path,
      reportId,
      length,
    });
    return bytesToDataView(bytes);
  }

  async readInputReport(timeoutMs: number, length = 64): Promise<DataView | null> {
    const bytes = await invoke<number[] | null>("ds5_read_input_report", {
      path: this.info.path,
      timeoutMs,
      length,
    });
    return bytes ? bytesToDataView(bytes) : null;
  }
}

export class Ds5BridgeHidClient {
  private readonly tauriDevice: TauriHidDevice;

  constructor(public readonly device: HIDDevice) {
    this.tauriDevice = device as unknown as TauriHidDevice;
  }

  static isSupportedDevice(device: HIDDevice): boolean {
    return (
      device.vendorId === SONY_VENDOR_ID &&
      SUPPORTED_PRODUCT_IDS.includes(device.productId as 0x0ce6 | 0x0df2)
    ) || (
      device.vendorId === PICO_MANAGER_VENDOR_ID &&
      device.productId === PICO_MANAGER_PRODUCT_ID
    );
  }

  static async requestDevice(): Promise<Ds5BridgeHidClient> {
    const devices = await Ds5BridgeHidClient.authorizedDevices();
    const device = devices.find(isPicoManagerDevice) ?? devices[0];
    if (!device) {
      throw new Error(NO_DEVICE_SELECTED_ERROR);
    }

    return new Ds5BridgeHidClient(device);
  }

  static async authorizedDevices(): Promise<HIDDevice[]> {
    const devices = await invoke<TauriHidDeviceInfo[]>("ds5_list_devices");
    return tauriDeviceInfosToHidDevices(devices)
      .filter((device) => Ds5BridgeHidClient.isSupportedDevice(device))
      .sort(comparePicoManagementDevicePriority);
  }

  static devicePath(device: HIDDevice): string | null {
    return (device as unknown as TauriHidDevice).info?.path ?? null;
  }

  async open(): Promise<void> {
    if (!this.tauriDevice.opened) {
      await this.tauriDevice.open();
    }
  }

  async close(): Promise<void> {
    if (this.tauriDevice.opened) {
      await this.tauriDevice.close();
    }
  }

  async readConfig(): Promise<ConfigBody> {
    await this.open();
    const report = await this.tauriDevice.receiveFeatureReport(REPORT_GET_CONFIG);
    debugFeatureReport("readConfig receive", REPORT_GET_CONFIG, report);
    try {
      const config = decodeConfigBody(report);
      debugConfig("readConfig decoded", config);
      return config;
    } catch (cause) {
      if (cause instanceof ConfigDecodeError) {
        debugConfigDecodeError(cause);
      }

      throw cause;
    }
  }

  async applyConfig(config: ConfigBody): Promise<void> {
    await this.open();
    const body = encodeConfigBody(config);
    const report = commandReport(CMD_UPDATE_CONFIG);
    report.set(body, 1);
    await this.tauriDevice.sendFeatureReport(REPORT_SET_CONFIG, report);
  }

  async readDs5ButtonMapping(): Promise<Ds5ButtonMapping> {
    await this.open();
    const report = await this.tauriDevice.receiveFeatureReport(DS5_MAPPING_REPORT_ID);
    return decodeDs5ButtonMapping(report);
  }

  async readNs2ProButtonMapping(): Promise<Ns2ProButtonMapping> {
    await this.open();
    const report = await this.tauriDevice.receiveFeatureReport(NS2PRO_MAPPING_REPORT_ID);
    return decodeNs2ProButtonMapping(report);
  }

  async applyDs5ButtonMapping(mapping: Ds5ButtonMapping): Promise<void> {
    await this.open();
    const report = commandReport(CMD_UPDATE_DS5_BUTTON_MAPPING);
    report.set(encodeDs5ButtonMapping(mapping), 1);
    await this.tauriDevice.sendFeatureReport(REPORT_SET_CONFIG, report);
  }

  async applyNs2ProButtonMapping(mapping: Ns2ProButtonMapping): Promise<void> {
    await this.open();
    const report = commandReport(CMD_UPDATE_NS2PRO_BUTTON_MAPPING);
    report.set(encodeNs2ProButtonMapping(mapping), 1);
    await this.tauriDevice.sendFeatureReport(REPORT_SET_CONFIG, report);
  }

  async readFirmwareVersion(): Promise<string> {
    await this.open();
    const report = await this.tauriDevice.receiveFeatureReport(REPORT_GET_FIRMWARE_VERSION);
    debugFeatureReport("readFirmwareVersion receive", REPORT_GET_FIRMWARE_VERSION, report);
    return sanitizeFirmwareVersion(decodeNullTerminatedText(featureReportPayload(report, REPORT_GET_FIRMWARE_VERSION)));
  }

  async readPicoBridgeStatus(): Promise<PicoBridgeStatus> {
    await this.open();
    const report = await this.tauriDevice.receiveFeatureReport(REPORT_GET_SIGNAL_STRENGTH);
    debugFeatureReport("readPicoBridgeStatus receive", REPORT_GET_SIGNAL_STRENGTH, report);
    const payload = featureReportPayload(report, REPORT_GET_SIGNAL_STRENGTH);
    if (isBridgeStatusPayload(payload)) {
      const backend = payload.getUint8(1);
      const lastError = payload.byteLength >= 4 ? payload.getUint8(3) : 0;
      const inputOwner = decodeInputOwner(payload.byteLength >= 25 ? payload.getUint8(24) : BRIDGE_INPUT_OWNER_AUTO);
      const inputOwnerPolicy = decodeInputOwner(payload.byteLength >= 28 ? payload.getUint8(27) : BRIDGE_INPUT_OWNER_AUTO);
      const ds5Connected = payload.byteLength >= 26 ? payload.getUint8(25) !== 0 : false;
      const ns2proConnected = payload.byteLength >= 27 ? payload.getUint8(26) !== 0 : false;
      const ns2proBatteryText = payload.byteLength >= 29 ? formatBatteryPercent(payload.getUint8(28)) : null;
      const ns2proBleState = decodeNs2ProBleState(payload.byteLength >= 31 ? payload.getUint8(30) : 0);
      const rssi = payload.byteLength >= 30 ? payload.getInt8(29) : 0;
      const signalStrength = rssi < 0 ? rssi : null;
      const ns2proBleLastError = payload.byteLength >= 32 ? payload.getUint8(31) : 0;
      const ns2proBleHasBond = payload.byteLength >= 33 ? payload.getUint8(32) !== 0 : false;
      const ns2proRumbleDebug = decodeNs2ProRumbleDebug(payload);
      if (backend === BRIDGE_BACKEND_NS2PRO) {
        return { inputMode: "NS2Pro", lastError, inputOwner, inputOwnerPolicy, ds5Connected, ns2proConnected, ns2proBatteryText, signalStrength, ns2proBleState, ns2proBleLastError, ns2proBleHasBond, ns2proRumbleDebug };
      }
      if (backend === BRIDGE_BACKEND_BT_DS5) {
        return { inputMode: "DS", lastError, inputOwner: "DS5", inputOwnerPolicy: "DS5", ds5Connected, ns2proConnected, ns2proBatteryText, signalStrength, ns2proBleState, ns2proBleLastError, ns2proBleHasBond, ns2proRumbleDebug: null };
      }
    }

    return {
      inputMode: "DS",
      lastError: 0,
      inputOwner: "DS5",
      inputOwnerPolicy: "DS5",
      ds5Connected: false,
      ns2proConnected: false,
      ns2proBatteryText: null,
      signalStrength: payload.byteLength > 0 ? payload.getInt8(0) : null,
      ns2proBleState: "Disabled",
      ns2proBleLastError: 0,
      ns2proBleHasBond: false,
      ns2proRumbleDebug: null,
    };
  }

  async setInputOwner(owner: PicoInputOwner): Promise<void> {
    await this.open();
    const report = commandReport(CMD_SET_INPUT_OWNER);
    report[1] = encodeInputOwner(owner);
    await this.tauriDevice.sendFeatureReport(REPORT_SET_CONFIG, report);
  }

  async startNs2ProBlePairing(): Promise<void> {
    await this.open();
    await this.tauriDevice.sendFeatureReport(REPORT_SET_CONFIG, commandReport(CMD_NS2PRO_BLE_START_PAIRING));
  }

  async clearNs2ProBleBond(): Promise<void> {
    await this.open();
    await this.tauriDevice.sendFeatureReport(REPORT_SET_CONFIG, commandReport(CMD_NS2PRO_BLE_CLEAR_BOND));
  }

  async calibrateNs2ProStickCenter(): Promise<void> {
    await this.open();
    await this.tauriDevice.sendFeatureReport(REPORT_SET_CONFIG, commandReport(CMD_NS2PRO_CALIBRATE_STICK_CENTER));
  }

  async readSignalStrength(): Promise<number | null> {
    return (await this.readPicoBridgeStatus()).signalStrength;
  }

  async readInputMode(): Promise<PicoInputMode> {
    return (await this.readPicoBridgeStatus()).inputMode;
  }

  async readBatteryText(timeoutMs: number): Promise<string | null> {
    await this.open();
    const report = await this.tauriDevice.readInputReport(timeoutMs);
    return report ? parseDualSenseBatteryText(report) : null;
  }

  async saveToFlash(): Promise<void> {
    await this.open();
    await this.tauriDevice.sendFeatureReport(REPORT_SET_CONFIG, commandReport(CMD_SAVE_TO_FLASH));
    await this.tauriDevice.sendFeatureReport(REPORT_SET_CONFIG, commandReport(CMD_SAVE_BUTTON_MAPPING));
  }

  async reconnectUsb(): Promise<void> {
    await this.open();
    await this.tauriDevice.sendFeatureReport(REPORT_SET_CONFIG, commandReport(CMD_RECONNECT_USB));
    this.tauriDevice.opened = false;
  }

  async readSerialNumber(): Promise<string> {
    await this.open();

    const reportLength = FEATURE_REPORT_DEFAULT_PAYLOAD_SIZE;
    const payload = new Uint8Array(new ArrayBuffer(reportLength));
    payload[0] = DEVICE_SYSTEM;
    payload[1] = ACTION_READ_SERIAL_NUMBER;

    if (isBluetoothFeatureReport(reportLength)) {
      fillFeatureReportChecksum(REPORT_COMMAND, payload);
    }

    await this.tauriDevice.sendFeatureReport(REPORT_COMMAND, payload);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const report = await this.tauriDevice.receiveFeatureReport(REPORT_RESULT);

      if (isSerialNumberResult(report)) {
        return decodeSerialNumber(new DataView(report.buffer, report.byteOffset + 4, SERIAL_NUMBER_SIZE));
      }

      await sleep(10);
    }

    return this.device.serialNumber || "--";
  }
}

export async function startDeviceMonitor(): Promise<void> {
  await invoke("ds5_start_device_monitor");
}

export function tauriDeviceInfosToHidDevices(devices: TauriHidDeviceInfo[]): HIDDevice[] {
  return devices.map((device) => new TauriHidDevice(device) as unknown as HIDDevice);
}

export function isAutoConnectCandidate(device: HIDDevice): boolean {
  return Ds5BridgeHidClient.isSupportedDevice(device);
}

export function isPicoManagementDevice(device: HIDDevice): boolean {
  if (!Ds5BridgeHidClient.isSupportedDevice(device)) {
    return false;
  }

  return isPicoManagerDevice(device) || isDualSenseRuntimeDevice(device);
}

export function webHidAvailable(): boolean {
  return true;
}

export function getDeviceLabel(device: HIDDevice | null): string {
  if (!device) {
    return "No device";
  }

  const productId = device.productId.toString(16).padStart(4, "0").toUpperCase();
  const serialNumber = device.serialNumber?.trim();
  const descriptorSummary = getDeviceDescriptorSummary(device);
  return `${device.productName || "DS5 Bridge"} · 054C:${productId}${serialNumber ? ` · ${serialNumber}` : ""}${descriptorSummary ? ` · ${descriptorSummary}` : ""}`;
}

export function getDeviceKey(device: HIDDevice): string {
  const path = (device as unknown as TauriHidDevice).info?.path;
  if (path) {
    const cachedKey = deviceSessionKeyByPath.get(path);
    if (cachedKey) {
      return cachedKey;
    }
    const key = device.serialNumber?.trim() ? `serial:${device.vendorId}:${device.productId}:${device.serialNumber}` : `path:${path}`;
    deviceSessionKeyByPath.set(path, key);
    return key;
  }

  return `session:${nextDeviceSessionId++}`;
}

export function getDevicePortKey(device: HIDDevice): string {
  const info = (device as unknown as TauriHidDevice).info;
  const path = info?.path.toLowerCase();
  if (!path) {
    return getDeviceKey(device);
  }

  const usbInstance = path.match(/vid_[0-9a-f]{4}&pid_[0-9a-f]{4}[^#]*/)?.[0];
  const normalizedInstance = usbInstance?.replace(/&mi_[0-9a-f]{2}.*/, "");
  if (normalizedInstance) {
    return `usb:${device.vendorId}:${device.productId}:${normalizedInstance}`;
  }

  return `path:${path.replace(/&col\d+/, "")}`;
}

export function getControllerIconSrc(device: HIDDevice | null): string {
  return device?.productId === DUALSENSE_EDGE_PRODUCT_ID ? "/images/ps5-controller-edge.webp" : "/svg/ps5-controller-gamepad-seeklogo.svg";
}

function commandReport(command: number): Uint8Array<ArrayBuffer> {
  const report = new Uint8Array(new ArrayBuffer(FEATURE_REPORT_PAYLOAD_SIZE));
  report[0] = command;
  return report;
}

function getDeviceDescriptorSummary(device: HIDDevice): string {
  const info = (device as unknown as TauriHidDevice).info;
  return info?.interfaceNumber !== undefined ? `interface ${info.interfaceNumber}` : "";
}

function isBluetoothFeatureReport(reportLength: number): boolean {
  return reportLength > FEATURE_REPORT_DEFAULT_PAYLOAD_SIZE;
}

function isSerialNumberResult(report: DataView): boolean {
  return (
    report.byteLength >= SERIAL_NUMBER_SIZE + 4 &&
    report.getUint8(0) === REPORT_RESULT &&
    report.getUint8(1) === DEVICE_SYSTEM &&
    report.getUint8(2) === ACTION_READ_SERIAL_NUMBER
  );
}

function featureReportPayload(report: DataView, reportId: number): DataView {
  if (report.byteLength > 0 && report.getUint8(0) === reportId) {
    return new DataView(report.buffer, report.byteOffset + 1, report.byteLength - 1);
  }

  return report;
}

function isBridgeStatusPayload(payload: DataView): boolean {
  const version = payload.byteLength >= 1 ? payload.getUint8(0) : 0;
  return (
    payload.byteLength >= 2 &&
    version >= BRIDGE_STATUS_MIN_VERSION &&
    version <= BRIDGE_STATUS_MAX_VERSION &&
    (payload.getUint8(1) === BRIDGE_BACKEND_BT_DS5 || payload.getUint8(1) === BRIDGE_BACKEND_NS2PRO)
  );
}

function decodeInputOwner(owner: number): PicoInputOwner {
  if (owner === BRIDGE_INPUT_OWNER_DS5) {
    return "DS5";
  }
  if (owner === BRIDGE_INPUT_OWNER_NS2PRO) {
    return "NS2Pro";
  }
  return "Auto";
}

function decodeNs2ProBleState(state: number): Ns2ProBleState {
  switch (state) {
    case 1:
      return "Idle";
    case 2:
      return "PairingRequested";
    case 3:
      return "Scanning";
    case 4:
      return "Connecting";
    case 5:
      return "Initializing";
    case 6:
      return "Ready";
    case 7:
      return "Error";
    case 8:
      return "Unsupported";
    default:
      return "Disabled";
  }
}

function decodeNs2ProRumbleDebug(payload: DataView): Ns2ProRumbleDebug | null {
  if (payload.byteLength < 63 || payload.getUint8(0) < 3) {
    return null;
  }

  return {
    sequence: payload.getUint8(57),
    low: payload.getUint8(58),
    high: payload.getUint8(59),
    source: decodeNs2ProRumbleSource(payload.getUint8(60)),
    bleSentCount: payload.getUint8(61),
    usbQueuedCount: payload.getUint8(62),
  };
}

function decodeNs2ProRumbleSource(source: number): Ns2ProRumbleDebug["source"] {
  switch (source) {
    case 1:
      return "rumble";
    case 2:
      return "haptics";
    case 3:
      return "mixed";
    default:
      return "none";
  }
}

function encodeInputOwner(owner: PicoInputOwner): number {
  if (owner === "DS5") {
    return BRIDGE_INPUT_OWNER_DS5;
  }
  if (owner === "NS2Pro") {
    return BRIDGE_INPUT_OWNER_NS2PRO;
  }
  return BRIDGE_INPUT_OWNER_AUTO;
}

function decodeSerialNumber(data: DataView): string {
  return new TextDecoder("shift_jis").decode(data).replace(/\0/g, "").trim();
}

function decodeNullTerminatedText(data: DataView): string {
  return new TextDecoder().decode(data).replace(/\0/g, "").trim();
}

function sanitizeFirmwareVersion(version: string): string {
  const normalized = version.trim();

  if (/^\d{3}$/.test(normalized) || /^v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized)) {
    return normalized;
  }

  const embeddedVersion = normalized.match(/v?(\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?)/i);
  if (embeddedVersion?.[1]) {
    return embeddedVersion[1];
  }

  return "--";
}

function comparePicoManagementDevicePriority(left: HIDDevice, right: HIDDevice): number {
  return devicePriority(left) - devicePriority(right);
}

function devicePriority(device: HIDDevice): number {
  if (isDualSenseRuntimeDevice(device)) {
    return 0;
  }

  if (isPicoManagerDevice(device)) {
    return 1;
  }

  return 2;
}

function isPicoManagerDevice(device: HIDDevice): boolean {
  return device.vendorId === PICO_MANAGER_VENDOR_ID && device.productId === PICO_MANAGER_PRODUCT_ID;
}

function isDualSenseRuntimeDevice(device: HIDDevice): boolean {
  if (!(device.vendorId === SONY_VENDOR_ID &&
      SUPPORTED_PRODUCT_IDS.includes(device.productId as 0x0ce6 | 0x0df2))) {
    return false;
  }

  const info = (device as unknown as TauriHidDevice).info;
  return info?.interfaceNumber === 3 || info?.usagePage === 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function fillFeatureReportChecksum(reportId: number, reportData: Uint8Array): void {
  if (reportData.byteLength <= FEATURE_REPORT_CHECKSUM_SIZE) {
    return;
  }

  const body = new DataView(reportData.buffer, reportData.byteOffset, reportData.byteLength - FEATURE_REPORT_CHECKSUM_SIZE);
  const crc = crc32([FEATURE_REPORT_CHECKSUM_PREFIX, reportId], body);

  reportData[reportData.byteLength - 4] = crc & 0xff;
  reportData[reportData.byteLength - 3] = (crc >>> 8) & 0xff;
  reportData[reportData.byteLength - 2] = (crc >>> 16) & 0xff;
  reportData[reportData.byteLength - 1] = (crc >>> 24) & 0xff;
}

function crc32(prefixBytes: number[], dataView: DataView): number {
  let crc = -1 >>> 0;

  for (const byte of prefixBytes) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  }

  for (let i = 0; i < dataView.byteLength; ++i) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ dataView.getUint8(i)) & 0xff];
  }

  return (crc ^ -1) >>> 0;
}

function makeCrcTable(): number[] {
  const table: number[] = [];

  for (let n = 0; n < 256; ++n) {
    let c = n;

    for (let k = 0; k < 8; ++k) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }

    table[n] = c >>> 0;
  }

  return table;
}

const crcTable = makeCrcTable();

function bytesToDataView(bytes: number[]): DataView {
  const buffer = new Uint8Array(bytes).buffer;
  return new DataView(buffer);
}

function parseDualSenseBatteryText(report: DataView): string | null {
  const reportId = report.byteLength > 0 ? report.getUint8(0) : 0;
  const status0Offset = reportId === 0x31 ? 54 : 53;
  if (report.byteLength <= status0Offset) {
    return null;
  }

  const status0 = report.getUint8(status0Offset);
  const chargeStatus = (status0 & 0xf0) >> 4;
  let level = status0 & 0x0f;

  if (chargeStatus === 2) {
    level = 10;
  }

  if (level >= 10) {
    return "100%";
  }

  if (level >= 0) {
    return `${Math.min(level * 10 + 5, 100)}%`;
  }

  return null;
}

function formatBatteryPercent(percent: number): string | null {
  if (!Number.isInteger(percent) || percent > 100) {
    return null;
  }

  return `${percent}%`;
}

function debugFeatureReport(label: string, reportId: number, data: DataView): void {
  if (!import.meta.env.DEV) {
    return;
  }

  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  console.info(`[DS5 Bridge HID] ${label}`, {
    reportId: `0x${reportId.toString(16).padStart(2, "0")}`,
    byteLength: data.byteLength,
    hex: bytesToHex(bytes),
  });
}

function debugConfig(label: string, config: ConfigBody): void {
  if (!import.meta.env.DEV) {
    return;
  }

  console.info(`[DS5 Bridge HID] ${label}`, config);
}

function debugConfigDecodeError(error: ConfigDecodeError): void {
  if (!import.meta.env.DEV) {
    return;
  }

  console.warn("[DS5 Bridge HID] readConfig decode failed", error.values);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}
