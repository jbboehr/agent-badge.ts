import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveProviderDirectories } from "./provider-directories.js";

describe("resolveProviderDirectories", () => {
  it("uses the standard provider directories by default", () => {
    expect(
      resolveProviderDirectories({
        cwd: "/work/repo",
        homeRoot: "/home/example",
        env: {}
      })
    ).toEqual({
      codex: resolve("/home/example/.codex"),
      claude: resolve("/home/example/.claude")
    });
  });

  it("accepts independent absolute provider directory overrides", () => {
    expect(
      resolveProviderDirectories({
        cwd: "/work/repo",
        homeRoot: "/home/example",
        env: {
          AGENT_BADGE_CODEX_DIR: "/data/codex",
          AGENT_BADGE_CLAUDE_DIR: "/data/claude"
        }
      })
    ).toEqual({
      codex: resolve("/data/codex"),
      claude: resolve("/data/claude")
    });
  });

  it("resolves relative paths from cwd and tilde paths from homeRoot", () => {
    expect(
      resolveProviderDirectories({
        cwd: "/work/repo",
        homeRoot: "/home/example",
        env: {
          AGENT_BADGE_CODEX_DIR: "var/codex",
          AGENT_BADGE_CLAUDE_DIR: "~/var/claude"
        }
      })
    ).toEqual({
      codex: resolve("/work/repo/var/codex"),
      claude: join(resolve("/home/example"), "var/claude")
    });
  });
});
