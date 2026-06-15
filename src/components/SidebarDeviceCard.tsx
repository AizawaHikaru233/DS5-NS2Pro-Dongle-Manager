import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from "@floating-ui/react";
import { BatteryFull, ChevronRight, CircleAlert, CircleArrowUp, Gamepad2, LoaderCircle, Radio } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { getControllerIconSrc, type Ns2ProBleState } from "@/protocol/ds5BridgeHid";
import type { DeviceInputSource } from "@/components/DeviceStrip";
import type { Ns2ProPairingStatus } from "@/hooks/useDs5Bridge";

const NS2PRO_CONTROLLER_ICON_SRC = "/svg/ns2pro-controller.svg";

interface SidebarDeviceCardProps {
  connectedDevice: HIDDevice | null;
  selectedInputSource: DeviceInputSource;
  deviceLabel: string;
  batteryText: string;
  ns2proBatteryText: string;
  firmwareVersion: string;
  signalStrength: string;
  inputMode: string;
  inputOwner: string;
  ds5Connected: boolean;
  ns2proConnected: boolean;
  ns2proBleState: Ns2ProBleState;
  ns2proBleHasBond: boolean;
  ns2ProPairing: Ns2ProPairingStatus;
  firmwareUpdateAvailable?: boolean;
  firmwareUpdateVersion?: string;
  onFirmwareUpdateClick?: () => void;
  onSelectedInputSourceChange: (source: DeviceInputSource) => void;
}

interface PopoverSourceRow {
  key: string;
  icon: ReactNode;
  text: string;
}

interface PopoverSource {
  source: DeviceInputSource;
  label: string;
  iconSrc: string | null;
  active: boolean;
  rows: PopoverSourceRow[];
}

export function SidebarDeviceCard({
  connectedDevice,
  selectedInputSource,
  deviceLabel,
  batteryText,
  ns2proBatteryText,
  firmwareVersion,
  signalStrength,
  inputOwner,
  ds5Connected,
  ns2proConnected,
  ns2proBleState,
  ns2proBleHasBond,
  ns2ProPairing,
  firmwareUpdateAvailable = false,
  firmwareUpdateVersion,
  onFirmwareUpdateClick,
  onSelectedInputSourceChange,
}: SidebarDeviceCardProps) {
  const { i18n, t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [isPopoverMounted, setIsPopoverMounted] = useState(false);
  const popoverCloseTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const [deviceName] = deviceLabel.split(" 路 ");
  const connectedDeviceIconSrc = getControllerIconSrc(connectedDevice);
  const displayDeviceName = selectedInputSource === "NS2Pro" ? "Switch 2 Pro Controller" : deviceName;
  const displayFirmwareVersion = firmwareVersion.trim() || "--";
  const displaySignalStrength = signalStrength.trim() || "--";
  const showSignal = selectedInputSource === "DS5" || (selectedInputSource === "NS2Pro" && ns2proBleState === "Ready");
  const ns2ProConnectionTypeKey = ns2proBleState === "Ready" ? "device.connectionTypes.bluetooth" : "device.connectionTypes.wired";
  const isSignalLoading = isLoadingValue(displaySignalStrength);
  const isFirmwareLoading = isLoadingValue(displayFirmwareVersion);
  const isZh = i18n.language.toLowerCase().startsWith("zh");

  const popoverSources: PopoverSource[] = [];

  if (ds5Connected) {
    popoverSources.push({
        source: "DS5",
        label: "DualSense Wireless Controller",
        iconSrc: connectedDeviceIconSrc,
        active: selectedInputSource === "DS5",
        rows: [
          {
            key: "firmware",
            icon: isLoadingValue(displayFirmwareVersion)
              ? <LoaderCircle className="settings-device-card-loading-icon" size={15} aria-hidden="true" />
              : <CircleAlert size={15} aria-hidden="true" />,
            text: t("device.firmwareVersion", { version: displayFirmwareVersion }),
          },
          {
            key: "signal",
            icon: isLoadingValue(displaySignalStrength)
              ? <LoaderCircle className="settings-device-card-loading-icon" size={15} aria-hidden="true" />
              : <Radio size={15} aria-hidden="true" />,
            text: t("device.signalStrength", { signal: displaySignalStrength }),
          },
          {
            key: "connection",
            icon: <Radio size={15} aria-hidden="true" />,
            text: t("device.connectionType", { type: t("device.connectionTypes.bluetooth") }),
          },
          {
            key: "battery",
            icon: <BatteryFull size={15} aria-hidden="true" />,
            text: t("device.battery", { battery: batteryText }),
          },
        ],
      });
  }

  if (isNs2ProPopoverVisible(ns2ProPairing, ns2proConnected, ns2proBleState)) {
    popoverSources.push({
        source: "NS2Pro",
        label: "Switch 2 Pro Controller",
        iconSrc: NS2PRO_CONTROLLER_ICON_SRC,
        active: selectedInputSource === "NS2Pro",
        rows: [
          {
            key: "firmware",
            icon: isLoadingValue(displayFirmwareVersion)
              ? <LoaderCircle className="settings-device-card-loading-icon" size={15} aria-hidden="true" />
              : <CircleAlert size={15} aria-hidden="true" />,
            text: t("device.firmwareVersion", { version: displayFirmwareVersion }),
          },
          ...(ns2proBleState === "Ready" ? [
            {
              key: "signal",
              icon: isLoadingValue(displaySignalStrength)
                ? <LoaderCircle className="settings-device-card-loading-icon" size={15} aria-hidden="true" />
                : <Radio size={15} aria-hidden="true" />,
              text: t("device.signalStrength", { signal: displaySignalStrength }),
            },
          ] : []),
          {
            key: "connection",
            icon: <Gamepad2 size={15} aria-hidden="true" />,
            text: t("device.connectionType", { type: t(ns2ProConnectionTypeKey) }),
          },
          {
            key: "battery",
            icon: <BatteryFull size={15} aria-hidden="true" />,
            text: t("device.battery", { battery: ns2proBatteryText }),
          },
        ],
      });
  }

  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: "right-start",
    middleware: [offset({ mainAxis: 24, crossAxis: 0 }), flip(), shift({ padding: 10 })],
    whileElementsMounted: autoUpdate,
  });
  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "dialog" });
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role]);

  useEffect(() => {
    if (popoverCloseTimerRef.current) {
      window.clearTimeout(popoverCloseTimerRef.current);
      popoverCloseTimerRef.current = null;
    }

    if (isOpen) {
      setIsPopoverMounted(true);
      return;
    }

    popoverCloseTimerRef.current = window.setTimeout(() => {
      setIsPopoverMounted(false);
      popoverCloseTimerRef.current = null;
    }, 160);

    return () => {
      if (popoverCloseTimerRef.current) {
        window.clearTimeout(popoverCloseTimerRef.current);
        popoverCloseTimerRef.current = null;
      }
    };
  }, [isOpen]);

  return (
    <>
      <button ref={refs.setReference} type="button" className="settings-device-card-trigger" {...getReferenceProps()}>
        <span className="settings-device-card-icon" aria-hidden="true">
          {selectedInputSource === "NS2Pro" ? (
            <img src={NS2PRO_CONTROLLER_ICON_SRC} alt="" draggable={false} />
          ) : (
            <img src={connectedDeviceIconSrc} alt="" draggable={false} />
          )}
        </span>
        <span className="settings-device-card-copy">
          <span className="settings-device-card-title-row">
            <strong>{displayDeviceName}</strong>
            <em className="settings-device-card-page-badge">{isZh ? "\u5f53\u524d\u8bbe\u7f6e\u9875" : "Current page"}</em>
          </span>
          <span className="settings-device-card-meta">
            {selectedInputSource === "DS5" && (
              <span>
                <BatteryFull size={15} aria-hidden="true" />
                <em>{t("device.battery", { battery: batteryText })}</em>
              </span>
            )}
            {selectedInputSource === "NS2Pro" && (
              <span>
                <BatteryFull size={15} aria-hidden="true" />
                <em>{t("device.battery", { battery: ns2proBatteryText })}</em>
              </span>
            )}
            {showSignal && (
              <span>
                {isSignalLoading ? <LoaderCircle className="settings-device-card-loading-icon" size={15} aria-hidden="true" /> : <Radio size={15} aria-hidden="true" />}
                <em>{t("device.signalStrength", { signal: displaySignalStrength })}</em>
              </span>
            )}
            <span>
              {isFirmwareLoading ? <LoaderCircle className="settings-device-card-loading-icon" size={15} aria-hidden="true" /> : <CircleAlert size={15} aria-hidden="true" />}
              <em>{t("device.firmwareVersion", { version: displayFirmwareVersion })}</em>
              {firmwareUpdateAvailable && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        role="button"
                        tabIndex={0}
                        className="settings-device-card-update"
                        aria-label={t("device.firmwareUpdateAvailable", { version: firmwareUpdateVersion })}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setIsOpen(false);
                          onFirmwareUpdateClick?.();
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") {
                            return;
                          }

                          event.preventDefault();
                          event.stopPropagation();
                          setIsOpen(false);
                          onFirmwareUpdateClick?.();
                        }}
                      >
                        <CircleArrowUp size={16} strokeWidth={2.4} aria-hidden="true" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="right" sideOffset={8}>
                      {t("device.firmwareUpdateAvailable", { version: firmwareUpdateVersion })}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </span>
            <span>
              <Gamepad2 size={15} aria-hidden="true" />
              <em>{t("device.connectionType", { type: t(selectedInputSource === "DS5" ? "device.connectionTypes.bluetooth" : ns2ProConnectionTypeKey) })}</em>
            </span>
          </span>
        </span>
        <ChevronRight size={16} aria-hidden="true" />
      </button>

      <FloatingPortal>
        {isPopoverMounted && (
          <Card ref={refs.setFloating} className="settings-device-popover" data-state={isOpen ? "open" : "closed"} style={floatingStyles} {...getFloatingProps()}>
            <CardContent className="settings-device-popover-content">
              <div className="settings-device-popover-head">
                <strong>{t("device.selectDevice")}</strong>
                <span>{isZh ? `已连接手柄：${popoverSources.length}` : `Connected controllers: ${popoverSources.length}`}</span>
              </div>
              <div className="settings-device-popover-list">
                {popoverSources.map((item) => (
                  <button
                    key={item.source}
                    type="button"
                    className={`settings-device-popover-item ${item.active ? "is-active" : ""}`}
                    onClick={() => {
                      onSelectedInputSourceChange(item.source);
                      setIsOpen(false);
                    }}
                  >
                    <span className="settings-device-popover-preview" aria-hidden="true">
                      {item.iconSrc ? (
                        <img src={item.iconSrc} alt="" draggable={false} />
                      ) : (
                        <span className="settings-device-popover-placeholder-icon">
                          <Gamepad2 size={42} />
                        </span>
                      )}
                    </span>
                    <span className="settings-device-popover-info">
                      <strong>
                        <span>{item.label}</span>
                        {item.active && <em>{isZh ? "当前设置页" : "Current page"}</em>}
                      </strong>
                      {item.rows.map((row) => (
                        <span key={row.key} className="settings-device-popover-row">
                          {row.icon}
                          <span>{row.text}</span>
                        </span>
                      ))}
                    </span>
                  </button>
                ))}
                {popoverSources.length === 0 && (
                  <div className="settings-device-popover-empty">
                    {isZh ? "当前没有已连接手柄" : "No connected controller"}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </FloatingPortal>
    </>
  );
}

function isLoadingValue(value: string): boolean {
  return value.trim() === "--";
}

function isNs2ProPopoverVisible(status: Ns2ProPairingStatus, connected: boolean, bleState: Ns2ProBleState): boolean {
  if (bleState === "Ready") {
    return true;
  }

  if (connected) {
    return true;
  }

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
