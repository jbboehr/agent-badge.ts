import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  AGENT_BADGE_CLAUDE_DIR_ENV,
  AGENT_BADGE_CODEX_DIR_ENV,
  resolveProviderDirectories
} from "../providers/provider-directories.js";

export type ProviderName = "codex" | "claude";
export type ProviderHomeLabel = string;

export interface ProviderAvailability {
  readonly available: boolean;
  readonly homeLabel: ProviderHomeLabel;
}

export interface ProviderDetectionResult {
  readonly codex: ProviderAvailability;
  readonly claude: ProviderAvailability;
}

export interface DetectProviderAvailabilityOptions {
  readonly cwd?: string;
  readonly homeRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
}

function buildProviderAvailability(
  rootPath: string,
  homeLabel: ProviderHomeLabel
): ProviderAvailability {
  return {
    available: existsSync(rootPath),
    homeLabel
  };
}

export function detectProviderAvailability(
  options: DetectProviderAvailabilityOptions = {}
): ProviderDetectionResult {
  const homeRoot = options.homeRoot ?? homedir();
  const useAmbientEnvironment =
    options.homeRoot === undefined || resolve(homeRoot) === resolve(homedir());
  const env = options.env ?? (useAmbientEnvironment ? process.env : {});
  const directories = resolveProviderDirectories({
    cwd: options.cwd,
    homeRoot,
    env
  });

  return {
    codex: buildProviderAvailability(
      directories.codex,
      env[AGENT_BADGE_CODEX_DIR_ENV]?.trim() ? directories.codex : "~/.codex"
    ),
    claude: buildProviderAvailability(
      directories.claude,
      env[AGENT_BADGE_CLAUDE_DIR_ENV]?.trim()
        ? directories.claude
        : "~/.claude"
    )
  };
}
