import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type * as P from "@talkto/api/platform";
import * as I from "@talkto/api/inputs";
import { input, request } from "./api.js";
import { Dialog, Notice } from "./components.js";
import { useHuman, useServices } from "./session.js";
import { agentPrompt } from "./agent-prompt.js";
import { agentsIndexUrl, type AgentGuideId } from "./landing-parts.js";
import {
  AgentGrid,
  CopyNowButton,
  findGuide,
  guideAgentType,
  JoinStep,
  asksSameMachine,
  markInstalled,
  SameMachine,
  useCopy,
  type Guide,
} from "./agent-flow.js";
import { toolName, Walkthrough } from "./agent-walkthrough.js";
import { AutoStartPanel } from "./agent-wakes.js";
import { arrival, settleBaseline, startBaseline } from "./join-watch.js";
import "./agent-connection.css";

type Stage =
  | { readonly kind: "pick" }
  | { readonly kind: "same"; readonly agent: Guide }
  | { readonly kind: "walk"; readonly agent: Guide; readonly skipInstall: boolean }
  /** `refused`: the browser would not copy, so the prompt is shown to select. */
  | { readonly kind: "join"; readonly refused?: boolean };

/** The last agent chosen here, so connecting a second agent of the same kind starts on it. */
const lastAgentKey = "talkto-connect-agent";
function lastAgent(): Guide | null {
  try {
    return findGuide(localStorage.getItem(lastAgentKey) ?? undefined);
  } catch {
    return null;
  }
}
function rememberAgent(id: AgentGuideId) {
  try {
    localStorage.setItem(lastAgentKey, id);
  } catch {
    // Private windows can refuse storage; the dialog then starts without a choice.
  }
}

/** People and other non-agent members never count as the agent being connected. */
const isAgent = (participant: { readonly kind?: unknown }) => !participant.kind;

/**
 * Connect agents: pick the agent from onboarding's grid, then its walkthrough
 * (agent-walkthrough.tsx) full screen: the plan first, then one step at a time, ending on
 * Auto-start right here when it answers on its own, or on the TalkTo hooks for a tool that has
 * them. An agent that already has TalkTo copies the join prompt from the top of the first screen.
 */
export function ConnectAgentsDialog({
  server,
  close,
}: {
  readonly server: P.ServerContext;
  readonly close: () => void;
}) {
  const { api } = useServices();
  const user = useHuman();
  const connection = useQuery({
    queryKey: ["session"],
    queryFn: ({ signal }) => request(api.platform.currentUser(), signal),
  });
  const mcpUrl = connection.data ? connection.data.data.connection.mcpUrl : null;
  const prompt = mcpUrl === null ? null : agentPrompt({ server, mcpUrl });
  const [initial] = useState(lastAgent);
  const [stage, setStage] = useState<Stage>({ kind: "pick" });
  // "Answers on its own" is the default; this is the agent the person chose "Answers when you ask
  // it" for instead.
  const [askFor, setAskFor] = useState<string | null>(null);
  const waking = (agent: Guide) => askFor !== agent.id;
  // The server's agents when this walkthrough started, so the one that joins during it stands out.
  const [baseline, setBaseline] = useState(() => startBaseline(Date.now()));
  const agents = useQuery({
    queryKey: ["human", user.id, server.accountId, server.id, "connect-agents"],
    queryFn: ({ signal }) =>
      request(
        api.server.listParticipants({
          params: { serverId: server.id },
          query: input(I.ListParticipants, { limit: 100 }),
        }),
        signal,
      ),
    // Until the agent being connected joins, including while the baseline waits for a list
    // fetched since its walkthrough started.
    refetchInterval: (query) =>
      stage.kind === "walk" &&
      arrival(
        baseline,
        query.state.data?.data.items ?? [],
        guideAgentType[stage.agent.id],
        isAgent,
      ) === null
        ? 4000
        : false,
  });
  const items = agents.data?.data.items;
  const updatedAt = agents.dataUpdatedAt;
  useEffect(() => {
    if (items === undefined) return;
    const ids = items.map((agent) => agent.id);
    setBaseline((current) => settleBaseline(current, { updatedAt, ids }));
  }, [items, updatedAt]);
  const joined =
    stage.kind === "walk"
      ? arrival(baseline, items ?? [], guideAgentType[stage.agent.id], isAgent)
      : null;
  const go = (next: Stage) => {
    // Each walkthrough waits for its own agent: one connected earlier never counts as this one.
    if (next.kind === "walk") {
      setBaseline(startBaseline(Date.now()));
      void agents.refetch();
    }
    setStage(next);
    body.current?.closest("dialog")?.scrollTo({ top: 0 });
  };
  const body = useRef<HTMLDivElement>(null);
  const chosen = stage.kind === "pick" || stage.kind === "join" ? initial : stage.agent;
  const title =
    stage.kind === "walk" || stage.kind === "same"
      ? `Connect ${toolName(stage.agent)} to ${server.name}`
      : "Connect agents";
  return (
    <Dialog title={title} className="connect-dialog" close={close}>
      <div ref={body} className="connect-body" data-stage={stage.kind}>
        {stage.kind === "pick" ? (
          <PickStage
            server={server}
            prompt={prompt}
            grid={
              <AgentGrid
                chosen={chosen?.id ?? null}
                busy={false}
                choose={(agent) => {
                  rememberAgent(agent.id);
                  go(
                    asksSameMachine(agent, mcpUrl)
                      ? { kind: "same", agent }
                      : { kind: "walk", agent, skipInstall: false },
                  );
                }}
              />
            }
            join={(refused) => go({ kind: "join", refused })}
          />
        ) : stage.kind === "same" ? (
          <div className="connect-pick">
            <SameMachine
              guide={stage.agent}
              level={3}
              yes={() => go({ kind: "walk", agent: stage.agent, skipInstall: true })}
              no={() => go({ kind: "walk", agent: stage.agent, skipInstall: false })}
              yesClassName="btn connect-next"
              noClassName="btn secondary"
            />
            <button
              type="button"
              className="text-button connect-back"
              onClick={() => go({ kind: "pick" })}
            >
              ← Other agents
            </button>
          </div>
        ) : stage.kind === "walk" ? (
          mcpUrl === null ? (
            <p className="inline-note" role="status">
              Loading your TalkTo address…
            </p>
          ) : (
            <Walkthrough
              key={`${stage.agent.id}-${stage.skipInstall}`}
              guide={stage.agent}
              mcpUrl={mcpUrl}
              serverName={server.name}
              prompt={prompt}
              waking={waking(stage.agent)}
              setWaking={(on) => setAskFor(on ? null : stage.agent.id)}
              switchGuide={(agent) => {
                rememberAgent(agent.id);
                go({ kind: "walk", agent, skipInstall: false });
              }}
              joined={joined}
              check={() => void agents.refetch()}
              skipInstall={stage.skipInstall}
              installed={() => markInstalled(stage.agent)}
              autoStart={(agent) => (
                <AutoStartPanel accountId={server.accountId} serverId={server.id} agent={agent} />
              )}
              finish={close}
              chooseAnother={() => go({ kind: "pick" })}
              secondaryClassName="btn secondary"
            />
          )
        ) : (
          <div className="connect-pick">
            <button
              type="button"
              className="text-button connect-back"
              onClick={() => go({ kind: "pick" })}
            >
              ← All agents
            </button>
            {stage.refused === true && (
              <p className="flow-reminder connect-refused" role="alert">
                Your browser didn’t allow copying. Select the prompt below and press ⌘C or Ctrl+C.
              </p>
            )}
            <JoinStep
              guide={null}
              mcpUrl={mcpUrl}
              serverName={server.name}
              prompt={prompt}
              copyClassName="btn"
              level={3}
              reveal={stage.refused !== true}
            >
              <p className="connect-quiet">It then shows up under Agents.</p>
            </JoinStep>
          </div>
        )}
      </div>
      <Notice error={connection.error} retry={() => void connection.refetch()} />
    </Dialog>
  );
}

/**
 * The first screen. An agent that already has TalkTo only needs the join prompt, so it leads, one
 * click to copy (owner, November 23, 2026: "more obvious that for already connected agents I can
 * just copy the prompt"); a new agent starts from the grid below. "See the prompt" opens the
 * prompt's own page, and so does a refused copy, with the text there to select.
 */
function PickStage({
  server,
  prompt,
  grid,
  join,
}: {
  readonly server: P.ServerContext;
  /** The join prompt; null while the TalkTo address loads. */
  readonly prompt: string | null;
  readonly grid: ReactNode;
  /** Opens the join prompt's page; `refused` when copying failed. */
  readonly join: (refused: boolean) => void;
}) {
  const copier = useCopy(prompt);
  const id = useId();
  useEffect(() => {
    if (copier.state === "refused") join(true);
  }, [copier.state, join]);
  return (
    <div className="connect-pick">
      <section className="connect-copy-bar" aria-labelledby={`${id}-copy`}>
        <div className="connect-copy-text">
          <p className="connect-copy-title" id={`${id}-copy`}>
            Agent already connected to TalkTo?
          </p>
          <p className="connect-copy-lead" role="status">
            {copier.state === "copied"
              ? `Copied. Paste it into your agent’s chat to join ${server.name}.`
              : prompt === null
                ? "Loading your TalkTo address…"
                : "Paste the join prompt into it."}
          </p>
        </div>
        <div className="connect-copy-actions">
          <CopyNowButton
            copier={copier}
            ready={prompt !== null}
            label="Copy join prompt"
            className="btn"
          />
          <button type="button" className="text-button" onClick={() => join(false)}>
            See the prompt
          </button>
        </div>
      </section>
      <p className="connect-question">Or set up a new agent:</p>
      {grid}
      <p className="connect-quiet">
        <span />
        <a href={agentsIndexUrl} target="_blank" rel="noopener noreferrer">
          All agents ↗
        </a>
      </p>
    </div>
  );
}
