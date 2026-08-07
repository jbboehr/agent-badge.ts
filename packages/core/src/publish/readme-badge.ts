export const AGENT_BADGE_README_START_MARKER = "<!-- agent-badge:start -->";
export const AGENT_BADGE_README_END_MARKER = "<!-- agent-badge:end -->";
export const AGENT_BADGE_PROJECT_URL =
  "https://github.com/arlegotin/agent-badge";

export interface ReadmeBadgeMarkupOptions {
  readonly label: string;
  readonly badgeUrl: string;
  readonly linkUrl?: string | null;
}

const README_BADGE_BLOCK_PATTERN =
  /(?:^|\n)<!-- agent-badge:start -->\n[\s\S]*?\n<!-- agent-badge:end -->\n*/g;
const README_BADGE_REGION_PATTERN =
  /<!-- agent-badge:start -->[\s\S]*?<!-- agent-badge:end -->/g;
const README_MARKDOWN_BADGE_PATTERN =
  /\[?!\[[^\]\n]*\]\((https?:\/\/[^)\s]+)\)(?:\]\([^)\n]+\))?/g;
const README_HTML_BADGE_PATTERN =
  /(<img\b[^>]*\bsrc\s*=\s*)(["'])(https?:\/\/[^"']+)\2([^>]*>)/gi;

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function buildManagedBadgeBlock(badgeMarkdown: string): string {
  return `${AGENT_BADGE_README_START_MARKER}
${badgeMarkdown}
${AGENT_BADGE_README_END_MARKER}
`;
}

function buildManagedBadgeInline(badgeMarkdown: string): string {
  return `${AGENT_BADGE_README_START_MARKER}${badgeMarkdown}${AGENT_BADGE_README_END_MARKER}`;
}

function updateHtmlBadgeUrl(
  html: string,
  badgeMarkdown: string
): string | null {
  const htmlMatches = [...html.matchAll(README_HTML_BADGE_PATTERN)];
  const markdownMatches = [
    ...badgeMarkdown.matchAll(README_MARKDOWN_BADGE_PATTERN)
  ];

  if (htmlMatches.length !== 1 || markdownMatches.length !== 1) {
    return null;
  }

  const newBadgeUrl = markdownMatches[0][1];

  return html.replace(
    README_HTML_BADGE_PATTERN,
    (_match, prefix: string, quote: string, _oldUrl: string, suffix: string) =>
      `${prefix}${quote}${newBadgeUrl}${quote}${suffix}`
  );
}

function updateExistingManagedBadge(
  content: string,
  badgeMarkdown: string
): string | null {
  const regions = content.match(README_BADGE_REGION_PATTERN) ?? [];

  if (regions.length !== 1) {
    return null;
  }

  const existingRegion = regions[0];
  const managedRegion =
    updateHtmlBadgeUrl(existingRegion, badgeMarkdown) ??
    (existingRegion.includes("\n")
      ? buildManagedBadgeBlock(badgeMarkdown).trimEnd()
      : buildManagedBadgeInline(badgeMarkdown));

  return content.replace(README_BADGE_REGION_PATTERN, managedRegion);
}

function isAgentBadgeEndpoint(badgeUrl: string): boolean {
  try {
    const shieldsUrl = new URL(badgeUrl);

    if (
      shieldsUrl.origin !== "https://img.shields.io" ||
      shieldsUrl.pathname !== "/endpoint"
    ) {
      return false;
    }

    const endpoint = shieldsUrl.searchParams.get("url");

    if (endpoint === null) {
      return false;
    }

    const endpointUrl = new URL(endpoint);

    return (
      endpointUrl.hostname === "gist.githubusercontent.com" &&
      decodeURIComponent(endpointUrl.pathname).endsWith("/agent-badge.json")
    );
  } catch {
    return false;
  }
}

function updateExistingUnmanagedBadge(
  content: string,
  badgeMarkdown: string
): string | null {
  const markdownMatches = [
    ...content.matchAll(README_MARKDOWN_BADGE_PATTERN)
  ]
    .filter((match) => isAgentBadgeEndpoint(match[1]))
    .map((match) => ({ match, kind: "markdown" as const }));
  const htmlMatches = [...content.matchAll(README_HTML_BADGE_PATTERN)]
    .filter((match) => isAgentBadgeEndpoint(match[3]))
    .map((match) => ({ match, kind: "html" as const }));
  const matches = [...markdownMatches, ...htmlMatches];

  if (matches.length !== 1) {
    return null;
  }

  const { match, kind } = matches[0];
  const matchIndex = match.index;
  const replacement =
    kind === "html"
      ? updateHtmlBadgeUrl(match[0], badgeMarkdown)
      : badgeMarkdown;

  if (replacement === null) {
    return null;
  }

  return `${content.slice(0, matchIndex)}${buildManagedBadgeInline(
    replacement
  )}${content.slice(matchIndex + match[0].length)}`;
}

export function buildReadmeBadgeMarkdown({
  label,
  badgeUrl,
  linkUrl = null
}: ReadmeBadgeMarkupOptions): string {
  const imageMarkdown = `![${label}](${badgeUrl})`;

  return linkUrl === null ? imageMarkdown : `[${imageMarkdown}](${linkUrl})`;
}

export function buildReadmeBadgeSnippet(
  options: ReadmeBadgeMarkupOptions
): string {
  return buildReadmeBadgeMarkdown(options);
}

export function upsertReadmeBadge(
  content: string,
  badgeMarkdown: string
): string {
  const updatedContent = updateExistingManagedBadge(content, badgeMarkdown);

  if (updatedContent !== null) {
    return updatedContent;
  }

  const migratedContent = updateExistingUnmanagedBadge(content, badgeMarkdown);

  if (migratedContent !== null) {
    return migratedContent;
  }

  const managedBlock = buildManagedBadgeBlock(badgeMarkdown);
  const withoutManagedBlock = content
    .replace(README_BADGE_BLOCK_PATTERN, "")
    .replace(README_BADGE_REGION_PATTERN, "");
  const normalizedContent = withoutManagedBlock.replace(/^\n+/, "");

  if (normalizedContent.length === 0) {
    return managedBlock;
  }

  return ensureTrailingNewline(`${managedBlock}\n${normalizedContent}`);
}
