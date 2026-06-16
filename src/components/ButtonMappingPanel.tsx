import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, Gamepad2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import type { UseDs5BridgeResult } from "@/hooks/useDs5Bridge";
import { DUALSENSE_EDGE_PRODUCT_ID } from "@/protocol/ds5BridgeHid";
import {
  BUTTON_MAPPING_TARGETS,
  DS5_MAPPING_INPUTS,
  NS2PRO_MAPPING_INPUTS,
  type ButtonMappingTarget,
  type Ds5MappingInput,
  type Ns2ProMappingInput,
} from "@/protocol/buttonMapping";

interface ButtonMappingPanelProps {
  bridge: UseDs5BridgeResult;
  source: "DS5" | "NS2Pro";
}

type MappingIconName =
  | "up"
  | "right"
  | "down"
  | "left"
  | "square"
  | "cross"
  | "circle"
  | "triangle"
  | "l1"
  | "r1"
  | "l2"
  | "r2"
  | "create"
  | "options"
  | "l3"
  | "r3"
  | "ps"
  | "touchpad"
  | "mute"
  | "leftFunction"
  | "rightFunction"
  | "leftPaddle"
  | "rightPaddle"
  | "y"
  | "b"
  | "a"
  | "x"
  | "l"
  | "r"
  | "zl"
  | "zr"
  | "minus"
  | "plus"
  | "home"
  | "capture"
  | "gl"
  | "gr"
  | "none";

const SOURCE_ICON_MAP: Record<string, MappingIconName> = {
  up: "up",
  right: "right",
  down: "down",
  left: "left",
  square: "square",
  cross: "cross",
  circle: "circle",
  triangle: "triangle",
  l1: "l1",
  r1: "r1",
  l2: "l2",
  r2: "r2",
  create: "create",
  options: "options",
  l3: "l3",
  r3: "r3",
  ps: "ps",
  touchpad: "touchpad",
  mute: "mute",
  leftFunction: "leftFunction",
  rightFunction: "rightFunction",
  leftPaddle: "leftPaddle",
  rightPaddle: "rightPaddle",
  y: "y",
  b: "b",
  a: "a",
  x: "x",
  l: "l",
  r: "r",
  zl: "zl",
  zr: "zr",
  minus: "minus",
  plus: "plus",
  home: "home",
  capture: "capture",
  gl: "gl",
  gr: "gr",
};

const TARGET_ICON_MAP: Record<ButtonMappingTarget, MappingIconName> = {
  up: "up",
  right: "right",
  down: "down",
  left: "left",
  square: "square",
  cross: "cross",
  circle: "circle",
  triangle: "triangle",
  l1: "l1",
  r1: "r1",
  l2: "l2",
  r2: "r2",
  create: "create",
  options: "options",
  l3: "l3",
  r3: "r3",
  ps: "ps",
  touchpad: "touchpad",
  mute: "mute",
  leftFunction: "leftFunction",
  rightFunction: "rightFunction",
  leftPaddle: "leftPaddle",
  rightPaddle: "rightPaddle",
  none: "none",
};

const TARGET_OPTIONS = [...BUTTON_MAPPING_TARGETS, "none"] as const;
const DS5_HIDDEN_MAPPING_KEYS = new Set<ButtonMappingTarget | string>([
  "mute",
  "leftFunction",
  "rightFunction",
  "leftPaddle",
  "rightPaddle",
]);

const NS2PRO_HIDDEN_TARGET_KEYS = new Set<ButtonMappingTarget | string>([
  "mute",
  "leftFunction",
  "rightFunction",
  "leftPaddle",
  "rightPaddle",
]);

const CONTROLLER_ICON_PATHS: Partial<Record<MappingIconName, string>> = {
  up: "/controller-icons/ps5/T_P5_Dpad_UP_Alt.png",
  right: "/controller-icons/ps5/T_P5_Dpad_Right_Alt.png",
  down: "/controller-icons/ps5/T_P5_Dpad_Down_Alt.png",
  left: "/controller-icons/ps5/T_P5_Dpad_Left_Alt.png",
  square: "/controller-icons/ps5/T_P5_Square_Alt.png",
  cross: "/controller-icons/ps5/T_P5_Cross_Alt.png",
  circle: "/controller-icons/ps5/T_P5_Circle_Alt.png",
  triangle: "/controller-icons/ps5/T_P5_Triangle_Alt.png",
  l1: "/controller-icons/ps5/T_P5_L1_Alt.png",
  r1: "/controller-icons/ps5/T_P5_R1_Alt.png",
  l2: "/controller-icons/ps5/T_P5_L2_Alt.png",
  r2: "/controller-icons/ps5/T_P5_R2_Alt.png",
  create: "/controller-icons/ps5/T_P5_Share_Alt.png",
  options: "/controller-icons/ps5/T_P5_Options_Alt.png",
  l3: "/controller-icons/ps5/T_P5_L3_Alt.png",
  r3: "/controller-icons/ps5/T_P5_R3_Alt.png",
  ps: "/controller-icons/ps5/ps_button_logo_md.png",
  touchpad: "/controller-icons/ps5/T_P5_Touch_Pad_Alt.png",
  y: "/controller-icons/switch/T_S_Y_Alt.png",
  b: "/controller-icons/switch/T_S_B_Alt.png",
  a: "/controller-icons/switch/T_S_A_Alt.png",
  x: "/controller-icons/switch/T_S_X_Alt.png",
  l: "/controller-icons/switch/T_S_L_Alt.png",
  r: "/controller-icons/switch/T_S_R_Alt.png",
  zl: "/controller-icons/switch/T_S_LT_Alt.png",
  zr: "/controller-icons/switch/T_S_RT_Alt.png",
  minus: "/controller-icons/switch/T_S_Minus_Alt.png",
  plus: "/controller-icons/switch/T_S_Plus_Alt.png",
  home: "/controller-icons/switch/T_S_Home_Alt.png",
  capture: "/controller-icons/switch/T_S_Square_Alt.png",
  gl: "/controller-icons/switch/switchpro_gl_md.png",
  gr: "/controller-icons/switch/switchpro_gr_md.png",
};

function chunk<T>(items: readonly T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    rows.push([...items.slice(index, index + size)]);
  }
  return rows;
}

function MappingToken({
  name,
  label,
}: {
  name: MappingIconName;
  label: string;
}) {
  const assetPath = CONTROLLER_ICON_PATHS[name];
  return (
    <span className="mapping-token" title={label} aria-label={label}>
      {assetPath ? (
        <img className="mapping-token__image" src={assetPath} alt="" draggable={false} />
      ) : (
        <span className={["mapping-token__fallback", name === "none" ? "mapping-token__fallback--muted" : ""].filter(Boolean).join(" ")}>
          {label}
        </span>
      )}
    </span>
  );
}

function MappingPicker({
  inputLabel,
  value,
  options,
  onChange,
  open,
  onToggle,
  onDismiss,
  optionLabel,
  forceUpward,
  forceCentered,
  alignLeftward,
}: {
  inputLabel: string;
  value: ButtonMappingTarget;
  options: readonly ButtonMappingTarget[];
  onChange: (value: ButtonMappingTarget) => void;
  open: boolean;
  onToggle: () => void;
  onDismiss: () => void;
  optionLabel: (value: ButtonMappingTarget) => string;
  forceUpward: boolean;
  forceCentered: boolean;
  alignLeftward: boolean;
}) {
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const [dynamicOpenUpward, setDynamicOpenUpward] = useState(false);
  const rowCount = Math.max(1, Math.ceil(options.length / 4));
  const popoverHeight = 20 + rowCount * 56 + Math.max(0, rowCount - 1) * 10;

  useEffect(() => {
    if (!open || forceUpward || forceCentered || !pickerRef.current) {
      return;
    }

    const rect = pickerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    setDynamicOpenUpward(spaceBelow < popoverHeight && spaceAbove > spaceBelow);
  }, [forceCentered, forceUpward, open, popoverHeight]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) {
        onDismiss();
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [onDismiss, open]);

  const openUpward = !forceCentered && (forceUpward || dynamicOpenUpward);

  return (
    <div className="mapping-picker" ref={pickerRef}>
      <button
        type="button"
        className={["mapping-picker__button", open ? "is-open" : ""].join(" ")}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={inputLabel}
        onClick={onToggle}
      >
        <MappingToken name={TARGET_ICON_MAP[value] ?? "none"} label={optionLabel(value)} />
        <ChevronDown size={14} className="mapping-picker__chevron" aria-hidden="true" />
      </button>
      {open ? (
        <div
          className={[
            "mapping-picker__popover",
            openUpward ? "is-upward" : "",
            forceCentered ? "is-centered" : "",
            alignLeftward ? "is-leftward" : "",
          ].filter(Boolean).join(" ")}
          role="listbox"
          aria-label={inputLabel}
          style={{ ["--mapping-picker-height" as string]: `${popoverHeight}px` }}
        >
          <div className="mapping-picker__grid">
            {options.map((option) => (
              <button
                key={option}
                type="button"
                className={["mapping-picker__option", option === value ? "is-active" : ""].join(" ")}
                title={optionLabel(option)}
                onClick={() => onChange(option)}
              >
                <MappingToken name={TARGET_ICON_MAP[option] ?? "none"} label={optionLabel(option)} />
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ButtonMappingPanel({ bridge, source }: ButtonMappingPanelProps) {
  const { t } = useTranslation();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const isDs5 = source === "DS5";
  const mapping = isDs5 ? bridge.ds5ButtonMappingDraft : bridge.ns2proButtonMappingDraft;
  const rawInputs = isDs5 ? DS5_MAPPING_INPUTS : NS2PRO_MAPPING_INPUTS;

  const visibleInputs = useMemo(
    () => rawInputs.filter((key) => {
      if (isDs5) {
        return !DS5_HIDDEN_MAPPING_KEYS.has(key);
      }
      return true;
    }),
    [rawInputs, isDs5],
  );

  const rows = useMemo(() => chunk(visibleInputs, 4), [visibleInputs]);
  const visibleTargetOptions = useMemo(
    () => TARGET_OPTIONS.filter((option) => {
      if (isDs5) {
        return !DS5_HIDDEN_MAPPING_KEYS.has(option);
      }
      return !NS2PRO_HIDDEN_TARGET_KEYS.has(option);
    }),
    [isDs5],
  );

  return (
    <Card className="panel config-panel">
      <CardContent className="config-sections p-0">
        <section className="config-section config-section-featured config-section-input-owner mapping-page-section">
          <div className="config-section-heading">
            <span className="config-section-icon">
              <Gamepad2 size={17} />
            </span>
            <div>
              <h3>{t("mapping.title")}</h3>
              <p>{t(isDs5 ? "mapping.ds5Description" : "mapping.ns2proDescription")}</p>
            </div>
          </div>

          {isDs5 && bridge.connectedControllerProductId === DUALSENSE_EDGE_PRODUCT_ID ? (
            <div className="config-note mapping-note">
              <AlertTriangle size={16} />
              <span>{t("mapping.dseRearProfileNotice")}</span>
            </div>
          ) : null}

          <div className="mapping-grid-panel">
            {rows.map((row, rowIndex) => (
              <div className="mapping-grid-row" key={`${source}-${rowIndex}`}>
                {row.map((inputKey) => {
                  const sourceLabel = t(`mapping.inputs.${source}.${inputKey}`);
                  const target = mapping[inputKey as keyof typeof mapping] as ButtonMappingTarget;
                  const pickerKey = `${source}:${inputKey}`;
                  const forceCentered = rowIndex === 2;
                  const forceUpward = !forceCentered && rowIndex >= Math.max(0, rows.length - 2);
                  const isRightmostInRow = row.length >= 4 && row.indexOf(inputKey) === 3;

                  return (
                    <div className="mapping-grid-cell" key={inputKey}>
                      <div className="mapping-grid-card">
                        <div className="mapping-grid-card__source">
                          <MappingToken
                            name={SOURCE_ICON_MAP[inputKey] ?? "none"}
                            label={sourceLabel}
                          />
                        </div>
                        <span className="mapping-grid-card__arrow" aria-hidden="true">→</span>
                        <MappingPicker
                          inputLabel={sourceLabel}
                          value={target}
                          open={openKey === pickerKey}
                          options={visibleTargetOptions}
                          optionLabel={(value) => t(`mapping.targets.${value}`)}
                          forceUpward={forceUpward}
                          forceCentered={forceCentered}
                          alignLeftward={isRightmostInRow}
                          onToggle={() => setOpenKey((current) => current === pickerKey ? null : pickerKey)}
                          onDismiss={() => setOpenKey(null)}
                          onChange={(nextTarget) => {
                            setOpenKey(null);
                            if (isDs5) {
                              bridge.setDs5ButtonMappingField(inputKey as Ds5MappingInput, nextTarget);
                            } else {
                              bridge.setNs2ProButtonMappingField(inputKey as Ns2ProMappingInput, nextTarget);
                            }
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
                {row.length < 4 ? Array.from({ length: 4 - row.length }).map((_, index) => (
                  <div className="mapping-grid-cell mapping-grid-cell--empty" key={`empty-${rowIndex}-${index}`} />
                )) : null}
              </div>
            ))}
          </div>
        </section>
      </CardContent>
    </Card>
  );
}
