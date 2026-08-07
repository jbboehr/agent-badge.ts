import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import type { AttributionStatus } from "../attribution/attribution-types.js";
import type { NormalizedSessionSummary } from "../providers/session-summary.js";
import { resolveAgentBadgePaths } from "../repo/agent-badge-directory.js";

export const REFRESH_CACHE_FILE = ".agent-badge/cache/session-index.json";

const refreshCacheEntrySchema = z
  .object({
    provider: z.enum(["codex", "claude", "grok"]),
    providerSessionId: z.string().min(1),
    sessionUpdatedAt: z.string().min(1).nullable(),
    status: z.enum(["included", "ambiguous", "excluded"]),
    overrideDecision: z.enum(["include", "exclude"]).nullable(),
    tokens: z.number().int().nonnegative(),
    estimatedCostUsdMicros: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .default(null)
  })
  .strict();

const refreshCacheSchema = z
  .object({
    version: z.literal(2),
    costsComputed: z.boolean().optional().default(false),
    entries: z.record(z.string(), refreshCacheEntrySchema)
  })
  .strict();

export type RefreshCacheEntry = z.infer<typeof refreshCacheEntrySchema>;
export type RefreshCache = z.infer<typeof refreshCacheSchema>;

export interface ReadRefreshCacheOptions {
  readonly cwd: string;
  readonly agentBadgeDirectory?: string;
}

export interface WriteRefreshCacheOptions {
  readonly cwd: string;
  readonly agentBadgeDirectory?: string;
  readonly cache: RefreshCache;
}

function getRefreshCachePath(
  cwd: string,
  agentBadgeDirectory?: string
): string {
  return resolveAgentBadgePaths({
    cwd,
    env: agentBadgeDirectory
      ? { AGENT_BADGE_DIR: agentBadgeDirectory }
      : undefined
  }).refreshCachePath;
}

export interface BuildRefreshCacheEntryOptions {
  readonly session: Pick<
    NormalizedSessionSummary,
    "provider" | "providerSessionId" | "updatedAt" | "tokenUsage"
  >;
  readonly status: AttributionStatus;
  readonly overrideDecision: "include" | "exclude" | null;
  readonly estimatedCostUsdMicros: number | null;
}

export const defaultRefreshCache: RefreshCache = {
  version: 2,
  costsComputed: false,
  entries: {}
};

export function buildRefreshCacheKey(
  session: Pick<NormalizedSessionSummary, "provider" | "providerSessionId">
): string {
  const { provider, providerSessionId } = session;

  return `${provider}:${providerSessionId}`;
}

export function buildRefreshCacheEntry({
  session,
  status,
  overrideDecision,
  estimatedCostUsdMicros
}: BuildRefreshCacheEntryOptions): RefreshCacheEntry {
  return {
    provider: session.provider,
    providerSessionId: session.providerSessionId,
    sessionUpdatedAt: session.updatedAt,
    status,
    overrideDecision,
    tokens: session.tokenUsage.total,
    estimatedCostUsdMicros
  };
}

export async function readRefreshCache({
  cwd,
  agentBadgeDirectory
}: ReadRefreshCacheOptions): Promise<RefreshCache | null> {
  try {
    const content = await readFile(
      getRefreshCachePath(cwd, agentBadgeDirectory),
      "utf8"
    );

    return refreshCacheSchema.parse(JSON.parse(content));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }

    throw error;
  }
}

export async function writeRefreshCache({
  cwd,
  agentBadgeDirectory,
  cache
}: WriteRefreshCacheOptions): Promise<void> {
  const cachePath = getRefreshCachePath(cwd, agentBadgeDirectory);

  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(
    cachePath,
    `${JSON.stringify(refreshCacheSchema.parse(cache), null, 2)}\n`,
    "utf8"
  );
}
