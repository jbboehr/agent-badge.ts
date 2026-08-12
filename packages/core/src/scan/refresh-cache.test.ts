import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseNormalizedSessionSummary } from "../providers/session-summary.js";
import { buildHomeNormalizationContextDigest } from "../attribution/home-normalization.js";
import {
  REFRESH_CACHE_FILE,
  buildRefreshCacheEntry,
  buildRefreshCacheKey,
  defaultRefreshCache,
  readRefreshCache,
  writeRefreshCache
} from "./refresh-cache.js";

function createSession() {
  return parseNormalizedSessionSummary({
    provider: "codex",
    providerSessionId: "session-1",
    startedAt: "2026-03-30T10:00:00Z",
    updatedAt: "2026-03-30T10:05:00Z",
    cwd: "/Users/example/project",
    gitBranch: "main",
    observedRemoteUrl: "git@github.com:example/agent-badge.git",
    observedRemoteUrlNormalized: "https://github.com/example/agent-badge",
    attributionHints: {
      cwdRealPath: "/Users/example/project",
      transcriptProjectKey: "Users-example-project"
    },
    tokenUsage: {
      total: 42,
      input: 40,
      output: 2,
      cacheCreation: null,
      cacheRead: null,
      reasoningOutput: null
    },
    lineage: {
      parentSessionId: null,
      kind: "root"
    },
    metadata: {
      model: "gpt-5",
      modelProvider: "openai",
      sourceKind: "sqlite",
      cliVersion: "1.0.0"
    }
  });
}

async function withTempDir<T>(callback: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "agent-badge-refresh-cache-"));

  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("refresh-cache", () => {
  it("builds stable provider-owned session keys", () => {
    expect(
      buildRefreshCacheKey({
        provider: "claude",
        providerSessionId: "session-42"
      })
    ).toBe("claude:session-42");
  });

  it("writes and reads the aggregate-only cache file", async () => {
    await withTempDir(async (cwd) => {
      const session = createSession();
      const cache = {
        ...defaultRefreshCache,
        homeNormalizationContextDigest: buildHomeNormalizationContextDigest(
          "/Users/example",
          true
        ),
        entries: {
          [buildRefreshCacheKey(session)]: buildRefreshCacheEntry({
            session,
            status: "included",
            overrideDecision: null,
            estimatedCostUsdMicros: null
          })
        }
      };

      await writeRefreshCache({ cwd, cache });

      const cachePath = join(cwd, REFRESH_CACHE_FILE);
      const serialized = await readFile(cachePath, "utf8");

      expect(await readRefreshCache({ cwd })).toEqual(cache);
      expect(serialized).toContain('"version": 3');
      expect(serialized).toContain('"homeNormalization": true');
      expect(serialized).toMatch(
        /"homeNormalizationContextDigest": "[0-9a-f]{64}"/
      );
      expect(serialized).toContain('"tokens": 42');
      expect(serialized).not.toContain("/Users/example/project");
      expect(serialized).not.toContain("observedRemoteUrl");
      expect(serialized).not.toContain("evidence");
    });
  });

  it("writes the cache under a configured agent-badge directory", async () => {
    await withTempDir(async (cwd) => {
      const agentBadgeDirectory = ".github/agent-badge";

      await writeRefreshCache({
        cwd,
        agentBadgeDirectory,
        cache: defaultRefreshCache
      });

      expect(
        await readRefreshCache({ cwd, agentBadgeDirectory })
      ).toEqual(defaultRefreshCache);
      expect(
        await readFile(
          join(cwd, agentBadgeDirectory, "cache/session-index.json"),
          "utf8"
        )
      ).toContain('"version": 3');
    });
  });

  it("treats caches created before cost tracking as not yet computed", async () => {
    await withTempDir(async (cwd) => {
      const cachePath = join(cwd, REFRESH_CACHE_FILE);

      await mkdir(join(cwd, ".agent-badge", "cache"), { recursive: true });
      await writeFile(
        cachePath,
        `${JSON.stringify({
          version: 3,
          homeNormalization: true,
          homeNormalizationContextDigest: null,
          entries: {}
        })}\n`,
        "utf8"
      );

      expect(await readRefreshCache({ cwd })).toEqual(defaultRefreshCache);
    });
  });

  it("preserves ambiguous session tokens for shared publish", () => {
    const session = createSession();

    expect(
      buildRefreshCacheEntry({
        session,
        status: "ambiguous",
        overrideDecision: "include",
        estimatedCostUsdMicros: 99
      })
    ).toEqual({
      provider: "codex",
      providerSessionId: "session-1",
      sessionUpdatedAt: "2026-03-30T10:05:00Z",
      status: "ambiguous",
      overrideDecision: "include",
      tokens: 42,
      estimatedCostUsdMicros: 99
    });
  });

  it("rejects persisted private evidence fields", async () => {
    await withTempDir(async (cwd) => {
      const cachePath = join(cwd, REFRESH_CACHE_FILE);

      await mkdir(join(cwd, ".agent-badge", "cache"), { recursive: true });
      await writeFile(
        cachePath,
        JSON.stringify(
          {
            version: 3,
            homeNormalization: true,
            homeNormalizationContextDigest: null,
            entries: {
              "codex:session-1": {
                provider: "codex",
                providerSessionId: "session-1",
                sessionUpdatedAt: "2026-03-30T10:05:00Z",
                status: "included",
                overrideDecision: null,
                tokens: 42,
                estimatedCostUsdMicros: null,
                cwd: "/Users/example/project"
              }
            }
          },
          null,
          2
        ),
        "utf8"
      );

      await expect(readRefreshCache({ cwd })).rejects.toThrow();
    });
  });
});
