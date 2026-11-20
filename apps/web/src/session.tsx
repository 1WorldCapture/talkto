import { createContext, useContext, useEffect, type ReactNode } from "react";
import { MutationCache, QueryCache, QueryClient, useQuery } from "@tanstack/react-query";
import { requestFailure } from "./telemetry.js";
import * as P from "@talkto/api/platform";
import { createApi, request, ApiError, retryRead, denied } from "./api.js";
import { Notice } from "./components.js";

/** Forget agent data after a confirmed denial without discarding an owner's management records. */
export function clearAgentData(
  queries: QueryClient,
  scope: ReadonlyArray<string>,
  error: Error,
  includeManagement = false,
) {
  const privateKinds = [
    "home",
    "feed",
    "summary",
    "timeline",
    "agents",
    "channels",
    "direct-chats",
    "conversation",
    "file-shares",
    "onboarding-progress",
  ];
  const affected = queries
    .getQueryCache()
    .findAll({ queryKey: scope })
    .filter(
      (entry) =>
        includeManagement || entry.queryKey.some((part) => privateKinds.includes(String(part))),
    );
  void queries.cancelQueries({ predicate: (entry) => affected.includes(entry) }, { revert: false });
  for (const entry of affected)
    entry.setState({
      data: undefined,
      dataUpdatedAt: 0,
      error,
      status: "error",
      fetchStatus: "idle",
    });
}

/** Application composition root, with one protected cache and one generated client. */
export function createServices(origin: string) {
  const api = createApi(origin);
  const queries = new QueryClient({
    mutationCache: new MutationCache({ onError: (error) => requestFailure(error) }),
    queryCache: new QueryCache({
      onError(error, query) {
        requestFailure(error, query.queryKey);
        if (
          error instanceof ApiError &&
          error.code === "unauthenticated" &&
          query.queryKey[0] !== "session"
        ) {
          void queries.cancelQueries(
            { predicate: (entry) => entry.queryKey[0] !== "session" },
            { revert: false },
          );
          queries.removeQueries({ predicate: (entry) => entry.queryKey[0] !== "session" });
          queries.setQueryData(["session"], null);
        } else if (denied(error) && query.queryKey[0] === "human") {
          const scope = query.queryKey.slice(0, 3).map(String);
          const accountDenied = query.queryKey[3] === "account";
          clearAgentData(queries, scope, error, accountDenied);
        }
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        gcTime: 60_000,
        retry: retryRead,
        retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 2000),
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      },
      mutations: { retry: false },
    },
  });
  return { api, queries };
}
/** Shared request/cache dependencies are created at bootstrap, never at module import. */
export const Services = createContext<ReturnType<typeof createServices> | null>(null);
/** Authenticated identity scopes every protected query key. */
export const Human = createContext<P.User | null>(null);
/**
 * True on a self-hosted copy that signs people in with Cloudflare Access, where invitations send
 * no email (docs/self-host-cloudflare-access.md).
 */
const AccessSignIn = createContext(false);
/** Whether this copy signs people in with Cloudflare Access. */
export const useAccessSignIn = () => useContext(AccessSignIn);
/** Access the application-owned request boundary. */
export function useServices() {
  const value = useContext(Services);
  if (!value) throw new Error("Application services are missing");
  return value;
}
/** Access the identity established by the session gate. */
export function useHuman() {
  const value = useContext(Human);
  if (!value) throw new Error("Session gate is missing");
  return value;
}
/** Website session gate; provider outages retain confirmed data and invalid sessions stop the app. */
export function SessionGate({ children }: { readonly children: ReactNode }) {
  const { api, queries } = useServices();
  const session = useQuery({
    queryKey: ["session"],
    queryFn: ({ signal }) => request(api.platform.currentUser(), signal),
    refetchInterval: 60_000,
  });
  const user = session.data?.data.user;
  useEffect(() => {
    if (!user) return;
    void queries
      .cancelQueries({
        predicate: (entry) => entry.queryKey[0] === "human" && entry.queryKey[1] !== user.id,
      })
      .then(() =>
        queries.removeQueries({
          predicate: (entry) => entry.queryKey[0] === "human" && entry.queryKey[1] !== user.id,
        }),
      );
  }, [user?.id, queries]);
  if (
    session.data === null ||
    (session.error instanceof ApiError && session.error.code === "unauthenticated")
  ) {
    // An invitation's join page (join.tsx): sign-in brings the person back to it, signed up or not.
    const invited = location.pathname.startsWith("/app/join/");
    return (
      <section className="session-panel">
        <h1>{invited ? "You’re invited to a TalkTo server" : "Sign in to TalkTo"}</h1>
        <p>
          {invited
            ? "Sign in or create your account with the address the invitation was sent to."
            : "Manage your servers and connect your agents."}
        </p>
        <a
          className="btn"
          href={`/auth/login?return_to=${encodeURIComponent(location.pathname + location.search)}`}
        >
          {invited ? "Continue" : "Sign in"}
        </a>
      </section>
    );
  }
  if (!user)
    return (
      <section className="session-panel">
        {session.isPending ? (
          <p role="status">Checking your sign-in…</p>
        ) : (
          <Notice
            error={session.error}
            retry={() => {
              void session.refetch();
            }}
          />
        )}
      </section>
    );
  return (
    <Human.Provider value={user}>
      <AccessSignIn.Provider value={session.data?.data.connection.signIn === "cloudflare-access"}>
        <Notice error={session.error} stale />
        {children}
      </AccessSignIn.Provider>
    </Human.Provider>
  );
}
