import { describe, expect, it } from "vitest";

import { createDefaultAgentBadgeConfig } from "./default-config.js";

describe("createDefaultAgentBadgeConfig", () => {
  it("enables only detected providers by default", () => {
    const config = createDefaultAgentBadgeConfig({
      providers: {
        codex: {
          available: true,
          homeLabel: "~/.codex"
        },
        claude: {
          available: false,
          homeLabel: "~/.claude"
        },
        grok: {
          available: true,
          homeLabel: "~/.grok"
        }
      }
    });

    expect(config.providers).toEqual({
      codex: {
        enabled: true
      },
      claude: {
        enabled: false
      },
      grok: {
        enabled: true
      }
    });
  });

  it.each([
    {
      codex: true,
      claude: true,
      grok: false
    },
    {
      codex: true,
      claude: false,
      grok: true
    },
    {
      codex: false,
      claude: true,
      grok: false
    },
    {
      codex: false,
      claude: false,
      grok: true
    }
  ])(
    "maps detected provider availability into config defaults (%j)",
    ({ codex, claude, grok }) => {
      const config = createDefaultAgentBadgeConfig({
        providers: {
          codex: {
            available: codex,
            homeLabel: "~/.codex"
          },
          claude: {
            available: claude,
            homeLabel: "~/.claude"
          },
          grok: {
            available: grok,
            homeLabel: "~/.grok"
          }
        }
      });

      expect(config.providers.codex.enabled).toBe(codex);
      expect(config.providers.claude.enabled).toBe(claude);
      expect(config.providers.grok.enabled).toBe(grok);
    }
  );
});
