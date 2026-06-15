import { Crosshair, Gauge, Gamepad2, Vibrate, Volume2, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { flushSync } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { UseDs5BridgeResult } from "../hooks/useDs5Bridge";
import { fieldIssue, ControllerMode, Ns2ProRumbleStyle, PollingRateMode } from "../protocol/config";
import { ControllerModeControl } from "./config/ControllerModeControl";
import { FloatControl } from "./config/FloatControl";
import { IntegerControl } from "./config/IntegerControl";
import { PollingRateControl } from "./config/PollingRateControl";
import { ToggleControl } from "./config/ToggleControl";
import { SwitchProgressDialog } from "./config/SwitchProgressDialog";

/** 进度条动画持续时间（毫秒），可修改此值调整等待时间 */
export const PROGRESS_ANIMATION_DURATION_MS = 5000;

interface ConfigPanelProps {
  bridge: UseDs5BridgeResult;
  page?: "general" | "ns2pro" | "ds5";
  /** 进度条对话框完全关闭后回调（用于通知 App 清理切换态） */
  onProgressComplete?: () => void;
}

interface SoftwareSettingsPayload {
  ns2proAutoDetectEnabled: boolean;
}

type StickCalibrationResult = "success" | "failure" | null;

export function ConfigPanel({
  bridge,
  page = "general",
  onProgressComplete,
}: ConfigPanelProps) {
  const { t } = useTranslation();
  const [showProgressDialog, setShowProgressDialog] = useState(false);
  const [progressTitle, setProgressTitle] = useState("");
  const [progressDescription, setProgressDescription] = useState("");
  const [progress, setProgress] = useState(0);
  const [ns2proAutoDetectEnabled, setNs2proAutoDetectEnabled] = useState(false);
  const [usbReconnectDialogOpen, setUsbReconnectDialogOpen] = useState(false);
  const [stickCalibrationRunning, setStickCalibrationRunning] = useState(false);
  const [stickCalibrationResult, setStickCalibrationResult] = useState<StickCalibrationResult>(null);

  const progressValueRef = useRef(0);
  const progressFrameRef = useRef<number | null>(null);
  const timeoutIdsRef = useRef<number[]>([]);
  const prevOperationRef = useRef(bridge.operation);
  const switchRunIdRef = useRef(0);
  const finishingRef = useRef(false);
  const waitingForReconnectRef = useRef(false);
  const switchStartReadyTokenRef = useRef(bridge.switchReadyToken);
  const fallbackFinishTimeoutRef = useRef<number | null>(null);
  const finishProgressRef = useRef<((runId: number) => void) | null>(null);
  const onProgressCompleteRef = useRef(onProgressComplete);

  onProgressCompleteRef.current = onProgressComplete;

  const setProgressValue = useCallback((value: number) => {
    const nextValue = Math.max(0, Math.min(100, value));
    progressValueRef.current = nextValue;
    setProgress(nextValue);
  }, []);

  const setProgressValueMonotonic = useCallback((value: number) => {
    setProgressValue(Math.max(progressValueRef.current, value));
  }, [setProgressValue]);

  const clearManagedTimeouts = useCallback(() => {
    timeoutIdsRef.current.forEach((id) => window.clearTimeout(id));
    timeoutIdsRef.current = [];
    if (fallbackFinishTimeoutRef.current !== null) {
      window.clearTimeout(fallbackFinishTimeoutRef.current);
      fallbackFinishTimeoutRef.current = null;
    }
  }, []);

  const delay = useCallback((ms: number) => {
    return new Promise<void>((resolve) => {
      const id = window.setTimeout(() => {
        timeoutIdsRef.current = timeoutIdsRef.current.filter(
          (timeoutId) => timeoutId !== id,
        );
        resolve();
      }, ms);

      timeoutIdsRef.current.push(id);
    });
  }, []);

  const stopProgressAnimation = useCallback(() => {
    if (progressFrameRef.current !== null) {
      window.cancelAnimationFrame(progressFrameRef.current);
      progressFrameRef.current = null;
    }
  }, []);

  const animateProgressTo = useCallback(
    (to: number, durationMs: number, runId: number): Promise<void> => {
      stopProgressAnimation();

      const from = progressValueRef.current;
      const startedAt = performance.now();

      return new Promise((resolve) => {
        const tick = (now: number) => {
          if (switchRunIdRef.current !== runId) {
            progressFrameRef.current = null;
            resolve();
            return;
          }

          const elapsed = now - startedAt;
          const ratio = durationMs <= 0 ? 1 : Math.min(1, elapsed / durationMs);
          setProgressValueMonotonic(from + (to - from) * ratio);

          if (ratio >= 1) {
            progressFrameRef.current = null;
            resolve();
            return;
          }

          progressFrameRef.current = window.requestAnimationFrame(tick);
        };

        progressFrameRef.current = window.requestAnimationFrame(tick);
      });
    },
    [setProgressValueMonotonic, stopProgressAnimation],
  );

  const startProgressAnimation = useCallback(
    (title: string, description: string) => {
      const runId = switchRunIdRef.current + 1;
      switchRunIdRef.current = runId;
      finishingRef.current = false;
      waitingForReconnectRef.current = false;
      switchStartReadyTokenRef.current = bridge.switchReadyToken;

      clearManagedTimeouts();
      stopProgressAnimation();

      flushSync(() => {
        setProgressTitle(title);
        setProgressDescription(description);
        setProgressValue(0);
        setShowProgressDialog(true);
      });

      // 操作执行期间最多走到 90%，等待真正完成后再补到 100%
      animateProgressTo(90, PROGRESS_ANIMATION_DURATION_MS, runId);
      fallbackFinishTimeoutRef.current = window.setTimeout(() => {
        if (switchRunIdRef.current === runId && !finishingRef.current) {
          waitingForReconnectRef.current = false;
          finishProgressRef.current?.(runId);
        }
      }, PROGRESS_ANIMATION_DURATION_MS + 6_000);
    },
    [
      animateProgressTo,
      clearManagedTimeouts,
      setProgressValue,
      bridge.switchReadyToken,
      stopProgressAnimation,
    ],
  );

  const finishProgressAndReturnHome = useCallback(
    async (runId: number) => {
      if (finishingRef.current || switchRunIdRef.current !== runId) {
        return;
      }

      finishingRef.current = true;
      if (fallbackFinishTimeoutRef.current !== null) {
        window.clearTimeout(fallbackFinishTimeoutRef.current);
        fallbackFinishTimeoutRef.current = null;
      }

      const remainingProgress = 100 - progressValueRef.current;
      const finishDurationMs = Math.max(300, remainingProgress * 10);

      await animateProgressTo(100, finishDurationMs, runId);

      if (switchRunIdRef.current !== runId) {
        return;
      }

      setProgressValue(100);

      // 让用户看到 100%
      await delay(800);

      if (switchRunIdRef.current !== runId) {
        return;
      }

      setShowProgressDialog(false);

      // 等待 Dialog 关闭动画结束
      await delay(250);

      if (switchRunIdRef.current !== runId) {
        return;
      }

      setProgressValue(0);
      finishingRef.current = false;

      // 只有这里允许通知 App 清理切换态，页面保持在设置页以避免闪动。
      onProgressCompleteRef.current?.();
    },
    [animateProgressTo, delay, setProgressValue],
  );

  finishProgressRef.current = (runId: number) => {
    void finishProgressAndReturnHome(runId);
  };

  useEffect(() => {
    const prevOperation = prevOperationRef.current;
    prevOperationRef.current = bridge.operation;

    if (!showProgressDialog || bridge.operation !== null || prevOperation === null) {
      return;
    }

    if (bridge.shouldReturnHomeRef.current) {
      waitingForReconnectRef.current = true;
      return;
    }

    void finishProgressAndReturnHome(switchRunIdRef.current);
  }, [bridge.client, bridge.operation, bridge.shouldReturnHomeRef, finishProgressAndReturnHome, showProgressDialog]);

  useEffect(() => {
    if (!showProgressDialog || bridge.switchReadyToken === switchStartReadyTokenRef.current) {
      return;
    }

    waitingForReconnectRef.current = false;
    void finishProgressAndReturnHome(switchRunIdRef.current);
  }, [bridge.switchReadyToken, finishProgressAndReturnHome, showProgressDialog]);

  useEffect(() => {
    return () => {
      switchRunIdRef.current += 1;
      clearManagedTimeouts();
      stopProgressAnimation();
    };
  }, [clearManagedTimeouts, stopProgressAnimation]);

  useEffect(() => {
    setUsbReconnectDialogOpen(bridge.pendingUsbReconnectPrompt);
  }, [bridge.pendingUsbReconnectPrompt]);

  useEffect(() => {
    let active = true;
    void invoke<boolean>("ds5_get_ns2pro_auto_detect_enabled")
      .then((enabled) => {
        if (active) {
          setNs2proAutoDetectEnabled(enabled);
        }
      })
      .catch(() => undefined);

    const unlistenPromise = listen<SoftwareSettingsPayload>("ds5-software-settings-changed", (event) => {
      setNs2proAutoDetectEnabled(event.payload.ns2proAutoDetectEnabled);
    });

    return () => {
      active = false;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // 处理回报率切换
  const handlePollingRateChange = (value: PollingRateMode) => {
    const isChanged = bridge.draft.pollingRateMode !== value;

    if (!isChanged) {
      return;
    }

    bridge.setDraftField("pollingRateMode", value);
  };

  // 处理模式切换
  const handleControllerModeChange = (value: ControllerMode) => {
    const isChanged = bridge.draft.controllerMode !== value;

    if (!isChanged) {
      return;
    }

    bridge.setDraftField("controllerMode", value);
  };

  const handleNs2ProRumbleStyleChange = (value: Ns2ProRumbleStyle) => {
    bridge.setDraftField("ns2proRumbleStyle", value);
  };

  const handleNs2ProAutoDetectChange = (enabled: boolean) => {
    const previous = ns2proAutoDetectEnabled;
    setNs2proAutoDetectEnabled(enabled);

    void invoke<SoftwareSettingsPayload>("ds5_set_ns2pro_auto_detect_enabled", { enabled })
      .then((settings) => setNs2proAutoDetectEnabled(settings.ns2proAutoDetectEnabled))
      .catch(() => setNs2proAutoDetectEnabled(previous));
  };

  const handleUsbReconnectDialogOpenChange = (open: boolean) => {
    setUsbReconnectDialogOpen(open);
    if (!open) {
      bridge.dismissPendingUsbReconnectPrompt();
    }
  };

  const handleNs2ProStickCalibration = useCallback(async () => {
    if (stickCalibrationRunning) {
      return;
    }

    const runId = switchRunIdRef.current + 1;
    switchRunIdRef.current = runId;
    finishingRef.current = false;
    setStickCalibrationRunning(true);
    setStickCalibrationResult(null);
    clearManagedTimeouts();
    stopProgressAnimation();

    flushSync(() => {
      setProgressTitle(t("config.calibratingStickCenter"));
      setProgressDescription(t("config.calibratingStickCenterDescription"));
      setProgressValue(0);
      setShowProgressDialog(true);
    });

    const progressTask = animateProgressTo(90, 1400, runId);
    const succeeded = await bridge.calibrateNs2ProStickCenter();

    if (switchRunIdRef.current !== runId) {
      return;
    }

    await progressTask;
    await animateProgressTo(100, 240, runId);

    if (switchRunIdRef.current !== runId) {
      return;
    }

    await delay(250);
    setShowProgressDialog(false);
    setProgressValue(0);
    setStickCalibrationRunning(false);
    setStickCalibrationResult(succeeded ? "success" : "failure");
  }, [
    animateProgressTo,
    bridge,
    clearManagedTimeouts,
    delay,
    setProgressValue,
    stickCalibrationRunning,
    stopProgressAnimation,
    t,
  ]);

  return (
    <>
      <Card className="panel config-panel">
        {page === "ns2pro" ? (
          <CardContent className="config-sections p-0">
            <section className="config-section config-section-featured config-section-ns2pro-rumble">
              <div className="config-section-heading">
                <span className="config-section-icon">
                  <Vibrate size={17} />
                </span>
                <div>
                  <h3>{t("config.sections.ns2proRumble")}</h3>
                  <p>{t("config.sections.ns2proRumbleDescription")}</p>
                </div>
              </div>
              <div className="control-stack">
                <div className="control-row control-row-plain">
                  <strong>{t("config.rumbleStyle")}</strong>
                  <em>{t("config.rumbleStyleDescription")}</em>
                  <Tabs
                    value={String(bridge.draft.ns2proRumbleStyle)}
                    onValueChange={(next) => handleNs2ProRumbleStyleChange(Number(next) as Ns2ProRumbleStyle)}
                    className="w-full"
                  >
                    <TabsList className="grid h-10 w-full grid-cols-2">
                      <TabsTrigger value="0" className="h-8 text-sm font-bold">
                        {t("config.rumbleStyleOptions.linear")}
                      </TabsTrigger>
                      <TabsTrigger value="1" className="h-8 text-sm font-bold">
                        {t("config.rumbleStyleOptions.haptic")}
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>
                <FloatControl
                  label={t("config.rumbleStrength")}
                  value={bridge.draft.ns2proRumbleGain}
                  min={0}
                  max={2}
                  step={0.05}
                  displayScale={100}
                  displayMin={0}
                  displayMax={200}
                  displayStep={5}
                  fractionDigits={0}
                  issue={fieldIssue(bridge.issues, "ns2proRumbleGain")}
                  onChange={(value) => bridge.setDraftField("ns2proRumbleGain", value)}
                />
                <div className="control-row toggle-row">
                  <span>
                    <strong>{t("softwareSettings.ns2proAutoDetect")}</strong>
                    <small>{t("softwareSettings.ns2proAutoDetectDescription")}</small>
                  </span>
                  <Switch
                    checked={ns2proAutoDetectEnabled}
                    onCheckedChange={handleNs2ProAutoDetectChange}
                    className="justify-self-end"
                    title={ns2proAutoDetectEnabled ? t("toggle.enabled") : t("toggle.disabled")}
                    aria-label={t("softwareSettings.ns2proAutoDetect")}
                  />
                </div>
              </div>
            </section>
            <section className="config-section config-section-ns2pro-stick">
              <div className="config-section-heading">
                <span className="config-section-icon">
                  <Crosshair size={17} />
                </span>
                <div>
                  <h3>{t("config.sections.ns2proStick")}</h3>
                  <p>{t("config.sections.ns2proStickDescription")}</p>
                </div>
              </div>
              <div className="control-stack">
                <IntegerControl
                  label={`${t("config.ns2proLeftStickDeadzone")} (%)`}
                  description={t("config.ns2proLeftStickDeadzoneDescription")}
                  value={bridge.draft.ns2proLeftStickDeadzonePercent}
                  min={0}
                  max={30}
                  issue={fieldIssue(bridge.issues, "ns2proLeftStickDeadzonePercent")}
                  onChange={(value) => bridge.setDraftField("ns2proLeftStickDeadzonePercent", value)}
                />
                <IntegerControl
                  label={`${t("config.ns2proRightStickDeadzone")} (%)`}
                  description={t("config.ns2proRightStickDeadzoneDescription")}
                  value={bridge.draft.ns2proRightStickDeadzonePercent}
                  min={0}
                  max={30}
                  issue={fieldIssue(bridge.issues, "ns2proRightStickDeadzonePercent")}
                  onChange={(value) => bridge.setDraftField("ns2proRightStickDeadzonePercent", value)}
                />
                <ToggleControl
                  label={t("config.ns2proAutoStickCenter")}
                  description={t("config.ns2proAutoStickCenterDescription")}
                  value={bridge.draft.ns2proAutoStickCenter}
                  onChange={(value) => bridge.setDraftField("ns2proAutoStickCenter", value)}
                />
                <div className="control-row control-row-action">
                  <span>
                    <strong>{t("config.ns2proCalibrateStickCenter")}</strong>
                    <small>{t("config.ns2proCalibrateStickCenterDescription")}</small>
                  </span>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void handleNs2ProStickCalibration()}
                    disabled={!bridge.isConnected || bridge.operation !== null || stickCalibrationRunning}
                  >
                    {t("config.calibrateNow")}
                  </Button>
                </div>
              </div>
            </section>
          </CardContent>
        ) : page === "ds5" ? (
          <CardContent className="config-sections p-0">
            <section className="config-section config-section-featured">
              <div className="config-section-heading">
                <span className="config-section-icon">
                  <Volume2 size={17} />
                </span>
                <div>
                  <h3>{t("config.sections.ds5Haptics")}</h3>
                  <p>{t("config.sections.ds5HapticsDescription")}</p>
                </div>
              </div>
              <div className="control-stack">
                <FloatControl
                  label={t("config.ds5HapticsGain")}
                  description={t("config.ds5HapticsGainDescription")}
                  value={bridge.draft.ds5HapticsGain}
                  min={0}
                  max={2}
                  step={0.05}
                  displayScale={100}
                  displayMin={0}
                  displayMax={200}
                  displayStep={5}
                  fractionDigits={0}
                  issue={fieldIssue(bridge.issues, "ds5HapticsGain")}
                  onChange={(value) => bridge.setDraftField("ds5HapticsGain", value)}
                />
                <FloatControl
                  label={`${t("config.speakerVolume")} (%)`}
                  description={t("config.speakerVolumeDescription")}
                  value={bridge.draft.speakerVolume}
                  min={-100}
                  max={0}
                  step={0.01}
                  displayMin={0}
                  displayMax={100}
                  displayStep={1}
                  valueToDisplay={speakerVolumeToPercent}
                  displayToValue={percentToSpeakerVolume}
                  fractionDigits={0}
                  issue={fieldIssue(bridge.issues, "speakerVolume")}
                  onChange={(value) => bridge.setDraftField("speakerVolume", value)}
                />
                <IntegerControl
                  label={t("config.hapticsBufferLength")}
                  description={t("config.hapticsBufferLengthDescription")}
                  value={bridge.draft.hapticsBufferLength}
                  min={16}
                  max={128}
                  issue={fieldIssue(bridge.issues, "hapticsBufferLength")}
                  onChange={(value) => bridge.setDraftField("hapticsBufferLength", value)}
                />
              </div>
            </section>
            <section className="config-section">
              <div className="config-section-heading">
                <span className="config-section-icon">
                  <Crosshair size={17} />
                </span>
                <div>
                  <h3>{t("config.sections.ds5Stick")}</h3>
                  <p>{t("config.sections.ds5StickDescription")}</p>
                </div>
              </div>
              <div className="control-stack">
                <IntegerControl
                  label={`${t("config.ds5LeftStickDeadzone")} (%)`}
                  description={t("config.ds5LeftStickDeadzoneDescription")}
                  value={bridge.draft.ds5LeftStickDeadzonePercent}
                  min={0}
                  max={30}
                  issue={fieldIssue(bridge.issues, "ds5LeftStickDeadzonePercent")}
                  onChange={(value) => bridge.setDraftField("ds5LeftStickDeadzonePercent", value)}
                />
                <IntegerControl
                  label={`${t("config.ds5RightStickDeadzone")} (%)`}
                  description={t("config.ds5RightStickDeadzoneDescription")}
                  value={bridge.draft.ds5RightStickDeadzonePercent}
                  min={0}
                  max={30}
                  issue={fieldIssue(bridge.issues, "ds5RightStickDeadzonePercent")}
                  onChange={(value) => bridge.setDraftField("ds5RightStickDeadzonePercent", value)}
                />
              </div>
            </section>
          </CardContent>
        ) : (
          <CardContent className="config-sections p-0">
            <section className="config-section">
              <div className="config-section-heading">
                <span className="config-section-icon">
                  <Gamepad2 size={17} />
                </span>
                <div>
                  <h3>{t("config.sections.compatibility")}</h3>
                  <p>{t("config.sections.compatibilityDescription")}</p>
                </div>
              </div>
              <div className="control-stack compact-stack">
                <ControllerModeControl
                  value={bridge.draft.controllerMode}
                  onChange={handleControllerModeChange}
                />
              </div>
            </section>

            <section className="config-section">
              <div className="config-section-heading">
                <span className="config-section-icon">
                  <Gauge size={17} />
                </span>
                <div>
                  <h3>{t("config.sections.performance")}</h3>
                  <p>{t("config.sections.performanceDescription")}</p>
                </div>
              </div>
              <div className="control-stack compact-stack">
                <div className="config-tip">{t("config.pollingRateTip")}</div>
                <PollingRateControl
                  value={bridge.draft.pollingRateMode}
                  onChange={handlePollingRateChange}
                />
              </div>
            </section>

            <section className="config-section">
              <div className="config-section-heading">
                <span className="config-section-icon">
                  <Zap size={17} />
                </span>
                <div>
                  <h3>{t("config.sections.power")}</h3>
                  <p>{t("config.sections.powerDescription")}</p>
                </div>
              </div>
              <div className="control-stack compact-stack">
                <IntegerControl
                  label={`${t("config.inactiveTime")} (${t("config.inactiveTimeUnit")})`}
                  description={t("config.inactiveTimeDescription")}
                  value={bridge.draft.inactiveTime}
                  min={5}
                  max={60}
                  disabled={bridge.draft.disableInactiveDisconnect}
                  issue={fieldIssue(bridge.issues, "inactiveTime")}
                  onChange={(value) => bridge.setDraftField("inactiveTime", value)}
                />
                <ToggleControl
                  label={t("config.disableInactiveDisconnect")}
                  value={bridge.draft.disableInactiveDisconnect}
                  onChange={(value) => bridge.setDraftField("disableInactiveDisconnect", value)}
                />
                <ToggleControl
                  label={t("config.disablePicoLed")}
                  value={bridge.draft.disablePicoLed}
                  onChange={(value) => bridge.setDraftField("disablePicoLed", value)}
                />
              </div>
            </section>
          </CardContent>
        )}
      </Card>
      <SwitchProgressDialog
        open={showProgressDialog}
        title={progressTitle}
        description={progressDescription}
        progress={progress}
      />
      <Dialog open={stickCalibrationResult !== null} onOpenChange={(open) => !open && setStickCalibrationResult(null)}>
        <DialogContent className="sm:max-w-md" data-no-drag>
          <DialogHeader>
            <DialogTitle>
              {stickCalibrationResult === "success"
                ? t("config.stickCalibrationSucceededTitle")
                : t("config.stickCalibrationFailedTitle")}
            </DialogTitle>
            <DialogDescription>
              {stickCalibrationResult === "success"
                ? t("config.stickCalibrationSucceededDescription")
                : t("config.stickCalibrationFailedDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" onClick={() => setStickCalibrationResult(null)}>
              {t("config.stickCalibrationResultOk")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {usbReconnectDialogOpen && (
        <div className="usb-reconnect-toast" role="alert" data-no-drag>
          <div className="usb-reconnect-toast-copy">
            <strong>{t("config.usbReconnectPromptTitle")}</strong>
            <p>{t("config.usbReconnectPromptDescription")}</p>
          </div>
          <div className="usb-reconnect-toast-actions">
            <Button type="button" variant="ghost" onClick={() => handleUsbReconnectDialogOpenChange(false)}>
              {t("config.usbReconnectPromptLater")}
            </Button>
            <Button
              type="button"
              onClick={() => {
                handleUsbReconnectDialogOpenChange(false);
                startProgressAnimation(
                  t("config.switchingUsbSettings"),
                  t("config.switchingUsbSettingsDescription"),
                );
                void bridge.applyPendingUsbReconnect();
              }}
            >
              {t("config.usbReconnectPromptApply")}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

function speakerVolumeToPercent(value: number): number {
  if (value <= -100) {
    return 0;
  }

  return Math.min(100, Math.max(0, 100 * 10 ** (value / 20)));
}

function percentToSpeakerVolume(value: number): number {
  if (value <= 0) {
    return -100;
  }

  return Math.min(0, Math.max(-100, 20 * Math.log10(value / 100)));
}
