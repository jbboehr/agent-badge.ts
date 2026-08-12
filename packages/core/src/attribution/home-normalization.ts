import { createHash } from "node:crypto";
import { posix } from "node:path";

export const AGENT_BADGE_HOME_NORMALIZATION_ENV =
  "AGENT_BADGE_HOME_NORMALIZATION";

export function resolveHomeNormalization(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const value = env[AGENT_BADGE_HOME_NORMALIZATION_ENV]?.trim().toLowerCase();

  if (!value || value === "1" || value === "true") {
    return true;
  }

  if (value === "0" || value === "false") {
    return false;
  }

  throw new Error(
    `${AGENT_BADGE_HOME_NORMALIZATION_ENV} must be one of: 1, true, 0, false.`
  );
}

function normalizeAbsolutePath(value: string): string | null {
  const trimmed = value.trim();
  const isWindowsPath = /^[A-Za-z]:[\\/]/.test(trimmed);
  const withForwardSlashes = isWindowsPath
    ? trimmed.replace(/\\/g, "/")
    : trimmed;

  if (
    !withForwardSlashes.startsWith("/") &&
    !/^[A-Za-z]:\//.test(withForwardSlashes)
  ) {
    return null;
  }

  return posix.normalize(withForwardSlashes).replace(/\/$/, "");
}

function stripHomePrefix(path: string, homeRoot: string): string | null {
  const pathForComparison = /^[A-Za-z]:\//.test(path)
    ? path.toLowerCase()
    : path;
  const homeForComparison = /^[A-Za-z]:\//.test(homeRoot)
    ? homeRoot.toLowerCase()
    : homeRoot;

  if (pathForComparison === homeForComparison) {
    return null;
  }

  if (!pathForComparison.startsWith(`${homeForComparison}/`)) {
    return null;
  }

  return path.slice(homeRoot.length + 1);
}

function inferHomeRelativePath(path: string): string | null {
  const patterns = [
    /^\/(?:home|Users)\/[^/]+(?:\/(.*))?$/,
    /^\/var\/home\/[^/]+(?:\/(.*))?$/,
    /^\/root(?:\/(.*))?$/,
    /^[A-Za-z]:\/(?:Users|Documents and Settings)\/[^/]+(?:\/(.*))?$/i
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(path);

    if (match) {
      return match[1] || null;
    }
  }

  return null;
}

export function resolveHomeRelativePath(
  value: string,
  homeRoot?: string
): string | null {
  const normalizedPath = normalizeAbsolutePath(value);

  if (normalizedPath === null) {
    return null;
  }

  if (homeRoot) {
    const normalizedHome = normalizeAbsolutePath(homeRoot);
    const relativeToConfiguredHome =
      normalizedHome === null
        ? null
        : stripHomePrefix(normalizedPath, normalizedHome);

    if (relativeToConfiguredHome !== null) {
      return /^[A-Za-z]:\//.test(normalizedPath)
        ? relativeToConfiguredHome.toLowerCase()
        : relativeToConfiguredHome;
    }
  }

  const inferred = inferHomeRelativePath(normalizedPath);

  return inferred !== null && /^[A-Za-z]:\//.test(normalizedPath)
    ? inferred.toLowerCase()
    : inferred;
}

export function buildHomeNormalizationContextDigest(
  homeRoot: string,
  enabled: boolean
): string | null {
  if (!enabled) {
    return null;
  }

  const normalizedHome = normalizeAbsolutePath(homeRoot) ?? homeRoot.trim();

  return createHash("sha256")
    .update(`agent-badge-home-normalization-v1\0${normalizedHome}`)
    .digest("hex");
}
