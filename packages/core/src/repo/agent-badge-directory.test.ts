import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_AGENT_BADGE_DIR,
  GITHUB_AGENT_BADGE_DIR,
  resolveAgentBadgePaths
} from "./agent-badge-directory.js";

const cleanupPaths: string[] = [];

async function createRepoDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-badge-directory-"));
  cleanupPaths.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((targetPath) =>
      rm(targetPath, { recursive: true, force: true })
    )
  );
});

describe("resolveAgentBadgePaths", () => {
  it("defaults new repositories to .agent-badge", async () => {
    const cwd = await createRepoDirectory();

    expect(resolveAgentBadgePaths({ cwd, env: {} })).toMatchObject({
      directory: DEFAULT_AGENT_BADGE_DIR,
      configPath: join(cwd, DEFAULT_AGENT_BADGE_DIR, "config.json"),
      statePath: join(cwd, DEFAULT_AGENT_BADGE_DIR, "state.json")
    });
  });

  it("prefers an existing .github/agent-badge directory", async () => {
    const cwd = await createRepoDirectory();
    await Promise.all([
      mkdir(join(cwd, DEFAULT_AGENT_BADGE_DIR), { recursive: true }),
      mkdir(join(cwd, GITHUB_AGENT_BADGE_DIR), { recursive: true })
    ]);

    expect(resolveAgentBadgePaths({ cwd, env: {} }).directory).toBe(
      GITHUB_AGENT_BADGE_DIR
    );
  });

  it("uses AGENT_BADGE_DIR ahead of discovered directories", async () => {
    const cwd = await createRepoDirectory();
    await mkdir(join(cwd, GITHUB_AGENT_BADGE_DIR), { recursive: true });

    expect(
      resolveAgentBadgePaths({
        cwd,
        env: { AGENT_BADGE_DIR: "var/agent-badge" }
      })
    ).toMatchObject({
      directory: "var/agent-badge",
      cachePath: join(cwd, "var/agent-badge/cache"),
      logsPath: join(cwd, "var/agent-badge/logs")
    });
  });

  it("rejects AGENT_BADGE_DIR paths outside the repository", async () => {
    const cwd = await createRepoDirectory();

    expect(() =>
      resolveAgentBadgePaths({
        cwd,
        env: { AGENT_BADGE_DIR: "../outside" }
      })
    ).toThrow("AGENT_BADGE_DIR must name a directory inside the repository");
  });
});
