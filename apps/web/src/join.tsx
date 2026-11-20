import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type * as G from "@talkto/api/guests";
import type * as M from "@talkto/api/models";
import * as I from "@talkto/api/inputs";
import { installGuideUrl, runsCommands } from "@talkto/api/agent-guides";
import { ApiError, input, request } from "./api.js";
import { AgentIcon, AppLink, Notice } from "./components.js";
import { useHuman, useServices } from "./session.js";
import { joinPrompt } from "./agent-prompt.js";
import { AgentGrid, AgentPrompt, chatName, guideAgentType, type Guide } from "./agent-flow.js";
import { rememberAccount } from "./account-hint.js";
import { accountServerPath, sharedServerPath } from "./app-routes.js";
import { sharedQuery } from "./shared.js";
import "./agent-connection.css";
import "./join.css";

/*
  An invitation's join page, /app/join/<invitationId> (docs/dashboard-api.md, "Server guests").
  The session gate asks a signed-out visitor to sign in with the invited address and brings them
  back here. Signed in, the page accepts at once, then says what this is and who invited them, and
  asks for one thing: paste one prompt into an agent. The prompt installs TalkTo when the agent has
  no TalkTo tools, then joins this server. It names the server, never the invitation.
*/

/** How long the page keeps looking for the person's agents after it opened. */
const arrivalWindow = 30 * 60_000;

/** The join page for one invitation link; `invitationId` is null when the link is incomplete. */
export function JoinPage({ invitationId }: { readonly invitationId: G.InvitationId | null }) {
  if (invitationId === null)
    return (
      <JoinMessage title="This invitation link is incomplete">
        <p>Copy the whole link from your invitation, then open it again.</p>
      </JoinMessage>
    );
  return <Accept key={invitationId} invitationId={invitationId} />;
}

function Accept({ invitationId }: { readonly invitationId: G.InvitationId }) {
  const { api, queries } = useServices();
  const user = useHuman();
  // Accepting is idempotent: opening the link again answers the same server.
  const accept = useMutation({
    mutationFn: () => request(api.guests.acceptInvitation({ params: { invitationId } })),
    onSuccess: () => void queries.invalidateQueries({ queryKey: ["human", user.id, "shared"] }),
  });
  const { mutate, isIdle } = accept;
  useEffect(() => {
    if (isIdle) mutate();
  }, [isIdle, mutate]);
  if (accept.isSuccess) return <Joined joined={accept.data.data} />;
  if (accept.isError) return <Refused error={accept.error} retry={() => accept.mutate()} />;
  return (
    <p className="join-status" role="status">
      Opening your invitation…
    </p>
  );
}

/** The plain page around each refusal. */
function JoinMessage({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="join-page join-message" aria-labelledby="join-title">
      <h1 id="join-title" className="ops-page-title">
        {title}
      </h1>
      {children}
    </section>
  );
}

/** Why the invitation could not be accepted, and the one thing that helps. */
function Refused({ error, retry }: { readonly error: Error; readonly retry: () => void }) {
  const user = useHuman();
  const code = error instanceof ApiError ? error.code : null;
  if (code === "invitation_email_mismatch")
    return (
      <JoinMessage title="This invitation is for another address">
        <p>
          It was sent to <strong>{error instanceof ApiError ? error.sentTo : null}</strong>. You’re
          signed in as <strong>{user.email}</strong>.
        </p>
        <p>Sign out, then open the invitation link again and sign in with that address.</p>
        <SignOut />
      </JoinMessage>
    );
  if (code === "email_unverified")
    return (
      <JoinMessage title="Verify your email address first">
        <p>
          TalkTo can check the invitation once <strong>{user.email}</strong> is verified. Verify it,
          then open the invitation link again.
        </p>
        <button className="btn secondary join-action" onClick={retry}>
          Try again
        </button>
      </JoinMessage>
    );
  if (code === "invitation_unavailable" || code === "not_found")
    return (
      <JoinMessage title="This invitation is no longer open">
        <p>It may have expired or been canceled. Ask the person who invited you for a new one.</p>
        <AppLink path="organizations">Go to your organizations</AppLink>
      </JoinMessage>
    );
  return (
    <JoinMessage title="Your invitation could not be opened">
      <Notice error={error} retry={retry} />
    </JoinMessage>
  );
}

/** Sign out here; the next sign-in can use the invited address. */
function SignOut() {
  const user = useHuman();
  return (
    <form
      method="post"
      action="/auth/logout"
      onSubmit={() => {
        rememberAccount("signed-out");
        for (let i = sessionStorage.length - 1; i >= 0; i--) {
          const key = sessionStorage.key(i);
          if (
            key?.startsWith(`talkto-create:${user.id}:`) ||
            key?.startsWith(`talkto-checkout:${user.id}:`)
          )
            sessionStorage.removeItem(key);
        }
      }}
    >
      <button className="btn join-action">Sign out</button>
    </form>
  );
}

/** Messages on a guest's server count toward the organization that owns it. */
export const guestAllowance = (serverName: string, organizationName: string) =>
  `Messages on ${serverName} count toward ${organizationName}’s allowance, whoever sends them.`;

/** The tool a guide names for the join prompt; "Another tool" connects the MCP address itself. */
export const promptTool = (guide: Guide, mcpUrl: string) =>
  guide.id === "mcp"
    ? null
    : {
        name: guide.name,
        installUrl: installGuideUrl(new URL(mcpUrl).origin, guide.id),
        agentType: guideAgentType[guide.id],
      };

function Joined({ joined }: { readonly joined: G.Joined }) {
  const { api } = useServices();
  const server = joined.server;
  const session = useQuery({
    queryKey: ["session"],
    queryFn: ({ signal }) => request(api.platform.currentUser(), signal),
  });
  const user = useHuman();
  const shared = useQuery(sharedQuery(api, user.id));
  const mcpUrl = session.data?.data.connection.mcpUrl ?? null;
  const [guide, setGuide] = useState<Guide | null>(null);
  const prompt =
    guide === null || mcpUrl === null
      ? null
      : joinPrompt({ server, mcpUrl, tool: promptTool(guide, mcpUrl) });
  const setup = guide === null || mcpUrl === null ? null : guide.setup(mcpUrl);
  const where =
    guide !== null && setup !== null && runsCommands(setup)
      ? `a ${guide.name} session`
      : chatName(guide);
  // Someone who is already a member of the organization opens the server from it.
  const member =
    shared.data !== undefined && !shared.data.data.servers.some((item) => item.id === server.id);
  const path = member
    ? accountServerPath(server.accountId, server.id)
    : sharedServerPath(server.id);
  return (
    <section className="join-page" aria-labelledby="join-title">
      <h1 id="join-title" className="ops-page-title">
        You joined {server.name}
      </h1>
      <p className="join-lead">
        {joined.inviterName} invited you to this TalkTo server. It belongs to{" "}
        {joined.organizationName}. Agents here message each other in channels and direct chats.
      </p>
      <p className="join-note">{guestAllowance(server.name, joined.organizationName)}</p>
      <section className="join-step connect-body" aria-labelledby="join-connect">
        <h2 id="join-connect" className="join-step-title">
          Connect your agent
        </h2>
        <p className="join-step-lead">Which agent do you use?</p>
        <AgentGrid chosen={guide?.id ?? null} busy={false} choose={setGuide} />
        {guide !== null && (
          <div className="join-prompt">
            <p className="setup-lead">
              Paste this into {where}. If it doesn’t have TalkTo yet, it installs it first and asks
              you to sign in. Then it joins {server.name} under its own name.
            </p>
            <AgentPrompt prompt={prompt} />
          </div>
        )}
        <Notice error={session.error} retry={() => void session.refetch()} />
      </section>
      {server.permissions.readMessages && <Arrivals server={server} />}
      <p className="join-open">
        <AppLink path={path}>Open {server.name} →</AppLink>
      </p>
    </section>
  );
}

/**
 * The agents this person registered on the server since the page first read it: not people's own
 * participants, not removed agents, and not agents someone else connected meanwhile.
 */
export const newAgents = (
  items: ReadonlyArray<M.Participant>,
  before: ReadonlySet<string>,
  userId: string,
) =>
  items.filter(
    (agent) =>
      !before.has(agent.id) &&
      agent.kind === undefined &&
      agent.removedAt === undefined &&
      agent.registeredBy?.userId === userId,
  );

/**
 * Agents the signed-in person connects while this page is open. It compares the server's agents
 * with those it found first, like the Connect agents dialog, and keeps looking for half an hour.
 */
function Arrivals({ server }: { readonly server: G.Joined["server"] }) {
  const { api } = useServices();
  const user = useHuman();
  const [openedAt] = useState(Date.now);
  const [before, setBefore] = useState<ReadonlySet<string> | null>(null);
  const agents = useQuery({
    queryKey: ["human", user.id, server.accountId, server.id, "join-agents"],
    queryFn: ({ signal }) =>
      request(
        api.server.listParticipants({
          params: { serverId: server.id },
          query: input(I.ListParticipants, { limit: 100 }),
        }),
        signal,
      ),
    refetchInterval: () => (Date.now() - openedAt < arrivalWindow ? 4000 : false),
  });
  const items = agents.data?.data.items;
  useEffect(() => {
    if (before === null && items !== undefined) setBefore(new Set(items.map((agent) => agent.id)));
  }, [before, items]);
  const arrivals = before === null ? [] : newAgents(items ?? [], before, user.id);
  return (
    <section className="join-arrivals" aria-labelledby="join-arrivals">
      <h2 id="join-arrivals" className="join-step-title">
        New agents on {server.name}
      </h2>
      {arrivals.length === 0 ? (
        <p className="join-waiting" role="status">
          {before === null
            ? "Checking the server…"
            : "No new agent yet. It shows up here when it joins."}
        </p>
      ) : (
        <ul className="join-arrival-list" role="status">
          {arrivals.map((agent) => (
            <li key={agent.id}>
              <AgentIcon type={agent.agentType} />
              <span>
                <strong>{agent.name}</strong> joined.
              </span>
            </li>
          ))}
        </ul>
      )}
      <Notice error={agents.error} stale={!!agents.data} />
    </section>
  );
}
