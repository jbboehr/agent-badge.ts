import { join } from "node:path";

import { z } from "zod";

import { normalizeGitRemoteUrl } from "../../repo/repo-fingerprint.js";
import {
  parseNormalizedSessionSummary,
  type NormalizedSessionSummary
} from "../session-summary.js";
import {
  aggregateGrokUsageRecords,
  listGrokSessionFiles,
  readGrokSessionSummary,
  readGrokSessionUsageLedger,
  type GrokSessionFile,
  type GrokSessionSummary,
  type GrokSessionUsageLedger,
  type GrokUsageRecord
} from "./grok-jsonl.js";

export interface ScanGrokSessionsOptions {
  readonly homeRoot: string;
  readonly grokRoot?: string;
}

export interface ScanGrokSessionsIncrementalOptions {
  readonly homeRoot: string;
  readonly grokRoot?: string;
  readonly cursor: string | null;
}

export interface ScanGrokSessionsIncrementalResult {
  readonly sessions: NormalizedSessionSummary[];
  readonly deletedSessionIds: readonly string[];
  readonly cursor: string;
  readonly mode: "incremental" | "full";
}

const grokCursorFileSchema = z
  .object({
    modifiedAtMs: z.number().nonnegative(),
    size: z.number().int().nonnegative(),
    sessionId: z.string().min(1).nullable(),
    parentSessionId: z.string().min(1).nullable(),
    sessionKind: z.string().min(1).nullable()
  })
  .strict();

const grokIncrementalCursorSchema = z
  .object({
    kind: z.literal("grok-session-jsonl-files-v2"),
    files: z.record(z.string(), grokCursorFileSchema)
  })
  .strict();

type GrokIncrementalCursor = z.infer<typeof grokIncrementalCursorSchema>;

interface GrokSessionNode {
  readonly file: GrokSessionFile;
  readonly summary: GrokSessionSummary;
  ledgerPromise: Promise<GrokSessionUsageLedger> | null;
}

interface GrokSessionGraph {
  readonly nodes: readonly GrokSessionNode[];
  readonly bySessionId: ReadonlyMap<string, GrokSessionNode>;
  readonly summaryByRelativePath: ReadonlyMap<string, GrokSessionSummary>;
}

function isSubagentSession(sessionKind: string | null): boolean {
  return sessionKind?.toLowerCase().startsWith("subagent") ?? false;
}

async function buildGrokSessionGraph(
  files: readonly GrokSessionFile[]
): Promise<GrokSessionGraph> {
  const summaries = await Promise.all(files.map(readGrokSessionSummary));
  const nodes: GrokSessionNode[] = [];
  const bySessionId = new Map<string, GrokSessionNode>();
  const summaryByRelativePath = new Map<string, GrokSessionSummary>();

  files.forEach((file, index) => {
    const summary = summaries[index];

    if (summary === null || summary === undefined) {
      return;
    }

    const node: GrokSessionNode = {
      file,
      summary,
      ledgerPromise: null
    };
    nodes.push(node);
    bySessionId.set(summary.sessionId, node);
    summaryByRelativePath.set(file.relativePath, summary);
  });

  return { nodes, bySessionId, summaryByRelativePath };
}

function getGrokLedger(node: GrokSessionNode): Promise<GrokSessionUsageLedger> {
  node.ledgerPromise ??= readGrokSessionUsageLedger(node.file);
  return node.ledgerPromise;
}

function buildGrokIncrementalCursorFromGraph(
  files: readonly GrokSessionFile[],
  graph: GrokSessionGraph
): string {
  return JSON.stringify({
    kind: "grok-session-jsonl-files-v2",
    files: Object.fromEntries(
      files
        .map((file) => {
          const summary = graph.summaryByRelativePath.get(file.relativePath);

          return [
            file.relativePath,
            {
              modifiedAtMs: file.modifiedAtMs,
              size: file.size,
              sessionId: summary?.sessionId ?? null,
              parentSessionId: summary?.parentSessionId ?? null,
              sessionKind: summary?.sessionKind ?? null
            }
          ] as const;
        })
        .sort(([left], [right]) => left.localeCompare(right))
    )
  });
}

export async function buildGrokIncrementalCursorFromSource(
  homeRoot: string,
  grokRoot = join(homeRoot, ".grok")
): Promise<string> {
  const files = await listGrokSessionFiles(grokRoot);
  const graph = await buildGrokSessionGraph(files);

  return buildGrokIncrementalCursorFromGraph(files, graph);
}

function parseGrokIncrementalCursor(
  cursor: string | null
): GrokIncrementalCursor | null {
  if (typeof cursor !== "string" || cursor.length === 0) {
    return null;
  }

  try {
    return grokIncrementalCursorSchema.parse(JSON.parse(cursor));
  } catch {
    return null;
  }
}

function isGrokFileChanged(
  file: GrokSessionFile,
  cursor: GrokIncrementalCursor
): boolean {
  const previous = cursor.files[file.relativePath];

  return (
    previous === undefined ||
    previous.modifiedAtMs !== file.modifiedAtMs ||
    previous.size !== file.size
  );
}

async function getAncestorRecordKeys(
  node: GrokSessionNode,
  graph: GrokSessionGraph
): Promise<ReadonlySet<string>> {
  const keys = new Set<string>();
  const visited = new Set<string>([node.summary.sessionId]);
  let parentSessionId = node.summary.parentSessionId;

  while (parentSessionId !== null && !visited.has(parentSessionId)) {
    visited.add(parentSessionId);
    const parent = graph.bySessionId.get(parentSessionId);

    if (parent === undefined) {
      break;
    }

    for (const record of (await getGrokLedger(parent)).records) {
      keys.add(record.key);
    }
    parentSessionId = parent.summary.parentSessionId;
  }

  return keys;
}

async function getExclusiveRecords(
  node: GrokSessionNode,
  graph: GrokSessionGraph
): Promise<readonly GrokUsageRecord[]> {
  const [ledger, ancestorKeys] = await Promise.all([
    getGrokLedger(node),
    getAncestorRecordKeys(node, graph)
  ]);

  return ledger.records.filter((record) => !ancestorKeys.has(record.key));
}

function childPromptId(
  child: GrokSessionNode,
  parentLedger: GrokSessionUsageLedger
): string | null {
  if (child.summary.forkParentPromptId !== null) {
    return child.summary.forkParentPromptId;
  }

  return (
    parentLedger.subagents.find(
      (event) => event.childSessionId === child.summary.sessionId
    )?.parentPromptId ?? null
  );
}

async function collectReconciledRecords(
  node: GrokSessionNode,
  graph: GrokSessionGraph,
  includeBase: boolean,
  visited: ReadonlySet<string> = new Set()
): Promise<readonly GrokUsageRecord[]> {
  if (visited.has(node.summary.sessionId)) {
    return [];
  }

  const nextVisited = new Set(visited).add(node.summary.sessionId);
  const ledger = await getGrokLedger(node);
  const records = includeBase ? [...(await getExclusiveRecords(node, graph))] : [];
  const incompletePrompts = new Map(
    ledger.prompts
      .filter((prompt) => prompt.usageIncomplete)
      .map((prompt) => [prompt.promptId, prompt] as const)
  );

  if (incompletePrompts.size === 0) {
    return records;
  }

  const children = graph.nodes.filter(
    (candidate) =>
      candidate.summary.parentSessionId === node.summary.sessionId &&
      isSubagentSession(candidate.summary.sessionKind)
  );

  for (const child of children) {
    const promptId = childPromptId(child, ledger);
    const prompt = promptId === null ? undefined : incompletePrompts.get(promptId);

    if (prompt === undefined) {
      continue;
    }

    const event = ledger.subagents.find(
      (candidate) => candidate.childSessionId === child.summary.sessionId
    );
    const foldedBeforeSnapshot =
      event?.finishedLineIndex !== null &&
      event?.finishedLineIndex !== undefined &&
      event.finishedLineIndex <= prompt.lineIndex;
    records.push(
      ...(await collectReconciledRecords(
        child,
        graph,
        !foldedBeforeSnapshot,
        nextVisited
      ))
    );
  }

  return [...new Map(records.map((record) => [record.key, record])).values()];
}

function inheritedGitRemotes(
  node: GrokSessionNode,
  graph: GrokSessionGraph
): readonly string[] {
  const visited = new Set<string>();
  let current: GrokSessionNode | undefined = node;

  while (current !== undefined && !visited.has(current.summary.sessionId)) {
    visited.add(current.summary.sessionId);

    if (current.summary.gitRemotes.length > 0) {
      return current.summary.gitRemotes;
    }

    current =
      current.summary.parentSessionId === null
        ? undefined
        : graph.bySessionId.get(current.summary.parentSessionId);
  }

  return [];
}

async function normalizeGrokSession(
  node: GrokSessionNode,
  graph: GrokSessionGraph
): Promise<NormalizedSessionSummary | null> {
  if (isSubagentSession(node.summary.sessionKind)) {
    return null;
  }

  const summary = node.summary;
  const usage = aggregateGrokUsageRecords(
    await collectReconciledRecords(node, graph, true)
  );
  const observedRemoteUrl = inheritedGitRemotes(node, graph)[0] ?? null;
  const observedRemoteUrlNormalized = observedRemoteUrl
    ? normalizeGitRemoteUrl(observedRemoteUrl)?.normalizedUrl ?? null
    : null;

  return parseNormalizedSessionSummary({
    provider: "grok",
    providerSessionId: summary.sessionId,
    startedAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    cwd:
      summary.sourceWorkspaceDir ?? summary.gitRootDir ?? summary.cwd,
    gitBranch: summary.gitBranch,
    observedRemoteUrl,
    observedRemoteUrlNormalized,
    attributionHints: {
      cwdRealPath: null,
      transcriptProjectKey: null
    },
    tokenUsage: {
      total: usage.totalTokens,
      input: usage.inputTokens,
      output: usage.outputTokens,
      cacheCreation: usage.cacheCreationTokens,
      cacheRead: usage.cacheReadTokens,
      reasoningOutput: usage.reasoningTokens
    },
    lineage: {
      parentSessionId: summary.parentSessionId,
      kind: summary.parentSessionId === null ? "root" : "child"
    },
    metadata: {
      model: summary.model,
      modelProvider: "xai",
      sourceKind: "grok-session-jsonl",
      cliVersion: null,
      reportedCostUsdMicros: usage.reportedCostUsdMicros
    }
  });
}

async function readGrokSessionsFromNodes(
  nodes: readonly GrokSessionNode[],
  graph: GrokSessionGraph
): Promise<NormalizedSessionSummary[]> {
  const sessions = await Promise.all(
    nodes.map((node) => normalizeGrokSession(node, graph))
  );

  return sessions.filter(
    (session): session is NormalizedSessionSummary => session !== null
  );
}

function nearestNonSubagentSessionId(
  sessionId: string | null,
  entriesBySessionId: ReadonlyMap<
    string,
    { readonly parentSessionId: string | null; readonly sessionKind: string | null }
  >
): string | null {
  const visited = new Set<string>();
  let currentId = sessionId;

  while (currentId !== null && !visited.has(currentId)) {
    visited.add(currentId);
    const current = entriesBySessionId.get(currentId);

    if (current === undefined) {
      return null;
    }

    if (!isSubagentSession(current.sessionKind)) {
      return currentId;
    }

    currentId = current.parentSessionId;
  }

  return null;
}

function currentCursorEntriesBySessionId(
  graph: GrokSessionGraph
): ReadonlyMap<
  string,
  { readonly parentSessionId: string | null; readonly sessionKind: string | null }
> {
  return new Map(
    graph.nodes.map((node) => [
      node.summary.sessionId,
      {
        parentSessionId: node.summary.parentSessionId,
        sessionKind: node.summary.sessionKind
      }
    ])
  );
}

function previousCursorEntriesBySessionId(
  cursor: GrokIncrementalCursor
): ReadonlyMap<
  string,
  { readonly parentSessionId: string | null; readonly sessionKind: string | null }
> {
  return new Map(
    Object.values(cursor.files).flatMap((entry) =>
      entry.sessionId === null
        ? []
        : [
            [
              entry.sessionId,
              {
                parentSessionId: entry.parentSessionId,
                sessionKind: entry.sessionKind
              }
            ] as const
          ]
    )
  );
}

function addNonSubagentDescendants(
  ancestorSessionId: string,
  graph: GrokSessionGraph,
  target: Set<string>
): void {
  for (const node of graph.nodes) {
    if (isSubagentSession(node.summary.sessionKind)) {
      continue;
    }

    const visited = new Set<string>([node.summary.sessionId]);
    let parentSessionId = node.summary.parentSessionId;

    while (parentSessionId !== null && !visited.has(parentSessionId)) {
      if (parentSessionId === ancestorSessionId) {
        target.add(node.summary.sessionId);
        break;
      }

      visited.add(parentSessionId);
      parentSessionId =
        graph.bySessionId.get(parentSessionId)?.summary.parentSessionId ?? null;
    }
  }
}

export async function scanGrokSessions({
  homeRoot,
  grokRoot: configuredGrokRoot
}: ScanGrokSessionsOptions): Promise<NormalizedSessionSummary[]> {
  const grokRoot = configuredGrokRoot ?? join(homeRoot, ".grok");
  const files = await listGrokSessionFiles(grokRoot);
  const graph = await buildGrokSessionGraph(files);

  return readGrokSessionsFromNodes(graph.nodes, graph);
}

export async function scanGrokSessionsIncremental({
  homeRoot,
  grokRoot: configuredGrokRoot,
  cursor
}: ScanGrokSessionsIncrementalOptions): Promise<ScanGrokSessionsIncrementalResult> {
  const grokRoot = configuredGrokRoot ?? join(homeRoot, ".grok");
  const files = await listGrokSessionFiles(grokRoot);
  const graph = await buildGrokSessionGraph(files);
  const nextCursor = buildGrokIncrementalCursorFromGraph(files, graph);
  const previousCursor = parseGrokIncrementalCursor(cursor);

  if (previousCursor === null) {
    return {
      sessions: await readGrokSessionsFromNodes(graph.nodes, graph),
      deletedSessionIds: [],
      cursor: nextCursor,
      mode: "full"
    };
  }

  const changedFiles = files.filter((file) =>
    isGrokFileChanged(file, previousCursor)
  );
  const changedSessionIds = new Set(
    changedFiles.flatMap((file) => {
      const summary = graph.summaryByRelativePath.get(file.relativePath);

      return summary === undefined ? [] : [summary.sessionId];
    })
  );
  const currentEntries = currentCursorEntriesBySessionId(graph);
  const previousEntries = previousCursorEntriesBySessionId(previousCursor);
  const impactedSessionIds = new Set<string>();
  const deletedSessionIds = new Set<string>();

  for (const sessionId of changedSessionIds) {
    const currentEntry = currentEntries.get(sessionId);
    const currentRoot = nearestNonSubagentSessionId(sessionId, currentEntries);
    const previousRoot = nearestNonSubagentSessionId(sessionId, previousEntries);

    if (currentRoot !== null) {
      impactedSessionIds.add(currentRoot);
    }
    if (currentEntry !== undefined && !isSubagentSession(currentEntry.sessionKind)) {
      addNonSubagentDescendants(sessionId, graph, impactedSessionIds);
    }
    if (previousRoot !== null && graph.bySessionId.has(previousRoot)) {
      impactedSessionIds.add(previousRoot);
    }
  }

  for (const [relativePath, previous] of Object.entries(previousCursor.files)) {
    const currentSummary = graph.summaryByRelativePath.get(relativePath);

    if (previous.sessionId === null) {
      continue;
    }

    if (previous.sessionId === currentSummary?.sessionId) {
      if (
        !isSubagentSession(previous.sessionKind) &&
        isSubagentSession(currentSummary.sessionKind)
      ) {
        deletedSessionIds.add(previous.sessionId);
      }
      continue;
    }

    if (isSubagentSession(previous.sessionKind)) {
      const previousRoot = nearestNonSubagentSessionId(
        previous.sessionId,
        previousEntries
      );

      if (previousRoot !== null && graph.bySessionId.has(previousRoot)) {
        impactedSessionIds.add(previousRoot);
      }
    } else {
      deletedSessionIds.add(previous.sessionId);
      addNonSubagentDescendants(
        previous.sessionId,
        graph,
        impactedSessionIds
      );
    }
  }

  const impactedNodes = [...impactedSessionIds].flatMap((sessionId) => {
    const node = graph.bySessionId.get(sessionId);

    return node === undefined ? [] : [node];
  });

  return {
    sessions: await readGrokSessionsFromNodes(impactedNodes, graph),
    deletedSessionIds: [...deletedSessionIds].sort(),
    cursor: nextCursor,
    mode: "incremental"
  };
}
