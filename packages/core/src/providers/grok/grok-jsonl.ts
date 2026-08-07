import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";

import { z } from "zod";

const grokSummarySchema = z
  .object({
    info: z
      .object({
        id: z.string().min(1),
        cwd: z.string().min(1)
      })
      .passthrough(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
    last_active_at: z.string().min(1).nullable().optional(),
    current_model_id: z.string().min(1),
    parent_session_id: z.string().min(1).nullable().optional(),
    session_kind: z.string().min(1).nullable().optional(),
    fork_parent_prompt_id: z.string().min(1).nullable().optional(),
    source_workspace_dir: z.string().min(1).nullable().optional(),
    git_root_dir: z.string().min(1).nullable().optional(),
    git_remotes: z.array(z.string().min(1)).optional().default([]),
    head_branch: z.string().min(1).nullable().optional()
  })
  .passthrough();

const promptUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional().default(0),
    outputTokens: z.number().int().nonnegative().optional().default(0),
    totalTokens: z.number().int().nonnegative().optional().default(0),
    cachedReadTokens: z.number().int().nonnegative().optional().default(0),
    cacheCreationTokens: z.number().int().nonnegative().optional().default(0),
    reasoningTokens: z.number().int().nonnegative().optional().default(0),
    costUsdTicks: z.number().int().nonnegative().nullable().optional(),
    costIsPartial: z.boolean().optional().default(false),
    usageIsIncomplete: z.boolean().optional().default(false)
  })
  .passthrough();

const responseUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().optional().default(0),
    output_tokens: z.number().int().nonnegative().optional().default(0),
    cache_read_input_tokens: z.number().int().nonnegative().optional().default(0),
    cache_creation_input_tokens: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .default(0),
    reasoning_tokens: z.number().int().nonnegative().optional().default(0)
  })
  .passthrough();

export interface GrokSessionFile {
  readonly sessionDir: string;
  readonly summaryPath: string;
  readonly updatesPath: string;
  readonly relativePath: string;
  readonly modifiedAtMs: number;
  readonly size: number;
}

export interface GrokSessionSummary {
  readonly sessionId: string;
  readonly cwd: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly model: string;
  readonly parentSessionId: string | null;
  readonly sessionKind: string | null;
  readonly forkParentPromptId: string | null;
  readonly sourceWorkspaceDir: string | null;
  readonly gitRootDir: string | null;
  readonly gitRemotes: readonly string[];
  readonly gitBranch: string | null;
}

export interface GrokSessionUsage {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
  readonly reasoningTokens: number;
  readonly reportedCostUsdMicros: number | null;
}

export interface GrokUsageRecord {
  readonly key: string;
  readonly kind: "prompt" | "response";
  readonly promptId: string | null;
  readonly lineIndex: number;
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
  readonly reasoningTokens: number;
  readonly costUsdTicks: number | null;
  readonly costTrustworthy: boolean;
  readonly usageIncomplete: boolean;
}

export interface GrokPromptSnapshot {
  readonly promptId: string;
  readonly lineIndex: number;
  readonly usageIncomplete: boolean;
}

export interface GrokSubagentEvent {
  readonly childSessionId: string;
  readonly parentPromptId: string | null;
  readonly spawnedLineIndex: number | null;
  readonly finishedLineIndex: number | null;
}

export interface GrokSessionUsageLedger {
  readonly records: readonly GrokUsageRecord[];
  readonly prompts: readonly GrokPromptSnapshot[];
  readonly subagents: readonly GrokSubagentEvent[];
}

interface GrokUpdateEnvelope {
  readonly method?: unknown;
  readonly params?: {
    readonly update?: {
      readonly sessionUpdate?: unknown;
      readonly prompt_id?: unknown;
      readonly message_id?: unknown;
      readonly target_prompt_index?: unknown;
      readonly usage?: unknown;
      readonly child_session_id?: unknown;
      readonly parent_prompt_id?: unknown;
    };
  };
}

async function findSummaryFiles(root: string): Promise<string[]> {
  let entries;

  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(root, entry.name);

      if (entry.isDirectory()) {
        return findSummaryFiles(entryPath);
      }

      if (entry.isFile() && entry.name === "summary.json") {
        return [entryPath];
      }

      return [];
    })
  );

  return nestedFiles.flat().sort();
}

async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

export async function listGrokSessionFiles(
  grokRoot: string
): Promise<GrokSessionFile[]> {
  const sessionsRoot = join(grokRoot, "sessions");
  const summaryPaths = await findSummaryFiles(sessionsRoot);
  const files = await Promise.all(
    summaryPaths.map(async (summaryPath): Promise<GrokSessionFile | null> => {
      const sessionDir = dirname(summaryPath);
      const updatesPath = join(sessionDir, "updates.jsonl");
      const [summaryStat, updatesStat] = await Promise.all([
        statOrNull(summaryPath),
        statOrNull(updatesPath)
      ]);

      if (summaryStat === null) {
        return null;
      }

      return {
        sessionDir,
        summaryPath,
        updatesPath,
        relativePath: relative(sessionsRoot, summaryPath),
        modifiedAtMs: Math.max(
          summaryStat.mtimeMs,
          updatesStat?.mtimeMs ?? 0
        ),
        size: summaryStat.size + (updatesStat?.size ?? 0)
      };
    })
  );

  return files.filter((file): file is GrokSessionFile => file !== null);
}

export async function readGrokSessionSummary(
  file: GrokSessionFile
): Promise<GrokSessionSummary | null> {
  try {
    const parsed = grokSummarySchema.parse(
      JSON.parse(await readFile(file.summaryPath, "utf8"))
    );

    return {
      sessionId: parsed.info.id,
      cwd: parsed.info.cwd,
      createdAt: parsed.created_at,
      updatedAt: parsed.last_active_at ?? parsed.updated_at,
      model: parsed.current_model_id,
      parentSessionId: parsed.parent_session_id ?? null,
      sessionKind: parsed.session_kind ?? null,
      forkParentPromptId: parsed.fork_parent_prompt_id ?? null,
      sourceWorkspaceDir: parsed.source_workspace_dir ?? null,
      gitRootDir: parsed.git_root_dir ?? null,
      gitRemotes: parsed.git_remotes,
      gitBranch: parsed.head_branch ?? null
    };
  } catch {
    return null;
  }
}

function parseRelevantUpdate(line: string): GrokUpdateEnvelope | null {
  if (
    !line.includes('"turn_completed"') &&
    !line.includes('"response_completed"') &&
    !line.includes('"rewind_marker"') &&
    !line.includes('"subagent_spawned"') &&
    !line.includes('"subagent_finished"')
  ) {
    return null;
  }

  try {
    return JSON.parse(line) as GrokUpdateEnvelope;
  } catch {
    return null;
  }
}

function promptUsageToSessionUsage(
  usage: z.infer<typeof promptUsageSchema>
): Omit<GrokSessionUsage, "reportedCostUsdMicros"> & {
  readonly costUsdTicks: number | null;
  readonly costTrustworthy: boolean;
  readonly usageIncomplete: boolean;
} {
  const uncachedInputTokens = Math.max(
    usage.inputTokens - usage.cachedReadTokens - usage.cacheCreationTokens,
    0
  );
  const calculatedTotal =
    uncachedInputTokens +
    usage.cachedReadTokens +
    usage.cacheCreationTokens +
    usage.outputTokens;

  return {
    totalTokens: Math.max(usage.totalTokens, calculatedTotal),
    inputTokens: uncachedInputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cachedReadTokens,
    reasoningTokens: usage.reasoningTokens,
    costUsdTicks: usage.costUsdTicks ?? null,
    costTrustworthy:
      typeof usage.costUsdTicks === "number" &&
      Number.isSafeInteger(usage.costUsdTicks) &&
      !usage.costIsPartial &&
      !usage.usageIsIncomplete,
    usageIncomplete: usage.usageIsIncomplete
  };
}

function responseUsageToSessionUsage(
  usage: z.infer<typeof responseUsageSchema>
): Omit<GrokSessionUsage, "reportedCostUsdMicros"> {
  // ResponseCompleted uses the Messages API's already-disjoint prompt buckets,
  // unlike TurnCompleted's full-input PromptUsage ledger.
  return {
    totalTokens:
      usage.input_tokens +
      usage.cache_read_input_tokens +
      usage.cache_creation_input_tokens +
      usage.output_tokens,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    reasoningTokens: usage.reasoning_tokens
  };
}

function sumUsage(
  usages: readonly Omit<GrokSessionUsage, "reportedCostUsdMicros">[]
): Omit<GrokSessionUsage, "reportedCostUsdMicros"> {
  return usages.reduce(
    (total, usage) => ({
      totalTokens: total.totalTokens + usage.totalTokens,
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      cacheCreationTokens:
        total.cacheCreationTokens + usage.cacheCreationTokens,
      cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
      reasoningTokens: total.reasoningTokens + usage.reasoningTokens
    }),
    {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0
    }
  );
}

function ticksToUsdMicros(ticks: number): number | null {
  if (!Number.isSafeInteger(ticks) || ticks < 0) {
    return null;
  }

  const micros = Math.round(ticks / 10_000);

  return Number.isSafeInteger(micros) && micros >= 0 ? micros : null;
}

export function aggregateGrokUsageRecords(
  records: readonly GrokUsageRecord[]
): GrokSessionUsage {
  const usage = sumUsage(records);
  let totalCostTicks = 0;
  let hasTrustworthyCost = records.length > 0;

  for (const record of records) {
    if (
      record.kind !== "prompt" ||
      !record.costTrustworthy ||
      record.costUsdTicks === null ||
      !Number.isSafeInteger(totalCostTicks + record.costUsdTicks)
    ) {
      hasTrustworthyCost = false;
      break;
    }

    totalCostTicks += record.costUsdTicks;
  }

  return {
    ...usage,
    reportedCostUsdMicros: hasTrustworthyCost
      ? ticksToUsdMicros(totalCostTicks)
      : null
  };
}

export async function readGrokSessionUsageLedger(
  file: GrokSessionFile
): Promise<GrokSessionUsageLedger> {
  const promptOrder: string[] = [];
  const activePromptIds = new Set<string>();
  const promptUsages = new Map<
    string,
    ReturnType<typeof promptUsageToSessionUsage> & {
      readonly lineIndex: number;
    }
  >();
  const responseUsages = new Map<
    string,
    {
      readonly promptIndex: number;
      readonly lineIndex: number;
      readonly usage: ReturnType<typeof responseUsageToSessionUsage>;
    }
  >();
  const subagents = new Map<string, GrokSubagentEvent>();
  let lineIndex = 0;

  try {
    const lines = createInterface({
      input: createReadStream(file.updatesPath, { encoding: "utf8" }),
      crlfDelay: Infinity
    });

    for await (const line of lines) {
      lineIndex += 1;
      const envelope = parseRelevantUpdate(line);
      const update = envelope?.params?.update;

      if (
        envelope?.method !== "_x.ai/session/update" ||
        update === undefined
      ) {
        continue;
      }

      if (update.sessionUpdate === "turn_completed") {
        const promptId =
          typeof update.prompt_id === "string" && update.prompt_id.length > 0
            ? update.prompt_id
            : `line:${lineIndex}`;

        if (!activePromptIds.has(promptId)) {
          promptOrder.push(promptId);
          activePromptIds.add(promptId);
        }

        const parsed = promptUsageSchema.safeParse(update.usage);
        if (parsed.success) {
          promptUsages.set(promptId, {
            ...promptUsageToSessionUsage(parsed.data),
            lineIndex
          });
        } else {
          promptUsages.delete(promptId);
        }
      } else if (update.sessionUpdate === "response_completed") {
        const parsed = responseUsageSchema.safeParse(update.usage);

        if (parsed.success) {
          const messageId =
            typeof update.message_id === "string" && update.message_id.length > 0
              ? update.message_id
              : `line:${lineIndex}`;
          responseUsages.set(
            messageId,
            {
              promptIndex: promptOrder.length,
              lineIndex,
              usage: responseUsageToSessionUsage(parsed.data)
            }
          );
        }
      } else if (
        update.sessionUpdate === "rewind_marker" &&
        typeof update.target_prompt_index === "number" &&
        Number.isSafeInteger(update.target_prompt_index) &&
        update.target_prompt_index >= 0
      ) {
        const targetPromptIndex = update.target_prompt_index;

        for (const promptId of promptOrder.slice(targetPromptIndex)) {
          promptUsages.delete(promptId);
          activePromptIds.delete(promptId);
        }
        promptOrder.splice(targetPromptIndex);

        for (const [messageId, response] of responseUsages) {
          if (response.promptIndex >= targetPromptIndex) {
            responseUsages.delete(messageId);
          }
        }
      } else if (
        update.sessionUpdate === "subagent_spawned" &&
        typeof update.child_session_id === "string" &&
        update.child_session_id.length > 0
      ) {
        const existing = subagents.get(update.child_session_id);
        subagents.set(update.child_session_id, {
          childSessionId: update.child_session_id,
          parentPromptId:
            typeof update.parent_prompt_id === "string" &&
            update.parent_prompt_id.length > 0
              ? update.parent_prompt_id
              : (existing?.parentPromptId ?? null),
          spawnedLineIndex: lineIndex,
          finishedLineIndex: existing?.finishedLineIndex ?? null
        });
      } else if (
        update.sessionUpdate === "subagent_finished" &&
        typeof update.child_session_id === "string" &&
        update.child_session_id.length > 0
      ) {
        const existing = subagents.get(update.child_session_id);
        subagents.set(update.child_session_id, {
          childSessionId: update.child_session_id,
          parentPromptId: existing?.parentPromptId ?? null,
          spawnedLineIndex: existing?.spawnedLineIndex ?? null,
          finishedLineIndex: lineIndex
        });
      }
    }
  } catch {
    // Missing or unreadable update logs represent a zero-usage session.
  }

  const responses = [...responseUsages.entries()];
  const responsesByPrompt = new Map<
    number,
    Array<{
      readonly messageId: string;
      readonly lineIndex: number;
      readonly usage: ReturnType<typeof responseUsageToSessionUsage>;
    }>
  >();

  for (const [messageId, response] of responses) {
    const existing = responsesByPrompt.get(response.promptIndex);
    const value = {
      messageId,
      lineIndex: response.lineIndex,
      usage: response.usage
    };

    if (existing === undefined) {
      responsesByPrompt.set(response.promptIndex, [value]);
    } else {
      existing.push(value);
    }
  }

  const records = promptOrder.flatMap<GrokUsageRecord>((promptId, promptIndex) => {
    const promptUsage = promptUsages.get(promptId);

    return promptUsage === undefined
      ? (responsesByPrompt.get(promptIndex) ?? []).map((response) => ({
          key: `response:${response.messageId}`,
          kind: "response" as const,
          promptId,
          lineIndex: response.lineIndex,
          ...response.usage,
          costUsdTicks: null,
          costTrustworthy: false,
          usageIncomplete: true
        }))
      : [
          {
            key: `prompt:${promptId}`,
            kind: "prompt" as const,
            promptId,
            ...promptUsage
          }
        ];
  });
  const trailingResponses = [...responsesByPrompt.entries()]
    .filter(([promptIndex]) => promptIndex >= promptOrder.length)
    .flatMap(([, usages]) =>
      usages.map((response): GrokUsageRecord => ({
        key: `response:${response.messageId}`,
        kind: "response",
        promptId: null,
        lineIndex: response.lineIndex,
        ...response.usage,
        costUsdTicks: null,
        costTrustworthy: false,
        usageIncomplete: true
      }))
    );

  return {
    records: [...records, ...trailingResponses],
    prompts: promptOrder.map((promptId) => {
      const usage = promptUsages.get(promptId);

      return {
        promptId,
        lineIndex: usage?.lineIndex ?? 0,
        usageIncomplete: usage?.usageIncomplete ?? true
      };
    }),
    subagents: [...subagents.values()]
  };
}

export async function readGrokSessionUsage(
  file: GrokSessionFile
): Promise<GrokSessionUsage> {
  return aggregateGrokUsageRecords(
    (await readGrokSessionUsageLedger(file)).records
  );
}
