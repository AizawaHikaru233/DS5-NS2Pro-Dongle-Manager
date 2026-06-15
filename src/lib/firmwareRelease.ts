import { APP_METADATA } from "../appConfig";

const UNKNOWN_VERSION = "--";
const FIRMWARE_UPDATE_CACHE_PREFIX = "firmware-update-cache:";
const FIRMWARE_UPDATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FIRMWARE_UPDATE_TIMEOUT_MS = import.meta.env.DEV ? 30_000 : 15_000;

export interface FirmwareReleaseAsset {
  name: string;
  downloadUrl: string;
}

export interface FirmwareReleaseInfo {
  tagName: string;
  name: string;
  body: string;
  htmlUrl: string;
  publishedAt: string | null;
  commitSha: string | null;
  assets: FirmwareReleaseAsset[];
  localizedNotes?: FirmwareLocalizedNotes;
}

export interface FirmwareUpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  currentRelease: FirmwareReleaseInfo | null;
  latestRelease: FirmwareReleaseInfo;
}

export interface FirmwareLocalizedNotes {
  zh_CN: FirmwareLocalizedBlock;
  en_US: FirmwareLocalizedBlock;
}

export interface FirmwareLocalizedBlock {
  title: string;
  summary: string;
  highlights: string[];
  upgradeNotice: string;
}

interface GitHubReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

interface GitHubRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  published_at?: string | null;
  target_commitish?: string | null;
  assets?: GitHubReleaseAsset[];
}

export async function checkFirmwareUpdate(currentVersion: string, signal?: AbortSignal): Promise<FirmwareUpdateCheckResult | null> {
  if (!shouldCheckFirmwareUpdate(currentVersion)) {
    return null;
  }

  const normalizedVersion = normalizeCurrentVersion(currentVersion);
  const cachedResult = readCachedFirmwareUpdate(normalizedVersion);

  if (cachedResult) {
    void refreshFirmwareUpdateCache(normalizedVersion);
    return cachedResult;
  }

  return fetchFirmwareUpdate(normalizedVersion, signal);
}

export function shouldCheckFirmwareUpdate(currentVersion: string): boolean {
  const normalizedVersion = normalizeCurrentVersion(currentVersion);

  return Boolean(
    typeof window !== "undefined" &&
      navigator.onLine &&
      normalizedVersion &&
      normalizedVersion !== UNKNOWN_VERSION &&
      isLikelyFirmwareVersion(normalizedVersion),
  );
}

function firmwareUpdateUrl(currentVersion: string): string {
  const url = new URL(APP_METADATA.firmwareUpdateApiUrl);
  url.searchParams.set("currentVersion", currentVersion);
  return url.toString();
}

async function fetchFirmwareUpdate(currentVersion: string, signal?: AbortSignal): Promise<FirmwareUpdateCheckResult> {
  const result = normalizeFirmwareUpdateResult(
    await fetchJson<Partial<FirmwareUpdateCheckResult> | GitHubRelease>(firmwareUpdateUrl(currentVersion), mergeWithTimeout(signal)),
    currentVersion,
  );
  writeCachedFirmwareUpdate(currentVersion, result);
  return result;
}

function refreshFirmwareUpdateCache(currentVersion: string): void {
  if (!navigator.onLine) {
    return;
  }

  void fetchFirmwareUpdate(currentVersion).catch((error) => {
    console.debug("Firmware update cache refresh failed", error);
  });
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Firmware update check failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

function normalizeCurrentVersion(version: string): string {
  const normalized = version.trim();

  if (/^\d{3}$/.test(normalized)) {
    return `v${Number(normalized[0])}.${Number(normalized[1])}.${Number(normalized[2])}`;
  }

  const semanticMatch = normalized.match(/^v?(\d+\.\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)$/i);
  if (semanticMatch) {
    return `v${semanticMatch[1]}`;
  }

  return normalized;
}

function isLikelyFirmwareVersion(version: string): boolean {
  return /^\d{3}$/.test(version) || /^v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/i.test(version);
}

function normalizeFirmwareUpdateResult(result: Partial<FirmwareUpdateCheckResult> | GitHubRelease, currentVersion: string): FirmwareUpdateCheckResult {
  if (isGitHubRelease(result)) {
    const latestRelease = normalizeGitHubFirmwareRelease(result);
    return {
      updateAvailable: compareFirmwareVersions(latestRelease.tagName, currentVersion) > 0,
      currentVersion,
      currentRelease: null,
      latestRelease,
    };
  }

  if (!result.latestRelease?.tagName) {
    throw new Error("Firmware update check failed: invalid latest release payload");
  }

  const latestRelease = normalizeFirmwareReleaseInfo(result.latestRelease);
  const normalizedCurrentVersion = normalizeCurrentVersion(result.currentVersion || currentVersion);
  return {
    updateAvailable: result.updateAvailable ?? compareFirmwareVersions(latestRelease.tagName, normalizedCurrentVersion) > 0,
    currentVersion: normalizedCurrentVersion,
    currentRelease: result.currentRelease ? normalizeFirmwareReleaseInfo(result.currentRelease) : null,
    latestRelease,
  };
}

function isGitHubRelease(result: Partial<FirmwareUpdateCheckResult> | GitHubRelease): result is GitHubRelease {
  return Boolean((result as GitHubRelease).tag_name || (result as GitHubRelease).html_url);
}

function normalizeGitHubFirmwareRelease(release: GitHubRelease): FirmwareReleaseInfo {
  return {
    tagName: normalizeCurrentVersion(String(release.tag_name || UNKNOWN_VERSION)),
    name: String(release.name || release.tag_name || UNKNOWN_VERSION),
    body: String(release.body || ""),
    htmlUrl: String(release.html_url || APP_METADATA.firmwareGithubUrl),
    publishedAt: typeof release.published_at === "string" ? release.published_at : null,
    commitSha: typeof release.target_commitish === "string" ? release.target_commitish : null,
    assets: Array.isArray(release.assets)
      ? release.assets
        .filter((asset): asset is Required<GitHubReleaseAsset> => Boolean(asset?.name && asset?.browser_download_url))
        .map((asset) => ({ name: String(asset.name), downloadUrl: String(asset.browser_download_url) }))
      : [],
  };
}

function normalizeFirmwareReleaseInfo(release: Partial<FirmwareReleaseInfo>): FirmwareReleaseInfo {
  return {
    tagName: normalizeCurrentVersion(String(release.tagName || UNKNOWN_VERSION)),
    name: String(release.name || release.tagName || UNKNOWN_VERSION),
    body: String(release.body || ""),
    htmlUrl: String(release.htmlUrl || APP_METADATA.firmwareGithubUrl),
    publishedAt: typeof release.publishedAt === "string" ? release.publishedAt : null,
    commitSha: typeof release.commitSha === "string" ? release.commitSha : null,
    assets: Array.isArray(release.assets)
      ? release.assets
        .filter((asset): asset is FirmwareReleaseAsset => Boolean(asset?.name && asset?.downloadUrl))
        .map((asset) => ({ name: String(asset.name), downloadUrl: String(asset.downloadUrl) }))
      : [],
    localizedNotes: release.localizedNotes,
  };
}

function compareFirmwareVersions(left: string, right: string): number {
  const leftParts = parseFirmwareVersionParts(left);
  const rightParts = parseFirmwareVersionParts(right);

  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

function parseFirmwareVersionParts(version: string): number[] {
  const match = version.trim().match(/^v?(\d+(?:\.\d+){0,3})/i);
  return match ? match[1].split(".").map((part) => Number(part) || 0) : [0];
}

function cacheKey(currentVersion: string): string {
  return `${FIRMWARE_UPDATE_CACHE_PREFIX}${currentVersion}`;
}

function readCachedFirmwareUpdate(currentVersion: string): FirmwareUpdateCheckResult | null {
  try {
    const raw = localStorage.getItem(cacheKey(currentVersion));

    if (!raw) {
      return null;
    }

    const cached = JSON.parse(raw) as { savedAt?: number; result?: FirmwareUpdateCheckResult };

    if (!cached.savedAt || !cached.result || Date.now() - cached.savedAt > FIRMWARE_UPDATE_CACHE_TTL_MS) {
      localStorage.removeItem(cacheKey(currentVersion));
      return null;
    }

    return cached.result;
  } catch {
    return null;
  }
}

function writeCachedFirmwareUpdate(currentVersion: string, result: FirmwareUpdateCheckResult): void {
  try {
    localStorage.setItem(cacheKey(currentVersion), JSON.stringify({ savedAt: Date.now(), result }));
  } catch {
    // Ignore storage quota or private-mode failures; the live response is still usable.
  }
}

function mergeWithTimeout(signal?: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), FIRMWARE_UPDATE_TIMEOUT_MS);

  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }

  controller.signal.addEventListener("abort", () => window.clearTimeout(timeoutId), { once: true });
  return controller.signal;
}
