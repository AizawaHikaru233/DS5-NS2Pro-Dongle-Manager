import { Gamepad2, Info, Settings } from "lucide-react";
import { FaGithub } from "react-icons/fa";
import { useTranslation } from "react-i18next";
import {
  APP_METADATA,
  SETTINGS_SIDEBAR_PROVIDER_STYLE,
  type AppView,
} from "@/appConfig";
import { ConfigPanel } from "@/components/ConfigPanel";
import { ButtonMappingPanel } from "@/components/ButtonMappingPanel";
import { SidebarDeviceCard } from "@/components/SidebarDeviceCard";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import type { FirmwareUpdateCheckResult } from "@/lib/firmwareRelease";
import type { UseDs5BridgeResult } from "@/hooks/useDs5Bridge";
import type { DeviceInputSource } from "@/components/DeviceStrip";

const GENERAL_NAV_ITEMS = [
  { icon: Gamepad2, labelKey: "settings.nav.mapping", view: "mappingSettings" },
  { icon: Settings, labelKey: "settings.nav.general", view: "settings" },
  { icon: Info, labelKey: "settings.nav.about", view: "about" },
] as const satisfies ReadonlyArray<{
  icon: typeof Settings;
  labelKey: string;
  view: Exclude<AppView, "home">;
}>;

interface SettingsViewProps {
  bridge: UseDs5BridgeResult;
  selectedInputSource: DeviceInputSource;
  firmwareUpdateResult: FirmwareUpdateCheckResult | null;
  sidebarOpen: boolean;
  view: AppView;
  onFirmwareUpdateClick: () => void;
  onProgressComplete: () => void;
  onSelectedInputSourceChange: (source: DeviceInputSource) => void;
  onSidebarOpenChange: (open: boolean) => void;
  onViewChange: (view: AppView) => void;
}

export function SettingsView({
  bridge,
  selectedInputSource,
  firmwareUpdateResult,
  sidebarOpen,
  view,
  onFirmwareUpdateClick,
  onProgressComplete,
  onSelectedInputSourceChange,
  onSidebarOpenChange,
  onViewChange,
}: SettingsViewProps) {
  const { t } = useTranslation();
  const controllerSpecificItem = selectedInputSource === "NS2Pro"
    ? { icon: Gamepad2, labelKey: "settings.nav.ns2pro", view: "ns2proSettings" as const }
    : { icon: Gamepad2, labelKey: "settings.nav.ds5", view: "ds5Settings" as const };
  const navItems = [controllerSpecificItem, ...GENERAL_NAV_ITEMS];

  return (
    <SidebarProvider className="settings-page" style={SETTINGS_SIDEBAR_PROVIDER_STYLE} open={sidebarOpen} onOpenChange={onSidebarOpenChange}>
      <Sidebar className="settings-sidebar" collapsible="icon" aria-label={t("settings.navigation")}>
        <SidebarContent className="settings-sidebar-content">
          <SidebarDeviceCard
            connectedDevice={bridge.client?.device ?? null}
            selectedInputSource={selectedInputSource}
            deviceLabel={bridge.deviceLabel}
            batteryText={bridge.batteryText}
            ns2proBatteryText={bridge.ns2proBatteryText}
            firmwareVersion={bridge.firmwareVersion}
            signalStrength={bridge.signalStrength}
            inputMode={bridge.inputMode}
            inputOwner={bridge.inputOwner}
            ds5Connected={bridge.ds5Connected}
            ns2proConnected={bridge.ns2proConnected}
            ns2proBleState={bridge.ns2proBleState}
            ns2proBleHasBond={bridge.ns2proBleHasBond}
            ns2ProPairing={bridge.ns2ProPairing}
            firmwareUpdateAvailable={Boolean(firmwareUpdateResult?.updateAvailable)}
            firmwareUpdateVersion={firmwareUpdateResult?.latestRelease.tagName}
            onFirmwareUpdateClick={onFirmwareUpdateClick}
            onSelectedInputSourceChange={onSelectedInputSourceChange}
          />
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {navItems.map((item) => {
                  const label = t(item.labelKey);

                  return (
                    <SidebarMenuItem key={item.labelKey}>
                      <SidebarMenuButton type="button" isActive={view === item.view} tooltip={label} onClick={() => onViewChange(item.view)}>
                        <item.icon />
                        <span>{label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarTrigger className="settings-sidebar-trigger" />
      </Sidebar>

      <SidebarInset className="settings-detail">
        <div key={view} className="settings-view-transition">
          {view === "settings" || view === "ns2proSettings" || view === "ds5Settings" ? (
            <ConfigPanel
              bridge={bridge}
              page={view === "ns2proSettings" ? "ns2pro" : view === "ds5Settings" ? "ds5" : "general"}
              onProgressComplete={onProgressComplete}
            />
          ) : view === "mappingSettings" ? (
            <ButtonMappingPanel bridge={bridge} source={selectedInputSource} />
          ) : (
            <section className="panel about-panel" aria-labelledby="about-title">
              <div className="panel-title about-panel-title">
                <Info size={18} />
                <h2 id="about-title">{t("about.title")}</h2>
              </div>

              <div className="about-info-grid">
                {APP_METADATA.githubUrl ? (
                  <a className="config-section about-github-card" href={APP_METADATA.githubUrl} target="_blank" rel="noreferrer">
                    <FaGithub aria-hidden="true" />
                    <span>
                      <span className="about-info-label">{t("about.softwareGithub")}</span>
                      <strong>{APP_METADATA.githubUrl}</strong>
                    </span>
                  </a>
                ) : (
                  <div className="config-section about-github-card">
                    <FaGithub aria-hidden="true" />
                    <span>
                      <span className="about-info-label">{t("about.softwareGithub")}</span>
                      <strong>{APP_METADATA.githubRepo}</strong>
                    </span>
                  </div>
                )}
                <a className="config-section about-github-card" href={APP_METADATA.firmwareGithubUrl} target="_blank" rel="noreferrer">
                  <FaGithub aria-hidden="true" />
                  <span>
                    <span className="about-info-label">{t("about.firmwareGithub")}</span>
                    <strong>{APP_METADATA.firmwareGithubUrl}</strong>
                  </span>
                </a>
              </div>
            </section>
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
