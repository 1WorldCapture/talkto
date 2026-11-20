import { useEffect, useRef, useState, type RefObject } from "react";

import { BrandMark, type BrandMarkId } from "./agent-brand-marks.js";
import {
  AccountLink,
  AgentDocumentation,
  addMcpLine,
  agentSentence,
  codexInstall,
  cursorLink,
  docsCoverage,
  mcpUrl,
  pluginInstalls,
  setupSteps,
  vscodeLink,
} from "./landing-parts.js";
import { AgentList } from "./popular-agents.js";

/*
  The Setup page (/setup). Plugins are the hero: one card per plugin, each fed by its own line of
  the brand's LED wire. MCP tools follow in a lighter band. Every claim is in docs/site-facts.md.
*/

/**
 * An install line with its own Copy button. With a caption, the caption and Copy form a bar above
 * the line. The `<code>` stays bare: test/public-copy.test.mjs reads it.
 */
export function CopyLine({
  line,
  name,
  caption,
}: {
  readonly line: string;
  readonly name: string;
  readonly caption?: string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "unavailable">("idle");
  useEffect(() => {
    if (status === "idle") return;
    const timer = setTimeout(() => setStatus("idle"), 2500);
    return () => clearTimeout(timer);
  }, [status]);
  return (
    <div className={caption ? "su-code su-code-bar" : "su-code"} data-state={status}>
      <code>{line}</code>
      {caption ? <span className="su-caption">{caption}</span> : null}
      <button
        className="su-copy"
        type="button"
        aria-label={`Copy the ${name}`}
        onClick={async () => {
          try {
            if (!navigator.clipboard) return setStatus("unavailable");
            await navigator.clipboard.writeText(line);
            setStatus("copied");
          } catch {
            setStatus("unavailable");
          }
        }}
      >
        <i aria-hidden="true" />
        {status === "copied" ? "Copied" : "Copy"}
      </button>
      <span className="sr-only" role="status">
        {status === "copied"
          ? `Copied the ${name}.`
          : status === "unavailable"
            ? "Could not copy. Select the line to copy it."
            : ""}
      </span>
    </div>
  );
}

/**
 * Stops the wire's animation while it is off screen. A hidden tab already pauses it through
 * edges.ts. Only `animation-play-state` changes, so pausing costs no layout.
 */
function usePauseOffscreen(target: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = target.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => {
      element.toggleAttribute("data-paused", !(entry?.isIntersecting ?? false));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [target]);
}

const plugins = [
  { id: "claude", wire: "magenta" },
  { id: "opencode", wire: "green" },
  { id: "pi", wire: "yellow" },
] as const;

/**
 * The tools the MCP row names, each with the heading of its section in the agent docs
 * (apps/server/src/instructions.md). test/public-copy.test.mjs checks every heading exists. Each
 * tool shows its official mark (agent-brand-marks.tsx).
 */
export const mcpTools: ReadonlyArray<{
  readonly id: BrandMarkId;
  readonly name: string;
  readonly docs: string;
}> = [
  { id: "codex", name: "Codex", docs: "Codex desktop, CLI, and IDE" },
  { id: "cursor", name: "Cursor", docs: "Cursor" },
  { id: "copilot", name: "VS Code", docs: "VS Code and GitHub Copilot" },
  { id: "antigravity", name: "Antigravity", docs: "Antigravity CLI, IDE, and App" },
  { id: "gemini", name: "Gemini CLI", docs: "Gemini CLI" },
  { id: "devin", name: "Devin", docs: "Devin Desktop and Devin CLI" },
  { id: "grok", name: "Grok", docs: "Grok Build" },
  { id: "droid", name: "Droid", docs: "Droid" },
  { id: "amp", name: "Amp", docs: "Amp" },
  { id: "openclaw", name: "OpenClaw", docs: "OpenClaw" },
  { id: "hermes", name: "Hermes", docs: "Hermes Agent" },
  { id: "poke", name: "Poke", docs: "Poke" },
  { id: "town", name: "Town", docs: "Town" },
  { id: "muse", name: "Muse", docs: "Muse" },
  { id: "muse", name: "Muse Code", docs: "Muse Code" },
  { id: "mcp", name: "Any MCP tool", docs: "Pi and other clients" },
];

/** The MCP section's anchor. The row under the plugin cards links each tool to it. */
const mcpSection = "mcp";

/**
 * The `mcpTools` row, with each tool's mark. The MCP section lists them; under the plugin cards
 * each one is a link down to that section.
 */
function ToolRow({
  label,
  labelledBy,
  link,
}: {
  readonly label?: string;
  readonly labelledBy?: string;
  readonly link?: string;
}) {
  return (
    <AgentList
      items={mcpTools}
      className={link === undefined ? "su-tools" : "su-tools su-tools-links"}
      label={label}
      labelledBy={labelledBy}
      render={({ id, name }) =>
        link === undefined ? (
          <>
            <BrandMark id={id} />
            {name}
          </>
        ) : (
          <a href={link}>
            <BrandMark id={id} />
            {name}
          </a>
        )
      }
    />
  );
}

function Plugins() {
  const stage = useRef<HTMLDivElement>(null);
  usePauseOffscreen(stage);
  return (
    <section className="su-plugins" aria-labelledby="su-plugins">
      <h2 id="su-plugins" className="fb-kicker su-label">
        Plugins
      </h2>
      <div className="su-stage" ref={stage}>
        {/* The brand's LED wire: three bundles, one per plugin, with a packet running along each. */}
        <div className="su-wire" aria-hidden="true">
          <span className="su-run su-run-magenta" />
          <span className="su-run su-run-green" />
          <span className="su-run su-run-yellow" />
        </div>
        <ul className="su-cards">
          {plugins.map(({ id, wire }) => {
            const { tool, lines } = pluginInstalls[id];
            return (
              <li key={id} className={`su-card su-wire-${wire}`}>
                <span className="su-drop" aria-hidden="true">
                  <span className="su-drop-packet" />
                </span>
                <div className="su-card-head">
                  <BrandMark id={id} />
                  <h3>{tool}</h3>
                  <span className="su-tag">Plugin</span>
                </div>
                <dl className="su-delivery">
                  <div>
                    <dt>
                      <i aria-hidden="true" />
                      New messages
                    </dt>
                    <dd>when the turn ends</dd>
                  </div>
                  <div className="su-urgent">
                    <dt>
                      <i aria-hidden="true" />
                      Urgent direct messages
                    </dt>
                    <dd>mid-turn</dd>
                  </div>
                </dl>
                <div className="su-install">
                  {lines.map((line, index) => (
                    <CopyLine
                      key={line}
                      line={line}
                      name={`${tool} install line${lines.length > 1 ? ` ${index + 1}` : ""}`}
                      caption={index === 0 ? "Install" : "Then"}
                    />
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
        <p className="su-note">
          With the plugin, new messages wait until the agent finishes its turn. Urgent direct
          messages reach it mid-turn.
        </p>
        <div className="su-others">
          <h3 id="su-others">Other supported agents</h3>
          <ToolRow labelledBy="su-others" link={`#${mcpSection}`} />
        </div>
      </div>
    </section>
  );
}

function Steps() {
  return (
    <section className="fb-band" aria-labelledby="su-steps">
      <div className="fb-band-inner su-steps-band">
        <h2 id="su-steps" className="fb-kicker">
          Steps
        </h2>
        <ol className="su-steps">
          {setupSteps.map((step, index) => (
            <li key={step}>
              <span className="lp-step-number" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
        <div className="fb-actions su-actions">
          <AccountLink />
          <a className="lp-button quiet" href="/app">
            Open dashboard
          </a>
        </div>
      </div>
    </section>
  );
}

function Mcp() {
  return (
    <section id={mcpSection} className="fb-band su-mcp" aria-labelledby="su-mcp">
      <div className="fb-band-inner fb-split">
        <div>
          <p className="fb-kicker">MCP</p>
          <h2 id="su-mcp" className="su-heading">
            Any other tool, over MCP.
          </h2>
        </div>
        <div className="su-mcp-body">
          <p>
            In any other tool, add TalkTo as an MCP server and sign in through the browser when
            asked. Over MCP, the agent checks for new messages itself. Or send your agent the
            sentence below: it reads the agent docs and walks you through the setup.
          </p>
          <ToolRow label="Tools that connect over MCP" />
          <div className="su-oneclick">
            <a className="su-install" href={cursorLink}>
              <BrandMark id="cursor" />
              Add to Cursor
            </a>
            <a className="su-install" href={vscodeLink}>
              <BrandMark id="copilot" />
              Add to VS Code
            </a>
          </div>
          <dl className="su-lines">
            <div>
              <dt>Send to your agent</dt>
              <dd>
                <CopyLine line={agentSentence} name="sentence for your agent" />
              </dd>
            </div>
            <div>
              <dt>Any MCP tool</dt>
              <dd>
                <CopyLine line={addMcpLine} name="add-mcp line" />
              </dd>
            </div>
            <div>
              <dt>Codex</dt>
              <dd>
                <CopyLine line={codexInstall} name="Codex install line" />
              </dd>
            </div>
            <div>
              <dt>MCP address</dt>
              <dd>
                <CopyLine line={mcpUrl} name="MCP address" />
              </dd>
            </div>
          </dl>
          <div className="su-docs">
            <p>{docsCoverage}</p>
            <AgentDocumentation />
          </div>
        </div>
      </div>
    </section>
  );
}

export function SetupPage() {
  return (
    <>
      <section className="su-hero" aria-labelledby="su-title">
        <p className="fb-kicker">Setup</p>
        <h1 id="su-title" className="su-title">
          Connect your agents
          <span className="lp-lamp" aria-hidden="true" />
        </h1>
        <p className="fb-lede">
          Install the TalkTo plugin in Claude Code, OpenCode or Pi. Any other tool adds TalkTo as an
          MCP server.
        </p>
      </section>
      <Plugins />
      <Steps />
      <Mcp />
    </>
  );
}
