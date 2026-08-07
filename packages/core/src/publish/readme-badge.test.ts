import { describe, expect, it } from "vitest";

import {
  AGENT_BADGE_README_END_MARKER,
  AGENT_BADGE_PROJECT_URL,
  AGENT_BADGE_README_START_MARKER,
  buildReadmeBadgeMarkdown,
  buildReadmeBadgeSnippet,
  upsertReadmeBadge
} from "./readme-badge.js";

describe("upsertReadmeBadge", () => {
  it("inserts one managed badge block", () => {
    const badgeMarkdown = buildReadmeBadgeMarkdown({
      label: "AI Usage",
      badgeUrl: "https://img.shields.io/endpoint?url=https%3A%2F%2Fexample.com"
    });

    expect(upsertReadmeBadge("# agent-badge\n", badgeMarkdown)).toBe(`${
      AGENT_BADGE_README_START_MARKER
    }
![AI Usage](https://img.shields.io/endpoint?url=https%3A%2F%2Fexample.com)
${AGENT_BADGE_README_END_MARKER}

# agent-badge
`);
  });

  it("reuses the managed block on re-run", () => {
    const firstBadgeMarkdown = buildReadmeBadgeMarkdown({
      label: "AI Usage",
      badgeUrl: "https://img.shields.io/endpoint?url=https%3A%2F%2Fexample.com%2Fold"
    });
    const secondBadgeMarkdown = buildReadmeBadgeMarkdown({
      label: "AI Usage",
      badgeUrl: "https://img.shields.io/endpoint?url=https%3A%2F%2Fexample.com%2Fnew"
    });
    const firstPass = upsertReadmeBadge("# agent-badge\n", firstBadgeMarkdown);
    const secondPass = upsertReadmeBadge(firstPass, secondBadgeMarkdown);

    expect(secondPass).toBe(`${
      AGENT_BADGE_README_START_MARKER
    }
![AI Usage](https://img.shields.io/endpoint?url=https%3A%2F%2Fexample.com%2Fnew)
${AGENT_BADGE_README_END_MARKER}

# agent-badge
`);
    expect(
      secondPass.match(
        new RegExp(AGENT_BADGE_README_START_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")
      )
    ).toHaveLength(1);
  });

  it("updates one inline managed badge in place", () => {
    const firstBadgeMarkdown = buildReadmeBadgeMarkdown({
      label: "AI Usage",
      badgeUrl: "https://img.shields.io/endpoint?url=https%3A%2F%2Fexample.com%2Fold"
    });
    const secondBadgeMarkdown = buildReadmeBadgeMarkdown({
      label: "AI Usage",
      badgeUrl: "https://img.shields.io/endpoint?url=https%3A%2F%2Fexample.com%2Fnew"
    });
    const content = `[Build](https://example.com/build) ${
      AGENT_BADGE_README_START_MARKER
    }${firstBadgeMarkdown}${AGENT_BADGE_README_END_MARKER}

# agent-badge
`;

    expect(upsertReadmeBadge(content, secondBadgeMarkdown)).toBe(
      `[Build](https://example.com/build) ${
        AGENT_BADGE_README_START_MARKER
      }${secondBadgeMarkdown}${AGENT_BADGE_README_END_MARKER}

# agent-badge
`
    );
  });

  it("discovers and manages one unmarked agent badge in place", () => {
    const badgeMarkdown = buildReadmeBadgeMarkdown({
      label: "AI Usage",
      badgeUrl:
        "https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Foctocat%2Fnew%2Fraw%2Fagent-badge.json&cacheSeconds=300"
    });
    const content = `# agent-badge

[Build](https://example.com/build) ![Old AI Usage](https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Foctocat%2Fold%2Fraw%2Fagent-badge.json&cacheSeconds=900)
`;

    expect(upsertReadmeBadge(content, badgeMarkdown)).toBe(`# agent-badge

[Build](https://example.com/build) ${
      AGENT_BADGE_README_START_MARKER
    }${badgeMarkdown}${AGENT_BADGE_README_END_MARKER}
`);
  });

  it("replaces an entire linked unmarked agent badge", () => {
    const badgeMarkdown = buildReadmeBadgeMarkdown({
      label: "AI Usage",
      badgeUrl:
        "https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Foctocat%2Fnew%2Fraw%2Fagent-badge.json&cacheSeconds=300",
      linkUrl: AGENT_BADGE_PROJECT_URL
    });
    const content = `# agent-badge

[![Old AI Usage](https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Foctocat%2Fold%2Fraw%2Fagent-badge.json&cacheSeconds=900)](https://example.com/old)
`;

    expect(upsertReadmeBadge(content, badgeMarkdown)).toBe(`# agent-badge

${AGENT_BADGE_README_START_MARKER}${badgeMarkdown}${AGENT_BADGE_README_END_MARKER}
`);
  });

  it("updates an HTML agent badge without replacing its surrounding markup", () => {
    const firstBadgeMarkdown = buildReadmeBadgeMarkdown({
      label: "AI Usage",
      badgeUrl:
        "https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Foctocat%2Fnew%2Fraw%2Fagent-badge.json&cacheSeconds=300",
      linkUrl: AGENT_BADGE_PROJECT_URL
    });
    const secondBadgeMarkdown = buildReadmeBadgeMarkdown({
      label: "AI Usage",
      badgeUrl:
        "https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Foctocat%2Fnewer%2Fraw%2Fagent-badge.json&cacheSeconds=900",
      linkUrl: AGENT_BADGE_PROJECT_URL
    });
    const oldBadgeUrl =
      "https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Foctocat%2Fold%2Fraw%2Fagent-badge.json&cacheSeconds=300";
    const content = `<p align="center">
  <a href="https://example.com/old">
    <img src="${oldBadgeUrl}" alt="AI usage badge">
  </a>
</p>
`;

    const firstPass = upsertReadmeBadge(content, firstBadgeMarkdown);
    const secondPass = upsertReadmeBadge(firstPass, secondBadgeMarkdown);

    expect(secondPass).toBe(`<p align="center">
  <a href="https://example.com/old">
    ${AGENT_BADGE_README_START_MARKER}<img src="https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Foctocat%2Fnewer%2Fraw%2Fagent-badge.json&cacheSeconds=900" alt="AI usage badge">${AGENT_BADGE_README_END_MARKER}
  </a>
</p>
`);
  });

  it("does not claim a non-Shields agent-badge.json image", () => {
    const badgeMarkdown = buildReadmeBadgeMarkdown({
      label: "AI Usage",
      badgeUrl:
        "https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Foctocat%2Fnew%2Fraw%2Fagent-badge.json&cacheSeconds=300"
    });
    const existingImage =
      "![Architecture](https://example.com/assets/agent-badge.json)";
    const updatedContent = upsertReadmeBadge(
      `${existingImage}\n\n# agent-badge\n`,
      badgeMarkdown
    );

    expect(updatedContent).toContain(existingImage);
    expect(updatedContent.startsWith(AGENT_BADGE_README_START_MARKER)).toBe(
      true
    );
  });

  it("does not choose between multiple unmarked agent badges", () => {
    const badgeMarkdown = buildReadmeBadgeMarkdown({
      label: "AI Usage",
      badgeUrl:
        "https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Foctocat%2Fnew%2Fraw%2Fagent-badge.json&cacheSeconds=300"
    });
    const firstBadge =
      "![First](https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Foctocat%2Ffirst%2Fraw%2Fagent-badge.json&cacheSeconds=300)";
    const secondBadge =
      "![Second](https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Foctocat%2Fsecond%2Fraw%2Fagent-badge.json&cacheSeconds=300)";
    const updatedContent = upsertReadmeBadge(
      `${firstBadge}\n${secondBadge}\n`,
      badgeMarkdown
    );

    expect(updatedContent).toContain(firstBadge);
    expect(updatedContent).toContain(secondBadge);
    expect(updatedContent.startsWith(AGENT_BADGE_README_START_MARKER)).toBe(
      true
    );
  });

  it("supports linking the badge image to the repository", () => {
    const badgeMarkdown = buildReadmeBadgeMarkdown({
      label: "AI Usage",
      badgeUrl: "https://img.shields.io/endpoint?url=https%3A%2F%2Fexample.com",
      linkUrl: AGENT_BADGE_PROJECT_URL
    });

    expect(upsertReadmeBadge("# agent-badge\n", badgeMarkdown)).toBe(`${
      AGENT_BADGE_README_START_MARKER
    }
[![AI Usage](https://img.shields.io/endpoint?url=https%3A%2F%2Fexample.com)](${AGENT_BADGE_PROJECT_URL})
${AGENT_BADGE_README_END_MARKER}

# agent-badge
`);
  });
});

describe("buildReadmeBadgeSnippet", () => {
  it("builds a pasteable snippet when no README exists", () => {
    expect(
      buildReadmeBadgeSnippet({
        label: "AI Usage",
        badgeUrl: "https://img.shields.io/endpoint?url=https%3A%2F%2Fexample.com"
      })
    ).toBe("![AI Usage](https://img.shields.io/endpoint?url=https%3A%2F%2Fexample.com)");
  });

  it("builds a linked snippet when a repository URL is provided", () => {
    expect(
      buildReadmeBadgeSnippet({
        label: "AI Usage",
        badgeUrl: "https://img.shields.io/endpoint?url=https%3A%2F%2Fexample.com",
        linkUrl: AGENT_BADGE_PROJECT_URL
      })
    ).toBe(
      `[![AI Usage](https://img.shields.io/endpoint?url=https%3A%2F%2Fexample.com)](${AGENT_BADGE_PROJECT_URL})`
    );
  });
});
