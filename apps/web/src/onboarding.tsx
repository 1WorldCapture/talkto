import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Schema } from "effect";
import * as M from "@talkto/api/models";
import * as O from "@talkto/api/onboarding";
import * as P from "@talkto/api/platform";
import { pluginNames, type PluginName } from "@talkto/api/plugins";
import { installGuideUrl } from "@talkto/api/agent-guides";
import { describeAgentType, normalizeAgentType } from "@talkto/api/agent-types";
import { input, request } from "./api.js";
import { AgentIcon, Notice } from "./components.js";
import { SessionGate, useHuman, useServices } from "./session.js";
import { useOnboardingState } from "./onboarding-state.js";
import { awaitsProgress, progressInterval } from "./onboarding-polling.js";
import { ThemeToggle } from "./theme.js";
import { setupPrompt } from "./agent-prompt.js";
import { findGuide, guideAgentType, type Guide } from "./agent-flow.js";
import { toolName } from "./agent-walkthrough.js";
import { BrandMark } from "./agent-brand-marks.js";
import { agentGuides, type AgentGuideId } from "./landing-parts.js";
import { freeStartLine, useStarterEligibility } from "./starter.js";
import { FeedbackDialog } from "./feedback.js";
import { defaultOrganizationName, defaultServerName } from "./organization-name.js";
import "./onboarding.css";

/*
  First-run setup (owner-approved prototype, November 18, 2026): create the server, add a first
  agent with one message to paste, add a second, then open the server. Every screen says what to
  do now and has a visible way out that names where it goes. Leaving always finishes or dismisses
  the run first, so /app never sends the person back here (sendsToSetup in app-routes.ts).

  The saved step names stay as they were, so saved runs still decode: "server" is creating,
  "agents" is every agent screen, and the retired "share" step reads like "done".
*/

/** A command before its revision; the wizard adds the current revision when it sends it. */
type Values = Readonly<Record<string, string | number | null | ReadonlyArray<string>>>;
type Act = (
  commands: ReadonlyArray<Values>,
  options?: {
    readonly onSuccess?: (state: O.State) => void;
    readonly onError?: () => void;
  },
) => void;
/*
  Creating the organization and the server can take 5–15 seconds. On November 18, 2026 two people
  gave up at the usual 15-second limit although their servers were made. A retry resumes the same
  organization and server, so waiting longer is safe.
*/
const creationLimit = "60 seconds";
/** Setup's three steps: the server, a first agent, then every agent after it. */
const stageCount = 3;

/** The commands behind each way out of setup. Skip setup still makes the server, then leaves. */
export const createCommands = (draft: {
  readonly accountId: string | null;
  readonly organizationName: string;
  readonly serverName: string;
}): ReadonlyArray<Values> => [{ kind: "configure", ...draft }, { kind: "provision" }];
export const skipSetupCommands = (draft: Parameters<typeof createCommands>[0]) => [
  ...createCommands(draft),
  { kind: "dismiss" },
];
/** Skip for now, I’m done and Open server: finished with two agents, dismissed with fewer. */
export const leaveCommands: ReadonlyArray<Values> = [{ kind: "finish" }];

/** The server page, on its General channel when known. */
export const serverPath = (
  setup: { readonly accountId: string; readonly serverId: string },
  generalConversationId: string | null,
) =>
  `/app/accounts/${setup.accountId}/servers/${setup.serverId}${generalConversationId === null ? "" : `?channel=${generalConversationId}`}`;

/** Setup's agent chips: the popular tools first, in this order; the rest wait under More agents. */
export const popularSetupAgents: ReadonlyArray<AgentGuideId> = [
  "claude-code",
  "codex",
  "cursor",
  "opencode",
  "pi",
  "chatgpt",
  "grok-bot",
  "muse",
];
const popularGuides = popularSetupAgents.flatMap((id) =>
  agentGuides.filter((guide) => guide.id === id),
);
const otherGuides = agentGuides.filter((guide) => !popularSetupAgents.includes(guide.id));

/**
 * The tool an agent says it runs in, named the way setup names tools: its guide's name and mark
 * where one matches the reported agentType, the type's own label otherwise.
 */
export function reportedTool(agentType: string) {
  const type = normalizeAgentType(agentType);
  const guide = agentGuides.find((entry) => guideAgentType[entry.id] === type) ?? null;
  if (guide !== null) return { name: guide.name, guide } satisfies ReportedTool;
  const described = describeAgentType(type);
  return {
    name:
      described.icon === "generic" && (type === "" || type === "generic")
        ? "Your agent"
        : described.label.replaceAll(" · ", " "),
    guide: null,
  } satisfies ReportedTool;
}
interface ReportedTool {
  readonly name: string;
  readonly guide: Guide | null;
}

/** Setup's one message for this slot: install if needed, sign in, then join with its key. */
export function slotPrompt({
  server,
  mcpUrl,
  runId,
  slot,
  guide,
}: {
  readonly server: { readonly id: string; readonly name: string };
  readonly mcpUrl: string;
  readonly runId: O.RunId;
  readonly slot: O.SlotIndex;
  readonly guide: Guide;
}) {
  const type = guideAgentType[guide.id];
  return setupPrompt({
    server,
    mcpUrl,
    requestKey: O.agentRequestKey(runId, slot),
    tool:
      guide.id === "mcp"
        ? null
        : {
            name: guide.name,
            installUrl: installGuideUrl(new URL(mcpUrl).origin, guide.id),
            agentType:
              type === null ? null : input(Schema.Struct({ type: M.AgentType }), { type }).type,
          },
  });
}

export function Onboarding() {
  return (
    <SessionGate>
      <OnboardingSession />
    </SessionGate>
  );
}
function OnboardingSession() {
  const state = useOnboardingState();
  const user = useHuman();
  if (state.isPending || (!state.isFetchedAfterMount && !state.isError))
    return (
      <Frame>
        <p role="status">Finding your place…</p>
      </Frame>
    );
  if (state.isError)
    return (
      <Frame>
        <Notice error={state.error} retry={() => void state.refetch()} />
        <a className="fs-text-button" href="/app/organizations">
          Your organizations
        </a>
      </Frame>
    );
  return <Wizard key={user.id} state={state.data.data} />;
}

/** The page: the dashboard's top bar without its navigation, and one panel in the middle. */
function Frame({
  busy = false,
  children,
}: {
  readonly busy?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <section className="first-setup" aria-label="TalkTo setup">
      <header className="fs-bar">
        <a href="/" className="fs-brand" aria-label="TalkTo">
          talkto
        </a>
        <ThemeToggle />
      </header>
      <main className="fs-main">
        <section className="fs-panel" aria-live="polite" aria-busy={busy}>
          {children}
        </section>
      </main>
    </section>
  );
}

function Wizard({ state }: { readonly state: O.State }) {
  const { api, queries } = useServices();
  const user = useHuman();
  const run = state.run;
  const setup = run?.setup.kind === "ready" ? run.setup : null;
  const step = run?.step ?? "server";
  const [feedback, setFeedback] = useState(false);
  // The public footer's /app?feedback=1 lands here for someone still setting up: open it once.
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const asked = search.feedback !== undefined;
  useEffect(() => {
    if (!asked) return;
    setFeedback(true);
    void navigate({ to: "/onboarding", search: { ...search, feedback: undefined }, replace: true });
  }, [asked, navigate, search]);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  // Polling restarts its watch on each step change and on return to the page.
  const [watchingSince, setWatchingSince] = useState(() => Date.now());
  const scope = ["human", user.id, "onboarding"];
  const progressKey = [...scope, "onboarding-progress", run?.id, step];
  useEffect(() => {
    const change = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  useEffect(() => {
    setWatchingSince(Date.now());
  }, [run?.id, step]);
  const awaiting = awaitsProgress(step);
  // People install and sign in to their agent in another app, so coming back must check at once.
  // The tab becoming visible refetches through refetchOnWindowFocus; switching back from another
  // app while the tab stayed visible fires only the window's focus event.
  useEffect(() => {
    if (!awaiting) return;
    const regain = () => {
      if (document.visibilityState !== "visible") return;
      setWatchingSince(Date.now());
      void queries.refetchQueries(
        { queryKey: ["human", user.id, "onboarding", "onboarding-progress"], type: "active" },
        { cancelRefetch: false },
      );
    };
    window.addEventListener("focus", regain);
    document.addEventListener("visibilitychange", regain);
    return () => {
      window.removeEventListener("focus", regain);
      document.removeEventListener("visibilitychange", regain);
    };
  }, [awaiting, queries, user.id]);
  const progress = useQuery({
    queryKey: progressKey,
    queryFn: ({ signal }) =>
      request(
        api.onboarding.progress({
          query: { runId: input(Schema.Struct({ id: O.RunId }), { id: run?.id }).id },
        }),
        signal,
      ),
    enabled: setup !== null && visible,
    refetchInterval: () => progressInterval({ step, visible, watchingSince, now: Date.now() }),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: awaiting,
    refetchOnReconnect: false,
    staleTime: 0,
  });
  useEffect(() => {
    if (!visible)
      void queries.cancelQueries({
        queryKey: ["human", user.id, "onboarding", "onboarding-progress"],
      });
  }, [visible, queries, user.id]);
  const evidence = progress.isError ? undefined : progress.data?.data;
  // The newest state known here, so a command sent right after another (Skip setup once the server
  // is ready) carries the revision that one returned, before the page re-renders with it.
  const known = useRef(state);
  if (state.revision >= known.current.revision) known.current = state;
  const action = useMutation({
    // Commands go one after another, each with the revision the previous one returned.
    mutationFn: async (commands: ReadonlyArray<Values>) => {
      let latest = known.current;
      for (const values of commands) {
        const response = await request(
          api.onboarding.command({
            payload: { command: input(O.Command, { ...values, revision: latest.revision }) },
          }),
          undefined,
          "routine",
          values.kind === "provision" ? creationLimit : undefined,
        );
        queries.setQueryData([...scope, "state"], response);
        latest = response.data;
        known.current = latest;
      }
      return latest;
    },
    onSettled: () => {
      void queries.invalidateQueries({ queryKey: ["human", user.id] });
    },
  });
  const [leaving, setLeaving] = useState(false);
  const act: Act = (commands, options) => {
    if (action.isPending || leaving) return;
    action.mutate(commands, {
      onSuccess: (next) => options?.onSuccess?.(next),
      onError: () => options?.onError?.(),
    });
  };
  /** Opens the server page once the run is ready, on its General channel when it can be read. */
  const open = async (next: O.State) => {
    setLeaving(true);
    const ready = next.run?.setup.kind === "ready" ? next.run.setup : null;
    if (next.run === null || ready === null) return window.location.assign("/app");
    let general = evidence?.server?.server.generalConversationId ?? null;
    if (general === null)
      try {
        const fresh = await request(api.onboarding.progress({ query: { runId: next.run.id } }));
        general = fresh.data.server?.server.generalConversationId ?? null;
      } catch {
        // The server page opens on its own first tab without it.
      }
    window.location.assign(serverPath(ready, general));
  };
  const leave = (commands: ReadonlyArray<Values>) =>
    act(commands, { onSuccess: (next) => void open(next) });
  const check = () => {
    setWatchingSince(Date.now());
    void progress.refetch();
  };
  const busy = action.isPending || leaving;
  let content: ReactNode;
  if (setup === null) content = <ServerSteps state={state} act={act} open={open} busy={busy} />;
  else if (run === null) content = null;
  else if (progress.isError)
    content = (
      <>
        <Heading text="Let’s reconnect" />
        <p className="fs-now">Your setup is saved. Check your connection, then try again.</p>
        <div className="fs-body">
          <Notice error={progress.error} retry={check} />
        </div>
        <Exit note="Opens your server.">
          <button className="fs-btn secondary lone" onClick={() => leave(leaveCommands)}>
            Skip for now
          </button>
        </Exit>
      </>
    );
  else if (evidence === undefined) content = <p role="status">Checking your server…</p>;
  else if (evidence.server === null)
    content = (
      <>
        <Heading text="Your server is out of reach" />
        <p className="fs-now">Ask its owner for access, or start again with a new server.</p>
        <div className="fs-actions">
          <button className="fs-btn" onClick={check}>
            Check again
          </button>
          <button className="fs-btn secondary" onClick={() => act([{ kind: "new_run" }])}>
            Start again
          </button>
        </div>
      </>
    );
  else
    content = (
      <AgentSteps
        key={run.id}
        run={run}
        server={evidence.server}
        act={act}
        leave={() => leave(leaveCommands)}
        busy={busy}
      />
    );
  return (
    <Frame busy={busy}>
      {content}
      <Notice
        error={action.error}
        retry={() => {
          action.reset();
          void queries.invalidateQueries({ queryKey: scope });
        }}
      />
      {feedback && <FeedbackDialog accountId={setup?.accountId} close={() => setFeedback(false)} />}
    </Frame>
  );
}

/** The screen's title, focused when it changes so a screen reader hears the new screen. */
function Heading({ text, children }: { readonly text: string; readonly children?: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [text]);
  return (
    <h1 tabIndex={-1} ref={heading}>
      {children ?? text}
    </h1>
  );
}

/** "Step 2 of 3" with three segments; `done` fills them all for the last screen. */
export function StepMeter({
  stage,
  done = false,
}: {
  readonly stage: number;
  readonly done?: boolean;
}) {
  return (
    <div className="fs-step">
      <span className="fs-segments" aria-hidden="true">
        {Array.from({ length: stageCount }, (_, index) => (
          <i key={index} className={done || index < stage ? "filled" : ""} />
        ))}
      </span>
      {done ? "Setup complete" : `Step ${stage} of ${stageCount}`}
    </div>
  );
}

/** A line of good news above the step: the server is ready, an agent joined. */
function Status({ children }: { readonly children: ReactNode }) {
  return (
    <p className="fs-status">
      <span className="fs-tick" aria-hidden="true">
        ✓
      </span>
      <span>{children}</span>
    </p>
  );
}

/** The screen's buttons over a hairline, then the note that says where the way out goes. */
function Exit({
  note,
  center = false,
  children,
}: {
  readonly note: ReactNode;
  readonly center?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <>
      <div className="fs-actions">{children}</div>
      <p className={`fs-exit-note ${center ? "center" : ""}`}>{note}</p>
    </>
  );
}

/** Step 1: name the server (and a new organization), then wait while both are made. */
function ServerSteps({
  state,
  act,
  open,
  busy,
}: {
  readonly state: O.State;
  readonly act: Act;
  readonly open: (next: O.State) => Promise<void>;
  readonly busy: boolean;
}) {
  const { api } = useServices();
  const user = useHuman();
  const saved = state.run?.setup;
  const draft = saved !== undefined && saved.kind !== "ready" ? saved : null;
  const eligibility = useStarterEligibility();
  const offer = freeStartLine(eligibility.data?.data);
  const accounts = useQuery({
    queryKey: ["human", user.id, "onboarding", "accounts"],
    queryFn: ({ signal }) =>
      request(
        api.platform.listAccounts({ query: input(P.IdentityListing, { limit: 20 }) }),
        signal,
      ),
    refetchOnMount: "always",
  });
  // Only organizations the person can add a server to; with none, setup makes their own.
  const own = accounts.data?.data.items.filter((account) => account.permissions.createServer) ?? [];
  const [accountChoice, setAccountChoice] = useState<string | null>(draft?.accountId ?? null);
  const accountId = accountChoice ?? own[0]?.id ?? null;
  const [serverName, setServerName] = useState(
    () => draft?.serverName ?? defaultServerName(user.firstName),
  );
  const [organizationName, setOrganizationName] = useState(
    () => draft?.organizationName ?? defaultOrganizationName(user.email, user.firstName),
  );
  // What is being made, for the Creating screen: set on Create server or Skip setup.
  const [making, setMaking] = useState<{
    readonly serverName: string;
    readonly organizationName: string | null;
  } | null>(null);
  // Skip setup, from the form or while creating: leave as soon as the server is ready.
  const skip = useRef(false);
  const [skipping, setSkipping] = useState(false);
  const values = () => ({
    accountId,
    organizationName:
      organizationName.trim() || defaultOrganizationName(user.email, user.firstName),
    serverName: serverName.trim() || defaultServerName(user.firstName),
  });
  const created = () => {
    if (!skip.current) return setMaking(null);
    act([{ kind: "dismiss" }], {
      onSuccess: (dismissed) => void open(dismissed),
      onError: () => setMaking(null),
    });
  };
  const create = (skipNow: boolean) => {
    if (busy || !accounts.isSuccess) return;
    skip.current = skipNow;
    setSkipping(skipNow);
    const chosen = values();
    setMaking({
      serverName: chosen.serverName,
      organizationName: chosen.accountId === null ? chosen.organizationName : null,
    });
    act(createCommands(chosen), { onSuccess: created, onError: () => setMaking(null) });
  };
  // A setup saved while its server was being made resumes here, once per visit.
  const resumed = useRef(false);
  const resuming = saved?.kind === "creating";
  useEffect(() => {
    if (!resuming || resumed.current) return;
    resumed.current = true;
    setMaking({
      serverName: saved.serverName,
      organizationName: saved.accountId === null ? saved.organizationName : null,
    });
    act([{ kind: "provision" }], { onSuccess: created, onError: () => setMaking(null) });
  });
  if (making !== null || resuming) {
    const names = making ?? {
      serverName: draft?.serverName ?? "",
      organizationName: draft?.accountId === null ? draft.organizationName : null,
    };
    return (
      <>
        <StepMeter stage={1} />
        <Heading text="Creating your server…" />
        <p className="fs-now">
          {skipping
            ? "This takes a few seconds. Then your dashboard opens."
            : "This takes a few seconds. You don’t need to do anything."}
        </p>
        <div className="fs-body">
          <div className="fs-progress" role="progressbar" aria-label="Creating your server" />
          <dl className="fs-facts">
            <dt>Server</dt>
            <dd>{names.serverName}</dd>
            {names.organizationName !== null && (
              <>
                <dt>Organization</dt>
                <dd>{names.organizationName}</dd>
              </>
            )}
          </dl>
          {resuming && making === null && (
            <button
              className="fs-btn"
              onClick={() => act([{ kind: "provision" }], { onSuccess: created })}
            >
              Try again
            </button>
          )}
        </div>
        {!skipping && (
          <Exit note="Skip setup opens your dashboard as soon as the server is ready.">
            <button
              className="fs-btn secondary lone"
              onClick={() => {
                skip.current = true;
                setSkipping(true);
              }}
            >
              Skip setup
            </button>
          </Exit>
        )}
      </>
    );
  }
  const newOrganization = accounts.isSuccess && own.length === 0;
  return (
    <>
      <StepMeter stage={1} />
      <Heading text="Create your server" />
      <p className="fs-now">Your agents will meet here. Check the names, then create it.</p>
      <form
        className="fs-body"
        onSubmit={(event) => {
          event.preventDefault();
          create(false);
        }}
      >
        <div className="fs-field">
          <label htmlFor="server-name">Server name</label>
          <input
            id="server-name"
            value={serverName}
            required
            maxLength={100}
            autoComplete="off"
            onChange={(event) => setServerName(event.target.value)}
          />
          {!newOrganization && <span className="fs-hint">You can rename it later.</span>}
        </div>
        {newOrganization && (
          <div className="fs-field">
            <label htmlFor="organization-name">Organization</label>
            <input
              id="organization-name"
              value={organizationName}
              required
              maxLength={100}
              autoComplete="organization"
              onChange={(event) => setOrganizationName(event.target.value)}
            />
            <span className="fs-hint">You can rename both later.</span>
          </div>
        )}
        {own.length > 1 && (
          <div className="fs-field">
            <label htmlFor="organization">Organization</label>
            <select
              id="organization"
              value={accountId ?? ""}
              onChange={(event) => setAccountChoice(event.target.value)}
            >
              {own.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {offer !== null && <p className="fs-hint fs-offer">{offer}</p>}
        {accounts.isPending && (
          <p className="fs-hint" role="status">
            Loading your organizations…
          </p>
        )}
        <Notice error={accounts.error} retry={() => void accounts.refetch()} />
        <Exit
          note={`Skip setup creates the server with ${newOrganization ? "these names" : "this name"} and opens your dashboard.`}
        >
          <button className="fs-btn" type="submit" aria-disabled={busy || !accounts.isSuccess}>
            Create server
          </button>
          <button
            className="fs-btn secondary"
            type="button"
            aria-disabled={busy || !accounts.isSuccess}
            onClick={() => create(true)}
          >
            Skip setup
          </button>
        </Exit>
      </form>
    </>
  );
}

/**
 * Steps 2 and 3: pick an agent, paste its message, see it join; then another, as many as setup
 * connects. What shows follows the saved run and who has joined, so a reload lands on the same
 * screen.
 */
function AgentSteps({
  run,
  server,
  act,
  leave,
  busy,
}: {
  readonly run: O.Run;
  readonly server: O.ServerProgress;
  readonly act: Act;
  readonly leave: () => void;
  readonly busy: boolean;
}) {
  const { api } = useServices();
  const connection = useQuery({
    queryKey: ["session"],
    queryFn: ({ signal }) => request(api.platform.currentUser(), signal),
  });
  const mcpUrl = connection.data?.data.connection.mcpUrl ?? null;
  const slots = O.runSlots(run);
  const arrived = O.progressAgents(server);
  // Every slot's arrival, so a slot just picked counts as waiting before progress reports it.
  const agents = slots.map((_, index) => arrived[index] ?? null);
  const joined = agents.filter((agent) => agent !== null);
  const latest = joined.at(-1) ?? null;
  const serverName = server.server.name;
  const open = agents.findIndex((agent) => agent === null);
  // "Add another agent": the next slot after the joined screen, or one more after Done.
  const [adding, setAdding] = useState(false);
  // "Change": back to the chips for the slot whose message is showing.
  const [picking, setPicking] = useState(false);
  const target = open >= 0 ? open : adding ? slots.length : null;
  const slot = target !== null && Schema.is(O.SlotIndex)(target) ? target : null;
  useEffect(() => {
    setPicking(false);
  }, [slot]);
  const canAdd = slots.length < O.maxAgents;
  const leaveLabel = joined.length === 0 ? "Skip for now" : "I’m done";
  const choose = (at: O.SlotIndex, guide: Guide) => {
    if (guide.id === slots[at]?.setup) return setPicking(false);
    // A finished run goes back to the agent step first, so setup watches for the new agent.
    const commands: Array<Values> = run.step === "agents" ? [] : [{ kind: "step", step: "agents" }];
    commands.push({
      kind: "choose",
      slot: at,
      setup: guide.id,
      agentType: guideAgentType[guide.id] ?? O.unchosenAgentType,
    });
    act(commands, {
      onSuccess: () => {
        setPicking(false);
        setAdding(false);
      },
    });
  };
  if (slot === null)
    return (
      <Done
        agents={joined}
        serverName={serverName}
        open={leave}
        add={canAdd ? () => setAdding(true) : null}
        busy={busy}
      />
    );
  const chosen = slots[slot];
  const guide = chosen === undefined || picking ? null : findGuide(chosen.setup);
  // One agent in and nobody asked for the next yet: the arrival, with the choice of what's next.
  if (latest !== null && joined.length === 1 && slot === 1 && guide === null && !adding && !picking)
    return (
      <Joined
        agent={latest}
        serverName={serverName}
        add={() => setAdding(true)}
        done={leave}
        busy={busy}
      />
    );
  const first = slot === 0;
  if (guide === null)
    return (
      <>
        {first && joined.length === 0 && <Status>{serverName} is ready</Status>}
        <StepMeter stage={first ? 2 : 3} />
        <Heading text={first ? "Add your first agent" : "Add another agent"} />
        <p className="fs-now">
          {first
            ? "Pick the agent you use. Next you’ll get one message to paste into it."
            : "Pick one more. The same tool in another project works too."}
        </p>
        <div className="fs-body">
          {joined.length > 0 && <AgentList agents={joined} serverName={serverName} />}
          <AgentChips
            chosen={findGuide(chosen?.setup)?.id ?? null}
            busy={busy}
            choose={(picked) => choose(slot, picked)}
          />
        </div>
        <Exit
          note={
            joined.length === 0
              ? "Opens your server. You can add agents there any time."
              : `Opens ${serverName}.`
          }
        >
          <button className="fs-btn secondary lone" aria-disabled={busy} onClick={leave}>
            {leaveLabel}
          </button>
        </Exit>
        <Notice error={connection.error} retry={() => void connection.refetch()} />
      </>
    );
  const tool = toolName(guide);
  return (
    <>
      <StepMeter stage={first ? 2 : 3} />
      <Heading text={`Paste this into ${tool}`} />
      <p className="fs-now">Copy the message, paste it into {tool} and send it.</p>
      <div className="fs-body">
        <div className="fs-picked">
          <BrandMark id={guide.mark} />
          <strong>{guide.name}</strong>
          <button className="fs-text-button" type="button" onClick={() => setPicking(true)}>
            Change
          </button>
        </div>
        <SetupMessage
          prompt={
            mcpUrl === null
              ? null
              : slotPrompt({ server: server.server, mcpUrl, runId: run.id, slot, guide })
          }
        />
        <div className="fs-wait" role="status">
          <i className="fs-lamp" aria-hidden="true" />
          <div>
            <strong>Waiting for your agent to join…</strong>
            <span>
              It sets up TalkTo first if needed and may ask you to sign in. This page updates by
              itself.
            </span>
          </div>
        </div>
      </div>
      <Exit note="Opens your server. Your agent can still join after you leave.">
        <button className="fs-btn secondary lone" aria-disabled={busy} onClick={leave}>
          {leaveLabel}
        </button>
      </Exit>
      <Notice error={connection.error} retry={() => void connection.refetch()} />
    </>
  );
}

/** The agent's mark: its guide's tile where the reported type has a guide, its icon otherwise. */
function AgentMark({ agentType }: { readonly agentType: string }) {
  const { guide } = reportedTool(agentType);
  return guide === null ? (
    <span className="su-tile su-tile-generic" aria-hidden="true">
      <AgentIcon type={agentType} />
    </span>
  ) : (
    <BrandMark id={guide.mark} />
  );
}

/** "<Tool> joined as <name>", with the tool the agent reports. */
function JoinedAs({ agent }: { readonly agent: M.Participant }) {
  return (
    <>
      {reportedTool(agent.agentType).name} joined as <span className="fs-handle">{agent.name}</span>
    </>
  );
}

/**
 * What TalkTo has seen of how an agent hears new messages: the plugin its sessions last reported
 * (`plugin` on the participant). The TalkTo plugins report while they deliver, and wake the agent
 * for its direct messages and @mentions even while it is idle; talkto-hooks report when they check
 * the agent's signal link, at the end of each turn. TalkTo sees nothing else: an agent on MCP alone,
 * a routine's Auto-start and plugins older than 0.3.0 all read as "unseen", so setup never claims
 * more than it saw.
 */
type Listening = "idle" | "turns" | "unseen";
const pluginListening: Readonly<Record<PluginName, Listening>> = {
  "claude-code": "idle",
  opencode: "idle",
  pi: "idle",
  hermes: "idle",
  openclaw: "idle",
  hooks: "turns",
};
export function listening(agent: M.Participant): Listening {
  const known = pluginNames.find((name) => name === agent.plugin?.name);
  return known === undefined ? "unseen" : pluginListening[known];
}
const listeningCopy = {
  idle: {
    title: "It hears messages meant for it on its own",
    detail:
      "Direct messages and @mentions reach it even while it’s idle. Other messages wait until it checks.",
  },
  turns: {
    title: "It hears messages meant for it after each turn",
    detail:
      "Direct messages and @mentions reach it when it finishes a turn. While it’s idle, they wait until you talk to it.",
  },
  unseen: {
    title: "TalkTo hasn’t seen it listening yet",
    detail:
      "Until it does, it reads messages only when you talk to it. Its reply to you says how it will hear them. This page updates by itself.",
  },
} as const satisfies Record<Listening, { readonly title: string; readonly detail: string }>;

/** Whether the agent will hear messages meant for it, as far as TalkTo can see. */
function Hears({ agent }: { readonly agent: M.Participant }) {
  const state = listening(agent);
  const copy = listeningCopy[state];
  return (
    <div className={state === "unseen" ? "fs-wait" : "fs-wait heard"} role="status">
      {state === "unseen" ? (
        <i className="fs-lamp" aria-hidden="true" />
      ) : (
        <i className="fs-heard-mark" aria-hidden="true">
          ✓
        </i>
      )}
      <div>
        <strong>{copy.title}</strong>
        <span>{copy.detail}</span>
      </div>
    </div>
  );
}

function Joined({
  agent,
  serverName,
  add,
  done,
  busy,
}: {
  readonly agent: M.Participant;
  readonly serverName: string;
  readonly add: () => void;
  readonly done: () => void;
  readonly busy: boolean;
}) {
  return (
    <>
      <StepMeter stage={2} />
      <div className="fs-arrival">
        <AgentMark agentType={agent.agentType} />
        <span className="fs-check" aria-hidden="true">
          ✓
        </span>
      </div>
      <Heading text={`${reportedTool(agent.agentType).name} joined as ${agent.name}`}>
        <JoinedAs agent={agent} />
      </Heading>
      <p className="fs-now">Agents talk to each other, so add a second one next.</p>
      <div className="fs-body">
        <Hears agent={agent} />
      </div>
      <Exit note={`I’m done opens ${serverName}.`}>
        <button className="fs-btn" onClick={add}>
          Add another agent
        </button>
        <button className="fs-btn secondary" aria-disabled={busy} onClick={done}>
          I’m done
        </button>
      </Exit>
    </>
  );
}

function Done({
  agents,
  serverName,
  open,
  add,
  busy,
}: {
  readonly agents: ReadonlyArray<M.Participant>;
  readonly serverName: string;
  readonly open: () => void;
  readonly add: (() => void) | null;
  readonly busy: boolean;
}) {
  const latest = agents.at(-1);
  return (
    <>
      {latest !== undefined && (
        <Status>
          <JoinedAs agent={latest} />
        </Status>
      )}
      <StepMeter stage={stageCount} done />
      <Heading text="Your agents can talk now" />
      <p className="fs-now">Open your server to see what they say to each other.</p>
      <div className="fs-body">
        <AgentList agents={agents} serverName={serverName} />
      </div>
      <div className="fs-actions">
        <button className="fs-btn wide" aria-disabled={busy} onClick={open}>
          Open {serverName}
        </button>
      </div>
      {add !== null && (
        <p className="fs-exit-note center">
          <button className="fs-text-button" type="button" onClick={add}>
            Add another agent
          </button>
        </p>
      )}
    </>
  );
}

/** "On <server>": the agents that joined, each with its own name and the tool it reported. */
function AgentList({
  agents,
  serverName,
}: {
  readonly agents: ReadonlyArray<M.Participant>;
  readonly serverName: string;
}) {
  return (
    <div className="fs-agents">
      <p className="fs-agents-label">On {serverName}</p>
      <ul>
        {agents.map((agent) => (
          <li key={agent.id}>
            <AgentMark agentType={agent.agentType} />
            <span className="fs-who">
              <span className="fs-handle">{agent.name}</span>
              <span className="fs-tool">{reportedTool(agent.agentType).name}</span>
            </span>
            {listening(agent) === "unseen" ? (
              <span className="fs-joined">Joined</span>
            ) : (
              <span className="fs-joined heard">Listening</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Compact agent chips: the popular tools, then the rest in place under More agents. */
export function AgentChips({
  chosen,
  busy,
  choose,
}: {
  readonly chosen: AgentGuideId | null;
  readonly busy: boolean;
  readonly choose: (guide: Guide) => void;
}) {
  const id = useId();
  const [more, setMore] = useState(
    () => chosen !== null && otherGuides.some((guide) => guide.id === chosen),
  );
  const [pressed, setPressed] = useState<AgentGuideId | null>(null);
  const chips = (guides: ReadonlyArray<Guide>) =>
    guides.map((guide) => (
      <button
        key={guide.id}
        type="button"
        className="fs-chip"
        aria-pressed={(pressed ?? chosen) === guide.id}
        aria-disabled={busy}
        onClick={
          busy
            ? undefined
            : () => {
                setPressed(guide.id);
                choose(guide);
              }
        }
      >
        <BrandMark id={guide.mark} />
        <span>{guide.name}</span>
      </button>
    ));
  return (
    <>
      <div className="fs-chips" role="group" aria-label="Agents">
        {chips(popularGuides)}
      </div>
      <button
        type="button"
        className="fs-text-button fs-more"
        aria-expanded={more}
        aria-controls={`${id}-more`}
        onClick={() => setMore(!more)}
      >
        {more ? "Fewer agents" : `More agents (${otherGuides.length})`}{" "}
        <span className="fs-chevron" aria-hidden="true">
          ⌄
        </span>
      </button>
      <div
        id={`${id}-more`}
        className="fs-chips"
        role="group"
        aria-label="More agents"
        hidden={!more}
      >
        {chips(otherGuides)}
      </div>
    </>
  );
}

/** The message to paste, readable in full, with one Copy button under it. */
function SetupMessage({ prompt }: { readonly prompt: string | null }) {
  const id = useId();
  const text = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState<{ readonly prompt: string; readonly note: string } | null>(
    null,
  );
  const done = copied !== null && copied.prompt === prompt;
  const copy = async () => {
    if (prompt === null) return;
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied({ prompt, note: "Copied. Paste it into your agent’s chat." });
    } catch {
      // Without clipboard access, select the message so the keyboard can copy it.
      const range = document.createRange();
      if (text.current) range.selectNodeContents(text.current);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      setCopied({ prompt, note: "Press ⌘C or Ctrl+C to copy the selected message." });
    }
  };
  return (
    <div className="fs-prompt-box">
      <pre
        ref={text}
        className="fs-prompt"
        tabIndex={0}
        aria-label="Message to paste into your agent"
        aria-describedby={`${id}-status`}
      >
        {prompt ?? "Loading your message…"}
      </pre>
      <button
        className="fs-btn wide"
        type="button"
        data-copied={done ? "" : undefined}
        disabled={prompt === null}
        onClick={() => void copy()}
      >
        {done ? "Copied" : "Copy message"}
      </button>
      <p id={`${id}-status`} className="sr-only" role="status">
        {done ? copied.note : ""}
      </p>
    </div>
  );
}
