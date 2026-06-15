export const CONFIG_BODY_SIZE = 33;
export const FEATURE_REPORT_PAYLOAD_SIZE = 63;
export const CONFIG_VERSION = 8;

export type PollingRateMode = 0 | 1 | 2;
export type ControllerMode = 0 | 1 | 2;
export type Ns2ProRumbleStyle = 0 | 1;

export interface ConfigBody {
  configVersion: number;
  ds5HapticsGain: number;
  speakerVolume: number;
  inactiveTime: number;
  disableInactiveDisconnect: boolean;
  disablePicoLed: boolean;
  pollingRateMode: PollingRateMode;
  hapticsBufferLength: number;
  controllerMode: ControllerMode;
  ns2proRumbleGain: number;
  ns2proRumbleStyle: Ns2ProRumbleStyle;
  ns2proBleHasTarget: boolean;
  ns2proBleAddressType: 0 | 1;
  ns2proBleAddress: [number, number, number, number, number, number];
  ds5LeftStickDeadzonePercent: number;
  ds5RightStickDeadzonePercent: number;
  ns2proLeftStickDeadzonePercent: number;
  ns2proRightStickDeadzonePercent: number;
  ns2proAutoStickCenter: boolean;
}

export interface ConfigValidationIssue {
  field: keyof ConfigBody;
}

export const DEFAULT_CONFIG: ConfigBody = {
  configVersion: CONFIG_VERSION,
  ds5HapticsGain: 1,
  speakerVolume: 0,
  inactiveTime: 30,
  disableInactiveDisconnect: false,
  disablePicoLed: false,
  pollingRateMode: 0,
  hapticsBufferLength: 64,
  controllerMode: 2,
  ns2proRumbleGain: 1,
  ns2proRumbleStyle: 1,
  ns2proBleHasTarget: false,
  ns2proBleAddressType: 0,
  ns2proBleAddress: [0, 0, 0, 0, 0, 0],
  ds5LeftStickDeadzonePercent: 3,
  ds5RightStickDeadzonePercent: 0,
  ns2proLeftStickDeadzonePercent: 3,
  ns2proRightStickDeadzonePercent: 0,
  ns2proAutoStickCenter: true,
};

export const POLLING_RATE_OPTIONS: Array<{
  value: PollingRateMode;
  label: string;
}> = [
  { value: 0, label: "250 Hz" },
  { value: 1, label: "500 Hz" },
  { value: 2, label: "1000 Hz" },
];

export const CONTROLLER_MODE_OPTIONS: Array<{
  value: ControllerMode;
}> = [
  { value: 0 },
  { value: 1 },
  { value: 2 },
];

export function decodeConfigBody(source: ArrayBuffer | DataView | Uint8Array): ConfigBody {
  const bytes = toUint8Array(source);
  const candidates = configBodyOffsets(bytes.byteLength);
  const parsed = candidates
    .map((offset) => {
      const config = decodeAt(bytes, offset);
      return config ? { offset, config, issues: validateConfig(config) } : null;
    })
    .filter(Boolean) as Array<{ offset: number; config: ConfigBody; issues: ConfigValidationIssue[] }>;
  const valid = parsed.find((candidate) => candidate.issues.length === 0);

  if (valid) {
    return valid.config;
  }

  if (parsed[0]) {
    throw new ConfigDecodeError("invalidConfig", {
      issues: parsed[0].issues.map((issue) => issue.field),
      offset: parsed[0].offset,
      candidates: parsed.map(({ offset, issues }) => ({
        offset,
        issues: issues.map((issue) => issue.field),
      })),
      rawHex: bytesToHex(bytes),
    });
  }

  throw new ConfigDecodeError("invalidBytes", {
    count: bytes.byteLength,
    expected: CONFIG_BODY_SIZE,
  });
}

export function encodeConfigBody(config: ConfigBody): Uint8Array<ArrayBuffer> {
  const issues = validateConfig(config);
  if (issues.length > 0) {
    throw new ConfigDecodeError("invalidConfig", {
      issues: issues.map((issue) => issue.field),
    });
  }

  const bytes = new Uint8Array(new ArrayBuffer(CONFIG_BODY_SIZE));
  const view = new DataView(bytes.buffer);
  view.setUint8(0, config.configVersion);
  view.setFloat32(1, config.ds5HapticsGain, true);
  view.setFloat32(5, config.speakerVolume, true);
  view.setUint8(9, config.inactiveTime);
  view.setUint8(10, config.disableInactiveDisconnect ? 1 : 0);
  view.setUint8(11, config.disablePicoLed ? 1 : 0);
  view.setUint8(12, config.pollingRateMode);
  view.setUint8(13, config.hapticsBufferLength);
  view.setUint8(14, config.controllerMode);
  view.setFloat32(15, config.ns2proRumbleGain, true);
  view.setUint8(19, config.ns2proRumbleStyle);
  view.setUint8(20, config.ns2proBleHasTarget ? 1 : 0);
  view.setUint8(21, config.ns2proBleAddressType);
  config.ns2proBleAddress.forEach((byte, index) => view.setUint8(22 + index, byte));
  view.setUint8(28, config.ds5LeftStickDeadzonePercent);
  view.setUint8(29, config.ds5RightStickDeadzonePercent);
  view.setUint8(30, config.ns2proLeftStickDeadzonePercent);
  view.setUint8(31, config.ns2proRightStickDeadzonePercent);
  view.setUint8(32, config.ns2proAutoStickCenter ? 1 : 0);
  return bytes;
}

export function validateConfig(config: ConfigBody): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];

  if (!Number.isInteger(config.configVersion) || config.configVersion < 0 || config.configVersion > 255) {
    issues.push({ field: "configVersion" });
  }

  if (!Number.isFinite(config.ds5HapticsGain) || config.ds5HapticsGain < 0 || config.ds5HapticsGain > 2) {
    issues.push({ field: "ds5HapticsGain" });
  }

  if (!Number.isFinite(config.speakerVolume) || config.speakerVolume < -100 || config.speakerVolume > 0) {
    issues.push({ field: "speakerVolume" });
  }

  if (!Number.isInteger(config.inactiveTime) || config.inactiveTime < 5 || config.inactiveTime > 60) {
    issues.push({ field: "inactiveTime" });
  }

  if (!Number.isInteger(config.pollingRateMode) || config.pollingRateMode < 0 || config.pollingRateMode > 2) {
    issues.push({ field: "pollingRateMode" });
  }

  if (
    !Number.isInteger(config.hapticsBufferLength) ||
    config.hapticsBufferLength < 16 ||
    config.hapticsBufferLength > 128
  ) {
    issues.push({ field: "hapticsBufferLength" });
  }

  if (!Number.isInteger(config.controllerMode) || config.controllerMode < 0 || config.controllerMode > 2) {
    issues.push({ field: "controllerMode" });
  }

  if (!Number.isFinite(config.ns2proRumbleGain) || config.ns2proRumbleGain < 0 || config.ns2proRumbleGain > 2) {
    issues.push({ field: "ns2proRumbleGain" });
  }

  if (!Number.isInteger(config.ns2proRumbleStyle) || config.ns2proRumbleStyle < 0 || config.ns2proRumbleStyle > 1) {
    issues.push({ field: "ns2proRumbleStyle" });
  }

  if (!Number.isInteger(config.ns2proBleAddressType) || config.ns2proBleAddressType < 0 || config.ns2proBleAddressType > 1) {
    issues.push({ field: "ns2proBleAddressType" });
  }

  if (
    !Array.isArray(config.ns2proBleAddress) ||
    config.ns2proBleAddress.length !== 6 ||
    config.ns2proBleAddress.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  ) {
    issues.push({ field: "ns2proBleAddress" });
  }

  if (!Number.isInteger(config.ds5LeftStickDeadzonePercent) || config.ds5LeftStickDeadzonePercent < 0 || config.ds5LeftStickDeadzonePercent > 30) {
    issues.push({ field: "ds5LeftStickDeadzonePercent" });
  }

  if (!Number.isInteger(config.ds5RightStickDeadzonePercent) || config.ds5RightStickDeadzonePercent < 0 || config.ds5RightStickDeadzonePercent > 30) {
    issues.push({ field: "ds5RightStickDeadzonePercent" });
  }

  if (!Number.isInteger(config.ns2proLeftStickDeadzonePercent) || config.ns2proLeftStickDeadzonePercent < 0 || config.ns2proLeftStickDeadzonePercent > 30) {
    issues.push({ field: "ns2proLeftStickDeadzonePercent" });
  }

  if (!Number.isInteger(config.ns2proRightStickDeadzonePercent) || config.ns2proRightStickDeadzonePercent < 0 || config.ns2proRightStickDeadzonePercent > 30) {
    issues.push({ field: "ns2proRightStickDeadzonePercent" });
  }

  return issues;
}

export function normalizeConfig(config: ConfigBody): ConfigBody {
  return {
    configVersion: clampInteger(config.configVersion ?? CONFIG_VERSION, 0, 255),
    ds5HapticsGain: clampToStep(config.ds5HapticsGain, 0, 2, 0.01),
    speakerVolume: clampToStep(config.speakerVolume, -100, 0, 0.01),
    inactiveTime: clampInteger(config.inactiveTime, 5, 60),
    disableInactiveDisconnect: Boolean(config.disableInactiveDisconnect),
    disablePicoLed: Boolean(config.disablePicoLed),
    pollingRateMode: clampInteger(config.pollingRateMode, 0, 2) as PollingRateMode,
    hapticsBufferLength: clampInteger(config.hapticsBufferLength, 16, 128),
    controllerMode: clampInteger(config.controllerMode, 0, 2) as ControllerMode,
    ns2proRumbleGain: clampToStep(config.ns2proRumbleGain, 0, 2, 0.01),
    ns2proRumbleStyle: clampInteger(config.ns2proRumbleStyle, 0, 1) as Ns2ProRumbleStyle,
    ns2proBleHasTarget: Boolean(config.ns2proBleHasTarget),
    ns2proBleAddressType: clampInteger(config.ns2proBleAddressType, 0, 1) as 0 | 1,
    ns2proBleAddress: normalizeBleAddress(config.ns2proBleAddress),
    ds5LeftStickDeadzonePercent: clampInteger(config.ds5LeftStickDeadzonePercent, 0, 30),
    ds5RightStickDeadzonePercent: clampInteger(config.ds5RightStickDeadzonePercent, 0, 30),
    ns2proLeftStickDeadzonePercent: clampInteger(config.ns2proLeftStickDeadzonePercent, 0, 30),
    ns2proRightStickDeadzonePercent: clampInteger(config.ns2proRightStickDeadzonePercent, 0, 30),
    ns2proAutoStickCenter: Boolean(config.ns2proAutoStickCenter),
  };
}

export function configsEqual(left: ConfigBody | null, right: ConfigBody | null): boolean {
  if (!left || !right) {
    return left === right;
  }

  return (
    left.configVersion === right.configVersion &&
    Math.abs(left.ds5HapticsGain - right.ds5HapticsGain) < 0.001 &&
    Math.abs(left.speakerVolume - right.speakerVolume) < 0.001 &&
    left.inactiveTime === right.inactiveTime &&
    left.disableInactiveDisconnect === right.disableInactiveDisconnect &&
    left.disablePicoLed === right.disablePicoLed &&
    left.pollingRateMode === right.pollingRateMode &&
    left.hapticsBufferLength === right.hapticsBufferLength &&
    left.controllerMode === right.controllerMode &&
    Math.abs(left.ns2proRumbleGain - right.ns2proRumbleGain) < 0.001 &&
    left.ns2proRumbleStyle === right.ns2proRumbleStyle &&
    left.ns2proBleHasTarget === right.ns2proBleHasTarget &&
    left.ns2proBleAddressType === right.ns2proBleAddressType &&
    left.ns2proBleAddress.every((byte, index) => byte === right.ns2proBleAddress[index]) &&
    left.ds5LeftStickDeadzonePercent === right.ds5LeftStickDeadzonePercent &&
    left.ds5RightStickDeadzonePercent === right.ds5RightStickDeadzonePercent &&
    left.ns2proLeftStickDeadzonePercent === right.ns2proLeftStickDeadzonePercent &&
    left.ns2proRightStickDeadzonePercent === right.ns2proRightStickDeadzonePercent &&
    left.ns2proAutoStickCenter === right.ns2proAutoStickCenter
  );
}

export function fieldIssue(
  issues: ConfigValidationIssue[],
  field: keyof ConfigBody,
): ConfigValidationIssue | undefined {
  return issues.find((issue) => issue.field === field);
}

export class ConfigDecodeError extends Error {
  constructor(
    public readonly code: "invalidConfig" | "invalidBytes",
    public readonly values: Record<string, unknown>,
  ) {
    super(code);
    this.name = "ConfigDecodeError";
  }
}

function decodeAt(bytes: Uint8Array, offset: number): ConfigBody | null {
  if (bytes.byteLength - offset < CONFIG_BODY_SIZE) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, CONFIG_BODY_SIZE);
  return {
    configVersion: view.getUint8(0),
    ds5HapticsGain: view.getFloat32(1, true),
    speakerVolume: view.getFloat32(5, true),
    inactiveTime: view.getUint8(9),
    disableInactiveDisconnect: view.getUint8(10) === 1,
    disablePicoLed: view.getUint8(11) === 1,
    pollingRateMode: view.getUint8(12) as PollingRateMode,
    hapticsBufferLength: view.getUint8(13),
    controllerMode: view.getUint8(14) as ControllerMode,
    ns2proRumbleGain: view.getFloat32(15, true),
    ns2proRumbleStyle: view.getUint8(19) as Ns2ProRumbleStyle,
    ns2proBleHasTarget: view.getUint8(20) === 1,
    ns2proBleAddressType: view.getUint8(21) as 0 | 1,
    ns2proBleAddress: [
      view.getUint8(22),
      view.getUint8(23),
      view.getUint8(24),
      view.getUint8(25),
      view.getUint8(26),
      view.getUint8(27),
    ],
    ds5LeftStickDeadzonePercent: view.getUint8(28),
    ds5RightStickDeadzonePercent: view.getUint8(29),
    ns2proLeftStickDeadzonePercent: view.getUint8(30),
    ns2proRightStickDeadzonePercent: view.getUint8(31),
    ns2proAutoStickCenter: view.getUint8(32) === 1,
  };
}

function configBodyOffsets(byteLength: number): number[] {
  if (byteLength < CONFIG_BODY_SIZE) {
    return [];
  }

  const offsets = new Set<number>([0]);
  if (byteLength >= CONFIG_BODY_SIZE + 1) {
    offsets.add(1);
  }

  for (let offset = 2; offset <= byteLength - CONFIG_BODY_SIZE; offset += 1) {
    offsets.add(offset);
  }

  return [...offsets];
}

function toUint8Array(source: ArrayBuffer | DataView | Uint8Array): Uint8Array {
  if (source instanceof Uint8Array) {
    return source;
  }

  if (source instanceof DataView) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  }

  return new Uint8Array(source);
}

function roundToStep(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampToStep(value: number, min: number, max: number, step: number): number {
  return Math.min(max, Math.max(min, roundToStep(value, step)));
}

function normalizeBleAddress(address: ConfigBody["ns2proBleAddress"]): ConfigBody["ns2proBleAddress"] {
  if (!Array.isArray(address) || address.length !== 6) {
    return [0, 0, 0, 0, 0, 0];
  }

  return address.map((byte) => clampInteger(byte, 0, 255)) as ConfigBody["ns2proBleAddress"];
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}
