import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  connectWays,
  hooksOf,
  hooksTitle,
  runsCommands,
  setupParts,
  type AgentSetup,
  type SetupStep,
} from "@talkto/api/agent-guides";
import type * as M from "@talkto/api/models";
import { BrandMark } from "./agent-brand-marks.js";
import {
  AgentPrompt,
  ConnectWays,
  findGuide,
  HooksOffer,
  InstallTabs,
  Rich,
  StepBody,
  Steps,
  type Guide,
} from "./agent-flow.js";
import { agentGuideUrl } from "./landing-parts.js";
import "./agent-walkthrough.css";

/*
  Connecting one agent, as a walkthrough (owner, November 17, 2026: "lay out the process up front,
  then step by step"). It opens on the whole plan, then shows one step at a time with Back and Next,
  so the person always knows where they are. The join step waits until the agent shows up, and
  "Answers on its own" ends with the Auto-start form right here, so nothing sends the person to
  another screen. The dashboard's Connect agents dialog uses it.
*/

/** The agent that joined during this walkthrough. */
export type Joined = Pick<M.Participant, "id" | "name">;

type Kind =
  /** The install. `first` is the page with the tool's own lead and its notes and extras. */
  | { readonly kind: "install"; readonly steps: ReadonlyArray<SetupStep>; readonly first: boolean }
  | { readonly kind: "sign-in"; readonly steps: ReadonlyArray<SetupStep> }
  | { readonly kind: "join" }
  /** The TalkTo hooks, after the join: recommended, and the person may skip it. */
  | { readonly kind: "hooks" }
  | { readonly kind: "wake"; readonly steps: ReadonlyArray<SetupStep> }
  | { readonly kind: "auto-start"; readonly step: SetupStep };
export type Step = Kind & {
  readonly key: string;
  readonly title: string;
  readonly summary: string;
  /** A word after the title in the step list, such as Recommended. */
  readonly tag?: string;
};

/**
 * The tool as running text: "Another tool" is a tile label, not a product, so the walkthrough says
 * "your tool" for it.
 */
export const toolName = (guide: Guide) => (guide.id === "mcp" ? "your tool" : guide.name);

/**
 * Pages from a recipe's steps: a step with a `title` starts its own page, and the untitled steps
 * after it stay on that page, so one page is one thing to do. Untitled steps before any title share
 * the first page, under `lead`.
 */
const pages = (
  steps: ReadonlyArray<SetupStep>,
  lead: string,
): ReadonlyArray<{ readonly title: string; readonly steps: ReadonlyArray<SetupStep> }> => {
  const out: Array<{ title: string; steps: Array<SetupStep> }> = [];
  for (const step of steps) {
    const current = out.at(-1);
    if (step.title !== undefined || current === undefined)
      out.push({ title: step.title ?? lead, steps: [step] });
    else current.steps.push(step);
  }
  return out;
};

/** The steps for this agent and way, in order. */
export const planOf = (
  guide: Guide,
  setup: AgentSetup,
  serverName: string,
  waking: boolean,
  skipInstall: boolean,
): ReadonlyArray<Step> => {
  const { install, signIn, recommended } = setupParts(setup);
  const commands = runsCommands(setup);
  const name = toolName(guide);
  const steps: Array<Step> = [];
  if (!skipInstall) {
    if (commands)
      // The agent installs itself from one prompt, or the person runs the same commands: one page.
      steps.push({
        key: "install",
        kind: "install",
        steps: install,
        first: true,
        title: `Install TalkTo in ${name}`,
        summary: `Paste one prompt. ${name} installs TalkTo itself.`,
      });
    else {
      const lead =
        guide.addsItself === true ? `Ask ${name} to add TalkTo` : `Add TalkTo to ${name}`;
      pages(install, lead).forEach((page, index) =>
        steps.push({
          key: `install-${index}`,
          kind: "install",
          steps: page.steps,
          first: index === 0,
          title: page.title,
          // The summary describes the whole install, so only an untitled first page carries it.
          summary:
            page.title !== lead
              ? ""
              : guide.addsItself === true
                ? `Send ${name} one message. It adds TalkTo itself.`
                : `A few clicks in ${name}.`,
        }),
      );
    }
    pages([...signIn, ...recommended], "Sign in").forEach((page, index) =>
      steps.push({
        key: `sign-in-${index}`,
        kind: "sign-in",
        steps: page.steps,
        title: page.title,
        summary: index === 0 ? `Approve the TalkTo sign-in in ${name}. Only you can do this.` : "",
      }),
    );
  }
  const join: Step = {
    key: "join",
    kind: "join",
    title: `Have it join ${serverName}`,
    summary: `Paste one prompt. ${guide.id === "mcp" ? "It" : name} joins under its own name, and this page sees it arrive.`,
  };
  // The TalkTo hooks are their own step, recommended, once the agent is in (owner, November 23,
  // 2026: "more prominent and with an info block to tell me why"). Always last, after any
  // Auto-start too, so Skip and Done both end the walkthrough the way Done always has, and the
  // Auto-start form still comes right after the join it needs.
  const hooks: ReadonlyArray<Step> =
    hooksOf(setup) !== null
      ? [
          {
            key: "hooks",
            kind: "hooks",
            title: `Let ${name} hear new messages`,
            summary: `${name} hears new messages while it works, and answers without you asking.`,
            tag: "Recommended",
          },
        ]
      : [];
  const wake = setup.wake;
  if (!waking || wake === undefined) return [...steps, join, ...hooks];
  // The steps after the join; the last one is the Auto-start form when the wake has one.
  const after = wake.autoStart ? wake.steps.slice(0, -1) : wake.steps;
  const wakePages: Array<Step> = pages(after, "Make it answer on its own").map((page, index) => ({
    key: `wake-${index}`,
    kind: "wake",
    steps: page.steps,
    title: page.title,
    summary: "",
  }));
  const form = wake.autoStart ? wake.steps.at(-1) : undefined;
  const last: ReadonlyArray<Step> =
    form === undefined
      ? []
      : [
          {
            key: "auto-start",
            kind: "auto-start",
            step: form,
            title: form.title ?? "Paste them here and test",
            summary: "Paste the address and key into TalkTo, then send a test.",
          },
        ];
  if (wake.autoStart) return [...steps, join, ...wakePages, ...last, ...hooks];
  // A host that wakes itself (ChatGPT) needs the right kind of chat, which the person opens before
  // turning TalkTo on in it: right after signing in, ahead of the join.
  const at = steps.findIndex((item) => item.key === "sign-in-0");
  return at < 0
    ? [...steps, ...wakePages, join, ...hooks]
    : [...steps.slice(0, at + 1), ...wakePages, ...steps.slice(at + 1), join, ...hooks];
};

/** Rough minutes for the plan, so the person knows what they are signing up for. */
const minutesFor = (steps: ReadonlyArray<Step>) => Math.max(2, Math.round(steps.length * 1.2));

export function Walkthrough({
  guide,
  mcpUrl,
  serverName,
  prompt,
  waking,
  setWaking,
  switchGuide,
  joined,
  check,
  skipInstall = false,
  installed,
  autoStart,
  finish,
  finishLabel = "Done",
  chooseAnother,
  copyClassName = "btn",
  primaryClassName = "btn",
  secondaryClassName = "btn secondary",
}: {
  readonly guide: Guide;
  readonly mcpUrl: string;
  readonly serverName: string;
  /** The join prompt for this server; null while it loads. */
  readonly prompt: string | null;
  /** Whether "Answers on its own" is chosen. */
  readonly waking: boolean;
  readonly setWaking: (waking: boolean) => void;
  /** Opens another recipe, when the chosen way is set up there (Claude Code routines). */
  readonly switchGuide: (guide: Guide) => void;
  /** The agent once it joined; the join step waits for it. */
  readonly joined: Joined | null;
  /** Asks the surface to look for the agent again now. */
  readonly check?: () => void;
  /** TalkTo is in this tool already (same machine): start at the join. */
  readonly skipInstall?: boolean;
  /** Called when the person leaves the install step, so the surface can remember the tool. */
  readonly installed?: () => void;
  /** The Auto-start form for the agent that joined. */
  readonly autoStart: (agent: Joined) => ReactNode;
  readonly finish: () => void;
  readonly finishLabel?: string;
  /** Back from the plan: the agent grid. */
  readonly chooseAnother: () => void;
  readonly copyClassName?: string;
  readonly primaryClassName?: string;
  readonly secondaryClassName?: string;
}) {
  const setup = guide.setup(mcpUrl);
  const steps = planOf(guide, setup, serverName, waking, skipInstall);
  const ways = connectWays(guide, setup);
  // -1 is the plan; then the index of the step on screen.
  const [at, setAt] = useState(-1);
  const index = Math.min(at, steps.length - 1);
  const step = index < 0 ? null : (steps[index] ?? null);
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current) return;
    heading.current?.focus();
    heading.current?.closest(".walk")?.querySelector(".walk-main")?.scrollTo({ top: 0 });
  }, [index]);
  const go = (next: number) => {
    moved.current = true;
    if (step?.kind === "install") installed?.();
    // Arriving at the join, look for the agent again: the surface may have stopped watching.
    if (steps[next]?.kind === "join") check?.();
    setAt(next);
  };
  const waitingForJoin = step?.kind === "join" && joined === null;
  const last = index === steps.length - 1;
  const nextTitle = steps[index + 1]?.title;
  return (
    <div className="walk">
      <nav className="walk-rail" aria-label="Steps">
        <p className="walk-agent">
          <BrandMark id={guide.mark} />
          <span>{guide.name}</span>
        </p>
        <ol>
          <li aria-current={index < 0 ? "step" : undefined} data-done={index >= 0}>
            <button type="button" onClick={() => go(-1)}>
              <span className="walk-dot" aria-hidden="true">
                {index >= 0 ? "✓" : ""}
              </span>
              The plan
            </button>
          </li>
          {steps.map((item, number) => (
            <li
              key={item.key}
              aria-current={number === index ? "step" : undefined}
              data-done={number < index}
            >
              <button type="button" onClick={() => go(number)}>
                <span className="walk-dot" aria-hidden="true">
                  {number < index ? "✓" : number + 1}
                </span>
                <span className="walk-rail-title">
                  {item.title}
                  {item.tag !== undefined && <span className="walk-tag">{item.tag}</span>}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <div className="walk-main">
        <div className="walk-progress" aria-hidden="true">
          <span style={{ width: `${((index + 1) / (steps.length + 1)) * 100}%` }} />
        </div>
        {step === null ? (
          <section className="walk-page" data-plan="" aria-labelledby="walk-heading">
            <p className="walk-kicker">
              {steps.length} {steps.length === 1 ? "step" : "steps"} · about {minutesFor(steps)}{" "}
              minutes
            </p>
            <h3 id="walk-heading" ref={heading} tabIndex={-1}>
              Here’s how we’ll connect {toolName(guide)}
            </h3>
            {ways !== null && (
              <ConnectWays
                ways={ways}
                wake={waking}
                choose={(way) => {
                  const other = findGuide(way.guide);
                  if (other !== null) switchGuide(other);
                  else setWaking(way.wake === true);
                }}
              />
            )}
            <ol className="walk-plan">
              {steps.map((item, number) => (
                <li key={item.key}>
                  <span className="walk-dot" aria-hidden="true">
                    {number + 1}
                  </span>
                  <span>
                    <strong>
                      {item.title}
                      {item.tag !== undefined && <span className="walk-tag">{item.tag}</span>}
                    </strong>
                    {item.summary !== "" && <span>{item.summary}</span>}
                  </span>
                </li>
              ))}
            </ol>
            <p className="walk-note">
              We’ll go one step at a time. You can come back to this list from the left.
            </p>
          </section>
        ) : (
          <section className="walk-page" aria-labelledby="walk-heading">
            <p className="walk-kicker">
              Step {index + 1} of {steps.length}
              {step.tag !== undefined && ` · ${step.tag}`}
            </p>
            <h3 id="walk-heading" ref={heading} tabIndex={-1}>
              {step.title}
            </h3>
            <StepContent
              step={step}
              guide={guide}
              setup={setup}
              mcpUrl={mcpUrl}
              prompt={prompt}
              joined={joined}
              check={check}
              autoStart={autoStart}
              copyClassName={copyClassName}
            />
          </section>
        )}
      </div>
      <footer className="walk-foot">
        <button
          type="button"
          className={secondaryClassName}
          onClick={() => (index < 0 ? chooseAnother() : go(index - 1))}
        >
          {index < 0 ? "← Other agents" : "← Back"}
        </button>
        <span className="walk-count">
          {waitingForJoin
            ? `Waiting for ${agentName(guide)} to join`
            : nextTitle !== undefined
              ? `Up next: ${nextTitle}`
              : index < 0
                ? ""
                : "Last step"}
        </span>
        {/* The hooks step is always the last (planOf), so Skip ends the walkthrough too. */}
        {step?.kind === "hooks" && (
          <button type="button" className={secondaryClassName} onClick={finish}>
            Skip
          </button>
        )}
        <button
          type="button"
          className={primaryClassName}
          data-autofocus
          disabled={waitingForJoin}
          onClick={() => (last ? finish() : go(index + 1))}
        >
          {index < 0
            ? "Start step 1 →"
            : waitingForJoin
              ? "Waiting…"
              : last
                ? finishLabel
                : "Next →"}
        </button>
      </footer>
    </div>
  );
}

/** The agent as running text, in waiting and arrival lines. */
const agentName = (guide: Guide) =>
  guide.id === "mcp"
    ? "your agent"
    : guide.id === "claude-code-routines"
      ? "the routine"
      : guide.name;

/** Where the person pastes the join prompt. */
const joinWhere = (guide: Guide, setup: AgentSetup) =>
  guide.id === "claude-code-routines"
    ? "Add this to the routine’s saved prompt, then choose **Run now** once."
    : guide.id === "mcp"
      ? "Paste this into your agent’s chat."
      : runsCommands(setup)
        ? `Paste this into a new ${guide.name} session.`
        : `Paste this into your ${guide.name} chat.`;

/** A page's actions: numbered when there are several, plain when there is one. */
function PageSteps({
  steps,
  mcpUrl,
}: {
  readonly steps: ReadonlyArray<SetupStep>;
  readonly mcpUrl: string;
}) {
  const [only] = steps;
  return steps.length === 1 && only !== undefined ? (
    <div className="walk-one">
      <StepBody step={only} mcpUrl={mcpUrl} />
    </div>
  ) : (
    <Steps steps={steps} mcpUrl={mcpUrl} />
  );
}

/** One step's page. Exported with planOf so tests can render every step. */
export function StepContent({
  step,
  guide,
  setup,
  mcpUrl,
  prompt,
  joined,
  check,
  autoStart,
  copyClassName,
}: {
  readonly step: Step;
  readonly guide: Guide;
  readonly setup: AgentSetup;
  readonly mcpUrl: string;
  readonly prompt: string | null;
  readonly joined: Joined | null;
  readonly check: (() => void) | undefined;
  readonly autoStart: (agent: Joined) => ReactNode;
  readonly copyClassName: string;
}) {
  const { signIn } = setupParts(setup);
  const name = toolName(guide);
  switch (step.kind) {
    case "install":
      return (
        <>
          {runsCommands(setup) ? (
            <InstallTabs
              guide={guide}
              setup={setup}
              mcpUrl={mcpUrl}
              buttonClassName={copyClassName}
            />
          ) : (
            <>
              {step.first && (
                <p className="setup-lead">
                  {guide.addsItself === true
                    ? `${name} adds TalkTo itself when you ask.`
                    : `Do this in ${name}.`}
                </p>
              )}
              <PageSteps steps={step.steps} mcpUrl={mcpUrl} />
            </>
          )}
          {step.first &&
            setup.notes?.map((note) => (
              <p key={note} className="setup-note">
                <Rich text={note} />
              </p>
            ))}
          {step.first &&
            setup.extras
              // The hooks have their own step after the join.
              .filter((extra) => extra.title !== hooksTitle)
              .map((extra) => (
                <details key={extra.title} className="connect-extra setup-extra">
                  <summary>{extra.title}</summary>
                  <div>
                    {extra.steps.map((item) => (
                      <StepBody key={item.text} step={item} mcpUrl={mcpUrl} />
                    ))}
                  </div>
                </details>
              ))}
          <p className="walk-note">
            Stuck?{" "}
            <a href={agentGuideUrl(guide.id)} target="_blank" rel="noopener noreferrer">
              Full {guide.id === "mcp" ? "setup" : guide.name} guide ↗
            </a>
          </p>
        </>
      );
    case "sign-in":
      return (
        <>
          {step.title === "Sign in" && (
            <p className="setup-lead">
              Only you can do this, in {name}. TalkTo’s tools work after you sign in.
            </p>
          )}
          <PageSteps steps={step.steps} mcpUrl={mcpUrl} />
        </>
      );
    case "join":
      return (
        <>
          <p className="setup-lead">
            <Rich text={joinWhere(guide, setup)} /> It picks its own name and joins.
          </p>
          <AgentPrompt prompt={prompt} buttonClassName={copyClassName} reveal />
          {joined === null ? (
            <div className="walk-status" role="status">
              <span className="waiting-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span>
                Waiting for {agentName(guide)} to join…{" "}
                {check && (
                  <button type="button" className="text-button" onClick={check}>
                    Check now
                  </button>
                )}
              </span>
            </div>
          ) : (
            <div className="walk-status" data-done="" role="status">
              <span aria-hidden="true">✓</span>
              <span>
                Joined as <strong>{joined.name}</strong>.
              </span>
            </div>
          )}
          {joined === null && signIn.length > 0 && (
            <p className="walk-note">
              Says it has no TalkTo tools, or asks you to sign in? Go back to{" "}
              <strong>Sign in</strong>, then paste the prompt again.
            </p>
          )}
        </>
      );
    case "hooks":
      return (
        <>
          <p className="setup-lead">
            One more step helps {name} keep up with TalkTo. It’s recommended, and you can add it
            later.
          </p>
          <HooksOffer guide={guide} mcpUrl={mcpUrl} />
        </>
      );
    case "wake":
      return <PageSteps steps={step.steps} mcpUrl={mcpUrl} />;
    case "auto-start":
      return (
        <>
          <p className="setup-lead">
            <Rich text={step.step.here ?? step.step.text} />
          </p>
          {joined === null ? (
            <p className="walk-status" role="status">
              This form appears once {agentName(guide)} has joined. Go back to the join step first.
            </p>
          ) : (
            autoStart(joined)
          )}
        </>
      );
  }
}
