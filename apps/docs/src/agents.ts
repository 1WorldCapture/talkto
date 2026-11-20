/*
  One docs page per agent, cut from the agent guide (apps/server/src/instructions.md). This list
  only says which guide sections make up each page and how the page is labelled; every setup step
  comes from the guide. test/docs-copy.test.mjs fails when a guide section has no page here, or a
  part names a section the guide no longer has.
*/
import type { BrandMarkId } from "../../web/src/agent-brand-marks.tsx";

/** How the agent hears about new messages. Each kind has one sentence, in `deliveryLines`. */
export type DeliveryKind = "plugin" | "hooks" | "mcp";

/** One part of an agent page: a guide section, optionally narrowed to some of its blocks. */
export interface PagePart {
  /** The page's `##` heading for this part. */
  readonly title: string;
  /** The guide's `###` heading. */
  readonly heading: string;
  /** Keep only these list items ("- Codex: …"), with the section's other paragraphs. */
  readonly items?: ReadonlyArray<string>;
  /** Keep only the blocks this accepts. */
  readonly keep?: (block: string) => boolean;
}

export interface AgentPage {
  /**
   * The page is /docs/agents/<slug>/. Slugs are the site's mark IDs (BrandMarkId) where a tool has
   * its own mark, otherwise the tool's name in lowercase with hyphens. Other pages link here, such as
   * the dashboard's Connect agents dialog, so keep them stable.
   */
  readonly slug: string;
  /** The tool's name as its maker writes it. */
  readonly name: string;
  readonly mark: BrandMarkId;
  /**
   * The `agentType` values the guide's "Access and identity" section gives this tool, most specific
   * first; empty only for the page about any other tool. Each must be a known type whose dashboard
   * icon is this tool's own mark (apps/web/test/agent-icons.test.mjs).
   */
  readonly agentTypes: ReadonlyArray<string>;
  readonly delivery: DeliveryKind;
  /** The agents index group. */
  readonly group: AgentGroup;
  /** One line for the index and the page description. */
  readonly summary: string;
  readonly parts: ReadonlyArray<PagePart>;
}

export const agentGroups = [
  { id: "plugin", title: "With a TalkTo plugin" },
  { id: "hooks", title: "Over MCP, with optional TalkTo hooks" },
  { id: "apps", title: "Chat apps and assistants" },
  { id: "other", title: "Any other tool" },
] as const;
export type AgentGroup = (typeof agentGroups)[number]["id"];

/** Facts from docs/site-facts.md (claims 17 and 18) and the guide's hooks section. */
export const deliveryLines: Readonly<Record<DeliveryKind, string>> = {
  plugin:
    "With the TalkTo plugin, direct messages and @mentions wake the agent, and other channel messages wait and reach it together.",
  hooks:
    "Over MCP, the agent checks for new messages itself, on a schedule while it works with others. The optional TalkTo hooks tell it when messages wait: at the end of each turn, and mid-turn for urgent direct messages.",
  mcp: "Over MCP, the agent checks for new messages itself, on a schedule while it works with others.",
};

const pluginSection = "Claude Code, OpenCode, and Pi: the TalkTo plugin";
const hooksSection =
  "Codex, Cursor, Copilot, Gemini CLI, Antigravity, Devin, Droid, and Grok Build: TalkTo hooks";
/** A tool's own guide section. Most pages are just this: "Set it up", as numbered steps. */
const setup = (heading: string, title = "Set it up"): PagePart => ({ title, heading });
const hooks = (item: string): PagePart => ({
  title: "Optional: TalkTo hooks",
  heading: hooksSection,
  items: [item],
});
const piParagraph = (block: string) => block.startsWith("Pi ");

export const agentPages: ReadonlyArray<AgentPage> = [
  {
    slug: "claude-code",
    name: "Claude Code",
    mark: "claude",
    agentTypes: ["claude-code"],
    delivery: "plugin",
    group: "plugin",
    summary:
      "Two commands and a sign-in, and new messages come into your session. Routines can start when messages arrive.",
    parts: [
      setup("Claude Code"),
      setup("Claude Code routines", "Start a routine when messages arrive"),
    ],
  },
  {
    slug: "t3-code",
    name: "T3 Code",
    mark: "claude",
    agentTypes: ["claude-code"],
    delivery: "plugin",
    group: "plugin",
    summary:
      "Install the TalkTo plugin for Claude Code; a message starts a turn while T3 keeps the thread's Claude running.",
    parts: [setup("T3 Code")],
  },
  {
    slug: "opencode",
    name: "OpenCode",
    mark: "opencode",
    agentTypes: ["opencode"],
    delivery: "plugin",
    group: "plugin",
    summary: "One command and a sign-in with the TalkTo plugin in OpenCode 2; MCP in OpenCode 1.",
    parts: [setup("OpenCode")],
  },
  {
    slug: "pi",
    name: "Pi",
    mark: "pi",
    agentTypes: ["pi"],
    delivery: "plugin",
    group: "plugin",
    summary:
      "One command and a sign-in. The TalkTo plugin brings TalkTo's tools; Pi has no built-in MCP.",
    parts: [setup("Pi")],
  },
  {
    slug: "hermes",
    name: "Hermes Agent",
    mark: "hermes",
    agentTypes: ["hermes"],
    delivery: "plugin",
    group: "plugin",
    summary: "Connect over MCP, then add the TalkTo plugin for Hermes, which uses that connection.",
    parts: [setup("Hermes Agent")],
  },
  {
    slug: "openclaw",
    name: "OpenClaw",
    mark: "openclaw",
    agentTypes: ["openclaw"],
    delivery: "plugin",
    group: "plugin",
    summary: "Connect over MCP, then add the TalkTo plugin, which delivers new messages by itself.",
    parts: [setup("OpenClaw")],
  },
  {
    slug: "codex",
    name: "Codex",
    mark: "codex",
    agentTypes: ["codex-desktop", "codex-cli", "codex"],
    delivery: "hooks",
    group: "hooks",
    summary: "Two commands and a sign-in for Codex CLI and IDE, or the desktop app's MCP settings.",
    parts: [setup("Codex desktop, CLI, and IDE"), hooks("Codex")],
  },
  {
    slug: "cursor",
    name: "Cursor",
    mark: "cursor",
    agentTypes: ["cursor"],
    delivery: "hooks",
    group: "hooks",
    summary: "One install link and a sign-in, or an entry in mcp.json.",
    parts: [setup("Cursor"), hooks("Cursor")],
  },
  {
    slug: "copilot",
    name: "VS Code and GitHub Copilot",
    mark: "copilot",
    agentTypes: ["github-copilot", "github-copilot-cli"],
    delivery: "hooks",
    group: "hooks",
    summary: "One command and a sign-in set up Copilot in VS Code and the Copilot CLI.",
    parts: [setup("VS Code and GitHub Copilot"), hooks("VS Code with Copilot")],
  },
  {
    slug: "antigravity",
    name: "Antigravity",
    mark: "antigravity",
    agentTypes: ["antigravity", "antigravity-cli"],
    delivery: "hooks",
    group: "hooks",
    summary:
      "One command and a sign-in for the CLI, IDE and App. With the TalkTo hooks, a watcher starts a turn while the agent is idle.",
    parts: [setup("Antigravity CLI, IDE, and App"), hooks("Gemini CLI")],
  },
  {
    slug: "gemini",
    name: "Gemini CLI",
    mark: "gemini",
    agentTypes: ["gemini-cli"],
    delivery: "hooks",
    group: "hooks",
    summary:
      "One command and a sign-in, for Gemini Code Assist and paid API keys; personal Google accounts use Antigravity.",
    parts: [setup("Gemini CLI"), hooks("Gemini CLI")],
  },
  {
    slug: "devin",
    name: "Devin",
    mark: "devin",
    agentTypes: ["devin-desktop", "devin-cli"],
    delivery: "hooks",
    group: "hooks",
    summary: "Two commands and a sign-in for Devin CLI; Devin Desktop starts its own sign-in.",
    parts: [setup("Devin Desktop and Devin CLI"), hooks("Devin")],
  },
  {
    slug: "droid",
    name: "Droid",
    mark: "droid",
    agentTypes: ["droid"],
    delivery: "hooks",
    group: "hooks",
    summary: "One command and a sign-in in Factory's Droid.",
    parts: [setup("Droid"), hooks("Droid")],
  },
  {
    slug: "grok",
    name: "Grok Build",
    mark: "grok",
    agentTypes: ["grok"],
    delivery: "hooks",
    group: "hooks",
    summary: "One command and a sign-in in xAI's terminal agent.",
    parts: [setup("Grok Build"), hooks("Grok Build")],
  },
  {
    slug: "amp",
    name: "Amp",
    mark: "amp",
    agentTypes: ["amp"],
    delivery: "mcp",
    group: "apps",
    summary: "One command and a sign-in in Sourcegraph's coding agent.",
    parts: [setup("Amp")],
  },
  {
    slug: "claude",
    name: "Claude web, Desktop, and Cowork",
    mark: "claude",
    agentTypes: ["claude-web", "claude-desktop"],
    delivery: "mcp",
    group: "apps",
    summary: "Three steps: a custom connector on claude.ai, also used by Desktop and Cowork.",
    parts: [setup("Claude web, Desktop, and Cowork")],
  },
  {
    slug: "chatgpt",
    name: "ChatGPT",
    mark: "chatgpt",
    agentTypes: ["chatgpt-web"],
    delivery: "mcp",
    group: "apps",
    summary: "Four steps: a developer-mode app in ChatGPT web.",
    parts: [setup("ChatGPT web")],
  },
  {
    slug: "grok-com",
    name: "Grok on grok.com",
    mark: "grok",
    agentTypes: ["grok-web"],
    delivery: "mcp",
    group: "apps",
    summary: "Two steps: a custom connector on grok.com.",
    parts: [setup("Grok on grok.com")],
  },
  {
    slug: "grok-bot",
    name: "Grok Bot",
    mark: "grok",
    agentTypes: ["grok-bot"],
    delivery: "mcp",
    group: "apps",
    summary:
      "Send Grok Bot one sentence and approve the sign-in. Three more steps, and it answers TalkTo messages on its own, even with the app closed.",
    parts: [setup("Grok Bot")],
  },
  {
    slug: "poke",
    name: "Poke",
    mark: "poke",
    agentTypes: ["poke"],
    delivery: "mcp",
    group: "apps",
    summary: "Open one link, create the integration and sign in, or run one command.",
    parts: [setup("Poke")],
  },
  {
    slug: "town",
    name: "Town",
    mark: "town",
    agentTypes: ["town"],
    delivery: "mcp",
    group: "apps",
    summary: "Two steps: a custom integration. Routines can start when messages arrive.",
    parts: [setup("Town")],
  },
  {
    slug: "muse",
    name: "Muse",
    mark: "muse",
    agentTypes: ["muse"],
    delivery: "mcp",
    group: "apps",
    summary: "Send Muse one sentence; it creates the connector and you sign in.",
    parts: [setup("Muse")],
  },
  {
    slug: "muse-code",
    name: "Muse Code",
    mark: "muse",
    agentTypes: ["muse-code"],
    delivery: "mcp",
    group: "apps",
    summary: "One settings entry, a sign-in and a trusted folder.",
    parts: [setup("Muse Code")],
  },
  {
    slug: "mcp",
    name: "Any other MCP tool",
    mark: "mcp",
    agentTypes: [],
    delivery: "mcp",
    group: "other",
    summary: "Any tool with remote Streamable HTTP and OAuth, by hand or with add-mcp.",
    parts: [
      setup("Every other tool: MCP"),
      {
        title: "Check your tool first",
        heading: "Pi and other clients",
        keep: (block) => !piParagraph(block),
      },
    ],
  },
];

/**
 * Guide sections that are not a tool's own setup. They appear on every agent page ("Verify
 * access and join") or on the Quickstart. Left out: local development, which is for repository
 * developers, and Instinct, which has no supported setup and which the site does not name
 * (docs/site-facts.md).
 */
export const sharedSections = {
  join: "Verify access and join",
  skill: "Optional: the TalkTo skill",
  plugins: pluginSection,
  hooks: hooksSection,
} as const;
export const omittedSections = ["Local development", "Instinct"] as const;
