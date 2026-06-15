import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Bluetooth, Cable, Gamepad2, Radio } from "lucide-react";
import {
  MdBattery0Bar,
  MdBattery1Bar,
  MdBattery2Bar,
  MdBattery3Bar,
  MdBattery4Bar,
  MdBattery5Bar,
  MdBattery6Bar,
  MdBatteryFull,
} from "react-icons/md";
import { useTranslation } from "react-i18next";
import { Tooltip } from "react-tooltip";
import { Card, CardContent } from "@/components/ui/card";
import { getDeviceKey, type Ns2ProBleState, type Ns2ProRumbleDebug, type PicoInputOwner } from "@/protocol/ds5BridgeHid";
import type { Ns2ProPairingStatus } from "@/hooks/useDs5Bridge";

type InputSourceId = "DS5" | "NS2Pro";
export type DeviceInputSource = InputSourceId;
const NS2PRO_RECONNECT_CARD_HOLD_MS = 8_000;
const NS2PRO_DISCONNECT_CARD_HOLD_MS = 900;
const NS2PRO_CONTROLLER_ICON_SRC = "/svg/ns2pro-controller.svg";

interface DeviceStripProps {
  authorizedDevices: HIDDevice[];
  authorizedDeviceSerialNumber: Record<string, string>;
  authorizedDeviceBatteryText: Record<string, string>;
  authorizedDeviceFirmwareVersion: Record<string, string>;
  authorizedDeviceSignalStrength: Record<string, string>;
  client: { device: HIDDevice } | null;
  batteryText: string;
  ns2proBatteryText: string;
  firmwareVersion: string;
  signalStrength: string;
  inputMode: string;
  inputOwner: string;
  inputOwnerPolicy: string;
  ds5Connected: boolean;
  ns2proConnected: boolean;
  ns2proBleState: Ns2ProBleState;
  ns2proBleLastError: number;
  ns2proBleHasBond: boolean;
  ns2proRumbleDebug: Ns2ProRumbleDebug | null;
  ns2ProPhysicalPathPresent: boolean;
  ns2ProPairing: Ns2ProPairingStatus;
  deviceSerialNumber: string;
  deviceLabel: string;
  isBusy: boolean;
  supported: boolean;
  onConnectAuthorized: (device: HIDDevice) => Promise<void> | void;
  onRetryNs2ProPairing: () => Promise<void> | void;
  onStartNs2ProBlePairing: () => Promise<void> | void;
  onSetInputOwner: (owner: PicoInputOwner) => Promise<void> | void;
  onOpenSettings: (source?: DeviceInputSource) => void;
}

interface PicoDeviceState {
  key: string;
  label: string;
  batteryText: string;
  ns2proBatteryText: string;
  firmwareVersion: string;
  signalStrength: string;
  inputOwner: string;
  inputOwnerPolicy: string;
  ds5Connected: boolean;
  ns2proConnected: boolean;
  ns2proBleState: Ns2ProBleState;
  ns2proBleLastError: number;
  ns2proBleHasBond: boolean;
  ns2ProPairing: Ns2ProPairingStatus;
  connected: boolean;
}

interface InputSourceCard {
  key: InputSourceId;
  owner: InputSourceId;
  label: string;
  connected: boolean;
  active: boolean;
  description: string;
}

interface RenderedSourceCard {
  key: string;
  pico: PicoDeviceState;
  source: InputSourceCard;
  picoIndexLabel: string | null;
}

export const DeviceStrip = memo(function DeviceStrip({
  authorizedDevices,
  client,
  batteryText,
  ns2proBatteryText,
  firmwareVersion,
  signalStrength,
  inputOwner,
  inputOwnerPolicy,
  ds5Connected,
  ns2proConnected,
  ns2proBleState,
  ns2proBleLastError,
  ns2proBleHasBond,
  ns2ProPhysicalPathPresent,
  ns2ProPairing,
  deviceLabel,
  isBusy,
  supported,
  onConnectAuthorized,
  onRetryNs2ProPairing,
  onStartNs2ProBlePairing,
  onSetInputOwner,
  onOpenSettings,
}: DeviceStripProps) {
  const { i18n, t } = useTranslation();
  const connectedDeviceKey = useMemo(() => client ? getDeviceKey(client.device) : null, [client]);
  const [heldNs2ProPico, setHeldNs2ProPico] = useState<PicoDeviceState | null>(null);
  const heldNs2ProUntilRef = useRef(0);

  const livePicoDevices = useMemo<PicoDeviceState[]>(() => {
    if (client) {
      return [
        {
          key: connectedDeviceKey ?? deviceLabel,
          label: deviceLabel,
          batteryText,
          ns2proBatteryText,
          firmwareVersion,
          signalStrength,
          inputOwner,
          inputOwnerPolicy,
          ds5Connected,
          ns2proConnected,
          ns2proBleState,
          ns2proBleLastError,
          ns2proBleHasBond,
          ns2ProPairing,
          connected: true,
        },
      ];
    }

    if (isNs2ProCardVisible(ns2ProPairing, ns2proConnected, ns2proBleState)) {
      return [
        {
          key: "ns2pro-transition",
          label: "DS5 NS2Pro Dongle Manager",
          batteryText,
          ns2proBatteryText,
          firmwareVersion,
          signalStrength,
          inputOwner: "NS2Pro",
          inputOwnerPolicy: "NS2Pro",
          ds5Connected: false,
          ns2proConnected,
          ns2proBleState,
          ns2proBleLastError,
          ns2proBleHasBond,
          ns2ProPairing,
          connected: false,
        },
      ];
    }

    return [];
  }, [
    batteryText,
    ns2proBatteryText,
    client,
    connectedDeviceKey,
    deviceLabel,
    ds5Connected,
    firmwareVersion,
    inputOwner,
    inputOwnerPolicy,
    ns2ProPairing,
    ns2proBleLastError,
    ns2proBleHasBond,
    ns2proBleState,
    ns2proConnected,
    signalStrength,
  ]);

  useEffect(() => {
    const visibleNs2ProPico = livePicoDevices.find((pico) => isNs2ProCardVisible(pico.ns2ProPairing, pico.ns2proConnected, pico.ns2proBleState));
    if (visibleNs2ProPico) {
      heldNs2ProUntilRef.current = Date.now() + (ns2ProPhysicalPathPresent ? NS2PRO_RECONNECT_CARD_HOLD_MS : NS2PRO_DISCONNECT_CARD_HOLD_MS);
      setHeldNs2ProPico(visibleNs2ProPico);
      return;
    }

    if (!heldNs2ProPico || Date.now() >= heldNs2ProUntilRef.current) {
      setHeldNs2ProPico(null);
      return;
    }

    const timeoutId = window.setTimeout(() => setHeldNs2ProPico(null), Math.max(0, heldNs2ProUntilRef.current - Date.now()));
    return () => window.clearTimeout(timeoutId);
  }, [heldNs2ProPico, livePicoDevices, ns2ProPhysicalPathPresent]);

  const renderedCards = useMemo<RenderedSourceCard[]>(() => {
    const picoDevices = livePicoDevices;
    const knownPicoCount = Math.max(authorizedDevices.length, picoDevices.length);
    const showPicoIndex = knownPicoCount > 1;
    const liveCards = picoDevices.flatMap((pico, index) => {
      const picoIndexLabel = showPicoIndex ? `Pico ${index + 1}` : null;
      const sourceCards = buildInputSourceCards(pico, t);

      return sourceCards.map((source) => ({
        key: source.key === "NS2Pro" ? "NS2Pro" : `${pico.key}:${source.key}`,
        pico,
        source,
        picoIndexLabel,
      }));
    });

    if (liveCards.length > 0 || !heldNs2ProPico) {
      return liveCards;
    }

    const heldPico = {
      ...heldNs2ProPico,
      key: "ns2pro-held-transition",
      inputOwner: "NS2Pro",
      inputOwnerPolicy: "NS2Pro",
      connected: false,
    };
    return buildInputSourceCards(heldPico, t).map((source) => ({
      key: source.key === "NS2Pro" ? "NS2Pro" : `${heldPico.key}:${source.key}`,
      pico: heldPico,
      source,
      picoIndexLabel: null,
    }));
  }, [authorizedDevices.length, heldNs2ProPico, livePicoDevices, t]);

  const hasCard = renderedCards.length > 0;
  const hasMultipleCards = renderedCards.length > 1;
  const switchInputLabel = i18n.language.toLowerCase().startsWith("zh") ? "切换输入" : "Switch input";
  const currentInputLabel = i18n.language.toLowerCase().startsWith("zh") ? "当前输入" : "Current input";

  const openSettingsFromCard = useCallback((source?: DeviceInputSource) => {
    if (client) {
      onOpenSettings(source);
    }
  }, [client, onOpenSettings]);

  const openSettingsFromKeyboard = useCallback((event: KeyboardEvent<HTMLElement>, source?: DeviceInputSource) => {
    if (!client || (event.key !== "Enter" && event.key !== " ")) {
      return;
    }

    event.preventDefault();
    onOpenSettings(source);
  }, [client, onOpenSettings]);

  return (
    <section className="device-stage" aria-label={t("device.label")}>
      <div className={`device-card-grid ${hasMultipleCards ? "has-multiple-devices" : ""}`}>
        {hasCard ? (
          renderedCards.map(({ key, pico, source, picoIndexLabel }) => (
            <SourceControllerCard
              key={key}
              pico={pico}
              source={source}
              picoIndexLabel={picoIndexLabel}
              currentInputLabel={currentInputLabel}
              switchInputLabel={switchInputLabel}
              isBusy={isBusy}
              zh={i18n.language.toLowerCase().startsWith("zh")}
              t={t}
              onOpenSettings={openSettingsFromCard}
              onOpenSettingsFromKeyboard={openSettingsFromKeyboard}
              onSetInputOwner={onSetInputOwner}
            />
          ))
        ) : (
          <EmptyConnectionPanel
            language={i18n.language}
            ns2ProPairing={ns2ProPairing}
            ns2proConnected={ns2proConnected}
            ns2proBleState={ns2proBleState}
            ns2proBleLastError={ns2proBleLastError}
            ns2proBleHasBond={ns2proBleHasBond}
            isBusy={isBusy}
            onRetryNs2ProPairing={onRetryNs2ProPairing}
            onStartNs2ProBlePairing={onStartNs2ProBlePairing}
          />
        )}
      </div>
      {hasCard && (
        <Ns2ProConnectionOptions
          language={i18n.language}
          ns2ProPairing={ns2ProPairing}
          ns2proConnected={ns2proConnected}
          ns2proBleState={ns2proBleState}
          ns2proBleLastError={ns2proBleLastError}
          ns2proBleHasBond={ns2proBleHasBond}
          isBusy={isBusy}
          onRetryNs2ProPairing={onRetryNs2ProPairing}
          onStartNs2ProBlePairing={onStartNs2ProBlePairing}
        />
      )}
      {!supported && <p className="device-hint">{t("notice.webHidUnsupported")}</p>}
      <Tooltip id="device-info-tooltip" place="top" positionStrategy="fixed" />
    </section>
  );
});

function EmptyConnectionPanel({
  language,
  ns2ProPairing,
  ns2proConnected,
  ns2proBleState,
  ns2proBleLastError,
  ns2proBleHasBond,
  isBusy,
  onRetryNs2ProPairing,
  onStartNs2ProBlePairing,
}: {
  language: string;
  ns2ProPairing: Ns2ProPairingStatus;
  ns2proConnected: boolean;
  ns2proBleState: Ns2ProBleState;
  ns2proBleLastError: number;
  ns2proBleHasBond: boolean;
  isBusy: boolean;
  onRetryNs2ProPairing: () => Promise<void> | void;
  onStartNs2ProBlePairing: () => Promise<void> | void;
}) {
  const zh = language.toLowerCase().startsWith("zh");
  const copy = zh
    ? {
      title: "\u7b49\u5f85\u624b\u67c4\u8fde\u63a5",
      hint: "DS5 \u53ef\u4ee5\u76f4\u63a5\u8fdb\u5165\u84dd\u7259\u914d\u5bf9\u540e\u8fde\u63a5\uff1bNS2Pro \u53ef\u4ee5\u9009\u62e9\u6709\u7ebf\u6216\u84dd\u7259\u7531 Pico \u8fdb\u884c\u914d\u5bf9\u3002",
    }
    : {
      title: "Waiting for a controller",
      hint: "DS5 can pair directly over Bluetooth. NS2Pro can be paired through Pico over wired or Bluetooth mode.",
    };

  return (
    <div className="device-empty-layout" role="status" aria-live="polite">
      <Card className="device-empty-card">
        <CardContent className="device-empty-content">
          <div className="device-empty-icon" aria-hidden="true">
            <Gamepad2 size={54} />
          </div>
          <strong>{copy.title}</strong>
          <p>{copy.hint}</p>
        </CardContent>
      </Card>
      <Ns2ProConnectionOptions
        language={language}
        ns2ProPairing={ns2ProPairing}
        ns2proConnected={ns2proConnected}
        ns2proBleState={ns2proBleState}
        ns2proBleLastError={ns2proBleLastError}
        ns2proBleHasBond={ns2proBleHasBond}
        isBusy={isBusy}
        onRetryNs2ProPairing={onRetryNs2ProPairing}
        onStartNs2ProBlePairing={onStartNs2ProBlePairing}
      />
    </div>
  );
}

function Ns2ProConnectionOptions({
  language,
  ns2ProPairing,
  ns2proConnected,
  ns2proBleState,
  ns2proBleLastError,
  ns2proBleHasBond,
  isBusy,
  onRetryNs2ProPairing,
  onStartNs2ProBlePairing,
}: {
  language: string;
  ns2ProPairing: Ns2ProPairingStatus;
  ns2proConnected: boolean;
  ns2proBleState: Ns2ProBleState;
  ns2proBleLastError: number;
  ns2proBleHasBond: boolean;
  isBusy: boolean;
  onRetryNs2ProPairing: () => Promise<void> | void;
  onStartNs2ProBlePairing: () => Promise<void> | void;
}) {
  const zh = language.toLowerCase().startsWith("zh");
  const ns2ProReady = isNs2ProInputReady(ns2ProPairing, ns2proConnected, ns2proBleState);
  const showPicoFoundInsteadOfLocalError = ns2proBleState === "Error" && ns2proBleLastError === 254 && Boolean(ns2ProPairing.picoPath);
  const displayNs2proBleState: Ns2ProBleState = showPicoFoundInsteadOfLocalError ? "Idle" : ns2proBleState;
  const displayNs2proBleLastError = showPicoFoundInsteadOfLocalError ? 0 : ns2proBleLastError;
  const picoFoundForBle = Boolean(ns2ProPairing.picoPath) || ns2ProPairing.phase === "waiting" || ns2ProPairing.phase === "paired" || ns2proConnected;
  const wiredAction = ns2ProWiredConnectionAction(ns2ProPairing, ns2ProReady, zh);
  const wiredForwarding = ns2ProPairing.running &&
    ns2ProPairing.waitingReason === "forwarding";
  const bluetoothReady = displayNs2proBleState === "Ready";
  const ds5OrNs2ProActive = ns2ProReady || bluetoothReady;
  const wiredBusy = isBusy || wiredForwarding || bluetoothReady;
  const wiredHint = ns2ProConnectionHint(ns2ProPairing, zh, true);
  const copy = zh
    ? {
      wiredTitle: "NS2Pro \u6709\u7ebf\u8fde\u63a5",
      wiredHint,
      wiredAction,
      bluetoothTitle: "NS2Pro \u84dd\u7259\u8fde\u63a5",
      bluetoothHint: ns2ProBleConnectionHint(displayNs2proBleState, displayNs2proBleLastError, picoFoundForBle, zh),
      bluetoothAction: ns2ProBleConnectionAction(displayNs2proBleState, displayNs2proBleLastError, picoFoundForBle, zh),
    }
    : {
      wiredTitle: "Wired NS2Pro",
      wiredHint,
      wiredAction,
      bluetoothTitle: "Bluetooth NS2Pro",
      bluetoothHint: ns2ProBleConnectionHint(displayNs2proBleState, displayNs2proBleLastError, picoFoundForBle, zh),
      bluetoothAction: ns2ProBleConnectionAction(displayNs2proBleState, displayNs2proBleLastError, picoFoundForBle, zh),
    };
  const bluetoothBusy = displayNs2proBleState === "PairingRequested" ||
    displayNs2proBleState === "Scanning" ||
    displayNs2proBleState === "Connecting" ||
    displayNs2proBleState === "Initializing";
  const bluetoothVisualState = displayNs2proBleState;
  const bluetoothDisabled = isBusy || wiredForwarding || ns2ProReady;

  return (
    <div className="device-connect-options">
      <button
        type="button"
        className={`device-connect-option is-wired is-${ns2ProPairing.phase} ${wiredBusy ? "is-disabled" : ""}`}
        disabled={wiredBusy}
        aria-disabled={wiredBusy}
        onClick={() => {
          if (wiredBusy) {
            return;
          }
          void onRetryNs2ProPairing();
        }}
      >
        <Cable size={24} aria-hidden="true" />
        <span>
          <strong>{copy.wiredTitle}</strong>
          <small>{copy.wiredHint}</small>
        </span>
        <em>{copy.wiredAction}</em>
      </button>
      <button
        type="button"
        className={`device-connect-option is-bluetooth is-${bluetoothVisualState.toLowerCase()} ${bluetoothDisabled ? "is-disabled" : ""}`}
        disabled={bluetoothDisabled}
        aria-disabled={bluetoothDisabled}
        onClick={() => {
          if (bluetoothDisabled) {
            return;
          }
          void onStartNs2ProBlePairing();
        }}
      >
        <Bluetooth size={24} aria-hidden="true" />
        <span>
          <strong>{copy.bluetoothTitle}</strong>
          <small>{copy.bluetoothHint}</small>
        </span>
        <em>{copy.bluetoothAction}</em>
      </button>
    </div>
  );
}

function ns2ProWiredConnectionAction(status: Ns2ProPairingStatus, ready: boolean, zh: boolean): string {
  if (status.phase === "error") {
    return zh ? "\u91cd\u8bd5" : "Retry";
  }

  const forwarding = status.running &&
    status.waitingReason === "forwarding";
  if (ready || forwarding) {
    return zh ? "\u5df2\u914d\u5bf9" : "Paired";
  }

  if (status.phase === "waiting") {
    switch (status.waitingReason) {
      case "waitingPico":
        return zh ? "\u5df2\u8fde\u63a5 NS2Pro" : "NS2Pro connected";
      case "waitingNs2Pro":
        return zh ? "\u5df2\u627e\u5230 Pico" : "Pico connected";
      case "waitingNs2ProBridgeStart":
        return zh ? "\u53ef\u4ee5\u914d\u5bf9" : "Ready to pair";
      case "forwarding":
        return zh ? "\u914d\u5bf9\u4e2d" : "Pairing";
      case "inputReceiveFailed":
      case "inputForwardFailed":
      case "outputForwardFailed":
        return zh ? "\u8f6c\u53d1\u5931\u8d25" : "Forward failed";
      default:
        return zh ? "\u914d\u5bf9\u4e2d" : "Pairing";
    }
  }

  return zh ? "\u5f00\u59cb\u914d\u5bf9" : "Start pairing";
}

function ns2ProBleConnectionAction(state: Ns2ProBleState, lastError: number, picoFound: boolean, zh: boolean): string {
  if (!picoFound || (state === "Error" && lastError === 254)) {
    return zh ? "\u672a\u627e\u5230 Pico" : "No Pico";
  }

  switch (state) {
    case "Disabled":
    case "Idle":
      return zh ? "\u5f00\u59cb\u914d\u5bf9" : "Start pairing";
    case "PairingRequested":
    case "Scanning":
      return zh ? "\u641c\u7d22\u4e2d" : "Searching";
    case "Connecting":
    case "Initializing":
      return zh ? "\u8fde\u63a5\u4e2d" : "Connecting";
    case "Ready":
      return zh ? "\u5df2\u8fde\u63a5" : "Connected";
    case "Error":
      return zh ? "\u9519\u8bef" : "Error";
    case "Unsupported":
      return zh ? "\u4e0d\u652f\u6301" : "Unsupported";
    default:
      return zh ? "\u672a\u77e5" : "Unknown";
  }
}

function ns2ProBleConnectionHint(state: Ns2ProBleState, lastError: number, picoFound: boolean, zh: boolean): string {
  if (!picoFound || (state === "Error" && lastError === 254)) {
    return zh
      ? "\u8bf7\u5148\u8fde\u4e0a Pico \u7ba1\u7406\u901a\u9053\uff0c\u7136\u540e\u70b9\u51fb\u8fd9\u91cc\u624b\u52a8\u5f00\u59cb NS2Pro \u84dd\u7259\u914d\u5bf9\u3002"
      : "Connect the Pico management channel first, then click here to start NS2Pro Bluetooth pairing manually.";
  }

  switch (state) {
    case "Disabled":
    case "Idle":
      return zh
        ? "\u5df2\u627e\u5230 Pico\u3002\u70b9\u51fb\u540e\u5c06\u624b\u52a8\u89e6\u53d1 10 \u79d2 NS2Pro \u84dd\u7259\u914d\u5bf9\u7a97\u53e3\uff0c\u671f\u95f4\u4e0d\u4f1a\u626b\u63cf DS5\u3002"
        : "Pico found. Click to start a 10-second manual NS2Pro Bluetooth pairing window. DS5 scanning is paused during that time.";
    case "PairingRequested":
    case "Scanning":
      return zh
        ? "\u6b63\u5728\u624b\u52a8\u641c\u7d22 NS2Pro \u84dd\u7259\u4fe1\u53f7\uff0c10 \u79d2\u7a97\u53e3\u5185\u4ec5\u4fdd\u7559\u8fd9\u6761\u914d\u5bf9\u6d41\u7a0b\u3002"
        : "Manually searching for the NS2Pro Bluetooth signal. Only this pairing flow stays active during the 10-second window.";
    case "Connecting":
      return zh
        ? "\u5df2\u627e\u5230 NS2Pro\uff0c\u6b63\u5728\u5efa\u7acb\u84dd\u7259\u8fde\u63a5\u3002"
        : "NS2Pro found. Establishing the Bluetooth connection.";
    case "Initializing":
      return zh
        ? "\u5df2\u8fde\u63a5 NS2Pro\uff0c\u6b63\u5728\u521d\u59cb\u5316\u8f93\u5165\u548c\u9707\u52a8\u901a\u9053\u3002"
        : "NS2Pro is connected. Initializing input and vibration channels.";
    case "Ready":
      return zh
        ? "NS2Pro \u5df2\u901a\u8fc7\u84dd\u7259\u63a5\u5165 Pico \u8f93\u5165\u901a\u9053\u3002\u84dd\u7259\u6a21\u5f0f\u4e0b\u957f\u6309 Home 5 \u79d2\u53ef\u65ad\u5f00\u8fde\u63a5\u3002"
        : "NS2Pro is connected to Pico over Bluetooth. Hold Home for 5 seconds to disconnect in Bluetooth mode.";
    case "Error":
      if (lastError === 253) {
        return zh
          ? "Pico \u84dd\u7259\u914d\u5bf9\u547d\u4ee4\u53d1\u9001\u5931\u8d25\uff0c\u53ef\u70b9\u51fb\u91cd\u8bd5\u3002"
          : "Failed to send the Pico Bluetooth pairing command. Click to retry.";
      }
      return zh
        ? "Pico \u84dd\u7259\u81ea\u52a8\u8fde\u63a5\u672a\u5b8c\u6210\uff0c\u53ef\u70b9\u51fb\u91cd\u8bd5\u3002"
        : "Pico Bluetooth auto-connect did not complete. Click to retry.";
    case "Unsupported":
      return zh
        ? "\u5f53\u524d\u56fa\u4ef6\u6216\u8bbe\u5907\u72b6\u6001\u4e0d\u652f\u6301 NS2Pro \u84dd\u7259\u8fde\u63a5\u3002"
        : "This firmware or device state does not support NS2Pro Bluetooth.";
    default:
      return zh ? "\u524d\u7aef\u672a\u8bc6\u522b\u7684\u84dd\u7259\u72b6\u6001\u3002" : "Frontend did not recognize this Bluetooth state.";
  }
}

function ns2ProConnectionHint(status: Ns2ProPairingStatus, zh: boolean, picoFound = false): string {
  if (status.phase === "paired") {
    return zh
      ? "\u5df2\u5b8c\u6210 NS2Pro \u6709\u7ebf\u63a5\u5165\uff0c\u53ef\u4ee5\u76f4\u63a5\u4f7f\u7528\u5e76\u5728\u8bbe\u7f6e\u9875\u8c03\u6574\u914d\u7f6e\u3002"
      : "NS2Pro wired input is ready. You can use it now and adjust settings on the config page.";
  }

  if (status.phase === "error") {
    return zh
      ? "\u6709\u7ebf\u63a5\u5165\u672a\u5b8c\u6210\uff0c\u8bf7\u91cd\u8bd5\u3002"
      : "The wired connection did not complete. Please retry.";
  }

  if (status.phase !== "waiting") {
    if (picoFound) {
      return zh
        ? "\u5df2\u627e\u5230 Pico\u3002\u70b9\u51fb\u540e\u5f00\u59cb\u63a2\u6d4b NS2Pro \u6709\u7ebf\u8fde\u63a5\u3002"
        : "Pico found. Click to start detecting a wired NS2Pro connection.";
    }

    return zh
      ? "\u5c06 NS2Pro \u901a\u8fc7 USB \u8fde\u63a5\u5230\u7535\u8111\uff0c\u7136\u540e\u70b9\u51fb\u5f00\u59cb\u914d\u5bf9\u3002"
      : "Connect NS2Pro to this PC over USB, then start pairing.";
  }

  switch (status.waitingReason) {
    case "waitingPico":
      return zh
        ? "\u6b63\u5728\u7b49\u5f85 Pico \u7ba1\u7406\u901a\u9053\uff0c\u8bf7\u786e\u8ba4 Dongle \u5df2\u8fde\u63a5\u5e76\u5904\u4e8e\u53ef\u914d\u5bf9\u72b6\u6001\u3002"
        : "Waiting for the Pico management channel. Make sure the dongle is connected and ready.";
    case "waitingNs2Pro":
      return zh
        ? "\u5df2\u627e\u5230 Pico\uff0c\u6b63\u5728\u7b49\u5f85 NS2Pro \u901a\u8fc7 USB \u63a5\u5165\u7535\u8111\u3002"
        : "Pico found. Waiting for NS2Pro to be connected to this PC over USB.";
    case "waitingNs2ProBridgeStart":
      return zh
        ? "\u5df2\u627e\u5230 Pico \u548c NS2Pro\uff0c\u6b63\u5728\u5b8c\u6210\u6709\u7ebf\u63a5\u5165\u3002"
        : "Pico and NS2Pro were found. Finishing the wired connection now.";
    case "forwarding":
      return zh
        ? "\u6b63\u5728\u8f6c\u5165 NS2Pro \u6709\u7ebf\u8f93\u5165\u3002"
        : "NS2Pro wired input is being forwarded now.";
    case "inputReceiveFailed":
      return zh
        ? "\u5df2\u542f\u52a8\u8f6c\u53d1\uff0c\u4f46 NS2Pro \u8f93\u5165\u63a5\u6536\u5931\u8d25\u3002"
        : "Bridge started, but NS2Pro input reception failed.";
    case "inputForwardFailed":
      return zh
        ? "\u5df2\u542f\u52a8\u8f6c\u53d1\uff0c\u4f46\u53d1\u9001\u5230 Pico \u4e32\u53e3\u5931\u8d25\u3002"
        : "Bridge started, but forwarding to Pico serial failed.";
    case "outputForwardFailed":
      return zh
        ? "\u5df2\u542f\u52a8\u8f6c\u53d1\uff0c\u4f46\u56de\u5199 NS2Pro \u8f93\u51fa\u5931\u8d25\u3002"
        : "Bridge started, but writing output back to NS2Pro failed.";
    default:
      return zh
        ? "\u6b63\u5728\u914d\u5bf9\u3002\u5982\u679c\u957f\u65f6\u95f4\u6ca1\u6709\u53d8\u5316\uff0c\u53ef\u4ee5\u70b9\u51fb\u91cd\u8bd5\u3002"
        : "Pairing is in progress. If it does not change, click Retry.";
  }
}

function SourceControllerCard({
  pico,
  source,
  picoIndexLabel,
  currentInputLabel,
  switchInputLabel,
  isBusy,
  zh,
  t,
  onOpenSettings,
  onOpenSettingsFromKeyboard,
  onSetInputOwner,
}: {
  pico: PicoDeviceState;
  source: InputSourceCard;
  picoIndexLabel: string | null;
  currentInputLabel: string;
  switchInputLabel: string;
  isBusy: boolean;
  zh: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
  onOpenSettings: (source?: DeviceInputSource) => void;
  onOpenSettingsFromKeyboard: (event: KeyboardEvent<HTMLElement>, source?: DeviceInputSource) => void;
  onSetInputOwner: (owner: PicoInputOwner) => Promise<void> | void;
}) {
  const title = picoIndexLabel ? `${source.label} 路 ${picoIndexLabel}` : source.label;
  const batteryText = source.owner === "DS5"
    ? pico.batteryText
    : formatNs2ProBatteryText(pico.ns2proBatteryText, source.connected);
  const showInputSwitchButton = source.owner === "NS2Pro"
    ? isNs2ProCardVisible(pico.ns2ProPairing, source.connected, pico.ns2proBleState)
    : pico.connected;
  const inputSwitchDisabled = isBusy || source.active || (source.owner === "NS2Pro" && !isNs2ProInputReady(pico.ns2ProPairing, source.connected, pico.ns2proBleState));
  const ns2ProConnectionTypeKey = pico.ns2proBleState === "Ready" ? "device.connectionTypes.bluetooth" : "device.connectionTypes.wired";
  const connectionTypeKey = source.owner === "DS5" ? "device.connectionTypes.bluetooth" : ns2ProConnectionTypeKey;
  const connectionTypeTooltip = t("device.connectionType", { type: t(connectionTypeKey) });
  const showSignal = source.owner === "NS2Pro" && pico.ns2proBleState === "Ready" && pico.signalStrength !== "--";

  return (
    <Card
      className={`device-strip-card device-source-card connected is-clickable ${source.active ? "is-input-active" : ""} ${source.connected ? "is-source-connected" : "is-source-disconnected"}`}
      role="button"
      tabIndex={0}
      onClick={() => onOpenSettings(source.owner)}
      onKeyDown={(event) => onOpenSettingsFromKeyboard(event, source.owner)}
    >
      <CardContent className="device-strip">
        <div className="device-preview" aria-hidden="true">
          <div className="device-hero connected-device-hero">
            {source.owner === "DS5" ? (
              <img src="/svg/ps5-controller-gamepad-seeklogo.svg" alt="" aria-hidden="true" draggable={false} />
            ) : (
              <img src={NS2PRO_CONTROLLER_ICON_SRC} alt="" aria-hidden="true" draggable={false} />
            )}
          </div>
        </div>
        <div className="device-info-panel device-source-info-panel">
          <div className="device-source-heading">
            <strong>
              <span>{title}</span>
            </strong>
          </div>
          <div className="device-status-icons" onClick={(event) => event.stopPropagation()}>
            {showInputSwitchButton && (
              <button
                type="button"
                className={`device-input-switch-button ${source.active ? "is-current" : ""}`}
                disabled={inputSwitchDisabled}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void onSetInputOwner(source.owner);
                }}
              >
                {source.active ? currentInputLabel : switchInputLabel}
              </button>
            )}
            <span
              className="device-meta-chip"
              data-tooltip-id="device-info-tooltip"
              data-tooltip-content={connectionTypeTooltip}
              data-tooltip-place="top"
              title={connectionTypeTooltip}
            >
              {t(connectionTypeKey)}
            </span>
            {source.owner === "DS5" && (
              <span
                className="device-battery"
                data-battery-level={batteryLevelState(pico.batteryText)}
                data-tooltip-id="device-info-tooltip"
                data-tooltip-content={t("device.battery", { battery: pico.batteryText })}
                data-tooltip-place="top"
              >
                <BatteryIcon batteryText={pico.batteryText} />
                <span>{pico.batteryText}</span>
              </span>
            )}
            {source.owner === "NS2Pro" && (
              <span
                className="device-battery"
                data-battery-level={batteryLevelState(batteryText)}
                data-tooltip-id="device-info-tooltip"
                data-tooltip-content="NS2Pro 电量是从输入报告档位估算的粗略值，不是原生精确百分比。"
                data-tooltip-place="top"
              >
                <BatteryIcon batteryText={batteryText} />
                <span>{batteryText}</span>
              </span>
            )}
            {showSignal && (
              <span
                className="device-signal"
                data-tooltip-id="device-info-tooltip"
                data-tooltip-content={t("device.signalStrength", { signal: pico.signalStrength })}
                data-tooltip-place="top"
              >
                <Radio size={14} aria-hidden="true" />
                <span>{pico.signalStrength}</span>
              </span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function buildInputSourceCards(
  pico: PicoDeviceState,
  t: (key: string, options?: Record<string, unknown>) => string,
): InputSourceCard[] {
  const orderedSources: InputSourceId[] = ["DS5", "NS2Pro"];
  const sourceSet = new Set<InputSourceId>();

  if (pico.ds5Connected) {
    sourceSet.add("DS5");
  }

  if (isNs2ProCardVisible(pico.ns2ProPairing, pico.ns2proConnected, pico.ns2proBleState)) {
    sourceSet.add("NS2Pro");
  }

  return orderedSources
    .filter((owner) => sourceSet.has(owner))
    .map((owner) => {
      const connected = owner === "DS5" ? pico.ds5Connected : (pico.ns2proConnected || isNs2ProBleReady(pico.ns2proBleState));
      const ns2ProVisible = owner === "NS2Pro" && isNs2ProCardVisible(pico.ns2ProPairing, pico.ns2proConnected, pico.ns2proBleState);

      return {
        key: owner,
        owner,
        label: owner === "DS5" ? "DualSense Wireless Controller" : "NS2Pro Controller",
        connected,
        active: pico.inputOwner === owner || ns2ProVisible,
        description: t(owner === "DS5" ? "config.inputOwner.ds5Status" : "config.inputOwner.ns2proStatus", {
          status: connected ? t("config.inputOwner.connected") : t("config.inputOwner.disconnected"),
        }),
      };
    });
}

function isNs2ProInputReady(status: Ns2ProPairingStatus, connected: boolean, bleState: Ns2ProBleState): boolean {
  if (isNs2ProBleReady(bleState)) {
    return true;
  }

  if (connected) {
    return true;
  }

  return isNs2ProWiredBridgeActive(status);
}

function isNs2ProCardVisible(status: Ns2ProPairingStatus, connected: boolean, bleState: Ns2ProBleState): boolean {
  if (isNs2ProInputReady(status, connected, bleState)) {
    return true;
  }

  return isNs2ProControllerDetected(status) && status.phase !== "inactive";
}

function isNs2ProControllerDetected(status: Ns2ProPairingStatus): boolean {
  return Boolean(status.ns2proPath);
}

function isNs2ProBleReady(bleState: Ns2ProBleState): boolean {
  return bleState === "Ready";
}

function isNs2ProWiredBridgeActive(status: Ns2ProPairingStatus): boolean {
  return Boolean(
    status.running &&
    status.picoPath &&
    status.ns2proPath &&
    (
      status.phase === "paired" ||
      status.waitingReason === "forwarding" ||
      status.inputReportsReceived > 0 ||
      status.inputReportsForwarded > 0 ||
      status.outputReportsReceived > 0 ||
      status.outputReportsForwarded > 0
    ),
  );
}

function BatteryIcon({ batteryText }: { batteryText: string }) {
  const level = batteryLevelFromText(batteryText);
  const iconProps = { size: 22, className: "device-battery-icon", focusable: false } as const;

  if (level === null) {
    return <MdBattery0Bar {...iconProps} />;
  }

  if (level >= 95) {
    return <MdBatteryFull {...iconProps} />;
  }

  if (level >= 82) {
    return <MdBattery6Bar {...iconProps} />;
  }

  if (level >= 68) {
    return <MdBattery5Bar {...iconProps} />;
  }

  if (level >= 54) {
    return <MdBattery4Bar {...iconProps} />;
  }

  if (level >= 40) {
    return <MdBattery3Bar {...iconProps} />;
  }

  if (level >= 26) {
    return <MdBattery2Bar {...iconProps} />;
  }

  if (level >= 12) {
    return <MdBattery1Bar {...iconProps} />;
  }

  return <MdBattery0Bar {...iconProps} />;
}

function formatNs2ProBatteryText(text: string, connected: boolean): string {
  if (!connected) {
    return "--";
  }

  const level = batteryLevelFromText(text);
  if (level === null) {
    return "--";
  }

  return `~${level}%`;
}

function batteryLevelFromText(text: string): number | null {
  const match = text.match(/\d+/);
  const value = match ? Number.parseInt(match[0], 10) : Number.NaN;

  if (Number.isNaN(value)) {
    return null;
  }

  return Math.min(Math.max(value, 0), 100);
}

function batteryLevelState(text: string): "unknown" | "low" | "medium" | "high" {
  const level = batteryLevelFromText(text);

  if (level === null) {
    return "unknown";
  }

  if (level <= 20) {
    return "low";
  }

  if (level <= 60) {
    return "medium";
  }

  return "high";
}
