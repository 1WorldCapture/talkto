/*
  Writes the docs pages that come from code, before Astro reads its content:

  - src/content/docs/agents/*.md: one page per agent, cut from the agent guide (instructions.md).
  - src/content/docs/agents/index.mdx: the agents index, from `agentPages`.
  - src/content/docs/api/<area>.md: the HTTP API reference, written by src/api-reference.ts
    (called from astro.config.ts, since it loads the API contracts through Vite).
  - src/content/partials/generated/*.md: the join steps, the skill, the install
    lines, the plan table, the free trial offer and the update steps, which hand-written pages
    include with <Render />.

  Generated files are not committed (see .gitignore). Page-specific text lives in the hand-written
  pages under src/content/docs/, and in src/agent-notes/<slug>.md for an agent page that needs a
  note above its steps (none does now: each guide section opens with its own summary).
*/
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  addMcpCommand,
  hookUpdates,
  mcpEndpoint,
  pluginUpdates,
  setupSentence,
  type UpdateGuide,
} from "@talkto/api/documentation";
import { findAgentGuide, runsCommands } from "@talkto/api/agent-guides";
import {
  alwaysOnAgentReads,
  archiveAfterDays,
  daysLabel,
  deepReadUnits,
  free,
  history,
  historyGigabytes,
  historyGraceDays,
  historyLabel,
  memoryMetering,
  plans,
  readsLabel,
  renewalWeight,
  serverHistoryGigabytes,
  starter,
  storageGigabytes,
  storageLabel,
  taskOperations,
} from "@talkto/api/pricing";
import { freePublished, starterPublished } from "./starter.ts";
import {
  agentGroups,
  agentPages,
  deliveryLines,
  sharedSections,
  type AgentPage,
  type PagePart,
} from "./agents.ts";
import {
  blocks,
  connectSections,
  listItems,
  readGuide,
  siteOrigin,
  type GuideSection,
} from "./guide.ts";

const yaml = (value: string) => JSON.stringify(value);

/** The guide's sentence on when its setups were checked against each tool's docs. Pages omit it. */
const isCheckedSentence = (block: string) =>
  block.includes("setups were checked against each tool's documentation");

function section(sections: ReadonlyArray<GuideSection>, heading: string): GuideSection {
  const found = sections.find((candidate) => candidate.heading === heading);
  if (found === undefined) throw new Error(`instructions.md has no "### ${heading}" section`);
  return found;
}

/**
 * The guide points to its own sections ("see \"Keep up while working\""). A page cut from it
 * may not contain them, so each reference becomes a link to the page that does.
 */
const guideReferences: ReadonlyArray<readonly [RegExp, string]> = [
  [/"Keep up while working"( below)?/g, "[Delivery](/concepts/delivery/)"],
  [/"Hermes Agent" below/g, "[Hermes Agent](/agents/hermes/)"],
  [/"OpenClaw" below/g, "[OpenClaw](/agents/openclaw/)"],
  [/"Claude Code" above/g, "[Claude Code](/agents/claude-code/)"],
  [/"Codex desktop, CLI, and IDE"/g, "[Codex](/agents/codex/)"],
  [/"Antigravity CLI, IDE, and App" below/g, "[Antigravity](/agents/antigravity/)"],
];
export function linkGuideReferences(text: string): string {
  return guideReferences.reduce((result, [pattern, link]) => result.replace(pattern, link), text);
}

function partBody(sections: ReadonlyArray<GuideSection>, part: PagePart): string {
  const kept = blocks(section(sections, part.heading).body)
    .filter((block) => !isCheckedSentence(block))
    .filter((block) => part.keep?.(block) ?? true)
    .flatMap((block) => {
      if (part.items === undefined || !block.startsWith("- ")) return [block];
      const items = listItems(block, part.items);
      return items.length === 0 ? [] : [items.join("\n")];
    });
  return linkGuideReferences(kept.join("\n\n"));
}

/** Which `agentType` this tool registers with, from the guide's "Access and identity" section. */
function agentTypeLine(types: ReadonlyArray<string>): string {
  const codes = types.map((type) => `\`${type}\``);
  if (codes.length === 1) return `When you register, set \`agentType\` to ${codes.join("")}.`;
  const list = `${codes.slice(0, -1).join(", ")} or ${codes.slice(-1).join("")}`;
  return `When you register, set \`agentType\` to ${list}, the most specific one you know.`;
}

/**
 * Whether the agent sets itself up from the setup sentence: its dashboard recipe has a step the
 * agent runs, or it is an app whose agent adds TalkTo itself when asked (Grok Bot, Muse). Other app
 * tools (the Claude app, ChatGPT and others) need the person to add TalkTo first. A page without a
 * recipe of its own keeps the sentence first.
 */
const selfInstalls = (slug: string): boolean => {
  const guide = findAgentGuide(slug);
  return (
    guide === null ||
    guide.addsItself === true ||
    runsCommands(guide.setup(mcpEndpoint(siteOrigin)))
  );
};

function agentMarkdown(
  sections: ReadonlyArray<GuideSection>,
  page: AgentPage,
  order: number,
  notes: string | null,
): string {
  const addsItself = findAgentGuide(page.slug)?.addsItself === true;
  const selfInstalled = selfInstalls(page.slug);
  return [
    "---",
    `title: ${yaml(`Connect ${page.name} to TalkTo`)}`,
    `description: ${yaml(page.summary)}`,
    "sidebar:",
    `  label: ${yaml(page.name)}`,
    `  order: ${order}`,
    `agent: ${yaml(page.slug)}`,
    "---",
    "",
    // The summary is the page description, shown under the title. Where the agent can run its own
    // install, or adds TalkTo itself in its app, the body offers that first (one sentence to the
    // agent), then the steps. In an app the person adds TalkTo, as the dashboard says, and the
    // sentence only joins a server.
    ...(addsItself
      ? [`Send this to ${page.name}, and it adds TalkTo itself:`]
      : selfInstalled
        ? ["Send this to your agent, and it sets itself up:"]
        : [
            `In ${page.name}, you add TalkTo yourself: do the steps below. Then send your agent this, and it joins your server:`,
          ]),
    "",
    "```text",
    setupSentence(siteOrigin),
    "```",
    "",
    addsItself
      ? `You approve the sign-in, and it joins your server under its own name. The steps below go through it. TalkTo's MCP endpoint is \`${mcpEndpoint(siteOrigin)}\`.`
      : selfInstalled
        ? `Or follow the steps below yourself. TalkTo's MCP endpoint is \`${mcpEndpoint(siteOrigin)}\`.`
        : `TalkTo's MCP endpoint is \`${mcpEndpoint(siteOrigin)}\`.`,
    "",
    ...(notes === null ? [] : [notes.trim(), ""]),
    ...page.parts.flatMap((part) => [`## ${part.title}`, "", partBody(sections, part), ""]),
    "## Join a server",
    "",
    `Once TalkTo is connected, send your agent the sentence at the top of this page, if you have not yet. It asks which server to join when that is not clear, and joins under its own name. ${deliveryLines[page.delivery]}`,
    "",
    "What the agent does:",
    "",
    section(sections, sharedSections.join).body,
    "",
    ...(page.agentTypes.length === 0 ? [] : [agentTypeLine(page.agentTypes), ""]),
    "## Go deeper",
    "",
    "- [Delivery: queued and urgent messages](/concepts/delivery/)",
    "- [Troubleshooting](/troubleshooting/)",
    `- [The full agent guide](${siteOrigin}/instructions), the same text agents get from TalkTo over MCP`,
    "",
  ].join("\n");
}

function agentsIndex(): string {
  return [
    "---",
    "title: Agents",
    `description: ${yaml("Connect each coding agent and chat app to TalkTo.")}`,
    "sidebar:",
    "  label: All agents",
    "  order: 0",
    "  group:",
    "    label: Agents",
    "---",
    "",
    "Pick the tool your agent runs in. Each page has the setup for that tool, the sentence to send your agent, and the steps to join a server. Agents that read Markdown can fetch any page with `index.md` at the end of its address.",
    "",
    ...agentGroups.flatMap((group) => [
      `## ${group.title}`,
      "",
      `<AgentGrid group="${group.id}">`,
      "",
      ...agentPages
        .filter((page) => page.group === group.id)
        .map((page) => `- [${page.name}](/agents/${page.slug}/): ${page.summary}`),
      "",
      "</AgentGrid>",
      "",
    ]),
  ].join("\n");
}

/**
 * Install lines in the guide's plugin section, as "- Claude Code: `…`, then `…`" items: each item's
 * leading commands, without the pointer to the tool's own section.
 */
function installMarkdown(sections: ReadonlyArray<GuideSection>): string {
  const items = blocks(section(sections, sharedSections.plugins).body)
    .filter((block) => block.startsWith("- "))
    .flatMap((block) => block.split("\n"))
    .flatMap((line) => {
      const match = /^- ([^:]+): (`[^`]+`(?:, then `[^`]+`)*)/.exec(line);
      return match?.[1] === undefined || match[2] === undefined
        ? []
        : [`- ${match[1]}: ${match[2]}`];
    });
  return [
    ...items,
    `- Any MCP tool: \`${addMcpCommand(mcpEndpoint(siteOrigin))}\`, then sign in from each tool`,
  ].join("\n");
}

/**
 * The free trial, or the Free plan that replaces it, said only once it is live: `starterPublished`
 * and `freePublished` follow the production switches (src/starter.ts). Same words as the public
 * site (docs/site-facts.md, 49 to 52 and 64).
 */
export function starterMarkdown(
  published: boolean = starterPublished,
  freePlan: boolean = freePublished,
): string | null {
  if (!published) return null;
  if (freePlan) {
    const monthly = free.messages.toLocaleString("en-US");
    return [
      `**Free plan: ${monthly} messages a month.** No credit card.`,
      "",
      `One server and one person, once per person. The ${monthly} messages are shared by your organization and start again each month. ${history.free.days} days of message history. ${storageLabel(free.storageGigabytes)} of file storage and ${readsLabel("free")}. When the messages run out, sending pauses until next month or until you choose a plan. Nothing is charged automatically.`,
    ].join("\n");
  }
  const messages = starter.messages.toLocaleString("en-US");
  return [
    `**Free trial: ${messages} messages.** No credit card. No time limit.`,
    "",
    `One starter server, once per person. The ${messages} messages are shared by your organization and do not refill. When they run out, sending pauses until you choose a plan. Nothing is charged automatically. Leftover messages carry over when you choose a plan.`,
  ].join("\n");
}

/** The plan table, preceded by the free trial when it is live. */
export function plansMarkdown(
  published: boolean = starterPublished,
  freePlan: boolean = freePublished,
): string {
  const offer = starterMarkdown(published, freePlan);
  return offer === null ? planTable() : `${offer}\n\n${planTable()}`;
}

const planKeys = ["shop", "studio", "factory"] as const;
const count = (value: number) => value.toLocaleString("en-US");

function planTable(): string {
  const rows = planKeys.map((key) => {
    const plan = plans[key];
    const people = plan.peopleLimit === null ? "Unlimited" : `Up to ${plan.peopleLimit}`;
    return `| ${plan.name} | $${plan.monthlyCents / 100} | ${count(plan.messages)} messages | ${readsLabel(key)} | ${storageLabel(storageGigabytes[key])} storage | ${historyLabel(key)} | ${people} | Unlimited |`;
  });
  return [
    "Flat monthly price per organization. Not per seat.",
    "",
    "| Plan | Per month (USD) | Messages per month | Reads per month | Storage | History | People | Agents |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    `Older messages are deleted, oldest first; each conversation keeps its newest message. Factory moves messages older than ${daysLabel(archiveAfterDays)} to an archive that people and agents with access to the server can still read (\`GET /v1/servers/{serverId}/archive\`). When an organization moves to a plan that keeps less history, the shorter limit starts ${historyGraceDays} days later.`,
    "",
    `An always-on agent reads about ${count(alwaysOnAgentReads.low)} to ${count(alwaysOnAgentReads.high)} times a month. A search, a timeline or an archive read counts as ${deepReadUnits} reads. After the month's reads, agents keep receiving, more slowly. History kept in place is also capped in size: ${historyGigabytes.shop} GB on Shop, ${historyGigabytes.studio} GB on Studio, ${historyGigabytes.factory} GB on Factory and ${serverHistoryGigabytes} GB per server. See [Limits](/concepts/limits/).`,
  ].join("\n");
}

/** "1 every 10 minutes" or "1 a minute": a slow lane in operations a minute. */
const slowLane = (perMinute: number) =>
  perMinute >= 1
    ? `${count(perMinute)} a minute`
    : `1 every ${count(Math.round(1 / perMinute))} minutes`;

/**
 * Task operations and memory edits per plan (owner, November 25, 2026), for Limits and the swarm
 * reference: every number from `taskOperations`, `renewalWeight` and `memoryMetering`.
 */
export function taskLimitsMarkdown(): string {
  const rows = (["free", ...planKeys] as const).map((key) => {
    const name = key === "free" ? "Monthly allowance, no card" : plans[key].name;
    const task = taskOperations[key];
    return `| ${name} | ${count(task.monthly)} | ${slowLane(task.slowPerMinute)} | ${count(memoryMetering.editsMonthly[key])} |`;
  });
  // A weight of one part names its fraction; another weight fails to typecheck until named here.
  const fractions = { 3: "a third", 5: "a fifth" } as const;
  const weight = fractions[renewalWeight.of];
  // Claiming and completing are whole operations; each of the two renewals is the weight.
  const perTask = 2 + (2 * renewalWeight.parts) / renewalWeight.of;
  return [
    "| Plan | Task operations per month | After the month's task operations | Memory edits per month |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    `Every \`create_tasks\`, \`claim_task\` and \`update_task\` call counts one task operation, including a claim that finds nothing and a call that is refused. A lease renewal (\`update_task\` with \`progress\` and no note) counts ${weight} of one. A worker that claims a task, renews its lease twice and completes it uses ${count(perTask)} task operations. After the month's task operations, task calls go through the slow lane above for the whole organization until the month resets. A memory edit is a new commit on a swarm's memory; each also counts as ${memoryMetering.commitMessages === 1 ? "one message" : `${memoryMetering.commitMessages} messages`}. After the month's memory edits, memory is read-only until the month resets.`,
  ].join("\n");
}

/** One host's update steps: the commands, what follows them, and automatic updates. */
function updateGuide(guide: UpdateGuide, level: "###" | "####"): string {
  return [
    `${level} ${guide.heading}`,
    ...(guide.commands.length === 0 ? [] : [["```sh", ...guide.commands, "```"].join("\n")]),
    guide.then,
    `**Automatic updates:** ${guide.autoUpdate}`,
  ].join("\n\n");
}

/** The updates page's "Updating your agents" steps, from packages/api/src/documentation.ts. */
export function updatingMarkdown(): string {
  return [
    ...pluginUpdates.map((guide) => updateGuide(guide, "###")),
    "### TalkTo hooks",
    "The hooks come from the same repository. Update them in the tool that runs them. Where a step says `<clone>`, use the folder where you cloned talkto-sh/talkto-plugin.",
    ...hookUpdates.map((guide) => updateGuide(guide, "####")),
  ].join("\n\n");
}

function write(path: URL, content: string) {
  mkdirSync(new URL(".", path), { recursive: true });
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  // Rewriting an unchanged file would restart the dev server's content sync for nothing.
  if (current !== content) writeFileSync(path, content);
}

/** Write every generated page and partial. `root` is the docs package directory. */
export function generateContent(root: URL) {
  const guide = readGuide(new URL("../server/src/instructions.md", root));
  const sections = connectSections(guide);
  const agents = new URL("src/content/docs/agents/", root);
  const partials = new URL("src/content/partials/generated/", root);
  const expected = new Set(["index.mdx", ...agentPages.map((page) => `${page.slug}.md`)]);
  if (existsSync(agents))
    for (const name of readdirSync(agents))
      if (!expected.has(name)) rmSync(new URL(name, agents), { force: true });
  agentPages.forEach((page, index) => {
    const notesPath = new URL(`src/agent-notes/${page.slug}.md`, root);
    const notes = existsSync(notesPath) ? readFileSync(notesPath, "utf8") : null;
    write(new URL(`${page.slug}.md`, agents), agentMarkdown(sections, page, index + 1, notes));
  });
  write(new URL("index.mdx", agents), agentsIndex());
  write(new URL("join.md", partials), `${section(sections, sharedSections.join).body}\n`);
  write(new URL("skill.md", partials), `${section(sections, sharedSections.skill).body}\n`);
  write(new URL("install.md", partials), `${installMarkdown(sections)}\n`);
  write(
    new URL("prompt.md", partials),
    ["```text", setupSentence(siteOrigin), "```", ""].join("\n"),
  );
  write(new URL("plans.md", partials), `${plansMarkdown()}\n`);
  write(new URL("task-limits.md", partials), `${taskLimitsMarkdown()}\n`);
  write(new URL("updating.md", partials), `${updatingMarkdown()}\n`);
  // The offer alone, for the FAQ's pricing answer; empty while production does not make it.
  write(new URL("offer.md", partials), `${starterMarkdown() ?? ""}\n`);
}
