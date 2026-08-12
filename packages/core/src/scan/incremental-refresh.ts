import { realpath } from "node:fs/promises";

import { attributeBackfillSessions } from "../attribution/attribution-engine.js";
import { buildHomeNormalizationContextDigest } from "../attribution/home-normalization.js";
import type { AttributedSession } from "../attribution/attribution-types.js";
import type { AgentBadgeConfig } from "../config/config-schema.js";
import {
  buildClaudeIncrementalCursorFromSource,
  scanClaudeSessionsIncremental
} from "../providers/claude/claude-adapter.js";
import {
  buildCodexIncrementalCursor,
  scanCodexSessionsIncremental
} from "../providers/codex/codex-adapter.js";
import {
  buildGrokIncrementalCursorFromSource,
  scanGrokSessionsIncremental
} from "../providers/grok/grok-adapter.js";
import {
  parseNormalizedSessionSummary,
  type NormalizedSessionSummary
} from "../providers/session-summary.js";
import type { ProviderDirectories } from "../providers/provider-directories.js";
import {
  estimateSessionCostsUsdMicrosByKey,
  resolvePricingCatalog
} from "../pricing/estimate-cost.js";
import { resolveRepoFingerprint } from "../repo/repo-fingerprint.js";
import type {
  AgentBadgeRefreshSummary,
  AgentBadgeState
} from "../state/state-schema.js";
import { runFullBackfillScan } from "./full-backfill.js";
import {
  buildRefreshCacheEntry,
  buildRefreshCacheKey,
  defaultRefreshCache,
  readRefreshCache,
  type RefreshCache
} from "./refresh-cache.js";

type ProviderName = NormalizedSessionSummary["provider"];

interface ProviderIncrementalResult {
  readonly provider: ProviderName;
  readonly sessions: NormalizedSessionSummary[];
  readonly cursor: string;
  readonly mode: "incremental" | "full";
  readonly deletedSessionIds: readonly string[];
}

export interface RunIncrementalRefreshOptions {
  readonly cwd: string;
  readonly agentBadgeDirectory?: string;
  readonly homeRoot: string;
  readonly providerDirectories?: ProviderDirectories;
  readonly config: Pick<AgentBadgeConfig, "providers" | "repo" | "badge">;
  readonly state: AgentBadgeState;
  readonly forceFull: boolean;
  readonly homeNormalization?: boolean;
}

export interface RunIncrementalRefreshResult {
  readonly scanMode: "full" | "incremental";
  readonly summary: AgentBadgeRefreshSummary;
  readonly providerCursors: Partial<Record<ProviderName, string | null>>;
  readonly cache: RefreshCache;
}

function enabledProviders(
  config: Pick<AgentBadgeConfig, "providers">
): ProviderName[] {
  const providers: ProviderName[] = [];

  if (config.providers.codex.enabled) {
    providers.push("codex");
  }

  if (config.providers.claude.enabled) {
    providers.push("claude");
  }

  if (config.providers.grok?.enabled) {
    providers.push("grok");
  }

  return providers;
}

function filterCacheByEnabledProviders(
  cache: RefreshCache,
  providers: readonly ProviderName[]
): RefreshCache {
  const enabledProviderSet = new Set(providers);

  return {
    ...cache,
    entries: Object.fromEntries(
      Object.entries(cache.entries).filter(([, entry]) =>
        enabledProviderSet.has(entry.provider)
      )
    )
  };
}

function cacheOverrideDecisionsMatchState(
  cache: RefreshCache,
  state: Pick<AgentBadgeState, "overrides">
): boolean {
  return Object.entries(cache.entries).every(
    ([sessionKey, entry]) =>
      entry.overrideDecision ===
      (state.overrides.ambiguousSessions[sessionKey] ?? null)
  );
}

export function summarizeRefreshCache(
  cache: RefreshCache
): AgentBadgeRefreshSummary {
  const entries = Object.values(cache.entries);
  const includedEntries = entries.filter(
    (entry) => entry.status === "included"
  );
  const hasCompleteEstimatedCost =
    includedEntries.length > 0 &&
    includedEntries.every((entry) => entry.estimatedCostUsdMicros !== null);

  return entries.reduce<AgentBadgeRefreshSummary>(
    (summary, entry) => ({
      includedSessions:
        summary.includedSessions + (entry.status === "included" ? 1 : 0),
      includedTokens:
        summary.includedTokens + (entry.status === "included" ? entry.tokens : 0),
      includedEstimatedCostUsdMicros: hasCompleteEstimatedCost
        ? (summary.includedEstimatedCostUsdMicros ?? 0) +
          (entry.status === "included" ? (entry.estimatedCostUsdMicros ?? 0) : 0)
        : null,
      ambiguousSessions:
        summary.ambiguousSessions + (entry.status === "ambiguous" ? 1 : 0),
      excludedSessions:
        summary.excludedSessions + (entry.status === "excluded" ? 1 : 0)
    }),
    {
      includedSessions: 0,
      includedTokens: 0,
      includedEstimatedCostUsdMicros: hasCompleteEstimatedCost ? 0 : null,
      ambiguousSessions: 0,
      excludedSessions: 0
    }
  );
}

async function mergeAttributedSessionsIntoCache(
  cache: RefreshCache,
  attributedSessions: readonly AttributedSession[],
  options: Pick<
    RunIncrementalRefreshOptions,
    | "cwd"
    | "agentBadgeDirectory"
    | "homeRoot"
    | "providerDirectories"
    | "config"
    | "state"
    | "homeNormalization"
  >
): Promise<RefreshCache> {
  const shouldEstimateCost =
    options.config.badge?.mode === "combined" ||
    options.config.badge?.mode === "cost";
  const observationSessions = attributedSessions.map(
    (attributedSession) => attributedSession.session
  );
  const estimatedCostBySessionKey = new Map<string, number | null>();

  if (shouldEstimateCost && observationSessions.length > 0) {
    const pricingCatalog = await resolvePricingCatalog({
      cwd: options.cwd,
      agentBadgeDirectory: options.agentBadgeDirectory
    });
    const estimatedCosts = await estimateSessionCostsUsdMicrosByKey({
      sessions: observationSessions,
      homeRoot: options.homeRoot,
      codexRoot: options.providerDirectories?.codex,
      pricingCatalog
    });

    for (const [sessionKey, estimatedCostUsdMicros] of Object.entries(
      estimatedCosts
    )) {
      estimatedCostBySessionKey.set(sessionKey, estimatedCostUsdMicros);
    }
  }

  return {
    ...cache,
    homeNormalization: options.homeNormalization ?? true,
    homeNormalizationContextDigest: buildHomeNormalizationContextDigest(
      options.homeRoot,
      options.homeNormalization ?? true
    ),
    costsComputed: shouldEstimateCost,
    entries: attributedSessions.reduce(
      (entries, attributedSession) => {
        const cacheKey = buildRefreshCacheKey(attributedSession.session);

        entries[cacheKey] =
          buildRefreshCacheEntry({
            session: attributedSession.session,
            status: attributedSession.status,
            overrideDecision:
              options.state.overrides.ambiguousSessions[cacheKey] ??
              attributedSession.overrideApplied,
            estimatedCostUsdMicros: shouldEstimateCost
              ? estimatedCostBySessionKey.has(cacheKey)
                ? (estimatedCostBySessionKey.get(cacheKey) ?? null)
                : 0
              : null
          });

        return entries;
      },
      { ...cache.entries }
    )
  };
}

async function resolveCwdRealPath(
  session: NormalizedSessionSummary
): Promise<NormalizedSessionSummary> {
  if (session.cwd === null) {
    return session;
  }

  try {
    const cwdRealPath = await realpath(session.cwd);

    return parseNormalizedSessionSummary({
      ...session,
      attributionHints: {
        ...session.attributionHints,
        cwdRealPath
      }
    });
  } catch {
    return session;
  }
}

async function buildProviderCursorsFromSessions(
  homeRoot: string,
  sessions: readonly NormalizedSessionSummary[],
  providers: readonly ProviderName[],
  providerDirectories?: ProviderDirectories
): Promise<Partial<Record<ProviderName, string | null>>> {
  const providerSet = new Set(providers);
  const providerCursors: Partial<Record<ProviderName, string | null>> = {};

  if (providerSet.has("codex")) {
    providerCursors.codex = buildCodexIncrementalCursor(sessions);
  }

  if (providerSet.has("claude")) {
    providerCursors.claude = await buildClaudeIncrementalCursorFromSource(
      homeRoot,
      providerDirectories?.claude
    );
  }

  if (providerSet.has("grok")) {
    providerCursors.grok = await buildGrokIncrementalCursorFromSource(
      homeRoot,
      providerDirectories?.grok
    );
  }

  return providerCursors;
}

async function runFullRefresh(
  options: RunIncrementalRefreshOptions,
  providers: readonly ProviderName[]
): Promise<RunIncrementalRefreshResult> {
  const fullScan = await runFullBackfillScan({
    cwd: options.cwd,
    homeRoot: options.homeRoot,
    providerDirectories: options.providerDirectories,
    config: options.config
  });
  const attribution = attributeBackfillSessions({
    repo: fullScan.repo,
    sessions: fullScan.sessions,
    overrides: options.state.overrides.ambiguousSessions,
    homeRoot: options.homeRoot,
    homeNormalization: options.homeNormalization ?? true
  });
  const cache = await mergeAttributedSessionsIntoCache(
    defaultRefreshCache,
    attribution.sessions,
    options
  );

  return {
    scanMode: "full",
    summary: summarizeRefreshCache(cache),
    providerCursors: await buildProviderCursorsFromSessions(
      options.homeRoot,
      fullScan.sessions,
      providers,
      options.providerDirectories
    ),
    cache
  };
}

async function runProviderIncrementalScans(
  options: RunIncrementalRefreshOptions,
  providers: readonly ProviderName[]
): Promise<ProviderIncrementalResult[]> {
  const scans = await Promise.all(
    providers.map(async (provider): Promise<ProviderIncrementalResult> => {
      if (provider === "codex") {
        const result = await scanCodexSessionsIncremental({
          homeRoot: options.homeRoot,
          codexRoot: options.providerDirectories?.codex,
          cursor: options.state.checkpoints.codex.cursor
        });

        return {
          provider,
          sessions: result.sessions,
          cursor: result.cursor,
          mode: result.mode,
          deletedSessionIds: []
        };
      }

      if (provider === "grok") {
        const result = await scanGrokSessionsIncremental({
          homeRoot: options.homeRoot,
          grokRoot: options.providerDirectories?.grok,
          cursor: options.state.checkpoints.grok.cursor
        });

        return {
          provider,
          sessions: result.sessions,
          cursor: result.cursor,
          mode: result.mode,
          deletedSessionIds: result.deletedSessionIds
        };
      }

      const result = await scanClaudeSessionsIncremental({
        homeRoot: options.homeRoot,
        claudeRoot: options.providerDirectories?.claude,
        cursor: options.state.checkpoints.claude.cursor
      });

      return {
        provider,
        sessions: result.sessions,
        cursor: result.cursor,
        mode: result.mode,
        deletedSessionIds: []
      };
    })
  );

  return scans;
}

export async function runIncrementalRefresh(
  options: RunIncrementalRefreshOptions
): Promise<RunIncrementalRefreshResult> {
  const providers = enabledProviders(options.config);
  const homeNormalization = options.homeNormalization ?? true;
  const homeNormalizationContextDigest =
    buildHomeNormalizationContextDigest(options.homeRoot, homeNormalization);

  if (options.forceFull || providers.length === 0) {
    return runFullRefresh(options, providers);
  }

  let cache: RefreshCache | null;

  try {
    cache = await readRefreshCache({
      cwd: options.cwd,
      agentBadgeDirectory: options.agentBadgeDirectory
    });
  } catch {
    return runFullRefresh(options, providers);
  }

  if (cache === null) {
    return runFullRefresh(options, providers);
  }

  if (
    cache.homeNormalization !== homeNormalization ||
    cache.homeNormalizationContextDigest !== homeNormalizationContextDigest
  ) {
    return runFullRefresh(options, providers);
  }

  if (!cacheOverrideDecisionsMatchState(cache, options.state)) {
    return runFullRefresh(options, providers);
  }

  if (
    (options.config.badge?.mode === "combined" ||
      options.config.badge?.mode === "cost") &&
    !cache.costsComputed
  ) {
    return runFullRefresh(options, providers);
  }

  if (
    providers.some(
      (provider) => options.state.checkpoints[provider]?.cursor == null
    )
  ) {
    return runFullRefresh(options, providers);
  }

  const providerScans = await runProviderIncrementalScans(options, providers);

  if (providerScans.some((scan) => scan.mode === "full")) {
    return runFullRefresh(options, providers);
  }

  cache = filterCacheByEnabledProviders(cache, providers);
  const deletedCacheKeys = new Set(
    providerScans.flatMap((scan) =>
      scan.deletedSessionIds.map(
        (sessionId) => `${scan.provider}:${sessionId}`
      )
    )
  );
  cache = {
    ...cache,
    entries: Object.fromEntries(
      Object.entries(cache.entries).filter(
        ([sessionKey]) => !deletedCacheKeys.has(sessionKey)
      )
    )
  };

  const repo = await resolveRepoFingerprint({
    cwd: options.cwd,
    config: options.config
  });
  const changedSessions = await Promise.all(
    providerScans.flatMap((scan) => scan.sessions).map(resolveCwdRealPath)
  );
  const attribution = attributeBackfillSessions({
    repo,
    sessions: changedSessions,
    overrides: options.state.overrides.ambiguousSessions,
    homeRoot: options.homeRoot,
    homeNormalization: options.homeNormalization ?? true
  });
  const nextCache = await mergeAttributedSessionsIntoCache(
    cache,
    attribution.sessions,
    options
  );

  return {
    scanMode: "incremental",
    summary: summarizeRefreshCache(nextCache),
    providerCursors: Object.fromEntries(
      providerScans.map((scan) => [scan.provider, scan.cursor])
    ),
    cache: nextCache
  };
}
