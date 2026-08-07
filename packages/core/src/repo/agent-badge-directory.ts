import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const AGENT_BADGE_DIR_ENV = "AGENT_BADGE_DIR";
export const DEFAULT_AGENT_BADGE_DIR = ".agent-badge";
export const GITHUB_AGENT_BADGE_DIR = ".github/agent-badge";

export interface AgentBadgePaths {
  readonly directory: string;
  readonly rootPath: string;
  readonly configPath: string;
  readonly statePath: string;
  readonly cachePath: string;
  readonly logsPath: string;
  readonly refreshCachePath: string;
  readonly pricingCachePath: string;
}

export interface ResolveAgentBadgePathsOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}

function toPortablePath(value: string): string {
  return sep === "/" ? value : value.split(sep).join("/");
}

function resolveConfiguredDirectory(cwd: string, configured: string): string {
  const rootPath = resolve(cwd, configured);
  const directory = relative(cwd, rootPath);

  if (
    directory.length === 0 ||
    directory === ".." ||
    directory.startsWith(`..${sep}`) ||
    isAbsolute(directory)
  ) {
    throw new Error(
      `${AGENT_BADGE_DIR_ENV} must name a directory inside the repository.`
    );
  }

  return toPortablePath(directory);
}

function detectDirectory(cwd: string): string {
  if (existsSync(resolve(cwd, GITHUB_AGENT_BADGE_DIR))) {
    return GITHUB_AGENT_BADGE_DIR;
  }

  if (existsSync(resolve(cwd, DEFAULT_AGENT_BADGE_DIR))) {
    return DEFAULT_AGENT_BADGE_DIR;
  }

  return DEFAULT_AGENT_BADGE_DIR;
}

export function resolveAgentBadgePaths({
  cwd,
  env = process.env
}: ResolveAgentBadgePathsOptions): AgentBadgePaths {
  const repositoryRoot = resolve(cwd);
  const configured = env[AGENT_BADGE_DIR_ENV]?.trim();
  const directory = configured
    ? resolveConfiguredDirectory(repositoryRoot, configured)
    : detectDirectory(repositoryRoot);
  const rootPath = resolve(repositoryRoot, directory);
  const cachePath = resolve(rootPath, "cache");

  return {
    directory,
    rootPath,
    configPath: resolve(rootPath, "config.json"),
    statePath: resolve(rootPath, "state.json"),
    cachePath,
    logsPath: resolve(rootPath, "logs"),
    refreshCachePath: resolve(cachePath, "session-index.json"),
    pricingCachePath: resolve(cachePath, "pricing.json")
  };
}
