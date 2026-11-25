import { Option, Schema } from "effect";
import * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import * as G from "@talkto/api/guests";

/*
  Which dashboard view a /app path opens, and where /app itself sends a person. Both are plain
  functions so the rules are tested without rendering (test/navigation.test.mjs).
*/

/** A /app path, read into the view that renders it. */
export type DashboardRoute =
  | {
      readonly kind: "account";
      readonly accountId: P.AccountId;
      readonly view: string | undefined;
      readonly serverId: string | undefined;
      /** A Board task page (`…/servers/<id>/board/T-14`): its last part, unparsed. */
      readonly task: string | undefined;
    }
  /** An invitation's join page; `invitationId` is null when the link is not one. */
  | { readonly kind: "join"; readonly invitationId: G.InvitationId | null }
  /** A server shared with the person as a guest; `serverId` is null when the path is not one. */
  | {
      readonly kind: "shared";
      readonly serverId: M.ServerId | null;
      /** A Board task page (`shared/<id>/board/T-14`): its last part, unparsed. */
      readonly task: string | undefined;
    }
  | { readonly kind: "account-settings" }
  | { readonly kind: "sign-ins" }
  | { readonly kind: "api-keys" }
  | { readonly kind: "entry" }
  | { readonly kind: "organizations" };

const decode = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: string | undefined,
): S["Type"] | null => Option.getOrNull(Schema.decodeUnknownOption(schema)(value));

/** Read a pathname under /app; anything unknown opens the organization list. */
export function dashboardRoute(pathname: string): DashboardRoute {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[1] === "join")
    return {
      kind: "join",
      invitationId: segments.length === 3 ? decode(G.InvitationId, segments[2]) : null,
    };
  if (segments[1] === "shared") {
    const task = segments.length === 5 && segments[3] === "board" ? segments[4] : undefined;
    return {
      kind: "shared",
      serverId:
        segments.length === 3 || task !== undefined ? decode(M.ServerId, segments[2]) : null,
      task,
    };
  }
  const accountId = decode(P.AccountId, segments[2]);
  if (accountId !== null)
    return {
      kind: "account",
      accountId,
      view: segments[3],
      serverId: segments[4],
      task: segments[5] === "board" ? segments[6] : undefined,
    };
  if (segments[1] === "account" && segments.length === 2) return { kind: "account-settings" };
  if (segments[1] === "account" && segments[2] === "sign-ins" && segments.length === 3)
    return { kind: "sign-ins" };
  if (segments[1] === "account" && segments[2] === "api-keys" && segments.length === 3)
    return { kind: "api-keys" };
  if (segments.length === 1) return { kind: "entry" };
  return { kind: "organizations" };
}

/** The /app path of a server shared with the person as a guest. */
export const sharedServerPath = (serverId: M.ServerId) => `shared/${serverId}`;
/** The /app path of an organization's server. */
export const accountServerPath = (accountId: P.AccountId, serverId: M.ServerId) =>
  `accounts/${accountId}/servers/${serverId}`;

/**
 * Where a /app/shared/<serverId> link sends someone the server is not shared with but who reaches
 * it as a member of its organization: the same page under the organization's route. A task's
 * `url` is a shared path because it goes to agents, whose person may be a guest or a member; this
 * opens it for members too. Null when the person does not reach the server as a member.
 */
export function memberServerPath(
  server: { readonly id: M.ServerId; readonly accountId: P.AccountId } | null,
  task: string | undefined,
): string | null {
  if (server === null) return null;
  const path = accountServerPath(server.accountId, server.id);
  return task === undefined ? path : `${path}/board/${task}`;
}

/** Where /app sends a person. */
export type Entry =
  | { readonly kind: "onboarding" }
  | { readonly kind: "account"; readonly accountId: P.AccountId }
  | { readonly kind: "shared"; readonly serverId: M.ServerId }
  | { readonly kind: "directory" };

/**
 * Whether /app sends the person to setup: a run that is neither finished nor dismissed, or a
 * first visit with no organization at all. Leaving setup (Skip setup, Skip for now, I’m done, Open
 * the server) always finishes or dismisses the run first, so it never comes back here by itself.
 * `entryTarget` asks this only once nothing shared with the person comes first.
 */
export const sendsToSetup = (
  setup: {
    readonly completedAt: string | null;
    readonly dismissedAt: string | null;
    readonly run: { readonly step: string } | null;
  },
  organizations: { readonly items: ReadonlyArray<unknown>; readonly more: boolean },
): boolean =>
  (setup.run !== null && setup.run.step !== "done" && setup.dismissedAt === null) ||
  (organizations.items.length === 0 &&
    !organizations.more &&
    setup.completedAt === null &&
    setup.dismissedAt === null);

/**
 * Where /app sends a person, from a fresh first page of their organizations, their setup and what
 * was shared with them (`null` when that could not be read).
 *
 * Someone with no organization who was invited to a server, or can open one as a guest, is never
 * sent to onboarding: they see the organization list with "Shared with you", or go straight to
 * the one server shared with them. Otherwise setup in progress, or a first visit, opens
 * onboarding; a single organization opens directly unless something is shared, which only the
 * list shows.
 */
export function entryTarget({
  accounts,
  more,
  setup,
  shared,
  billing,
}: {
  readonly accounts: ReadonlyArray<{ readonly id: P.AccountId }>;
  /** Whether more organizations follow the first page. */
  readonly more: boolean;
  readonly setup: {
    readonly completedAt: string | null;
    readonly dismissedAt: string | null;
    readonly run: { readonly step: string } | null;
  };
  readonly shared: {
    readonly servers: ReadonlyArray<{ readonly id: M.ServerId }>;
    readonly invitations: ReadonlyArray<unknown>;
  } | null;
  /** Billing returns to /app with `?billing=`; it never opens onboarding. */
  readonly billing: boolean;
}): Entry {
  const none = accounts.length === 0 && !more;
  const sharedAny = shared !== null && (shared.servers.length > 0 || shared.invitations.length > 0);
  if (none && shared === null) return { kind: "directory" };
  if (none && sharedAny) {
    const [only] = shared.servers;
    return only !== undefined && shared.servers.length === 1 && shared.invitations.length === 0
      ? { kind: "shared", serverId: only.id }
      : { kind: "directory" };
  }
  if (!billing && sendsToSetup(setup, { items: accounts, more })) return { kind: "onboarding" };
  if (sharedAny) return { kind: "directory" };
  const [only] = accounts;
  return only !== undefined && accounts.length === 1 && !more
    ? { kind: "account", accountId: only.id }
    : { kind: "directory" };
}
