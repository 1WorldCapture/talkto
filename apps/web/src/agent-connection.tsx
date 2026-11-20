import { useEffect, useRef, useState } from "react";
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
  findGuide,
  guideAgentType,
  JoinStep,
  asksSameMachine,
  markInstalled,
  SameMachine,
  type Guide,
} from "./agent-flow.js";
import { toolName, Walkthrough } from "./agent-walkthrough.js";
import { AutoStartPanel } from "./agent-wakes.js";
import "./agent-connection.css";

type Stage =
  | { readonly kind: "pick" }
  | { readonly kind: "same"; readonly agent: Guide }
  | { readonly kind: "walk"; readonly agent: Guide; readonly skipInstall: boolean }
  | { readonly kind: "join" };

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

/**
 * Connect agents: pick the agent from onboarding's grid, then its walkthrough
 * (agent-walkthrough.tsx) full screen: the plan first, then one step at a time, ending on
 * Auto-start right here when it answers on its own. "Skip to the prompt" keeps the plain join
 * prompt for someone who has done this before.
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
  // The server's agents when the dialog opened, so the one that joins during it stands out.
  const [before, setBefore] = useState<ReadonlySet<string> | null>(null);
  const walking = stage.kind === "walk";
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
    refetchInterval: (query) => {
      if (!walking || before === null) return false;
      const items = query.state.data?.data.items ?? [];
      return items.some((agent) => !before.has(agent.id)) ? false : 4000;
    },
  });
  const items = agents.data?.data.items;
  useEffect(() => {
    if (before === null && items !== undefined) setBefore(new Set(items.map((agent) => agent.id)));
  }, [before, items]);
  const arrivals =
    before === null ? [] : (items ?? []).filter((agent) => !before.has(agent.id) && !agent.kind);
  const joinedAs = (guide: Guide) => {
    const type = guideAgentType[guide.id];
    return arrivals.find((agent) => agent.agentType === type) ?? arrivals.at(0) ?? null;
  };
  const go = (next: Stage) => {
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
          <div className="connect-pick">
            <p className="connect-question">Which agent are you connecting?</p>
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
            <p className="connect-quiet">
              <span>
                Done this before?{" "}
                <button type="button" className="text-button" onClick={() => go({ kind: "join" })}>
                  Skip to the join prompt
                </button>
              </span>
              <a href={agentsIndexUrl} target="_blank" rel="noopener noreferrer">
                All agents ↗
              </a>
            </p>
          </div>
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
              joined={joinedAs(stage.agent)}
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
            <JoinStep
              guide={null}
              mcpUrl={mcpUrl}
              serverName={server.name}
              prompt={prompt}
              copyClassName="btn"
              level={3}
              reveal
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
