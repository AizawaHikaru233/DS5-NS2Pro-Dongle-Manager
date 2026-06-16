export const DS5_MAPPING_REPORT_ID = 0xfa;
export const NS2PRO_MAPPING_REPORT_ID = 0xfb;

export const CMD_UPDATE_DS5_BUTTON_MAPPING = 0x50;
export const CMD_SAVE_BUTTON_MAPPING = 0x51;
export const CMD_UPDATE_NS2PRO_BUTTON_MAPPING = 0x52;

export const BUTTON_MAPPING_TARGETS = [
  "up",
  "right",
  "down",
  "left",
  "square",
  "cross",
  "circle",
  "triangle",
  "l1",
  "r1",
  "l2",
  "r2",
  "create",
  "options",
  "l3",
  "r3",
  "ps",
  "touchpad",
  "mute",
  "leftFunction",
  "rightFunction",
  "leftPaddle",
  "rightPaddle",
] as const;

export type ButtonMappingTarget = typeof BUTTON_MAPPING_TARGETS[number] | "none";

export const BUTTON_MAPPING_TARGET_NONE = 0xff;

export const DS5_MAPPING_INPUTS = [
  "up",
  "right",
  "down",
  "left",
  "square",
  "cross",
  "circle",
  "triangle",
  "l1",
  "r1",
  "l2",
  "r2",
  "create",
  "options",
  "l3",
  "r3",
  "ps",
  "touchpad",
  "mute",
  "leftFunction",
  "rightFunction",
  "leftPaddle",
  "rightPaddle",
] as const;

export type Ds5MappingInput = typeof DS5_MAPPING_INPUTS[number];

export const NS2PRO_MAPPING_INPUTS = [
  "up",
  "right",
  "down",
  "left",
  "y",
  "b",
  "a",
  "x",
  "l",
  "r",
  "zl",
  "zr",
  "minus",
  "plus",
  "l3",
  "r3",
  "home",
  "capture",
  "gl",
  "gr",
] as const;

export type Ns2ProMappingInput = typeof NS2PRO_MAPPING_INPUTS[number];

export type Ds5ButtonMapping = Record<Ds5MappingInput, ButtonMappingTarget>;
export type Ns2ProButtonMapping = Record<Ns2ProMappingInput, ButtonMappingTarget>;

const targetIndexToKey = [...BUTTON_MAPPING_TARGETS, "none"] as const;

export const DEFAULT_DS5_BUTTON_MAPPING: Ds5ButtonMapping = Object.fromEntries(
  DS5_MAPPING_INPUTS.map((key) => [key, key]),
) as Ds5ButtonMapping;

export const DEFAULT_NS2PRO_BUTTON_MAPPING: Ns2ProButtonMapping = {
  up: "up",
  right: "right",
  down: "down",
  left: "left",
  y: "square",
  b: "cross",
  a: "circle",
  x: "triangle",
  l: "l1",
  r: "r1",
  zl: "l2",
  zr: "r2",
  minus: "create",
  plus: "options",
  l3: "l3",
  r3: "r3",
  home: "ps",
  capture: "touchpad",
  gl: "none",
  gr: "none",
};

export function encodeDs5ButtonMapping(mapping: Ds5ButtonMapping): Uint8Array {
  return encodeMapping(DS5_MAPPING_INPUTS, mapping);
}

export function encodeNs2ProButtonMapping(mapping: Ns2ProButtonMapping): Uint8Array {
  return encodeMapping(NS2PRO_MAPPING_INPUTS, mapping);
}

export function decodeDs5ButtonMapping(source: ArrayBuffer | DataView | Uint8Array): Ds5ButtonMapping {
  return decodeMapping(DS5_MAPPING_INPUTS, source, DEFAULT_DS5_BUTTON_MAPPING);
}

export function decodeNs2ProButtonMapping(source: ArrayBuffer | DataView | Uint8Array): Ns2ProButtonMapping {
  return decodeMapping(NS2PRO_MAPPING_INPUTS, source, DEFAULT_NS2PRO_BUTTON_MAPPING);
}

export function ds5MappingsEqual(left: Ds5ButtonMapping | null, right: Ds5ButtonMapping | null): boolean {
  return mappingsEqual(DS5_MAPPING_INPUTS, left, right);
}

export function ns2ProMappingsEqual(left: Ns2ProButtonMapping | null, right: Ns2ProButtonMapping | null): boolean {
  return mappingsEqual(NS2PRO_MAPPING_INPUTS, left, right);
}

function encodeMapping<T extends string>(inputs: readonly T[], mapping: Record<T, ButtonMappingTarget>): Uint8Array {
  return Uint8Array.from(inputs.map((key) => targetToIndex(mapping[key])));
}

function decodeMapping<T extends string>(
  inputs: readonly T[],
  source: ArrayBuffer | DataView | Uint8Array,
  fallback: Record<T, ButtonMappingTarget>,
): Record<T, ButtonMappingTarget> {
  const bytes = toUint8Array(source);
  return Object.fromEntries(inputs.map((key, index) => [key, indexToTarget(bytes[index] ?? BUTTON_MAPPING_TARGET_NONE, fallback[key])])) as Record<T, ButtonMappingTarget>;
}

function mappingsEqual<T extends string>(inputs: readonly T[], left: Record<T, ButtonMappingTarget> | null, right: Record<T, ButtonMappingTarget> | null): boolean {
  if (!left || !right) {
    return left === right;
  }
  return inputs.every((key) => left[key] === right[key]);
}

function targetToIndex(target: ButtonMappingTarget): number {
  if (target === "none") {
    return BUTTON_MAPPING_TARGET_NONE;
  }
  const index = BUTTON_MAPPING_TARGETS.indexOf(target);
  return index >= 0 ? index : BUTTON_MAPPING_TARGET_NONE;
}

function indexToTarget(index: number, fallback: ButtonMappingTarget): ButtonMappingTarget {
  if (index === BUTTON_MAPPING_TARGET_NONE) {
    return "none";
  }
  return targetIndexToKey[index] ?? fallback;
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
