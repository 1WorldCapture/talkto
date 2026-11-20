import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { BrandMark } from "./agent-brand-marks.js";
import { installPrompt } from "./agent-prompt.js";
import {
  installGuideUrl,
  runsCommands,
  setupParts,
  type ConnectWay,
} from "@talkto/api/agent-guides";
import {
  agentGuides,
  type AgentGuide,
  type AgentGuideId,
  type AgentSetup,
  type SetupStep,
} from "./landing-parts.js";
import { CopyLine } from "./setup-page.js";
import "./agent-flow.css";

/*
  The parts of connecting an agent, shared by the dashboard's Connect agents dialog
  (agent-connection.tsx) and the invitation join page (join.tsx): the agent grid, the copy prompt,
  the install tabs and steps, and the plain join prompt. Setup (onboarding.tsx) uses its guide
  lookups. The walkthrough that puts them in order, one step at a
  time, is agent-walkthrough.tsx. Setup content comes from agentGuides (@talkto/api/agent-guides),
  checked against the agent guide (test/agent-setup.test.mjs).
*/

/**
 * A selectable prompt with a bottom fade only while more text remains below. With `reveal`, Copy
 * leads and the full text waits behind a disclosure for anyone who wants to read it first.
 */
export function AgentPrompt({
  prompt,
  buttonClassName = "btn",
  reveal = false,
}: {
  readonly prompt: string | null;
  readonly buttonClassName?: string;
  readonly reveal?: boolean;
}) {
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const details = useRef<HTMLDetailsElement>(null);
  const [more, setMore] = useState(false);
  const [copy, setCopy] = useState<{ readonly prompt: string; readonly message: string } | null>(
    null,
  );
  useEffect(() => {
    const element = field.current;
    if (element === null) return;
    const measure = () =>
      setMore(element.scrollHeight - element.clientHeight - element.scrollTop > 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.addEventListener("scroll", measure);
    document.fonts.addEventListener("loadingdone", measure);
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", measure);
      document.fonts.removeEventListener("loadingdone", measure);
    };
  }, [prompt]);
  const copyPrompt = async () => {
    if (prompt === null) return;
    try {
      await navigator.clipboard.writeText(prompt);
      setCopy({ prompt, message: "Copied. Paste into your agent’s chat." });
    } catch {
      // The fallback selects the text, so a folded prompt opens first.
      if (details.current) details.current.open = true;
      field.current?.focus();
      field.current?.select();
      setCopy({ prompt, message: "Press ⌘C or Ctrl+C to copy the selected prompt." });
    }
  };
  const promptField = (
    <>
      <label className="sr-only" htmlFor={id}>
        Agent connection prompt
      </label>
      <div className="agent-prompt-field" data-more={more}>
        <textarea
          ref={field}
          id={id}
          readOnly
          value={prompt ?? "Loading your connection…"}
          aria-describedby={`${id}-status`}
          spellCheck={false}
        />
        <span className="agent-prompt-fade" aria-hidden="true" />
      </div>
    </>
  );
  const copyButton = (
    <button
      className={buttonClassName}
      data-autofocus
      disabled={prompt === null}
      onClick={() => void copyPrompt()}
    >
      Copy prompt
    </button>
  );
  const status = (
    <p id={`${id}-status`} className="agent-prompt-status" role="status">
      {copy?.prompt === prompt ? copy?.message : ""}
    </p>
  );
  if (reveal)
    return (
      <div className="agent-prompt" data-reveal="">
        {copyButton}
        {status}
        <details className="agent-prompt-details" ref={details}>
          <summary>Read the prompt first</summary>
          {promptField}
        </details>
      </div>
    );
  return (
    <div className="agent-prompt">
      {promptField}
      {copyButton}
      {status}
    </div>
  );
}

/** Step text: **bold** names something on screen, `code` is something to type. */
export function Rich({ text }: { readonly text: string }) {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/)
    .map((part, index) =>
      part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
        <strong key={index}>{part.slice(2, -2)}</strong>
      ) : part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
        <code key={index}>{part.slice(1, -1)}</code>
      ) : (
        <Fragment key={index}>{part}</Fragment>
      ),
    );
}

/** What a Copy button copies, for its accessible name ("Copy the …"). */
const lineName = (line: string) =>
  line.startsWith("{") ? "settings entry" : `command “${line.split(" ").slice(0, 3).join(" ")}”`;

export function StepBody({ step, mcpUrl }: { readonly step: SetupStep; readonly mcpUrl: string }) {
  return (
    <>
      <p>
        <Rich text={step.text} />
      </p>
      {step.link && (
        <a className="btn secondary connect-open" href={step.link.href}>
          {step.link.mark && <BrandMark id={step.link.mark} />}
          {step.link.label}
        </a>
      )}
      {step.address && <CopyLine line={mcpUrl} name="TalkTo address" caption="TalkTo address" />}
      {step.lines?.map((line) => (
        <CopyLine key={line} line={line} name={lineName(line)} />
      ))}
    </>
  );
}

export type Guide = AgentGuide & { readonly id: AgentGuideId };

/**
 * The agentType each guide's agent reports, as a hint in the join prompt. `null` leaves the type
 * to the agent: "Another tool" can be anything.
 */
export const guideAgentType: Readonly<Record<AgentGuideId, string | null>> = {
  "claude-code": "claude-code",
  codex: "codex",
  cursor: "cursor",
  chatgpt: "chatgpt",
  claude: "claude",
  copilot: "github-copilot",
  antigravity: "antigravity",
  opencode: "opencode",
  pi: "pi",
  grok: "grok",
  droid: "droid",
  amp: "amp",
  gemini: "gemini-cli",
  devin: "devin",
  openclaw: "openclaw",
  hermes: "hermes",
  "grok-com": "grok-web",
  "grok-bot": "grok-bot",
  "claude-code-routines": "claude-code",
  town: "town",
  poke: "poke",
  muse: "muse",
  "muse-code": "muse-code",
  mcp: null,
};

/** The guide a slot's saved setup names, if it still exists. */
export const findGuide = (id: string | undefined): Guide | null =>
  agentGuides.find((guide) => guide.id === id) ?? null;

/** Where the person pastes a prompt: agents whose chat is not named after the tool get a plain name. */
export const chatName = (guide: Guide | null) =>
  guide === null || guide.id === "mcp" || guide.id === "claude-code-routines"
    ? "your agent’s chat"
    : `your ${guide.name} chat`;

/** The main grid: plugin tools first, one tile per vendor. */
export const commonGuides: ReadonlyArray<Guide> = agentGuides.filter((guide) => guide.common);
/** Under More agents: the rest, including same-vendor variants such as the Claude app. */
export const moreGuides: ReadonlyArray<Guide> = agentGuides.filter((guide) => !guide.common);

/**
 * Which agent: the common tools, nothing picked until the person picks. The rest wait in their own
 * grid under More agents, so a same-vendor app never sits beside its plugin tool.
 */
export function AgentGrid({
  chosen,
  busy,
  choose,
}: {
  readonly chosen: AgentGuideId | null;
  readonly busy: boolean;
  readonly choose: (guide: Guide) => void;
}) {
  const id = useId();
  const [more, setMore] = useState(() => chosen !== null && !(findGuide(chosen)?.common ?? false));
  const tiles = (guides: ReadonlyArray<Guide>) =>
    guides.map((guide) => (
      <button
        key={guide.id}
        type="button"
        className="agent-pick"
        aria-pressed={chosen === guide.id}
        aria-disabled={busy}
        onClick={busy ? undefined : () => choose(guide)}
      >
        <BrandMark id={guide.mark} />
        <span className="agent-pick-name">{guide.name}</span>
        <span className="agent-pick-how">{guide.how}</span>
      </button>
    ));
  return (
    <>
      <div className="agent-grid" role="group" aria-label="Agents">
        {tiles(commonGuides)}
      </div>
      <p className="agent-more">
        <button
          type="button"
          className="inline-link"
          aria-expanded={more}
          aria-controls={`${id}-more`}
          onClick={() => setMore(!more)}
        >
          {more ? "Hide more agents" : `More agents (${moreGuides.length})`}
        </button>
      </p>
      <div
        id={`${id}-more`}
        className="agent-grid"
        role="group"
        aria-label="More agents"
        hidden={!more}
      >
        {tiles(moreGuides)}
      </div>
    </>
  );
}

/** Two tabs: the agent installs itself, or the person runs the same commands. */
export function InstallTabs({
  guide,
  setup,
  mcpUrl,
  buttonClassName,
}: {
  readonly guide: Guide;
  readonly setup: AgentSetup;
  readonly mcpUrl: string;
  readonly buttonClassName: string;
}) {
  const id = useId();
  const [tab, setTab] = useState<"prompt" | "manual">("prompt");
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const { install, signIn, recommended } = setupParts(setup);
  const yours = [...signIn, ...recommended];
  const prompt = installPrompt({
    tool: guide.name,
    url: installGuideUrl(new URL(mcpUrl).origin, guide.id),
    commands: setup.steps.flatMap((step) => (step.by === "agent" ? (step.lines ?? []) : [])),
    yours: yours.map((step) =>
      step.lines ? `${step.text} ${step.lines.map((line) => `\`${line}\``).join(" ")}` : step.text,
    ),
  });
  const labels = { prompt: "Copy prompt", manual: "Manual install" } as const;
  const order = ["prompt", "manual"] as const;
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = tab === "prompt" ? "manual" : "prompt";
    setTab(next);
    tabs.current[order.indexOf(next)]?.focus();
  };
  return (
    <>
      <div className="install-tabs" role="tablist" aria-label="How to install" onKeyDown={keys}>
        {order.map((value, index) => (
          <button
            key={value}
            ref={(element) => {
              tabs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${id}-${value}-tab`}
            aria-controls={`${id}-${value}`}
            aria-selected={tab === value}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
          >
            {labels[value]}
          </button>
        ))}
      </div>
      {tab === "prompt" ? (
        <div role="tabpanel" id={`${id}-prompt`} aria-labelledby={`${id}-prompt-tab`}>
          <p className="setup-lead">
            Paste this into a {guide.name} session. {guide.name} reads TalkTo’s install guide and
            runs it in its own terminal.
          </p>
          <AgentPrompt prompt={prompt} buttonClassName={buttonClassName} />
        </div>
      ) : (
        <div role="tabpanel" id={`${id}-manual`} aria-labelledby={`${id}-manual-tab`}>
          <p className="setup-lead">Manual install: run these yourself, in order.</p>
          <Steps steps={install} mcpUrl={mcpUrl} />
        </div>
      )}
    </>
  );
}

export function Steps({
  steps,
  mcpUrl,
  start,
}: {
  readonly steps: ReadonlyArray<SetupStep>;
  readonly mcpUrl: string;
  /** The first number, when this list continues another one. */
  readonly start?: number;
}) {
  return (
    <ol
      className="connect-steps setup-steps"
      start={start}
      // The numbers are drawn from a CSS counter, which ignores `start`.
      style={start === undefined ? undefined : { counterReset: `connect-step ${start - 1}` }}
    >
      {steps.map((step) => (
        <li key={step.text}>
          <div>
            <StepBody step={step} mcpUrl={mcpUrl} />
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * One numbered step of the flow: install, sign in, join, then the optional wake. Each is as
 * prominent as the others, so the person's own sign-in is never a footnote.
 */
export function FlowStep({
  number,
  title,
  tag,
  level,
  tone,
  children,
}: {
  readonly number: number;
  readonly title: ReactNode;
  /** A short word after the title: Required, Optional. */
  readonly tag?: string;
  /** The heading level in this surface: 2 under onboarding's h1, 4 under the dialog's h3. */
  readonly level: number;
  /** `you` marks a step only the person can do. */
  readonly tone?: "you";
  readonly children: ReactNode;
}) {
  return (
    <section className="flow-step" data-tone={tone}>
      <p className="flow-step-title" role="heading" aria-level={level}>
        <span className="flow-step-number" aria-hidden="true">
          {number}
        </span>
        <span>
          <span className="sr-only">Step {number}: </span>
          {title}
        </span>
        {tag && <span className="flow-step-tag">{tag}</span>}
      </p>
      {children}
    </section>
  );
}

/**
 * The join step: the short prompt for the agent's chat, then a reminder of the sign-in step for
 * the usual reason a join fails, an agent that has no TalkTo tools yet. `stress` raises the
 * reminder, for when the agent still has not joined.
 */
export function JoinStep({
  guide,
  mcpUrl,
  serverName,
  prompt,
  copyClassName,
  level,
  reveal = false,
  stress = false,
  children,
}: {
  readonly guide: Guide | null;
  readonly mcpUrl: string | null;
  readonly serverName: string;
  readonly prompt: string | null;
  readonly copyClassName: string;
  readonly level: number;
  readonly reveal?: boolean;
  readonly stress?: boolean;
  /** What follows the prompt in this surface, such as onboarding's waiting line. */
  readonly children?: ReactNode;
}) {
  const setup = guide === null || mcpUrl === null ? null : guide.setup(mcpUrl);
  const signIn = setup === null ? [] : setupParts(setup).signIn;
  const where =
    guide !== null && setup !== null && runsCommands(setup)
      ? `a ${guide.name} session`
      : chatName(guide);
  const number = joinNumber(guide, mcpUrl);
  return (
    <div className="agent-setup">
      <FlowStep number={number} title={`Join ${serverName}`} level={level}>
        <p className="setup-lead">Paste this into {where}. It picks its own name.</p>
        <AgentPrompt prompt={prompt} buttonClassName={copyClassName} reveal={reveal} />
        {children}
        {guide !== null && mcpUrl !== null && (
          <div className="flow-reminder" data-stress={stress} role="note">
            <p>
              <strong>Says it has no TalkTo tools, or asks you to sign in?</strong>{" "}
              {signIn.length > 0
                ? `Do step 2 in ${guide.name}, then paste the prompt again:`
                : `Finish the ${guide.name} steps first, then paste the prompt again.`}
            </p>
            {signIn.length > 0 && <Steps steps={signIn} mcpUrl={mcpUrl} />}
          </div>
        )}
      </FlowStep>
    </div>
  );
}

/** The join step's number: after install, and after sign-in where the person signs in. */
export const joinNumber = (guide: Guide | null, mcpUrl: string | null) =>
  guide === null ? 1 : mcpUrl !== null && setupParts(guide.setup(mcpUrl)).signIn.length > 0 ? 3 : 2;

/**
 * The choice between a tool's two ways to connect, early in its setup: answer when asked, or on
 * its own (or, for Claude Code, in a session or as a routine). Each way says what it gives.
 */
export function ConnectWays({
  ways,
  wake,
  choose,
}: {
  readonly ways: readonly [ConnectWay, ConnectWay];
  readonly wake: boolean;
  readonly choose: (way: ConnectWay) => void;
}) {
  const id = useId();
  const waking = ways.some((way) => way.wake === true);
  // The way this recipe sets up is the one without another recipe; between ask and wake, `wake`.
  const selected = (way: ConnectWay) =>
    way.guide === undefined && (!waking || (way.wake === true) === wake);
  return (
    <fieldset className="connect-ways">
      <legend className="connect-ways-question">How should it work?</legend>
      {ways.map((way, index) => (
        <label key={way.title} className="connect-way">
          <input
            type="radio"
            name={`${id}-way`}
            value={index}
            checked={selected(way)}
            onChange={() => choose(way)}
          />
          <span className="connect-way-text">
            <span className="connect-way-title">{way.title}</span>
            <span className="connect-way-summary">{way.summary}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * The tools this browser installed TalkTo in, so connecting another agent of the same kind can
 * skip the install on the same machine. A tool whose agent runs commands installs once per
 * machine; the question below asks which machine this is.
 */
const installedKey = "talkto-installed-agents";
export function installedAgents(): ReadonlyArray<string> {
  try {
    return (localStorage.getItem(installedKey) ?? "").split(",").filter((id) => id !== "");
  } catch {
    return [];
  }
}
export function markInstalled(guide: Guide) {
  try {
    const ids = new Set(installedAgents());
    ids.add(guide.id);
    localStorage.setItem(installedKey, [...ids].join(","));
  } catch {
    // Private windows can refuse storage; the next agent then starts on the install.
  }
}
/** Whether to ask "same machine?": a command tool installed before here, or joined in this run. */
export const asksSameMachine = (guide: Guide, mcpUrl: string | null, joinedHere = false) =>
  mcpUrl !== null &&
  runsCommands(guide.setup(mcpUrl)) &&
  (joinedHere || installedAgents().includes(guide.id));

/**
 * One question before the install, when TalkTo may already be in this tool: on the same machine,
 * go straight to the join prompt; on another, install it there.
 */
export function SameMachine({
  guide,
  level,
  yes,
  no,
  yesClassName,
  noClassName,
}: {
  readonly guide: Guide;
  readonly level: number;
  readonly yes: () => void;
  readonly no: () => void;
  readonly yesClassName: string;
  readonly noClassName: string;
}) {
  return (
    <div className="agent-setup same-machine">
      <p className="flow-step-title" role="heading" aria-level={level}>
        Is this {guide.name} on the same machine as before?
      </p>
      <p className="setup-lead">
        You installed TalkTo in {guide.name} already. It installs once per machine, so on the same
        machine it only needs to join.
      </p>
      <div className="same-machine-choices">
        <button type="button" className={yesClassName} onClick={yes}>
          Yes, same machine: join now
        </button>
        <button type="button" className={noClassName} onClick={no}>
          No, another machine: install there
        </button>
      </div>
    </div>
  );
}
