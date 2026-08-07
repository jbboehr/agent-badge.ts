import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const AGENT_BADGE_CODEX_DIR_ENV = "AGENT_BADGE_CODEX_DIR";
export const AGENT_BADGE_CLAUDE_DIR_ENV = "AGENT_BADGE_CLAUDE_DIR";
export const AGENT_BADGE_GROK_DIR_ENV = "AGENT_BADGE_GROK_DIR";

export interface ProviderDirectories {
  readonly codex: string;
  readonly claude: string;
  readonly grok: string;
}

export interface ResolveProviderDirectoriesOptions {
  readonly cwd?: string;
  readonly homeRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
}

function resolveConfiguredDirectory(
  configured: string | undefined,
  defaultPath: string,
  cwd: string,
  homeRoot: string
): string {
  const value = configured?.trim();

  if (!value) {
    return defaultPath;
  }

  if (value === "~") {
    return homeRoot;
  }

  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return resolve(homeRoot, value.slice(2));
  }

  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

export function resolveProviderDirectories(
  options: ResolveProviderDirectoriesOptions = {}
): ProviderDirectories {
  const cwd = resolve(options.cwd ?? process.cwd());
  const homeRoot = resolve(options.homeRoot ?? homedir());
  const useAmbientEnvironment =
    options.homeRoot === undefined || homeRoot === resolve(homedir());
  const env = options.env ?? (useAmbientEnvironment ? process.env : {});

  return {
    codex: resolveConfiguredDirectory(
      env[AGENT_BADGE_CODEX_DIR_ENV],
      join(homeRoot, ".codex"),
      cwd,
      homeRoot
    ),
    claude: resolveConfiguredDirectory(
      env[AGENT_BADGE_CLAUDE_DIR_ENV],
      join(homeRoot, ".claude"),
      cwd,
      homeRoot
    ),
    grok: resolveConfiguredDirectory(
      env[AGENT_BADGE_GROK_DIR_ENV] ?? env.GROK_HOME,
      join(homeRoot, ".grok"),
      cwd,
      homeRoot
    )
  };
}
