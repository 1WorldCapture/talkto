import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Effect } from "effect";
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError, createApi, denied, request, retryRead, type Credentials } from "../api/client";
import * as Store from "./store";
import * as WorkOS from "./workos";

type State =
  | { readonly status: "loading" }
  | { readonly status: "signedOut"; readonly notice: string | null }
  | { readonly status: "signedIn"; readonly connection: Store.Connection };

/** What every signed-in screen needs: the generated client, its credential and who is reading. */
export interface Services {
  readonly connection: Store.Connection;
  readonly scope: string;
  readonly api: ReturnType<typeof createApi>;
  readonly credentials: Credentials;
}

interface SessionContext {
  readonly state: State;
  readonly services: Services | null;
  readonly queries: QueryClient;
  readonly connect: (connection: Store.Connection) => Promise<void>;
  readonly signOut: (notice?: string | null) => Promise<void>;
}

const Context = createContext<SessionContext | null>(null);

/** One cache for the app; reads retry transient failures, sends never retry on their own. */
function createQueries(onUnauthenticated: () => void) {
  const queries: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError(error, query) {
        if (error instanceof ApiError && error.code === "unauthenticated") onUnauthenticated();
        // A server the person lost access to must not keep showing its messages.
        else if (denied(error) && query.queryKey[0] === "human" && query.queryKey[2] !== undefined)
          queries.removeQueries({ queryKey: query.queryKey.slice(0, 3), type: "inactive" });
      },
    }),
    mutationCache: new MutationCache({
      onError(error) {
        if (error instanceof ApiError && error.code === "unauthenticated") onUnauthenticated();
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        gcTime: 5 * 60_000,
        retry: retryRead,
        retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 2000),
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      },
      mutations: { retry: false },
    },
  });
  return queries;
}

/** Owns the stored credential, its refresh and sign-out, and the protected query cache. */
export function SessionProvider({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const signOutRef = useRef<(notice?: string | null) => Promise<void>>(async () => {});
  const [queries] = useState(() =>
    createQueries(() => {
      void signOutRef.current("Your sign-in has ended. Sign in again.");
    }),
  );
  // The latest connection, including refreshed tokens, without re-rendering every screen.
  const live = useRef<Store.Connection | null>(null);
  const refreshing = useRef<Promise<string | null> | null>(null);

  const signOut = useCallback(
    async (notice: string | null = null) => {
      live.current = null;
      await Store.clearConnection();
      await queries.cancelQueries();
      queries.clear();
      setState({ status: "signedOut", notice });
    },
    [queries],
  );
  signOutRef.current = signOut;

  useEffect(() => {
    void Store.readConnection().then((connection) => {
      live.current = connection;
      setState(
        connection === null
          ? { status: "signedOut", notice: null }
          : { status: "signedIn", connection },
      );
    });
  }, []);

  const connect = useCallback(
    async (connection: Store.Connection) => {
      await Store.writeConnection(connection);
      queries.clear();
      live.current = connection;
      setState({ status: "signedIn", connection });
    },
    [queries],
  );

  const services = useMemo<Services | null>(() => {
    if (state.status !== "signedIn") return null;
    const { connection } = state;
    /** One refresh at a time: WorkOS rotates the refresh token on every exchange. */
    const renew = () => {
      const current = live.current;
      if (current === null || current.kind !== "hosted") return Promise.resolve(null);
      refreshing.current ??= WorkOS.refresh(current)
        .then(async (outcome) => {
          if (outcome === "rejected") {
            await signOut("Your sign-in has ended. Sign in again.");
            return null;
          }
          if (outcome === "unavailable") return null;
          const next = { ...current, ...outcome };
          live.current = next;
          await Store.writeConnection(next);
          return next.accessToken;
        })
        .finally(() => {
          refreshing.current = null;
        });
      return refreshing.current;
    };
    const credentials: Credentials = {
      origin: connection.origin,
      async current() {
        const current = live.current ?? connection;
        if (current.kind === "local") return current.token;
        if (!WorkOS.expiresSoon(current.accessToken)) return current.accessToken;
        return (await renew()) ?? current.accessToken;
      },
      renew,
    };
    return {
      connection,
      scope: Store.scopeOf(connection),
      api: createApi(connection.origin),
      credentials,
    };
  }, [state, signOut]);

  const value = useMemo(
    () => ({ state, services, queries, connect, signOut }),
    [state, services, queries, connect, signOut],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Session state and actions, for the sign-in screen and the account sheet. */
export function useSession() {
  const value = useContext(Context);
  if (value === null) throw new Error("SessionProvider is missing");
  return value;
}

/** Services for screens behind the sign-in gate. */
export function useServices() {
  const { services } = useSession();
  if (services === null) throw new Error("This screen needs a signed-in session");
  return services;
}

/** Run one generated request with the session's credential. */
export function useRequest() {
  const { credentials } = useServices();
  return useCallback(
    <A, E>(operation: Effect.Effect<A, E>, signal?: AbortSignal) =>
      request(credentials, operation, signal),
    [credentials],
  );
}
