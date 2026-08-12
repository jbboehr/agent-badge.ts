import { describe, expect, it } from "vitest";

import {
  buildHomeNormalizationContextDigest,
  resolveHomeNormalization,
  resolveHomeRelativePath
} from "./home-normalization.js";

describe("resolveHomeNormalization", () => {
  it("enables home normalization by default", () => {
    expect(resolveHomeNormalization({})).toBe(true);
    expect(resolveHomeNormalization({ AGENT_BADGE_HOME_NORMALIZATION: "1" })).toBe(
      true
    );
    expect(
      resolveHomeNormalization({ AGENT_BADGE_HOME_NORMALIZATION: "TRUE" })
    ).toBe(true);
  });

  it("allows home normalization to be disabled", () => {
    expect(resolveHomeNormalization({ AGENT_BADGE_HOME_NORMALIZATION: "0" })).toBe(
      false
    );
    expect(
      resolveHomeNormalization({ AGENT_BADGE_HOME_NORMALIZATION: "false" })
    ).toBe(false);
  });

  it("rejects unsupported values", () => {
    expect(() =>
      resolveHomeNormalization({ AGENT_BADGE_HOME_NORMALIZATION: "yes" })
    ).toThrow("must be one of: 1, true, 0, false");
  });
});

describe("resolveHomeRelativePath", () => {
  it("uses the configured home when the path is beneath it", () => {
    expect(
      resolveHomeRelativePath("/custom/users/rin/Code/repo", "/custom/users/rin")
    ).toBe("Code/repo");
  });

  it.each([
    ["/home/sandbox/Code/repo", "Code/repo"],
    ["/var/home/rin/Code/repo", "Code/repo"],
    ["/Users/rin/Code/repo", "Code/repo"],
    ["C:\\Users\\rin\\Code\\repo", "code/repo"],
    ["/root/Code/repo", "Code/repo"]
  ])("infers a conventional home prefix from %s", (path, expected) => {
    expect(resolveHomeRelativePath(path)).toBe(expected);
  });

  it("does not guess a home for unrelated absolute paths", () => {
    expect(resolveHomeRelativePath("/srv/repos/example")).toBeNull();
  });

  it("preserves backslashes in legal POSIX path segments", () => {
    expect(resolveHomeRelativePath("/home/rin/Code/we\\ird")).toBe(
      "Code/we\\ird"
    );
  });

  it("case-folds Windows paths", () => {
    expect(
      resolveHomeRelativePath(
        "C:\\Users\\Rin\\Code\\Repo",
        "c:\\users\\rin"
      )
    ).toBe("code/repo");
  });

  it("does not treat a bare home directory as repository identity", () => {
    expect(resolveHomeRelativePath("/home/rin", "/home/rin")).toBeNull();
    expect(resolveHomeRelativePath("/home/sandbox")).toBeNull();
    expect(resolveHomeRelativePath("C:\\Users\\rin")).toBeNull();
  });
});

describe("buildHomeNormalizationContextDigest", () => {
  it("changes with the home without exposing either path", () => {
    const first = buildHomeNormalizationContextDigest("/home/rin", true);
    const second = buildHomeNormalizationContextDigest("/home/other", true);

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain("/home/rin");
  });

  it("does not bind disabled normalization to a home", () => {
    expect(buildHomeNormalizationContextDigest("/home/rin", false)).toBeNull();
  });
});
