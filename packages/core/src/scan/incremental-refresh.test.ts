import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultAgentBadgeConfig } from "../config/config-schema.js";
import {
  parseNormalizedSessionSummary,
  type NormalizedSessionSummary
} from "../providers/session-summary.js";
import { defaultAgentBadgeState } from "../state/state-schema.js";
import { buildGrokIncrementalCursorFromSource } from "../providers/grok/grok-adapter.js";
import {
  buildRefreshCacheEntry,
  buildRefreshCacheKey,
  defaultRefreshCache,
  writeRefreshCache
} from "./refresh-cache.js";

const {
  attributeBackfillSessionsMock,
  resolveRepoFingerprintMock,
  runFullBackfillScanMock,
  scanClaudeSessionsIncrementalMock,
  scanCodexSessionsIncrementalMock
} = vi.hoisted(() => ({
  attributeBackfillSessionsMock: vi.fn(),
  resolveRepoFingerprintMock: vi.fn(),
  runFullBackfillScanMock: vi.fn(),
  scanClaudeSessionsIncrementalMock: vi.fn(),
  scanCodexSessionsIncrementalMock: vi.fn()
}));

vi.mock("../attribution/attribution-engine.js", async () => {
  const actual = await vi.importActual<
    typeof import("../attribution/attribution-engine.js")
  >("../attribution/attribution-engine.js");

  return {
    ...actual,
    attributeBackfillSessions: attributeBackfillSessionsMock
  };
});

vi.mock("../providers/codex/codex-adapter.js", async () => {
  const actual = await vi.importActual<
    typeof import("../providers/codex/codex-adapter.js")
  >("../providers/codex/codex-adapter.js");

  return {
    ...actual,
    scanCodexSessionsIncremental: scanCodexSessionsIncrementalMock
  };
});

vi.mock("../providers/claude/claude-adapter.js", async () => {
  const actual = await vi.importActual<
    typeof import("../providers/claude/claude-adapter.js")
  >("../providers/claude/claude-adapter.js");

  return {
    ...actual,
    scanClaudeSessionsIncremental: scanClaudeSessionsIncrementalMock
  };
});

vi.mock("../repo/repo-fingerprint.js", async () => {
  const actual = await vi.importActual<
    typeof import("../repo/repo-fingerprint.js")
  >("../repo/repo-fingerprint.js");

  return {
    ...actual,
    resolveRepoFingerprint: resolveRepoFingerprintMock
  };
});

vi.mock("./full-backfill.js", async () => {
  const actual = await vi.importActual<typeof import("./full-backfill.js")>(
    "./full-backfill.js"
  );

  return {
    ...actual,
    runFullBackfillScan: runFullBackfillScanMock
  };
});

import {
  runIncrementalRefresh,
  summarizeRefreshCache
} from "./incremental-refresh.js";

const defaultTestProviders = {
  ...defaultAgentBadgeConfig.providers,
  grok: { enabled: false }
};

function createSession(
  overrides: Partial<NormalizedSessionSummary> &
    Pick<NormalizedSessionSummary, "provider" | "providerSessionId">
): NormalizedSessionSummary {
  const {
    provider,
    providerSessionId,
    attributionHints,
    tokenUsage,
    lineage,
    metadata,
    ...topLevelOverrides
  } = overrides;

  return parseNormalizedSessionSummary({
    provider,
    providerSessionId,
    startedAt: "2026-03-30T10:00:00Z",
    updatedAt: "2026-03-30T10:05:00Z",
    cwd: null,
    gitBranch: null,
    observedRemoteUrl: null,
    observedRemoteUrlNormalized: null,
    ...topLevelOverrides,
    attributionHints: {
      cwdRealPath: null,
      transcriptProjectKey: null,
      ...attributionHints
    },
    tokenUsage: {
      total: 0,
      input: null,
      output: null,
      cacheCreation: null,
      cacheRead: null,
      reasoningOutput: null,
      ...tokenUsage
    },
    lineage: {
      parentSessionId: null,
      kind: "unknown",
      ...lineage
    },
    metadata: {
      model: null,
      modelProvider: null,
      sourceKind: "test",
      cliVersion: null,
      ...metadata
    }
  });
}

function createRepoFingerprint() {
  return {
    gitRoot: "/tmp/agent-badge-repo",
    gitRootRealPath: "/tmp/agent-badge-repo",
    gitRootBasename: "agent-badge-repo",
    originUrlRaw: "git@github.com:example/agent-badge.git",
    originUrlNormalized: "https://github.com/example/agent-badge",
    host: "github.com",
    owner: "example",
    repo: "agent-badge",
    canonicalSlug: "example/agent-badge",
    aliasRemoteUrlsNormalized: [],
    aliasSlugs: []
  };
}

function createAttributedSession(
  session: NormalizedSessionSummary,
  status: "included" | "ambiguous" | "excluded",
  overrideApplied: "include" | "exclude" | null = null
) {
  return {
    session,
    status,
    evidence: [],
    reason: `${status} for test`,
    overrideApplied
  };
}

async function withTempDir<T>(callback: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "agent-badge-refresh-"));

  try {
    return await callback(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

beforeEach(() => {
  attributeBackfillSessionsMock.mockReset();
  resolveRepoFingerprintMock.mockReset();
  runFullBackfillScanMock.mockReset();
  scanClaudeSessionsIncrementalMock.mockReset();
  scanCodexSessionsIncrementalMock.mockReset();
});

describe("runIncrementalRefresh", () => {
  it("withholds a partial cached cost total when one included cost is unknown", () => {
    const known = createSession({
      provider: "codex",
      providerSessionId: "known",
      tokenUsage: { total: 10 }
    });
    const unknown = createSession({
      provider: "grok",
      providerSessionId: "unknown",
      tokenUsage: { total: 20 }
    });

    expect(
      summarizeRefreshCache({
        ...defaultRefreshCache,
        costsComputed: true,
        entries: {
          "codex:known": buildRefreshCacheEntry({
            session: known,
            status: "included",
            overrideDecision: null,
            estimatedCostUsdMicros: 100
          }),
          "grok:unknown": buildRefreshCacheEntry({
            session: unknown,
            status: "included",
            overrideDecision: null,
            estimatedCostUsdMicros: null
          })
        }
      })
    ).toEqual({
      includedSessions: 2,
      includedTokens: 30,
      includedEstimatedCostUsdMicros: null,
      ambiguousSessions: 0,
      excludedSessions: 0
    });
  });

  it("falls back to a full scan when the derived cache is missing", async () => {
    const fullSession = createSession({
      provider: "codex",
      providerSessionId: "codex-full",
      tokenUsage: {
        total: 42,
        input: 42,
        output: 0,
        cacheCreation: null,
        cacheRead: null,
        reasoningOutput: null
      }
    });

    runFullBackfillScanMock.mockResolvedValue({
      repo: createRepoFingerprint(),
      sessions: [fullSession],
      scannedProviders: ["codex"],
      counts: {
        scannedSessions: 1,
        dedupedSessions: 1,
        byProvider: {
          codex: {
            scannedSessions: 1,
            dedupedSessions: 1
          },
          claude: {
            scannedSessions: 0,
            dedupedSessions: 0
          }
        }
      }
    });
    attributeBackfillSessionsMock.mockReturnValue({
      sessions: [createAttributedSession(fullSession, "included")],
      counts: {
        included: 1,
        ambiguous: 0,
        excluded: 0
      }
    });

    await withTempDir(async (cwd) => {
      const result = await runIncrementalRefresh({
        cwd,
        homeRoot: "/tmp/home",
        config: {
          providers: defaultTestProviders,
          repo: defaultAgentBadgeConfig.repo
        },
        state: {
          ...defaultAgentBadgeState,
          checkpoints: {
            codex: {
              cursor: "opaque-codex",
              lastScannedAt: "2026-03-30T11:00:00Z"
            },
            claude: {
              cursor: "opaque-claude",
              lastScannedAt: "2026-03-30T11:00:00Z"
            }
          }
        },
        forceFull: false
      });

      expect(runFullBackfillScanMock).toHaveBeenCalledOnce();
      expect(result.scanMode).toBe("full");
      expect(result.summary).toEqual({
        includedSessions: 1,
        includedTokens: 42,
        includedEstimatedCostUsdMicros: null,
        ambiguousSessions: 0,
        excludedSessions: 0
      });
      expect(result.cache.entries["codex:codex-full"]).toEqual(
        expect.objectContaining({
          sessionUpdatedAt: "2026-03-30T10:05:00Z",
          status: "included",
          overrideDecision: null,
          tokens: 42,
          estimatedCostUsdMicros: null
        })
      );
      expect(result.providerCursors.codex).toContain("codex-thread-watermark-v1");
      expect(result.providerCursors.claude).toContain(
        "claude-project-jsonl-watermark-v1"
      );
    });
  });

  it("falls back to a full scan when a persisted override was removed", async () => {
    const session = createSession({
      provider: "codex",
      providerSessionId: "removed-override",
      tokenUsage: {
        total: 42,
        input: 42,
        output: 0,
        cacheCreation: null,
        cacheRead: null,
        reasoningOutput: null
      }
    });

    runFullBackfillScanMock.mockResolvedValue({
      repo: createRepoFingerprint(),
      sessions: [session],
      scannedProviders: ["codex"],
      counts: {
        scannedSessions: 1,
        dedupedSessions: 1,
        byProvider: {
          codex: {
            scannedSessions: 1,
            dedupedSessions: 1
          },
          claude: {
            scannedSessions: 0,
            dedupedSessions: 0
          }
        }
      }
    });
    attributeBackfillSessionsMock.mockReturnValue({
      sessions: [createAttributedSession(session, "excluded")],
      counts: {
        included: 0,
        ambiguous: 0,
        excluded: 1
      }
    });

    await withTempDir(async (cwd) => {
      await writeRefreshCache({
        cwd,
        cache: {
          ...defaultRefreshCache,
          entries: {
            [buildRefreshCacheKey(session)]: buildRefreshCacheEntry({
              session,
              status: "included",
              overrideDecision: "include",
              estimatedCostUsdMicros: null
            })
          }
        }
      });

      const result = await runIncrementalRefresh({
        cwd,
        homeRoot: "/tmp/home",
        config: {
          providers: defaultTestProviders,
          repo: defaultAgentBadgeConfig.repo
        },
        state: {
          ...defaultAgentBadgeState,
          checkpoints: {
            codex: {
              cursor: "opaque-codex",
              lastScannedAt: "2026-03-30T11:00:00Z"
            },
            claude: {
              cursor: "opaque-claude",
              lastScannedAt: "2026-03-30T11:00:00Z"
            }
          }
        },
        forceFull: false
      });

      expect(runFullBackfillScanMock).toHaveBeenCalledOnce();
      expect(scanCodexSessionsIncrementalMock).not.toHaveBeenCalled();
      expect(result.scanMode).toBe("full");
      expect(result.cache.entries["codex:removed-override"]).toEqual(
        expect.objectContaining({
          status: "excluded",
          overrideDecision: null,
          tokens: 42
        })
      );
    });
  });

  it("merges ambiguous sessions into the cache without zeroing their tokens", async () => {
    const changedCodexSession = createSession({
      provider: "codex",
      providerSessionId: "codex-1",
      tokenUsage: {
        total: 84,
        input: 84,
        output: 0,
        cacheCreation: null,
        cacheRead: null,
        reasoningOutput: null
      }
    });
    const ambiguousClaudeSession = createSession({
      provider: "claude",
      providerSessionId: "claude-1",
      tokenUsage: {
        total: 15,
        input: 15,
        output: 0,
        cacheCreation: null,
        cacheRead: null,
        reasoningOutput: null
      }
    });

    resolveRepoFingerprintMock.mockResolvedValue(createRepoFingerprint());
    scanCodexSessionsIncrementalMock.mockResolvedValue({
      sessions: [changedCodexSession],
      cursor: "codex-next",
      mode: "incremental"
    });
    scanClaudeSessionsIncrementalMock.mockResolvedValue({
      sessions: [ambiguousClaudeSession],
      cursor: "claude-next",
      mode: "incremental"
    });
    attributeBackfillSessionsMock.mockReturnValue({
      sessions: [
        createAttributedSession(changedCodexSession, "included"),
        createAttributedSession(ambiguousClaudeSession, "ambiguous", "include")
      ],
      counts: {
        included: 1,
        ambiguous: 1,
        excluded: 0
      }
    });

    await withTempDir(async (cwd) => {
      await writeRefreshCache({
        cwd,
        cache: {
          ...defaultRefreshCache,
          entries: {
            [buildRefreshCacheKey(changedCodexSession)]: buildRefreshCacheEntry({
              session: {
                ...changedCodexSession,
                tokenUsage: {
                  ...changedCodexSession.tokenUsage,
                  total: 21
                }
              },
              status: "included",
              overrideDecision: null,
              estimatedCostUsdMicros: null
            }),
            [buildRefreshCacheKey(ambiguousClaudeSession)]: buildRefreshCacheEntry({
              session: ambiguousClaudeSession,
              status: "ambiguous",
              overrideDecision: "include",
              estimatedCostUsdMicros: null
            })
          }
        }
      });

      const result = await runIncrementalRefresh({
        cwd,
        homeRoot: "/tmp/home",
        config: {
          providers: defaultTestProviders,
          repo: defaultAgentBadgeConfig.repo
        },
        state: {
          ...defaultAgentBadgeState,
          overrides: {
            ambiguousSessions: {
              "claude:claude-1": "include"
            }
          },
          checkpoints: {
            codex: {
              cursor: "opaque-codex",
              lastScannedAt: "2026-03-30T11:00:00Z"
            },
            claude: {
              cursor: "opaque-claude",
              lastScannedAt: "2026-03-30T11:00:00Z"
            }
          }
        },
        forceFull: false
      });

      expect(runFullBackfillScanMock).not.toHaveBeenCalled();
      expect(result.scanMode).toBe("incremental");
      expect(result.providerCursors).toEqual({
        codex: "codex-next",
        claude: "claude-next"
      });
      expect(result.summary).toEqual({
        includedSessions: 1,
        includedTokens: 84,
        includedEstimatedCostUsdMicros: null,
        ambiguousSessions: 1,
        excludedSessions: 0
      });
      expect(result.cache.entries["codex:codex-1"]).toEqual(
        expect.objectContaining({
          sessionUpdatedAt: "2026-03-30T10:05:00Z",
          status: "included",
          overrideDecision: null,
          tokens: 84,
          estimatedCostUsdMicros: null
        })
      );
      expect(result.cache.entries["claude:claude-1"]).toEqual(
        expect.objectContaining({
          sessionUpdatedAt: "2026-03-30T10:05:00Z",
          status: "ambiguous",
          overrideDecision: "include",
          tokens: 15,
          estimatedCostUsdMicros: null
        })
      );
    });
  });

  it("routes incremental scans to configured provider directories", async () => {
    const ambiguousCodexSession = createSession({
      provider: "codex",
      providerSessionId: "codex-override",
      tokenUsage: {
        total: 9,
        input: 9,
        output: 0,
        cacheCreation: null,
        cacheRead: null,
        reasoningOutput: null
      }
    });
    const ambiguousClaudeSession = createSession({
      provider: "claude",
      providerSessionId: "claude-override",
      tokenUsage: {
        total: 13,
        input: 13,
        output: 0,
        cacheCreation: null,
        cacheRead: null,
        reasoningOutput: null
      }
    });

    resolveRepoFingerprintMock.mockResolvedValue(createRepoFingerprint());
    scanCodexSessionsIncrementalMock.mockResolvedValue({
      sessions: [ambiguousCodexSession],
      cursor: "codex-next",
      mode: "incremental"
    });
    scanClaudeSessionsIncrementalMock.mockResolvedValue({
      sessions: [ambiguousClaudeSession],
      cursor: "claude-next",
      mode: "incremental"
    });
    attributeBackfillSessionsMock.mockReturnValue({
      sessions: [
        createAttributedSession(ambiguousCodexSession, "ambiguous"),
        createAttributedSession(ambiguousClaudeSession, "ambiguous")
      ],
      counts: {
        included: 0,
        ambiguous: 2,
        excluded: 0
      }
    });

    await withTempDir(async (cwd) => {
      const providerDirectories = {
        codex: "/data/custom-codex",
        claude: "/data/custom-claude",
        grok: "/data/custom-grok"
      };

      await writeRefreshCache({
        cwd,
        cache: defaultRefreshCache
      });

      const result = await runIncrementalRefresh({
        cwd,
        homeRoot: "/tmp/home",
        providerDirectories,
        config: {
          providers: defaultTestProviders,
          repo: defaultAgentBadgeConfig.repo
        },
        state: {
          ...defaultAgentBadgeState,
          overrides: {
            ambiguousSessions: {
              "codex:codex-override": "include",
              "claude:claude-override": "exclude"
            }
          },
          checkpoints: {
            codex: {
              cursor: "opaque-codex",
              lastScannedAt: "2026-03-30T11:00:00Z"
            },
            claude: {
              cursor: "opaque-claude",
              lastScannedAt: "2026-03-30T11:00:00Z"
            }
          }
        },
        forceFull: false
      });

      expect(scanCodexSessionsIncrementalMock).toHaveBeenCalledWith({
        homeRoot: "/tmp/home",
        codexRoot: providerDirectories.codex,
        cursor: "opaque-codex"
      });
      expect(scanClaudeSessionsIncrementalMock).toHaveBeenCalledWith({
        homeRoot: "/tmp/home",
        claudeRoot: providerDirectories.claude,
        cursor: "opaque-claude"
      });
      expect(result.cache.entries["codex:codex-override"]).toEqual(
        expect.objectContaining({
          overrideDecision: "include",
          tokens: 9
        })
      );
      expect(result.cache.entries["claude:claude-override"]).toEqual(
        expect.objectContaining({
          overrideDecision: "exclude",
          tokens: 13
        })
      );
    });
  });

  it("shared include decisions can promote cached ambiguous usage", async () => {
    const promotedSession = createSession({
      provider: "codex",
      providerSessionId: "codex-promoted",
      tokenUsage: {
        total: 33,
        input: 33,
        output: 0,
        cacheCreation: null,
        cacheRead: null,
        reasoningOutput: null
      }
    });

    resolveRepoFingerprintMock.mockResolvedValue(createRepoFingerprint());
    scanCodexSessionsIncrementalMock.mockResolvedValue({
      sessions: [promotedSession],
      cursor: "codex-promoted-next",
      mode: "incremental"
    });
    scanClaudeSessionsIncrementalMock.mockResolvedValue({
      sessions: [],
      cursor: "claude-next",
      mode: "incremental"
    });
    attributeBackfillSessionsMock.mockReturnValue({
      sessions: [createAttributedSession(promotedSession, "included", "include")],
      counts: {
        included: 1,
        ambiguous: 0,
        excluded: 0
      }
    });

    await withTempDir(async (cwd) => {
      await writeRefreshCache({
        cwd,
        cache: {
          ...defaultRefreshCache,
          entries: {
            [buildRefreshCacheKey(promotedSession)]: buildRefreshCacheEntry({
              session: promotedSession,
              status: "ambiguous",
              overrideDecision: "include",
              estimatedCostUsdMicros: null
            })
          }
        }
      });

      const result = await runIncrementalRefresh({
        cwd,
        homeRoot: "/tmp/home",
        config: {
          providers: defaultTestProviders,
          repo: defaultAgentBadgeConfig.repo
        },
        state: {
          ...defaultAgentBadgeState,
          overrides: {
            ambiguousSessions: {
              "codex:codex-promoted": "include"
            }
          },
          checkpoints: {
            codex: {
              cursor: "opaque-codex",
              lastScannedAt: "2026-03-30T11:00:00Z"
            },
            claude: {
              cursor: "opaque-claude",
              lastScannedAt: "2026-03-30T11:00:00Z"
            }
          }
        },
        forceFull: false
      });

      expect(result.summary).toEqual({
        includedSessions: 1,
        includedTokens: 33,
        includedEstimatedCostUsdMicros: null,
        ambiguousSessions: 0,
        excludedSessions: 0
      });
      expect(result.cache.entries["codex:codex-promoted"]).toEqual(
        expect.objectContaining({
          status: "included",
          overrideDecision: "include",
          tokens: 33
        })
      );
    });
  });

  it("falls back to a full scan when a provider cursor is unusable", async () => {
    const incrementalSession = createSession({
      provider: "codex",
      providerSessionId: "codex-invalid-cursor",
      tokenUsage: {
        total: 5,
        input: 5,
        output: 0,
        cacheCreation: null,
        cacheRead: null,
        reasoningOutput: null
      }
    });
    const fullSession = createSession({
      provider: "codex",
      providerSessionId: "codex-full-after-fallback",
      tokenUsage: {
        total: 12,
        input: 12,
        output: 0,
        cacheCreation: null,
        cacheRead: null,
        reasoningOutput: null
      }
    });

    scanCodexSessionsIncrementalMock.mockResolvedValue({
      sessions: [incrementalSession],
      cursor: "codex-rebuilt",
      mode: "full"
    });
    runFullBackfillScanMock.mockResolvedValue({
      repo: createRepoFingerprint(),
      sessions: [fullSession],
      scannedProviders: ["codex"],
      counts: {
        scannedSessions: 1,
        dedupedSessions: 1,
        byProvider: {
          codex: {
            scannedSessions: 1,
            dedupedSessions: 1
          },
          claude: {
            scannedSessions: 0,
            dedupedSessions: 0
          }
        }
      }
    });
    attributeBackfillSessionsMock.mockReturnValue({
      sessions: [createAttributedSession(fullSession, "excluded")],
      counts: {
        included: 0,
        ambiguous: 0,
        excluded: 1
      }
    });

    await withTempDir(async (cwd) => {
      await writeRefreshCache({
        cwd,
        cache: {
          ...defaultRefreshCache,
          entries: {
            [buildRefreshCacheKey(incrementalSession)]: buildRefreshCacheEntry({
              session: incrementalSession,
              status: "included",
              overrideDecision: null,
              estimatedCostUsdMicros: null
            })
          }
        }
      });

      const result = await runIncrementalRefresh({
        cwd,
        homeRoot: "/tmp/home",
        config: {
          providers: {
            codex: { enabled: true },
            claude: { enabled: false }
          },
          repo: defaultAgentBadgeConfig.repo
        },
        state: {
          ...defaultAgentBadgeState,
          checkpoints: {
            codex: {
              cursor: "opaque-codex",
              lastScannedAt: "2026-03-30T11:00:00Z"
            },
            claude: {
              cursor: null,
              lastScannedAt: null
            }
          }
        },
        forceFull: false
      });

      expect(scanCodexSessionsIncrementalMock).toHaveBeenCalledOnce();
      expect(runFullBackfillScanMock).toHaveBeenCalledOnce();
      expect(result.scanMode).toBe("full");
      expect(result.summary).toEqual({
        includedSessions: 0,
        includedTokens: 0,
        includedEstimatedCostUsdMicros: null,
        ambiguousSessions: 0,
        excludedSessions: 1
      });
      expect(result.cache.entries["codex:codex-full-after-fallback"]).toEqual(
        expect.objectContaining({
          sessionUpdatedAt: "2026-03-30T10:05:00Z",
          status: "excluded",
          overrideDecision: null,
          tokens: 12,
          estimatedCostUsdMicros: null
        })
      );
    });
  });

  it("incrementally refreshes Grok usage and evicts a deleted Grok session", async () => {
    await withTempDir(async (cwd) => {
      const grokRoot = join(cwd, "custom-grok");
      const sessionDir = join(grokRoot, "sessions", "repo", "grok-1");
      const updatesPath = join(sessionDir, "updates.jsonl");
      const turnCompleted = (
        promptId: string,
        totalTokens: number
      ): string =>
        JSON.stringify({
          method: "_x.ai/session/update",
          params: {
            update: {
              sessionUpdate: "turn_completed",
              prompt_id: promptId,
              usage: {
                inputTokens: totalTokens - 1,
                outputTokens: 1,
                totalTokens,
                costUsdTicks: totalTokens * 10_000
              }
            }
          }
        });

      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, "summary.json"),
        `${JSON.stringify({
          info: { id: "grok-1", cwd },
          created_at: "2026-08-01T10:00:00Z",
          updated_at: "2026-08-01T11:00:00Z",
          current_model_id: "grok-build-0.1",
          git_root_dir: cwd,
          git_remotes: ["git@github.com:example/agent-badge.git"],
          head_branch: "main"
        })}\n`,
        "utf8"
      );
      await writeFile(updatesPath, `${turnCompleted("p1", 11)}\n`, "utf8");

      const cursor = await buildGrokIncrementalCursorFromSource(cwd, grokRoot);
      const cachedSession = createSession({
        provider: "grok",
        providerSessionId: "grok-1",
        cwd,
        tokenUsage: {
          total: 11,
          input: 10,
          output: 1,
          cacheCreation: 0,
          cacheRead: 0,
          reasoningOutput: 0
        },
        metadata: {
          model: "grok-build-0.1",
          modelProvider: "xai",
          sourceKind: "grok-session-jsonl",
          cliVersion: null,
          reportedCostUsdMicros: 11
        }
      });
      await writeRefreshCache({
        cwd,
        cache: {
          ...defaultRefreshCache,
          entries: {
            "grok:grok-1": buildRefreshCacheEntry({
              session: cachedSession,
              status: "included",
              overrideDecision: null,
              estimatedCostUsdMicros: null
            })
          }
        }
      });

      await appendFile(updatesPath, `${turnCompleted("p2", 22)}\n`, "utf8");
      resolveRepoFingerprintMock.mockResolvedValue(createRepoFingerprint());
      attributeBackfillSessionsMock.mockImplementation(
        ({ sessions }: { sessions: readonly NormalizedSessionSummary[] }) => ({
          sessions: sessions.map((session) =>
            createAttributedSession(session, "included")
          ),
          counts: { included: sessions.length, ambiguous: 0, excluded: 0 }
        })
      );
      const config = {
        providers: {
          codex: { enabled: false },
          claude: { enabled: false },
          grok: { enabled: true }
        },
        repo: defaultAgentBadgeConfig.repo
      };
      const first = await runIncrementalRefresh({
        cwd,
        homeRoot: cwd,
        providerDirectories: { grok: grokRoot },
        config,
        state: {
          ...defaultAgentBadgeState,
          checkpoints: {
            ...defaultAgentBadgeState.checkpoints,
            grok: { cursor, lastScannedAt: "2026-08-01T12:00:00Z" }
          }
        },
        forceFull: false
      });

      expect(first.scanMode).toBe("incremental");
      expect(first.summary.includedTokens).toBe(33);
      expect(first.cache.entries["grok:grok-1"]?.tokens).toBe(33);

      await writeRefreshCache({ cwd, cache: first.cache });
      await rm(sessionDir, { recursive: true, force: true });
      const second = await runIncrementalRefresh({
        cwd,
        homeRoot: cwd,
        providerDirectories: { grok: grokRoot },
        config,
        state: {
          ...defaultAgentBadgeState,
          checkpoints: {
            ...defaultAgentBadgeState.checkpoints,
            grok: {
              cursor: first.providerCursors.grok ?? null,
              lastScannedAt: "2026-08-01T12:01:00Z"
            }
          }
        },
        forceFull: false
      });

      expect(second.scanMode).toBe("incremental");
      expect(second.cache.entries["grok:grok-1"]).toBeUndefined();
      expect(second.summary.includedSessions).toBe(0);
    });
  });
});
