import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  agentBadgeLogEntrySchema,
  type AgentBadgeLogEntry,
  type AgentBadgeLogStatus
} from "./log-entry.js";
import { resolveAgentBadgePaths } from "../repo/agent-badge-directory.js";

export const AGENT_BADGE_LOG_DIR = ".agent-badge/logs";
export const AGENT_BADGE_LOG_MAX_FILES = 7;

interface BuildLogEntryInput {
  readonly operation: string;
  readonly status: AgentBadgeLogStatus;
  readonly startAtMs: number;
  readonly counts: AgentBadgeLogEntry["counts"];
}

function toJsonLine(entry: AgentBadgeLogEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

function formatLogDate(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10).replace(/-/g, "");
}

export function buildLogEntry(
  options: BuildLogEntryInput
): AgentBadgeLogEntry {
  const entry: AgentBadgeLogEntry = {
    timestamp: new Date().toISOString(),
    operation: options.operation,
    status: options.status,
    durationMs: Math.max(0, Date.now() - options.startAtMs),
    counts: options.counts
  };

  return agentBadgeLogEntrySchema.parse(entry);
}

export async function listAgentBadgeLogFiles(options: {
  readonly cwd: string;
  readonly agentBadgeDirectory?: string;
}): Promise<string[]> {
  const logsRoot = resolveAgentBadgePaths({
    cwd: options.cwd,
    env: options.agentBadgeDirectory
      ? { AGENT_BADGE_DIR: options.agentBadgeDirectory }
      : undefined
  }).logsPath;

  try {
    const files = await readdir(logsRoot);

    return files.filter((name) => name.endsWith(".jsonl")).map((name) => join(logsRoot, name));
  } catch {
    return [];
  }
}

export async function rotateLogFiles(options: {
  readonly cwd: string;
  readonly agentBadgeDirectory?: string;
  readonly maxFiles?: number;
}): Promise<void> {
  const maxFiles = options.maxFiles ?? AGENT_BADGE_LOG_MAX_FILES;
  const files = await listAgentBadgeLogFiles({
    cwd: options.cwd,
    agentBadgeDirectory: options.agentBadgeDirectory
  });

  if (files.length <= maxFiles) {
    return;
  }

  const fileStats = await Promise.all(
    files.map(async (file) => ({
      path: file,
      mtimeMs: (await stat(file)).mtimeMs
    }))
  );
  const sorted = fileStats.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const removeCount = sorted.length - maxFiles;

  await Promise.all(
    sorted
      .slice(0, removeCount)
      .map(async (file) =>
        unlink(file.path).catch(() => {
          // Best-effort cleanup: lock or filesystem races are ignored.
        })
      )
  );
}

export async function appendAgentBadgeLog(options: {
  readonly cwd: string;
  readonly agentBadgeDirectory?: string;
  readonly entry: AgentBadgeLogEntry;
}): Promise<string> {
  const parsedEntry = agentBadgeLogEntrySchema.parse(options.entry);
  const logsRoot = resolveAgentBadgePaths({
    cwd: options.cwd,
    env: options.agentBadgeDirectory
      ? { AGENT_BADGE_DIR: options.agentBadgeDirectory }
      : undefined
  }).logsPath;

  await mkdir(logsRoot, { recursive: true });

  const logPath = join(logsRoot, `agent-badge-${formatLogDate()}.jsonl`);
  await appendFile(logPath, toJsonLine(parsedEntry), "utf8");

  await rotateLogFiles({
    cwd: options.cwd,
    agentBadgeDirectory: options.agentBadgeDirectory
  });

  return logPath;
}
