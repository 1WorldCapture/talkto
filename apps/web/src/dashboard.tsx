import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Navigate, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { Option, Schema } from "effect";
import * as P from "@talkto/api/platform";
import type * as A from "@talkto/api/account";
import * as M from "@talkto/api/models";
import { describeAgentType } from "@talkto/api/agent-types";
import * as I from "@talkto/api/inputs";
import type * as D from "@talkto/api/dashboard";
import { request, denied, input } from "./api.js";
import { rememberAccount } from "./account-hint.js";
import {
  AgentIcon,
  AppLink,
  ClampedText,
  Dialog,
  Notice,
  OrganizationIcon,
  Pagination,
  ParticipantMark,
  Search,
} from "./components.js";
import { MessageAgent } from "./person-chat.js";
import { ThemeControl, ThemeToggle } from "./theme.js";
import {
  AccessDialog,
  Accounts,
  CreateDialog,
  Empty,
  Members,
  Recovery,
  displayUser,
  useAccounts,
} from "./management.js";
import { SessionGate, useHuman, useServices } from "./session.js";
import { Activity, type InitialFeed } from "./activity.js";
import { readPreferences } from "./message-preferences.js";
import {
  homeQuery,
  managedServerQuery,
  memberServerQuery,
  starterQuery,
} from "./dashboard-queries.js";
import { ActivityTimeline } from "./activity-timeline.js";
import { formatActivityTime } from "./activity-time.js";
import {
  ConversationSelection,
  DirectChats,
  conversationTab,
  useConversationSelection,
} from "./conversations.js";
import { useInspection } from "./inspection.js";
import { BillingPage } from "./billing.js";
import { StarterHome } from "./starter.js";
import { ShareJoin } from "./share.js";
import "./dashboard.css";
import { useOnboardingState } from "./onboarding-state.js";
import { ServerSettings } from "./server-settings.js";
import { OrganizationSettings } from "./organization-settings.js";
import { ServerRenameNotices } from "./rename-name.js";
import { ServerTransfers } from "./server-transfers.js";
import { ServerInvites } from "./server-invites.js";
import { ConnectAgentsDialog } from "./agent-connection.js";
import { AutoStartInfo, WakesDialog, cadencePhrase } from "./agent-wakes.js";
import { PluginUpdate } from "./plugin-update.js";
import { RenameDialog, RenameNotices, earlierNames, useRenames } from "./agent-renames.js";
import { RemovalNotices, RemoveAgentDialog, RemovedTag, RestoreAgent } from "./agent-removals.js";
import { formatCount } from "./format.js";
import { AccountDeleted, AccountDeletedPanel, AccountSettings } from "./account.js";
import { SignedInComputers } from "./sign-ins.js";
import { ApiKeys } from "./api-keys.js";
import { FeedbackDialog } from "./feedback.js";
import type * as G from "@talkto/api/guests";
import { dashboardRoute, entryTarget, memberServerPath, sharedServerPath } from "./app-routes.js";
import { JoinPage } from "./join.js";
import { SharedWithYou, useShared } from "./shared.js";
import { SharedServerView, useServerPath } from "./server-path.js";
import { Board, TaskPage } from "./board.js";
import { parseTaskNumber } from "./board-model.js";

/** Authenticated Cards dashboard; every route remounts its local inspection state by scope. */
export function Dashboard() {
  // After deletion the session is gone; show the result without any authenticated view.
  const [deleted, setDeleted] = useState<A.DeletedAccount["status"] | null>(null);
  if (deleted !== null) return <AccountDeletedPanel status={deleted} />;
  return (
    <AccountDeleted.Provider value={setDeleted}>
      <SessionGate>
        <DashboardShell />
      </SessionGate>
    </AccountDeleted.Provider>
  );
}

function DashboardShell() {
  const { api } = useServices();
  const user = useHuman();
  const navigate = useNavigate();
  const path = useLocation({ select: (location) => location.pathname });
  const search = useSearch({ strict: false });
  const segments = path.split("/").filter(Boolean);
  const route = dashboardRoute(path);
  const accountId = route.kind === "account" ? route.accountId : undefined;
  const [dialog, setDialog] = useState<
    "accounts" | "create-account" | "profile" | "connect" | "feedback" | null
  >(null);
  // Public pages read this before their first paint to show "Dashboard" instead of "Sign in".
  useEffect(() => rememberAccount("signed-in"), []);
  const connection = useQuery({
    queryKey: ["session"],
    queryFn: ({ signal }) => request(api.platform.currentUser(), signal),
  });
  const go = (target: string) => {
    setDialog(null);
    void navigate({ to: "/app/$", params: { _splat: target }, search: {} });
  };
  const menu = useNarrowMenu();
  // The public footer links to /app?feedback=1. The entry page forwards the parameter to the
  // page the person lands on; that page opens the dialog once and drops the parameter.
  const asked = search.feedback !== undefined && segments.length > 1;
  useEffect(() => {
    if (!asked) return;
    setDialog("feedback");
    void navigate({
      to: "/app/$",
      params: { _splat: path.split("/").filter(Boolean).slice(1).join("/") },
      search: { ...search, feedback: undefined },
      replace: true,
    });
  }, [asked, navigate, path, search]);
  return (
    <section
      className="ops-console"
      aria-label="TalkTo dashboard"
      ref={menu.root}
      data-menu={menu.open ? "open" : undefined}
    >
      <header className="ops-titlebar">
        <a className="brand" href="/">
          talkto
        </a>
        <button
          ref={menu.button}
          type="button"
          className="ops-menu-button"
          aria-expanded={menu.open}
          onClick={menu.toggle}
        >
          <span className="ops-menu-icon" aria-hidden="true" />
          Menu
        </button>
        <nav aria-label="Dashboard navigation">
          <ThemeToggle />
          <button onClick={() => setDialog("connect")}>Connect</button>
          <a href="/onboarding">Onboarding</a>
          <a href="/instructions">Docs</a>
          <button onClick={() => setDialog("feedback")}>Feedback</button>
          <button onClick={() => setDialog("profile")}>{displayUser(user)}</button>
        </nav>
      </header>
      {route.kind === "account" ? (
        <AccountPage
          key={route.accountId}
          id={route.accountId}
          view={route.view ?? (search.billing ? "billing" : "home")}
          serverId={route.serverId}
          task={route.task}
          chooseAccount={() => setDialog("accounts")}
        />
      ) : route.kind === "join" ? (
        <JoinPage invitationId={route.invitationId} />
      ) : route.kind === "shared" ? (
        <SharedServerPage key={route.serverId} serverId={route.serverId} task={route.task} />
      ) : route.kind === "account-settings" ? (
        <AccountSettings />
      ) : route.kind === "sign-ins" ? (
        <SignedInComputers />
      ) : route.kind === "api-keys" ? (
        <ApiKeys />
      ) : route.kind === "entry" ? (
        <OrganizationEntry create={() => setDialog("create-account")} />
      ) : (
        <OrganizationDirectory create={() => setDialog("create-account")} />
      )}
      <button type="button" className="ops-rail-feedback" onClick={() => setDialog("feedback")}>
        <span>Feedback</span>
      </button>
      {dialog === "accounts" && (
        <Dialog title="Switch organization" close={() => setDialog(null)}>
          <div
            onClick={(event) => {
              if (event.target instanceof Element && event.target.closest("a")) setDialog(null);
            }}
          >
            <Accounts selected={accountId} presentation="list" />
          </div>
          <button className="text-button" onClick={() => setDialog("create-account")}>
            Create organization
          </button>
        </Dialog>
      )}
      {dialog === "create-account" && <CreateDialog close={() => setDialog(null)} created={go} />}
      {dialog === "connect" && (
        <Dialog title="Connect your agents" close={() => setDialog(null)}>
          <p>
            Add this URL to your agent client’s MCP connections. Follow its browser sign-in link.
          </p>
          <input
            aria-label="MCP URL"
            readOnly
            value={connection.data?.data.connection.mcpUrl ?? ""}
            onFocus={(event) => event.target.select()}
          />
          <p>Give your agent these instructions to connect and join your server.</p>
          <a href="/instructions" target="_blank" rel="noopener noreferrer">
            Connection instructions ↗
          </a>
        </Dialog>
      )}
      {dialog === "feedback" && (
        <FeedbackDialog accountId={accountId} close={() => setDialog(null)} />
      )}
      {dialog === "profile" && (
        <Dialog title={displayUser(user)} close={() => setDialog(null)}>
          <p>{user.email}</p>
          <ThemeControl />
          <div className="profile-actions">
            <button className="btn secondary" onClick={() => setDialog("accounts")}>
              <OrganizationIcon />
              Organizations
            </button>
            <button className="btn secondary" onClick={() => go("account")}>
              Account
            </button>
            <button className="btn secondary" onClick={() => go("account/sign-ins")}>
              Signed-in computers
            </button>
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
              <button className="btn secondary">Sign out</button>
            </form>
          </div>
        </Dialog>
      )}
    </section>
  );
}

/**
 * Narrow screens keep one compact bar: the dashboard, organization and server navigation sit
 * behind its Menu button. Wide screens hide the button and always show the navigation, so this
 * state has no effect there. The menu closes on navigation, on Escape and from its button.
 */
function useNarrowMenu() {
  const href = useLocation({ select: (location) => location.href });
  // The menu belongs to the page it was opened on, so any navigation closes it.
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const open = openedAt === href;
  const root = useRef<HTMLElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      root.current?.querySelector<HTMLElement>(".ops-titlebar nav :is(a, button)")?.focus();
      const close = (event: KeyboardEvent) => {
        // A dialog opened from the menu handles its own Escape and returns focus to its opener.
        if (event.key !== "Escape" || document.querySelector("dialog[open]")) return;
        setOpenedAt(null);
        button.current?.focus();
      };
      document.addEventListener("keydown", close);
      return () => document.removeEventListener("keydown", close);
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    // A link in the menu navigated and the menu hid it: return focus to the Menu button.
    const active = document.activeElement;
    if (
      !(active instanceof HTMLElement) ||
      active === document.body ||
      active.getClientRects().length === 0
    )
      button.current?.focus({ preventScroll: true });
  }, [open]);
  return {
    open,
    root,
    button,
    toggle: () => setOpenedAt(open ? null : href),
  };
}

function OrganizationDirectory({ create }: { readonly create: () => void }) {
  // Someone with no organization, such as a server guest, sees what was shared with them first.
  const first = useAccounts().data?.data;
  const guest = first !== undefined && first.items.length === 0 && first.nextCursor === null;
  return (
    <>
      <div className="ops-page-bar">
        <h1 className="ops-page-title">Organizations</h1>
        <button className="ops-new primary" onClick={create}>
          Create organization
        </button>
      </div>
      {guest && <SharedWithYou />}
      <Accounts />
      {!guest && <SharedWithYou />}
    </>
  );
}

/**
 * Skip the chooser only when a fresh, complete listing confirms a single membership. Someone with
 * no organization who has a shared server or an invitation is never sent to onboarding
 * (`entryTarget`, app-routes.ts).
 */
function OrganizationEntry({ create }: { readonly create: () => void }) {
  const result = useAccounts(undefined, true);
  const onboarding = useOnboardingState();
  const shared = useShared();
  const search = useSearch({ strict: false });
  if (
    !result.isFetchedAfterMount ||
    result.isPending ||
    !onboarding.isFetchedAfterMount ||
    onboarding.isPending ||
    shared.isPending
  )
    return <p role="status">Loading organization…</p>;
  if (result.isError)
    return (
      <>
        <Notice error={result.error} retry={() => void result.refetch()} />
        <AppLink path="organizations">All organizations</AppLink>
      </>
    );
  if (onboarding.isError)
    return (
      <>
        <Notice error={onboarding.error} retry={() => void onboarding.refetch()} />
        <OrganizationDirectory create={create} />
      </>
    );
  const page = result.data.data;
  const target = entryTarget({
    accounts: page.items,
    more: page.nextCursor !== null,
    setup: onboarding.data.data,
    shared: shared.data?.data ?? null,
    billing: search.billing !== undefined,
  });
  // A Feedback request from the public footer follows the person to where they land.
  const feedback = search.feedback === undefined ? {} : { feedback: search.feedback };
  if (target.kind === "onboarding") return <Navigate to="/onboarding" search={feedback} replace />;
  if (target.kind === "account")
    return (
      <Navigate
        to="/app/$"
        params={{ _splat: `accounts/${target.accountId}` }}
        search={search}
        replace
      />
    );
  if (target.kind === "shared")
    return (
      <Navigate
        to="/app/$"
        params={{ _splat: sharedServerPath(target.serverId) }}
        search={feedback}
        replace
      />
    );
  if (search.feedback !== undefined)
    return <Navigate to="/app/$" params={{ _splat: "organizations" }} search={search} replace />;
  // The directory's own "Shared with you" shows why the shared read failed.
  return <OrganizationDirectory create={create} />;
}

function AccountPage({
  id,
  view,
  serverId,
  task,
  chooseAccount,
}: {
  readonly id: P.AccountId;
  readonly view: string;
  readonly serverId?: string | undefined;
  /** A Board task page's last part (`T-14`). */
  readonly task?: string | undefined;
  readonly chooseAccount: () => void;
}) {
  const { api, queries } = useServices();
  const user = useHuman();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const result = useQuery({
    queryKey: ["human", user.id, id, "account"],
    queryFn: ({ signal }) =>
      request(api.platform.getAccount({ params: { accountId: id } }), signal),
  });
  const account = denied(result.error) ? undefined : result.data?.data;
  const accountDenied = denied(result.error);
  // Start the requested view alongside account lookup. Account rendering remains gated above it;
  // the shared query cache cancels and clears these requests if account access is denied.
  useEffect(() => {
    if (accountDenied) return;
    if (view === "home") {
      void queries.prefetchQuery(homeQuery(api, user.id, id, readPreferences(user.id).size));
      void queries.prefetchQuery(starterQuery(api, user.id, id));
    } else if (view === "servers" && serverId) {
      const parsed = Schema.decodeUnknownOption(M.ServerId)(serverId);
      if (Option.isSome(parsed))
        void queries.prefetchQuery(managedServerQuery(api, user.id, id, parsed.value));
    }
  }, [api, queries, user.id, id, view, serverId, accountDenied]);
  const base = `accounts/${id}`;
  if (!account)
    return (
      <>
        <Notice
          error={result.error}
          retry={() => {
            void result.refetch();
          }}
        />
        {result.isPending && (
          <p className="ops-empty" role="status">
            Loading organization…
          </p>
        )}
        <AppLink path="organizations">All organizations</AppLink>
      </>
    );
  return (
    <>
      <div className="ops-account-bar">
        <button
          className="ops-account-picker"
          onClick={chooseAccount}
          aria-label={`Switch organization, current: ${account.name}`}
          title="Switch organization"
        >
          {account.name}
        </button>
        <nav aria-label="Organization navigation">
          {[
            ["home", "Home"],
            ["servers", "Servers"],
            ["members", "Members"],
            ["billing", "Billing"],
            // The owner's organization settings: its name, for now.
            ...(account.permissions.rename ? [["settings", "Settings"]] : []),
          ].map(([key, label]) => (
            <AppLink
              key={key}
              path={key === "home" ? base : `${base}/${key}`}
              current={view === key}
            >
              {label}
            </AppLink>
          ))}
        </nav>
      </div>
      <Notice error={result.error} stale />
      <ShareJoin account={account} />
      {view === "billing" ? (
        <BillingPage accountId={id} />
      ) : view === "members" ? (
        <Members account={account} />
      ) : view === "settings" && account.permissions.rename ? (
        <OrganizationSettings account={account} />
      ) : view === "servers" && serverId ? (
        <ServerPage key={serverId} accountId={id} rawId={serverId} task={task} />
      ) : view === "servers" ? (
        <ServerDirectory account={account} create={() => setCreating(true)} />
      ) : view === "activity" ? (
        <Navigate to="/app/$" params={{ _splat: `${base}/servers` }} search={{}} replace />
      ) : view === "home" ? (
        <Home account={account} create={() => setCreating(true)} />
      ) : (
        <p className="ops-empty">Page not found.</p>
      )}
      {creating && (
        <CreateDialog
          accountId={id}
          close={() => setCreating(false)}
          created={(path) => {
            setCreating(false);
            void navigate({
              to: "/app/$",
              params: { _splat: path },
              search: { connect: "agents" },
            });
          }}
        />
      )}
    </>
  );
}

function Home({
  account,
  create,
}: {
  readonly account: P.AccountContext;
  readonly create: () => void;
}) {
  const { api } = useServices();
  const user = useHuman();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [access, setAccess] = useState<M.Server | null>(null);
  const inspecting = hovered || focused;
  const [feedLimit] = useState(() => readPreferences(user.id).size);
  const home = useQuery({
    ...homeQuery(api, user.id, account.id, feedLimit),
    refetchInterval: inspecting ? false : 30_000,
    refetchOnWindowFocus: !inspecting,
  });
  const { displayed } = useInspection(home.data, inspecting, denied(home.error));
  return (
    <div className="ops-home">
      <div className="ops-page-bar">
        <h1 className="ops-page-title">
          {displayed?.data.serverSelection === "active" ? "Most active · 30m" : "Servers"}
        </h1>
        <AppLink path={`accounts/${account.id}/servers`}>All servers →</AppLink>
        {account.permissions.createServer && (
          <button className="ops-new primary" onClick={create}>
            New server
          </button>
        )}
      </div>
      <Notice error={home.error} stale={!!home.data} />
      <StarterHome account={account} create={create} />
      <div
        className="ops-directory"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
        }}
      >
        {!denied(home.error) &&
          displayed?.data.servers.map((entry) => (
            <SummaryCard
              key={entry.summary.server.id}
              accountId={account.id}
              summary={entry.summary}
              access={
                entry.permissions.manageAccess ? () => setAccess(entry.summary.server) : undefined
              }
            />
          ))}
        {home.isPending && (
          <p role="status" className="ops-empty">
            Loading servers…
          </p>
        )}
        {displayed?.data.servers.length === 0 && (
          <p className="ops-empty">
            {displayed.data.serverSelection === "active"
              ? "No activity in the last 30 minutes."
              : "No servers to show."}{" "}
            <AppLink path={`accounts/${account.id}/servers`}>View all servers →</AppLink>
          </p>
        )}
      </div>
      {!home.isPending && (
        <FeedRoute
          accountId={account.id}
          initialFeed={
            home.data
              ? { feed: home.data.data.feed, limit: home.data.data.feedLimit ?? 50 }
              : undefined
          }
        />
      )}
      {access && (
        <AccessDialog accountId={account.id} server={access} close={() => setAccess(null)} />
      )}
    </div>
  );
}

/** Load a server's context while the pointer approaches its link; the query cache keeps one copy. */
function usePrefetchServer(accountId: P.AccountId, serverId: M.ServerId) {
  const { api, queries } = useServices();
  const user = useHuman();
  return () => void queries.prefetchQuery(managedServerQuery(api, user.id, accountId, serverId));
}

function SummaryCard({
  accountId,
  summary,
  access,
}: {
  readonly accountId: P.AccountId;
  readonly summary: D.Summary;
  readonly access?: (() => void) | undefined;
}) {
  const server = summary.server;
  const participants = summary.participants.slice(0, 6);
  const path = `accounts/${accountId}/servers/${server.id}`;
  const prefetch = usePrefetchServer(accountId, server.id);
  return (
    <article className="ops-server">
      <header className="ops-server-head">
        <h2 title={server.name}>
          <AppLink path={path} prefetch={prefetch}>
            {server.name}
          </AppLink>
        </h2>
        {access && (
          <button className="ops-access" onClick={access}>
            Access
          </button>
        )}
      </header>
      <div className="ops-channel-list">
        {summary.channels.map((channel) => (
          <span key={channel.id} title={channel.name}>
            <AppLink path={path} search={{ tab: "channels", channel: channel.id }}>
              # {channel.name}
            </AppLink>
          </span>
        ))}
        {server.channelCount > summary.channels.length && (
          <AppLink path={path} search={{ tab: "channels" }}>
            +{server.channelCount - summary.channels.length}
          </AppLink>
        )}
      </div>
      <div className="ops-agent-grid">
        {participants.map((participant) => (
          <AgentTile
            key={participant.id}
            accountId={accountId}
            serverId={server.id}
            participant={participant}
          />
        ))}
        {server.participantCount > participants.length && (
          <AppLink className="ops-overflow" path={path} search={{ tab: "agents" }}>
            +{server.participantCount - participants.length}
          </AppLink>
        )}
        {server.participantCount === 0 && <p className="ops-empty-agents">No agents registered.</p>}
      </div>
      <footer className="ops-server-foot">
        <span>{formatCount(server.participantCount, "agent")}</span>
        <span>{formatCount(server.channelCount, "channel")}</span>
      </footer>
    </article>
  );
}

function AgentTile({
  accountId,
  serverId,
  participant,
  layout = "tile",
}: {
  readonly accountId: P.AccountId;
  readonly serverId: M.ServerId;
  readonly participant: M.Participant;
  readonly layout?: "tile" | "row";
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const detail = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const inspecting = hovered || focused;
  useLayoutEffect(() => {
    if (!inspecting) return;
    const align = () => {
      if (!anchor.current || !detail.current) return;
      const { left } = anchor.current.getBoundingClientRect();
      const { width } = detail.current.getBoundingClientRect();
      if (width === 0) return;
      const inset = 8;
      const x = Math.max(
        inset,
        Math.min(left, document.documentElement.clientWidth - width - inset),
      );
      detail.current.style.left = `${x - left}px`;
    };
    align();
    window.addEventListener("resize", align);
    return () => window.removeEventListener("resize", align);
  }, [inspecting, layout]);
  return (
    <div
      ref={anchor}
      className={`ops-agent${layout === "row" ? " ops-agent-row" : ""}`}
      tabIndex={0}
      aria-label={`${participant.name}, ${describeAgentType(participant.agentType).label}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <AgentIcon type={participant.agentType} />
      <span className="ops-agent-name" title={participant.name}>
        {layout === "row" ? (
          participant.name
        ) : (
          <>
            <span className="ops-name-start">
              {participant.name.length > 12 ? participant.name.slice(0, -4) : participant.name}
            </span>
            {participant.name.length > 12 && (
              <span className="ops-name-end">{participant.name.slice(-4)}</span>
            )}
          </>
        )}
      </span>
      <div ref={detail} className="agent-detail" role="group" aria-label={`About `}>
        <strong>{participant.name}</strong>
        <span title={participant.agentType}>{describeAgentType(participant.agentType).label}</span>
        {participant.workingDirectory && <span>{participant.workingDirectory}</span>}
        {participant.joinedNote && <p>{participant.joinedNote}</p>}
        <span>{formatCount(participant.messageCount, "message")}</span>
        {participant.kind !== "person" && <span>{cadencePhrase(participant.wakeCadence)}</span>}
        <MessageAgent accountId={accountId} serverId={serverId} agent={participant} />
      </div>
    </div>
  );
}

function ServerDirectory({
  account,
  create,
}: {
  readonly account: P.AccountContext;
  readonly create: () => void;
}) {
  const { api } = useServices();
  const user = useHuman();
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const query = search.query ?? "";
  const cursor = search.cursor;
  const change = (next: {
    readonly query?: string | undefined;
    readonly cursor?: string | undefined;
  }) => {
    void navigate({
      to: "/app/$",
      params: { _splat: `accounts/${account.id}/servers` },
      search: next,
    });
  };
  const result = useQuery({
    queryKey: ["human", user.id, account.id, "servers", query, cursor],
    queryFn: ({ signal }) =>
      request(
        api.platform.managedServers({
          params: { accountId: account.id },
          query: input(P.ServerListing, { query, after: cursor, limit: 9 }),
        }),
        signal,
      ),
  });
  return (
    <>
      <div className="ops-page-bar">
        <h1 className="ops-page-title">Servers</h1>
        <Search label="Find servers" value={query} onChange={(value) => change({ query: value })} />
        {account.permissions.createServer && (
          <button className="ops-new primary" onClick={create}>
            New server
          </button>
        )}
      </div>
      <Notice error={result.error} stale={!!result.data} />
      <div className="ops-directory">
        {!denied(result.error) &&
          result.data?.data.items.map((server) => (
            <DirectoryCard key={server.id} accountId={account.id} server={server} />
          ))}
        {result.isPending && (
          <p className="ops-empty" role="status">
            Loading servers…
          </p>
        )}
      </div>
      {result.data && (
        <>
          <Empty items={result.data.data.items}>No servers found.</Empty>
          <Pagination
            cursor={cursor}
            next={result.data.data.nextCursor}
            count={result.data.data.items.length}
            onChange={(value) => change({ query, cursor: value })}
          />
        </>
      )}
    </>
  );
}

function DirectoryCard({
  accountId,
  server,
}: {
  readonly accountId: P.AccountId;
  readonly server: P.ServerContext;
}) {
  const { api } = useServices();
  const user = useHuman();
  const [access, setAccess] = useState(false);
  const prefetchServer = usePrefetchServer(accountId, server.id);
  const result = useQuery({
    queryKey: ["human", user.id, accountId, server.id, "summary"],
    enabled: server.permissions.readMessages && server.status === "ready",
    queryFn: ({ signal }) =>
      request(api.server.serverSummary({ params: { serverId: server.id } }), signal),
  });
  return (
    <>
      {server.permissions.readMessages && result.data && !denied(result.error) ? (
        <SummaryCard
          accountId={accountId}
          summary={result.data.data}
          access={server.permissions.manageAccess ? () => setAccess(true) : undefined}
        />
      ) : (
        <article className="ops-server">
          <header className="ops-server-head">
            <h2>
              <AppLink
                path={`accounts/${accountId}/servers/${server.id}`}
                prefetch={prefetchServer}
              >
                {server.name}
              </AppLink>
            </h2>
            {server.permissions.manageAccess && (
              <button className="ops-access" onClick={() => setAccess(true)}>
                Access
              </button>
            )}
          </header>
          <div className="ops-empty">
            {server.status === "provisioning"
              ? "Provisioning"
              : !server.permissions.readMessages
                ? "No message access"
                : result.error
                  ? "Summary unavailable"
                  : "Loading…"}
          </div>
        </article>
      )}
      {access && (
        <AccessDialog accountId={accountId} server={server} close={() => setAccess(false)} />
      )}
    </>
  );
}

/** Narrow screens scroll the tab row: keep the current tab in view and mark the edges that hide more. */
function useScrollingTabs(tab: string) {
  // The row mounts only once the server has loaded, so track the element itself.
  const [nav, setNav] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!nav) return;
    const current = nav.querySelector("[aria-current]");
    if (current) {
      const row = nav.getBoundingClientRect();
      const item = current.getBoundingClientRect();
      if (item.right > row.right) nav.scrollLeft += item.right - row.right + 24;
      else if (item.left < row.left) nav.scrollLeft -= row.left - item.left + 24;
    }
    const mark = () => {
      const start = nav.scrollLeft > 1;
      const end = nav.scrollWidth - nav.clientWidth - nav.scrollLeft > 1;
      nav.dataset.more = start && end ? "both" : start ? "start" : end ? "end" : "none";
    };
    mark();
    nav.addEventListener("scroll", mark, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(mark);
    observer?.observe(nav);
    return () => {
      nav.removeEventListener("scroll", mark);
      observer?.disconnect();
    };
  }, [nav, tab]);
  return setNav;
}

function ServerPage({
  accountId,
  rawId,
  task,
}: {
  readonly accountId: P.AccountId;
  readonly rawId: string;
  readonly task?: string | undefined;
}) {
  const parsed = Schema.decodeUnknownOption(M.ServerId)(rawId);
  if (Option.isNone(parsed)) return <p className="ops-empty">Server unavailable.</p>;
  return <ServerDetail accountId={accountId} id={parsed.value} task={task} />;
}

/**
 * A server shared with the person as a guest, at /app/shared/<serverId>: the server view without
 * the organization's bar, Access, Settings or Billing, from the guest's own listing.
 */
function SharedServerPage({
  serverId,
  task,
}: {
  readonly serverId: M.ServerId | null;
  readonly task?: string | undefined;
}) {
  const { api } = useServices();
  const user = useHuman();
  const search = useSearch({ strict: false });
  const shared = useShared();
  const server =
    serverId === null || denied(shared.error)
      ? undefined
      : shared.data?.data.servers.find((item) => item.id === serverId);
  // Not shared with them: a member of the server's organization opens it there instead.
  const member = useQuery({
    ...memberServerQuery(api, user.id, serverId),
    enabled: !shared.isPending && server === undefined,
  });
  const memberPath = memberServerPath(denied(member.error) ? null : (member.data ?? null), task);
  if (server)
    return (
      <SharedServerView value>
        <ServerDetail accountId={server.accountId} id={server.id} shared={server} task={task} />
      </SharedServerView>
    );
  if (memberPath !== null)
    return <Navigate to="/app/$" params={{ _splat: memberPath }} search={search} replace />;
  return (
    <>
      <Notice error={shared.error} retry={() => void shared.refetch()} />
      {!denied(member.error) && <Notice error={member.error} retry={() => void member.refetch()} />}
      {shared.isPending || (serverId !== null && member.isPending) ? (
        <p className="ops-empty" role="status">
          Loading server…
        </p>
      ) : (
        !shared.isError &&
        (member.error === null || denied(member.error)) && (
          <p className="ops-empty">
            This server isn’t shared with you, or your access was removed.{" "}
            <AppLink path="organizations">Your organizations →</AppLink>
          </p>
        )
      )}
    </>
  );
}

function ServerDetail({
  accountId,
  id,
  shared,
  task,
}: {
  readonly accountId: P.AccountId;
  readonly id: M.ServerId;
  /** A Board task page's last part (`T-14`): the page opens that task. */
  readonly task?: string | undefined;
  /** Set for a guest's shared server: its context comes from GET /v1/shared, not the organization. */
  readonly shared?: G.SharedServer | undefined;
}) {
  const { api } = useServices();
  const user = useHuman();
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const [connecting, setConnecting] = useState(false);
  const [access, setAccess] = useState(false);
  const [observedAt] = useState(Date.now);
  const result = useQuery({
    ...managedServerQuery(api, user.id, accountId, id),
    enabled: shared === undefined,
    refetchInterval: (q) =>
      q.state.data?.data.status === "provisioning" && Date.now() - observedAt < 60_000
        ? Date.now() - observedAt < 10_000
          ? 2000
          : 10_000
        : false,
  });
  const server: P.ServerDetail | undefined = shared
    ? { ...shared, files: null }
    : denied(result.error)
      ? undefined
      : result.data?.data;
  const conversation = useConversationSelection({
    accountId,
    serverId: id,
    conversationId: search.channel,
    enabled: server?.status === "ready" && server.permissions.readMessages,
  });
  const selected = denied(conversation.error) ? undefined : conversation.data?.data;
  const tab =
    task !== undefined
      ? "board"
      : search.channel
        ? conversationTab(selected?.kind, search.tab)
        : (search.tab ?? "activity");
  const tabs = useScrollingTabs(tab);
  const path = useServerPath(accountId, id);
  // Git share chips link the Files view only where the server still offers Git sharing.
  const files = server !== undefined && server.files !== null;
  return (
    <>
      <Notice
        error={result.error}
        retry={() => {
          void result.refetch();
        }}
      />
      {!shared && result.isPending && (
        <p className="ops-empty" role="status">
          Loading server…
        </p>
      )}
      {server && (
        <>
          <div className="ops-page-bar ops-server-heading">
            <h1 className="ops-page-title">
              <AppLink path={shared ? "organizations" : `accounts/${accountId}/servers`}>
                {shared ? "Shared with you" : "Servers"}
              </AppLink>
              <span>/</span>
              {server.name}
            </h1>
            <div className="ops-server-actions">
              {server.status === "ready" && server.permissions.readMessages && (
                <button className="ops-new primary" onClick={() => setConnecting(true)}>
                  Connect agents
                </button>
              )}
              {!shared && <ServerInvites accountId={accountId} server={server} />}
              {server.permissions.manageAccess && (
                <button className="ops-new" onClick={() => setAccess(true)}>
                  Access
                </button>
              )}
            </div>
          </div>
          {shared && (
            <p className="shared-origin">
              From {shared.organizationName}. Messages here count toward its allowance.
            </p>
          )}
          <nav className="ops-tabs" aria-label="Server navigation" ref={tabs}>
            {server.status === "ready" &&
              server.permissions.readMessages &&
              // The Board comes right after the first tab, on swarm servers only (spec 9.2).
              ["activity", "board", "channels", "directs", "agents", "files"]
                .filter((name) => name !== "board" || server.board === true || tab === "board")
                .map((name) => (
                  <AppLink key={name} path={path} search={{ tab: name }} current={name === tab}>
                    {name === "directs" ? "Direct chats" : name[0]?.toUpperCase() + name.slice(1)}
                  </AppLink>
                ))}
            {server.permissions.manageAccess && (
              <AppLink path={path} search={{ tab: "settings" }} current={tab === "settings"}>
                Settings
              </AppLink>
            )}
          </nav>
          {tab === "settings" && server.permissions.manageAccess ? (
            <ServerSettings server={server} />
          ) : server.status === "ready" && server.permissions.readMessages ? (
            <>
              {search.channel ? (
                <ConversationSelection
                  key={`${id}:${search.channel}`}
                  path={path}
                  result={conversation}
                >
                  <FeedRoute accountId={accountId} server={server} files={files} />
                </ConversationSelection>
              ) : task !== undefined ? (
                <TaskPage
                  key={task}
                  accountId={accountId}
                  server={server}
                  number={parseTaskNumber(task)}
                />
              ) : tab === "board" ? (
                <Board accountId={accountId} server={server} />
              ) : tab === "directs" ? (
                <DirectChats serverId={id} accountId={accountId} />
              ) : tab === "files" ? (
                <ServerTransfers accountId={accountId} server={server} />
              ) : tab === "channels" || tab === "agents" ? (
                <Registry key={tab} server={server} accountId={accountId} kind={tab} />
              ) : (
                <>
                  <ServerStrip accountId={accountId} server={server} />
                  <ServerRenameNotices accountId={accountId} serverId={id} enabled={!shared} />
                  <RenameNotices accountId={accountId} serverId={id} />
                  <RemovalNotices accountId={accountId} serverId={id} />
                  <FeedRoute accountId={accountId} server={server} files={files} />
                </>
              )}
            </>
          ) : (
            <Recovery accountId={accountId} server={server} />
          )}
          {access && (
            <AccessDialog accountId={accountId} server={server} close={() => setAccess(false)} />
          )}
          {(connecting || search.connect === "agents") &&
            server.status === "ready" &&
            server.permissions.readMessages && (
              <ConnectAgentsDialog
                server={server}
                close={() => {
                  setConnecting(false);
                  if (search.connect === "agents")
                    void navigate({
                      to: "/app/$",
                      params: { _splat: path },
                      search: { ...search, connect: undefined },
                      replace: true,
                    });
                }}
              />
            )}
        </>
      )}
    </>
  );
}

function ServerStrip({
  accountId,
  server,
}: {
  readonly accountId: P.AccountId;
  readonly server: P.ServerContext;
}) {
  const { api } = useServices();
  const user = useHuman();
  const [expanded, setExpanded] = useState(false);
  const rosterId = useId();
  const roster = useRef<HTMLDivElement>(null);
  const path = useServerPath(accountId, server.id);
  const result = useQuery({
    queryKey: ["human", user.id, accountId, server.id, "summary"],
    queryFn: ({ signal }) =>
      request(api.server.serverSummary({ params: { serverId: server.id } }), signal),
  });
  if (!result.data || denied(result.error)) return <Notice error={result.error} />;
  const summary = result.data.data;
  const remaining = summary.server.participantCount - summary.participants.length;
  const toggleRoster = (event: MouseEvent<HTMLButtonElement>) => {
    const grid = roster.current;
    if (!grid) return;
    // Capture the presented positions before canceling an interrupted transition.
    const before = Array.from(grid.children, (element) => ({
      element,
      rect: element.getBoundingClientRect(),
    }));
    const height = grid.getBoundingClientRect().height;
    for (const element of [grid, ...before.map((item) => item.element)])
      for (const animation of element.getAnimations()) animation.cancel();
    grid.removeAttribute("data-animating");
    flushSync(() => setExpanded((value) => !value));
    if (event.detail === 0 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timing = { duration: 250, easing: "cubic-bezier(0.25, 1, 0.5, 1)" };
    const after = before.map(({ element, rect }) => {
      const next = element.getBoundingClientRect();
      return { element, x: rect.x - next.x, y: rect.y - next.y };
    });
    const nextHeight = grid.getBoundingClientRect().height;
    grid.setAttribute("data-animating", "");
    for (const { element, x, y } of after)
      element.animate(
        [{ transform: `translate(${x}px, ${y}px)` }, { transform: "translate(0, 0)" }],
        timing,
      );
    // Height is the one layout animation: it keeps the message feed attached below.
    const transition = grid.animate(
      [{ height: `${height}px` }, { height: `${nextHeight}px` }],
      timing,
    );
    transition.onfinish = () => grid.removeAttribute("data-animating");
  };
  return (
    <div className="ops-server-overview">
      <section className="ops-server-channels" aria-label="Server channels">
        <header className="ops-roster-heading">
          <h2>Channels</h2>
        </header>
        <nav className="ops-summary-channels" aria-label="Channel shortcuts">
          {summary.channels.map((channel) => (
            <AppLink key={channel.id} path={path} search={{ tab: "channels", channel: channel.id }}>
              # {channel.name}
            </AppLink>
          ))}
          {summary.server.channelCount > summary.channels.length && (
            <AppLink path={path} search={{ tab: "channels" }}>
              All channels →
            </AppLink>
          )}
        </nav>
      </section>
      <section className="ops-server-roster" aria-label="Server agents">
        <header className="ops-roster-heading">
          <h2>
            Server agents <span>{summary.server.participantCount.toLocaleString()}</span>
          </h2>
          {summary.participants.length > 0 && (
            <button
              className="ops-roster-toggle"
              aria-expanded={expanded}
              aria-controls={rosterId}
              onClick={toggleRoster}
            >
              {expanded ? "Collapse" : "Expand"}
              <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="m3 4.5 3 3 3-3" />
              </svg>
            </button>
          )}
        </header>
        <div className="ops-roster-grid" id={rosterId} ref={roster} data-expanded={expanded}>
          {summary.participants.map((participant) => (
            <AgentTile
              key={participant.id}
              accountId={accountId}
              serverId={server.id}
              participant={participant}
              layout="row"
            />
          ))}
          {remaining > 0 && (
            <AppLink className="ops-roster-more" path={path} search={{ tab: "agents" }}>
              +{remaining}
              <span className={expanded ? undefined : "sr-only"}> more agents →</span>
            </AppLink>
          )}
        </div>
        {summary.server.participantCount === 0 && (
          <p className="ops-empty-agents">No agents yet.</p>
        )}
      </section>
    </div>
  );
}

function Registry({
  accountId,
  server,
  kind,
}: {
  readonly accountId: P.AccountId;
  readonly server: P.ServerContext;
  readonly kind: "agents" | "channels";
}) {
  const { api } = useServices();
  const user = useHuman();
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const query = search.query ?? "";
  const cursor = search.cursor;
  const channelState = search.state === "archived" ? "archived" : "active";
  // Removed agents are hidden unless the person asks for them, like archived channels.
  const agentState = search.state === "removed" ? "removed" : "active";
  const state = kind === "agents" ? agentState : channelState;
  const path = useServerPath(accountId, server.id);
  const [waking, setWaking] = useState<M.Participant | null>(null);
  const [renaming, setRenaming] = useState<M.Participant | null>(null);
  const [removing, setRemoving] = useState<M.Participant | null>(null);
  const renames = useRenames(accountId, server.id, kind === "agents");
  const change = (next: {
    readonly query?: string | undefined;
    readonly cursor?: string | undefined;
    readonly state?: string | undefined;
  }) => {
    void navigate({ to: "/app/$", params: { _splat: path }, search: { tab: kind, ...next } });
  };
  const agents = useQuery({
    queryKey: [
      "human",
      user.id,
      accountId,
      server.id,
      "agents",
      query,
      cursor,
      ...(agentState === "removed" ? ["removed"] : []),
    ],
    enabled: kind === "agents",
    queryFn: ({ signal }) =>
      request(
        api.server.listParticipants({
          params: { serverId: server.id },
          query: input(
            I.ListParticipants,
            cursor
              ? { cursor, limit: 24 }
              : agentState === "removed"
                ? { query, state: agentState, limit: 24 }
                : { query, limit: 24 },
          ),
        }),
        signal,
      ),
  });
  const channels = useQuery({
    queryKey: ["human", user.id, accountId, server.id, "channels", channelState, query, cursor],
    enabled: kind === "channels",
    queryFn: ({ signal }) =>
      request(
        api.server.listChannels({
          params: { serverId: server.id },
          query: input(
            I.ListChannels,
            cursor ? { cursor, limit: 20 } : { query, state: channelState, limit: 20 },
          ),
        }),
        signal,
      ),
  });
  const active = kind === "agents" ? agents : channels;
  return (
    <>
      <div className="ops-page-bar">
        <h2 className="ops-page-title">{kind === "agents" ? "Agents" : "Channels"}</h2>
        {kind === "channels" ? (
          <select
            aria-label="Channel status"
            value={state}
            onChange={(event) => change({ query, state: event.target.value })}
          >
            <option value="active">Active</option>
            <option value="archived">Archived</option>
          </select>
        ) : (
          <select
            aria-label="Agent status"
            value={state}
            onChange={(event) => change({ query, state: event.target.value })}
          >
            <option value="active">Active</option>
            <option value="removed">Removed</option>
          </select>
        )}
        <Search
          label={`Find ${kind}`}
          value={query}
          onChange={(value) => change({ query: value, state })}
        />
      </div>
      <Notice error={active.error} stale={!!active.data} />
      {!denied(active.error) &&
        (kind === "agents" ? (
          <div className="ops-registry">
            {agents.data?.data.items.map((agent) => (
              <div className="ops-registry-agent" key={agent.id}>
                <ParticipantMark participant={agent} />
                <div>
                  <strong>{agent.name}</strong>
                  <RemovedTag participant={agent} />
                  {agent.kind === "person" ? (
                    <span>Person, named from their sign-in</span>
                  ) : (
                    <span title={agent.agentType}>{describeAgentType(agent.agentType).label}</span>
                  )}
                  {agent.workingDirectory && (
                    <small title={agent.workingDirectory}>{agent.workingDirectory}</small>
                  )}
                  {agent.kind !== "person" && agent.removedAt === undefined && (
                    <small className="ops-agent-cadence">
                      {cadencePhrase(agent.wakeCadence)} ·{" "}
                      <span className="ops-agent-autostart">
                        <button
                          className="text-button ops-agent-wakes"
                          aria-label={`Auto-start for ${agent.name}`}
                          onClick={() => setWaking(agent)}
                        >
                          Auto-start
                        </button>
                        <AutoStartInfo />
                      </span>
                    </small>
                  )}
                  <PluginUpdate plugin={agent.plugin} />
                  <EarlierNames
                    names={earlierNames(renames.data?.data.items ?? [], agent.id, agent.name)}
                  />
                  {agent.joinedNote && (
                    <details className="ops-registration-note">
                      <summary>Registration note</summary>
                      <p>{agent.joinedNote}</p>
                    </details>
                  )}
                </div>
                {agent.kind !== "person" && (
                  <div className="ops-registry-actions">
                    <MessageAgent accountId={accountId} serverId={server.id} agent={agent} />
                    <button
                      className="text-button ops-agent-rename"
                      aria-label={`Rename ${agent.name}`}
                      onClick={() => setRenaming(agent)}
                    >
                      Rename
                    </button>
                    {agent.removedAt === undefined ? (
                      <button
                        className="text-button ops-agent-remove"
                        aria-label={`Remove ${agent.name} from this server`}
                        onClick={() => setRemoving(agent)}
                      >
                        Remove
                      </button>
                    ) : (
                      <RestoreAgent accountId={accountId} serverId={server.id} agent={agent} />
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="ops-channel-directory">
            {channels.data?.data.items.map((channel) => (
              <div className="ops-channel-row" key={channel.id}>
                <div>
                  <AppLink path={path} search={{ tab: "channels", channel: channel.id }}>
                    # {channel.name}
                  </AppLink>
                  {channel.description && (
                    <ClampedText className="muted" text={channel.description} />
                  )}
                </div>
                <span>{formatCount(channel.messageCount, "message")}</span>
              </div>
            ))}
          </div>
        ))}
      {active.isPending && (
        <p className="ops-empty" role="status">
          Loading {kind}…
        </p>
      )}
      {active.data && (
        <>
          <Empty items={active.data.data.items}>No {kind} found.</Empty>
          <Pagination
            cursor={cursor}
            next={active.data.data.nextCursor}
            count={active.data.data.items.length}
            onChange={(value) => change({ query, state, cursor: value })}
          />
        </>
      )}
      {waking && (
        <WakesDialog
          accountId={accountId}
          serverId={server.id}
          agent={waking}
          close={() => setWaking(null)}
        />
      )}
      {renaming && (
        <RenameDialog
          accountId={accountId}
          serverId={server.id}
          agent={renaming}
          close={() => setRenaming(null)}
        />
      )}
      {removing && (
        <RemoveAgentDialog
          accountId={accountId}
          serverId={server.id}
          agent={removing}
          close={() => setRemoving(null)}
        />
      )}
    </>
  );
}

/** An agent's names before its current one, newest first. */
function EarlierNames({ names }: { readonly names: ReadonlyArray<M.Name> }) {
  if (names.length === 0) return null;
  return (
    <small className="ops-agent-earlier" title={`Earlier names: ${names.join(", ")}`}>
      Was {names.join(", ")}
    </small>
  );
}

function FeedRoute({
  accountId,
  server,
  initialFeed,
  files = false,
}: {
  readonly accountId: P.AccountId;
  readonly server?: P.ServerContext | undefined;
  readonly initialFeed?: InitialFeed | undefined;
  /** Whether this server offers Git sharing (its Files tab). */
  readonly files?: boolean | undefined;
}) {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const path = useLocation({ select: (location) => location.pathname.slice(5) });
  const query = search.query ?? "";
  const window =
    server && search.start && search.end ? { start: search.start, end: search.end } : undefined;
  const context = server ? { range: search.range, at: search.at, ...window } : {};
  const clearWindow = () => {
    void navigate({
      to: "/app/$",
      params: { _splat: path },
      search: {
        tab: search.tab,
        query: search.query,
        channel: search.channel,
        range: search.range,
      },
      resetScroll: false,
    });
  };
  const feed = (
    <>
      {window && (
        <div className="ops-time-filter" role="group" aria-label="Selected message time range">
          <span>
            {formatActivityTime(window.start)} – {formatActivityTime(window.end)}
          </span>
          <button onClick={clearWindow}>Clear range</button>
        </div>
      )}
      <Activity
        key={`${server?.id ?? accountId}:${query}:${search.cursor ?? ""}:${search.channel ?? ""}:${search.message ?? ""}:${window?.start ?? ""}:${window?.end ?? ""}`}
        accountId={accountId}
        server={server}
        initialFeed={initialFeed}
        files={files}
        query={query}
        cursor={search.cursor}
        channel={search.channel}
        around={search.channel ? search.message : undefined}
        window={window}
        conversationSearch={server ? { ...context, query } : undefined}
        navigate={(selection) => {
          void navigate({
            to: "/app/$",
            params: { _splat: path },
            search: { ...context, ...selection, tab: selection.channel ? search.tab : undefined },
            resetScroll: false,
          });
        }}
      />
      {server && !search.channel && (
        <ActivityTimeline
          key={server.id}
          accountId={accountId}
          serverId={server.id}
          range={search.range ?? "day"}
          at={search.at}
          window={window}
          onRange={(range) => {
            void navigate({
              to: "/app/$",
              params: { _splat: path },
              search: { query, range },
              resetScroll: false,
            });
          }}
          onSelect={(selection, at) => {
            void navigate({
              to: "/app/$",
              params: { _splat: path },
              search: { query, range: search.range ?? "day", at, ...selection },
              resetScroll: false,
            });
          }}
          onClear={clearWindow}
        />
      )}
    </>
  );
  return feed;
}
