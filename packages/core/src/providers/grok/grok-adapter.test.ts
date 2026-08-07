import {
  appendFile,
  mkdir,
  mkdtemp,
  rm,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildGrokIncrementalCursorFromSource,
  scanGrokSessions,
  scanGrokSessionsIncremental
} from "./grok-adapter.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function createHome(): Promise<string> {
  const homeRoot = await mkdtemp(join(tmpdir(), "agent-badge-grok-"));
  cleanupPaths.push(homeRoot);
  return homeRoot;
}

function turnCompleted(
  promptId: string,
  usage: Record<string, unknown>
): string {
  return JSON.stringify({
    method: "_x.ai/session/update",
    params: {
      sessionId: "ignored-envelope-session",
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: promptId,
        usage
      }
    }
  });
}

function turnCompletedWithoutUsage(promptId: string): string {
  return JSON.stringify({
    method: "_x.ai/session/update",
    params: {
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: promptId,
        stop_reason: "error"
      }
    }
  });
}

function responseCompleted(
  messageId: string,
  usage: Record<string, unknown>
): string {
  return JSON.stringify({
    method: "_x.ai/session/update",
    params: {
      update: {
        sessionUpdate: "response_completed",
        message_id: messageId,
        usage
      }
    }
  });
}

function rewindMarker(targetPromptIndex: number): string {
  return JSON.stringify({
    method: "_x.ai/session/update",
    params: {
      update: {
        sessionUpdate: "rewind_marker",
        target_prompt_index: targetPromptIndex,
        created_at: "2026-08-01T12:30:00Z"
      }
    }
  });
}

function subagentSpawned(childSessionId: string, parentPromptId: string): string {
  return JSON.stringify({
    method: "_x.ai/session/update",
    params: {
      update: {
        sessionUpdate: "subagent_spawned",
        child_session_id: childSessionId,
        parent_prompt_id: parentPromptId
      }
    }
  });
}

function subagentFinished(childSessionId: string): string {
  return JSON.stringify({
    method: "_x.ai/session/update",
    params: {
      update: {
        sessionUpdate: "subagent_finished",
        child_session_id: childSessionId
      }
    }
  });
}

async function writeSession(options: {
  readonly homeRoot: string;
  readonly id: string;
  readonly cwd?: string;
  readonly sessionKind?: string;
  readonly parentSessionId?: string;
  readonly forkParentPromptId?: string;
  readonly sourceWorkspaceDir?: string;
  readonly gitRootDir?: string | null;
  readonly gitRemotes?: readonly string[];
  readonly updates?: readonly string[];
}): Promise<{
  readonly sessionDir: string;
  readonly summaryPath: string;
  readonly updatesPath: string;
}> {
  const cwd = options.cwd ?? "/work/repo";
  const sessionDir = join(
    options.homeRoot,
    ".grok",
    "sessions",
    encodeURIComponent(cwd),
    options.id
  );
  const summaryPath = join(sessionDir, "summary.json");
  const updatesPath = join(sessionDir, "updates.jsonl");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    summaryPath,
    `${JSON.stringify({
      info: { id: options.id, cwd },
      session_summary: "fixture",
      created_at: "2026-08-01T10:00:00Z",
      updated_at: "2026-08-01T11:00:00Z",
      last_active_at: "2026-08-01T12:00:00Z",
      num_messages: 2,
      current_model_id: "grok-build-0.1",
      parent_session_id: options.parentSessionId,
      session_kind: options.sessionKind,
      fork_parent_prompt_id: options.forkParentPromptId,
      source_workspace_dir: options.sourceWorkspaceDir,
      git_root_dir: options.gitRootDir === undefined ? cwd : options.gitRootDir,
      git_remotes:
        options.gitRemotes ?? ["git@github.com:example/repo.git"],
      head_branch: "main"
    })}\n`,
    "utf8"
  );
  await writeFile(
    updatesPath,
    `${(options.updates ?? []).join("\n")}${
      (options.updates?.length ?? 0) > 0 ? "\n" : ""
    }`,
    "utf8"
  );

  return { sessionDir, summaryPath, updatesPath };
}

describe("Grok provider adapter", () => {
  it("normalizes durable per-prompt usage and reported cost", async () => {
    const homeRoot = await createHome();
    await writeSession({
      homeRoot,
      id: "grok-root",
      updates: [
        turnCompleted("prompt-1", {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          cachedReadTokens: 40,
          cacheCreationTokens: 10,
          reasoningTokens: 5,
          costUsdTicks: 12_340_000
        }),
        turnCompleted("prompt-2", {
          inputTokens: 30,
          outputTokens: 7,
          totalTokens: 37,
          cachedReadTokens: 5,
          cacheCreationTokens: 0,
          reasoningTokens: 2,
          costUsdTicks: 660_000
        })
      ]
    });

    const sessions = await scanGrokSessions({ homeRoot });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      provider: "grok",
      providerSessionId: "grok-root",
      startedAt: "2026-08-01T10:00:00Z",
      updatedAt: "2026-08-01T12:00:00Z",
      cwd: "/work/repo",
      gitBranch: "main",
      observedRemoteUrlNormalized: "https://github.com/example/repo",
      tokenUsage: {
        total: 157,
        input: 75,
        output: 27,
        cacheCreation: 10,
        cacheRead: 45,
        reasoningOutput: 7
      },
      metadata: {
        model: "grok-build-0.1",
        modelProvider: "xai",
        sourceKind: "grok-session-jsonl",
        reportedCostUsdMicros: 1_300
      }
    });
  });

  it("deduplicates replayed prompt terminals and distrusts partial cost", async () => {
    const homeRoot = await createHome();
    await writeSession({
      homeRoot,
      id: "grok-replay",
      updates: [
        turnCompleted("same-prompt", {
          inputTokens: 10,
          outputTokens: 1,
          totalTokens: 11,
          costUsdTicks: 100_000
        }),
        turnCompleted("same-prompt", {
          inputTokens: 20,
          outputTokens: 2,
          totalTokens: 22,
          costUsdTicks: 200_000,
          usageIsIncomplete: true
        })
      ]
    });

    const [session] = await scanGrokSessions({ homeRoot });

    expect(session?.tokenUsage.total).toBe(22);
    expect(session?.metadata.reportedCostUsdMicros).toBeNull();
  });

  it("falls back to response usage for sessions predating prompt ledgers", async () => {
    const homeRoot = await createHome();
    await writeSession({
      homeRoot,
      id: "grok-response-fallback",
      updates: [
        "not-json",
        responseCompleted("message-1", {
          input_tokens: 7,
          output_tokens: 3,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
          reasoning_tokens: 1
        })
      ]
    });

    const [session] = await scanGrokSessions({ homeRoot });

    expect(session?.tokenUsage).toEqual({
      total: 13,
      input: 7,
      output: 3,
      cacheCreation: 1,
      cacheRead: 2,
      reasoningOutput: 1
    });
    expect(session?.metadata.reportedCostUsdMicros).toBeNull();
  });

  it("uses response usage but withholds cost when a prompt ledger is missing", async () => {
    const homeRoot = await createHome();
    await writeSession({
      homeRoot,
      id: "grok-missing-ledger",
      updates: [
        turnCompleted("prompt-1", {
          inputTokens: 9,
          outputTokens: 1,
          totalTokens: 10,
          costUsdTicks: 100_000
        }),
        responseCompleted("message-2", {
          input_tokens: 7,
          output_tokens: 3,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
          reasoning_tokens: 1
        }),
        turnCompletedWithoutUsage("prompt-2")
      ]
    });

    const [session] = await scanGrokSessions({ homeRoot });

    expect(session?.tokenUsage.total).toBe(23);
    expect(session?.metadata.reportedCostUsdMicros).toBeNull();
  });

  it("drops durable usage from branches removed by rewind", async () => {
    const homeRoot = await createHome();
    await writeSession({
      homeRoot,
      id: "grok-rewind",
      updates: [
        turnCompleted("prompt-1", {
          inputTokens: 9,
          outputTokens: 1,
          totalTokens: 10,
          costUsdTicks: 100_000
        }),
        turnCompleted("dead-prompt", {
          inputTokens: 18,
          outputTokens: 2,
          totalTokens: 20,
          costUsdTicks: 200_000
        }),
        rewindMarker(1),
        turnCompleted("replacement-prompt", {
          inputTokens: 27,
          outputTokens: 3,
          totalTokens: 30,
          costUsdTicks: 300_000
        })
      ]
    });

    const [session] = await scanGrokSessions({ homeRoot });

    expect(session?.tokenUsage.total).toBe(40);
    expect(session?.metadata.reportedCostUsdMicros).toBe(40);
  });

  it("excludes folded subagent sessions while retaining forks", async () => {
    const homeRoot = await createHome();
    const usage = [
      turnCompleted("prompt", {
        inputTokens: 10,
        outputTokens: 1,
        totalTokens: 11,
        costUsdTicks: 100_000
      })
    ];
    await Promise.all([
      writeSession({ homeRoot, id: "root", updates: usage }),
      writeSession({
        homeRoot,
        id: "subagent",
        sessionKind: "subagent",
        parentSessionId: "root",
        updates: usage
      }),
      writeSession({
        homeRoot,
        id: "fork",
        sessionKind: "fork",
        parentSessionId: "root",
        updates: usage
      })
    ]);

    const sessions = await scanGrokSessions({ homeRoot });

    expect(sessions.map((session) => session.providerSessionId).sort()).toEqual([
      "fork",
      "root"
    ]);
    expect(sessions.find((session) => session.providerSessionId === "fork")?.lineage)
      .toEqual({ parentSessionId: "root", kind: "child" });
    expect(
      sessions.find((session) => session.providerSessionId === "fork")?.tokenUsage
        .total
    ).toBe(0);
  });

  it("counts only usage created after a normal fork", async () => {
    const homeRoot = await createHome();
    const inherited = turnCompleted("parent-prompt", {
      inputTokens: 10,
      outputTokens: 1,
      totalTokens: 11,
      costUsdTicks: 100_000
    });
    await writeSession({ homeRoot, id: "root", updates: [inherited] });
    await writeSession({
      homeRoot,
      id: "fork",
      sessionKind: "fork",
      parentSessionId: "root",
      updates: [
        inherited,
        turnCompleted("fork-prompt", {
          inputTokens: 20,
          outputTokens: 2,
          totalTokens: 22,
          costUsdTicks: 200_000
        })
      ]
    });

    const sessions = await scanGrokSessions({ homeRoot });

    expect(
      sessions.find((session) => session.providerSessionId === "root")?.tokenUsage
        .total
    ).toBe(11);
    expect(
      sessions.find((session) => session.providerSessionId === "fork")?.tokenUsage
        .total
    ).toBe(22);
  });

  it("deduplicates inherited usage through multiple fork generations", async () => {
    const homeRoot = await createHome();
    const p1 = turnCompleted("p1", {
      inputTokens: 10,
      outputTokens: 1,
      totalTokens: 11,
      costUsdTicks: 100_000
    });
    const p2 = turnCompleted("p2", {
      inputTokens: 20,
      outputTokens: 2,
      totalTokens: 22,
      costUsdTicks: 200_000
    });
    const p3 = turnCompleted("p3", {
      inputTokens: 30,
      outputTokens: 3,
      totalTokens: 33,
      costUsdTicks: 300_000
    });
    await writeSession({ homeRoot, id: "root", updates: [p1] });
    await writeSession({
      homeRoot,
      id: "fork",
      sessionKind: "fork",
      parentSessionId: "root",
      updates: [p1, p2]
    });
    await writeSession({
      homeRoot,
      id: "fork-2",
      sessionKind: "fork",
      parentSessionId: "fork",
      updates: [p1, p2, p3]
    });

    const sessions = await scanGrokSessions({ homeRoot });

    expect(
      sessions.find((session) => session.providerSessionId === "fork-2")
        ?.tokenUsage.total
    ).toBe(33);
  });

  it("attributes worktree forks to their source workspace and inherits the remote", async () => {
    const homeRoot = await createHome();
    const inherited = turnCompleted("parent-prompt", {
      inputTokens: 10,
      outputTokens: 1,
      totalTokens: 11,
      costUsdTicks: 100_000
    });
    await writeSession({
      homeRoot,
      id: "root",
      cwd: "/work/repo",
      updates: [inherited]
    });
    await writeSession({
      homeRoot,
      id: "worktree",
      cwd: "/tmp/grok-worktree",
      sessionKind: "worktree",
      parentSessionId: "root",
      sourceWorkspaceDir: "/work/repo",
      gitRootDir: null,
      gitRemotes: [],
      updates: [
        inherited,
        turnCompleted("worktree-prompt", {
          inputTokens: 20,
          outputTokens: 2,
          totalTokens: 22,
          costUsdTicks: 200_000
        })
      ]
    });

    const sessions = await scanGrokSessions({ homeRoot });
    const worktree = sessions.find(
      (session) => session.providerSessionId === "worktree"
    );

    expect(worktree).toMatchObject({
      cwd: "/work/repo",
      observedRemoteUrlNormalized: "https://github.com/example/repo",
      tokenUsage: { total: 22 }
    });
  });

  it("recovers a subagent that finishes after an incomplete parent snapshot", async () => {
    const homeRoot = await createHome();
    await writeSession({
      homeRoot,
      id: "root",
      updates: [
        subagentSpawned("child", "parent-prompt"),
        turnCompleted("parent-prompt", {
          inputTokens: 9,
          outputTokens: 1,
          totalTokens: 10,
          usageIsIncomplete: true
        }),
        subagentFinished("child")
      ]
    });
    await writeSession({
      homeRoot,
      id: "child",
      sessionKind: "subagent",
      parentSessionId: "root",
      forkParentPromptId: "parent-prompt",
      updates: [
        turnCompleted("child-prompt", {
          inputTokens: 20,
          outputTokens: 2,
          totalTokens: 22,
          costUsdTicks: 200_000
        })
      ]
    });

    const sessions = await scanGrokSessions({ homeRoot });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.tokenUsage.total).toBe(32);
    expect(sessions[0]?.metadata.reportedCostUsdMicros).toBeNull();
  });

  it("does not re-add a subagent folded before an incomplete snapshot", async () => {
    const homeRoot = await createHome();
    await writeSession({
      homeRoot,
      id: "root",
      updates: [
        subagentSpawned("child", "parent-prompt"),
        subagentFinished("child"),
        turnCompleted("parent-prompt", {
          inputTokens: 30,
          outputTokens: 3,
          totalTokens: 33,
          usageIsIncomplete: true
        })
      ]
    });
    await writeSession({
      homeRoot,
      id: "child",
      sessionKind: "subagent",
      parentSessionId: "root",
      forkParentPromptId: "parent-prompt",
      updates: [
        turnCompleted("child-prompt", {
          inputTokens: 20,
          outputTokens: 2,
          totalTokens: 22,
          usageIsIncomplete: true
        })
      ]
    });

    const [session] = await scanGrokSessions({ homeRoot });

    expect(session?.tokenUsage.total).toBe(33);
  });

  it("returns only changed sessions from a valid incremental cursor", async () => {
    const homeRoot = await createHome();
    const first = await writeSession({
      homeRoot,
      id: "first",
      updates: [
        turnCompleted("p1", {
          inputTokens: 10,
          outputTokens: 1,
          totalTokens: 11,
          costUsdTicks: 100_000
        })
      ]
    });
    await writeSession({
      homeRoot,
      id: "second",
      updates: [
        turnCompleted("p2", {
          inputTokens: 20,
          outputTokens: 2,
          totalTokens: 22,
          costUsdTicks: 200_000
        })
      ]
    });
    const cursor = await buildGrokIncrementalCursorFromSource(homeRoot);
    await appendFile(
      first.updatesPath,
      `${turnCompleted("p3", {
        inputTokens: 30,
        outputTokens: 3,
        totalTokens: 33,
        costUsdTicks: 300_000
      })}\n`,
      "utf8"
    );
    const future = new Date(Date.now() + 5_000);
    await utimes(first.updatesPath, future, future);

    const result = await scanGrokSessionsIncremental({
      homeRoot,
      cursor
    });

    expect(result.mode).toBe("incremental");
    expect(result.sessions.map((session) => session.providerSessionId)).toEqual([
      "first"
    ]);
    expect(result.sessions[0]?.tokenUsage.total).toBe(44);
  });

  it("detects a changed file even when its mtime moves behind the old watermark", async () => {
    const homeRoot = await createHome();
    const session = await writeSession({
      homeRoot,
      id: "restored",
      updates: [
        turnCompleted("p1", {
          inputTokens: 10,
          outputTokens: 1,
          totalTokens: 11,
          costUsdTicks: 100_000
        })
      ]
    });
    const cursor = await buildGrokIncrementalCursorFromSource(homeRoot);
    await appendFile(
      session.updatesPath,
      `${turnCompleted("p2", {
        inputTokens: 20,
        outputTokens: 2,
        totalTokens: 22,
        costUsdTicks: 200_000
      })}\n`,
      "utf8"
    );
    const old = new Date("2020-01-01T00:00:00Z");
    await utimes(session.updatesPath, old, old);

    const result = await scanGrokSessionsIncremental({ homeRoot, cursor });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.tokenUsage.total).toBe(33);
  });

  it("reports deleted sessions so incremental refresh can evict stale cache entries", async () => {
    const homeRoot = await createHome();
    const session = await writeSession({
      homeRoot,
      id: "deleted",
      updates: [
        turnCompleted("p1", {
          inputTokens: 10,
          outputTokens: 1,
          totalTokens: 11,
          costUsdTicks: 100_000
        })
      ]
    });
    const cursor = await buildGrokIncrementalCursorFromSource(homeRoot);
    await rm(session.sessionDir, { recursive: true, force: true });

    const result = await scanGrokSessionsIncremental({ homeRoot, cursor });

    expect(result.mode).toBe("incremental");
    expect(result.sessions).toEqual([]);
    expect(result.deletedSessionIds).toEqual(["deleted"]);
  });

  it("re-homes inherited usage into a surviving fork when its parent is deleted", async () => {
    const homeRoot = await createHome();
    const inherited = turnCompleted("p1", {
      inputTokens: 10,
      outputTokens: 1,
      totalTokens: 11,
      costUsdTicks: 100_000
    });
    const root = await writeSession({
      homeRoot,
      id: "root",
      updates: [inherited]
    });
    await writeSession({
      homeRoot,
      id: "fork",
      sessionKind: "fork",
      parentSessionId: "root",
      updates: [
        inherited,
        turnCompleted("p2", {
          inputTokens: 20,
          outputTokens: 2,
          totalTokens: 22,
          costUsdTicks: 200_000
        })
      ]
    });
    const cursor = await buildGrokIncrementalCursorFromSource(homeRoot);
    await rm(root.sessionDir, { recursive: true, force: true });

    const result = await scanGrokSessionsIncremental({ homeRoot, cursor });

    expect(result.deletedSessionIds).toEqual(["root"]);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.providerSessionId).toBe("fork");
    expect(result.sessions[0]?.tokenUsage.total).toBe(33);
  });
});
