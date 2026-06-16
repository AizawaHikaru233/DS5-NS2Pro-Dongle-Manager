import type { CSSProperties } from "react";
import packageJson from "../package.json";

export type AppView = "home" | "settings" | "mappingSettings" | "ns2proSettings" | "ds5Settings" | "about";

export const APP_METADATA = {
  version: packageJson.version,
  githubRepo: "AizawaHikaru233/DS5-NS2Pro-Dongle-Manager",
  githubUrl: "https://github.com/AizawaHikaru233/DS5-NS2Pro-Dongle-Manager",
  firmwareGithubRepo: "AizawaHikaru233/DS5_NS2Pro_Dongle",
  firmwareGithubUrl: "https://github.com/AizawaHikaru233/DS5_NS2Pro_Dongle",
  firmwareUpdateApiUrl: "https://api.github.com/repos/AizawaHikaru233/DS5_NS2Pro_Dongle/releases/latest",
  softwareUpdateApiUrl: "https://api.github.com/repos/AizawaHikaru233/DS5-NS2Pro-Dongle-Manager/releases/latest",
} as const;

export const APP_TOAST_OPTIONS = {
  className: "app-toast",
  duration: 4200,
  style: {
    background: "var(--card)",
    color: "var(--card-foreground)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    boxShadow: "0 16px 42px rgba(16, 24, 40, 0.12)",
  },
  error: {
    iconTheme: {
      primary: "var(--destructive)",
      secondary: "var(--card)",
    },
  },
} as const;

export const SETTINGS_SIDEBAR_PROVIDER_STYLE = {
  "--sidebar-width": "300px",
  "--sidebar-width-icon": "80px",
} as CSSProperties;

export const SETTINGS_SIDEBAR_AUTO_COLLAPSE_QUERY = "(max-width: 1120px)";
