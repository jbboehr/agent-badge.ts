import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  applyAmbiguousSessionDecision,
  applyCompletedScanState,
  attributeBackfillSessions,
  buildAmbiguousSessionKey,
  formatScanReport,
  parseAgentBadgeConfig,
  parseAgentBadgeState,
  resolveAgentBadgePaths,
  resolveProviderDirectories,
  removeAmbiguousSessionDecision,
  runFullBackfillScan,
  appendAgentBadgeLog,
  buildLogEntry,
  type AgentBadgeState,
  type AppliedScanOverrideAction,
  type AttributeBackfillSessionsResult,
  type RunFullBackfillScanResult
} from "@legotin/agent-badge-core";

interface OutputWriter {
  write(chunk: string): unknown;
}

export interface RunScanCommandOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeRoot?: string;
  readonly stdout?: OutputWriter;
  readonly includeSession?: string[];
  readonly excludeSession?: string[];
}

export interface ScanCommandResult {
  readonly scan: RunFullBackfillScanResult;
  readonly attribution: AttributeBackfillSessionsResult;
  readonly state: AgentBadgeState;
  readonly overrideActions: readonly AppliedScanOverrideAction[];
  readonly warnings: readonly string[];
  readonly report: string;
}

async function readJsonFile(targetPath: string): Promise<unknown> {
  let rawContent: string;

  try {
    rawContent = await readFile(targetPath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : ".";

    throw new Error(`Unable to read ${targetPath}${detail}`);
  }

  try {
    return JSON.parse(rawContent) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : ".";

    throw new Error(`Unable to parse ${targetPath}${detail}`);
  }
}

async function writeStateFile(
  targetPath: string,
  state: AgentBadgeState
): Promise<void> {
  await writeFile(targetPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function writeLine(stdout: OutputWriter, line: string): void {
  stdout.write(`${line}\n`);
}

function applyRequestedOverrides(
  previousState: AgentBadgeState,
  attribution: AttributeBackfillSessionsResult,
  options: RunScanCommandOptions
): {
  readonly nextState: AgentBadgeState;
  readonly overrideActions: readonly AppliedScanOverrideAction[];
  readonly warnings: readonly string[];
} {
  const attributionStatusBySessionKey = new Map(
    attribution.sessions.map((session) => [
      buildAmbiguousSessionKey(session.session),
      session.status
    ])
  );

  const requestedActions: AppliedScanOverrideAction[] = [
    ...(options.includeSession ?? []).map((sessionKey) => ({
      sessionKey,
      decision: "include" as const
    })),
    ...(options.excludeSession ?? []).map((sessionKey) => ({
      sessionKey,
      decision: "exclude" as const
    }))
  ];

  let nextState = previousState;
  const overrideActions: AppliedScanOverrideAction[] = [];
  const warnings: string[] = [];

  for (const action of requestedActions) {
    if (action.decision === "exclude") {
      if (
        !Object.hasOwn(
          nextState.overrides.ambiguousSessions,
          action.sessionKey
        )
      ) {
        warnings.push(
          `Warning: cannot remove include override for ${action.sessionKey} because no persisted session override exists.`
        );
        continue;
      }

      nextState = removeAmbiguousSessionDecision(nextState, action.sessionKey);
      overrideActions.push(action);
      continue;
    }

    const attributionStatus = attributionStatusBySessionKey.get(
      action.sessionKey
    );
    const canApply =
      attributionStatus === "ambiguous" ||
      attributionStatus === "excluded";

    if (!canApply) {
      warnings.push(
        `Warning: cannot apply include override for ${action.sessionKey} because it is not ambiguous or excluded in the current scan result.`
      );
      continue;
    }

    nextState = applyAmbiguousSessionDecision(
      nextState,
      action.sessionKey,
      action.decision
    );
    overrideActions.push(action);
  }

  return {
    nextState,
    overrideActions,
    warnings
  };
}

function buildReportInput(
  scan: RunFullBackfillScanResult,
  attribution: AttributeBackfillSessionsResult,
  overrideActions: readonly AppliedScanOverrideAction[]
) {
  return {
    repo: {
      canonicalSlug: scan.repo.canonicalSlug,
      gitRootBasename: scan.repo.gitRootBasename
    },
    counts: {
      ...scan.counts,
      ...attribution.counts
    },
    attributedSessions: attribution.sessions,
    overrideActions
  };
}

export async function runScanCommand(
  options: RunScanCommandOptions = {}
): Promise<ScanCommandResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const homeRoot = resolve(options.homeRoot ?? homedir());
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const startAtMs = Date.now();
  const agentBadgePaths = resolveAgentBadgePaths({
    cwd,
    env
  });
  const providerDirectories = resolveProviderDirectories({
    cwd,
    homeRoot,
    env: options.env
  });
  const configPath = agentBadgePaths.configPath;
  const statePath = agentBadgePaths.statePath;

  try {
    const config = parseAgentBadgeConfig(await readJsonFile(configPath));
    const previousState = parseAgentBadgeState(await readJsonFile(statePath));
    const scan = await runFullBackfillScan({
      cwd,
      homeRoot,
      providerDirectories,
      config
    });
    const initialAttribution = attributeBackfillSessions({
      repo: scan.repo,
      sessions: scan.sessions,
      overrides: previousState.overrides.ambiguousSessions
    });
    const requestedOverrides = applyRequestedOverrides(
      previousState,
      initialAttribution,
      options
    );
    const attribution =
      requestedOverrides.overrideActions.length === 0
        ? initialAttribution
        : attributeBackfillSessions({
            repo: scan.repo,
            sessions: scan.sessions,
            overrides: requestedOverrides.nextState.overrides.ambiguousSessions
          });
    const report = formatScanReport(
      buildReportInput(scan, attribution, requestedOverrides.overrideActions)
    );
    const nextState = applyCompletedScanState({
      previousState,
      scanResult: {
        scannedProviders: scan.scannedProviders,
        overrideActions: requestedOverrides.overrideActions
      },
      now: new Date().toISOString()
    });

    for (const warning of requestedOverrides.warnings) {
      writeLine(stdout, warning);
    }

    writeLine(stdout, report);
    await writeStateFile(statePath, nextState);

    await appendAgentBadgeLog({
      cwd,
      agentBadgeDirectory: agentBadgePaths.directory,
      entry: buildLogEntry({
        operation: "scan",
        status: "success",
        startAtMs,
        counts: {
          scannedSessions: scan.counts.scannedSessions,
          attributedSessions: attribution.counts.included,
          ambiguousSessions: attribution.counts.ambiguous,
          publishedRecords: 0
        }
      })
    }).catch(() => {
      // Logging is best-effort and must not block command output.
    });

    return {
      scan,
      attribution,
      state: nextState,
      overrideActions: requestedOverrides.overrideActions,
      warnings: requestedOverrides.warnings,
      report
    };
  } catch (error) {
    await appendAgentBadgeLog({
      cwd,
      agentBadgeDirectory: agentBadgePaths.directory,
      entry: buildLogEntry({
        operation: "scan",
        status: "failure",
        startAtMs,
        counts: {
          scannedSessions: 0,
          attributedSessions: 0,
          ambiguousSessions: 0,
          publishedRecords: 0
        }
      })
    }).catch(() => {
      // Logging is best-effort and must not replace command failures.
    });

    throw error;
  }
}
