import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import * as M from "./models.js";
import * as D from "./dashboard.js";
import * as I from "./inputs.js";
import * as Envelope from "./envelope.js";
import { Authorization } from "./security.js";

/** TalkTo ownership boundary, independent of a messaging server. */
export const AccountId = Schema.String.check(Schema.isUUID(4)).pipe(Schema.brand("AccountId"));
/** Parsed account identifier. */
export type AccountId = typeof AccountId.Type;
/** WorkOS identifiers are never participant identifiers. */
export const UserId = Schema.String.check(Schema.isPattern(/^user_[A-Za-z0-9]+$/)).pipe(
  Schema.brand("UserId"),
);
/** Parsed human identity. */
export type UserId = typeof UserId.Type;
/** WorkOS organization backing an account. */
export const OrganizationId = Schema.String.check(Schema.isPattern(/^org_[A-Za-z0-9]+$/)).pipe(
  Schema.brand("OrganizationId"),
);
/** Parsed organization identifier. */
export type OrganizationId = typeof OrganizationId.Type;
/** Membership identifier retained on grants for departure revocation. */
export const MembershipId = Schema.String.check(Schema.isPattern(/^om_[A-Za-z0-9]+$/)).pipe(
  Schema.brand("MembershipId"),
);
/** Parsed membership identifier. */
export type MembershipId = typeof MembershipId.Type;
/** Platform account; personal and team accounts have identical behavior. */
export const Account = Schema.Struct({
  id: AccountId,
  organizationId: OrganizationId,
  name: M.ServerName,
  createdBy: UserId,
  createdAt: M.Timestamp,
});
/** Parsed account. */
export interface Account extends Schema.Schema.Type<typeof Account> {}
/** Server directory entry without querying message storage for statistics. */
export const Server = Schema.Struct({
  id: M.ServerId,
  accountId: AccountId,
  name: M.ServerName,
  createdBy: UserId,
  createdAt: M.Timestamp,
  status: Schema.Literals(["provisioning", "ready"]),
});
/** Parsed directory entry. */
export interface Server extends Schema.Schema.Type<typeof Server> {}
/** Membership context from WorkOS; membership alone never grants server access. */
export const Member = Schema.Struct({
  id: MembershipId,
  organizationId: OrganizationId,
  userId: UserId,
  status: Schema.Literals(["active", "inactive", "pending", "deleted"]),
  role: Schema.String,
  updatedAt: M.Timestamp,
});
/** Parsed membership. */
export interface Member extends Schema.Schema.Type<typeof Member> {}
/** Public human profile; credentials and provider internals are never projected. */
export const User = Schema.Struct({
  id: UserId,
  email: Schema.String,
  emailVerified: Schema.Boolean,
  firstName: Schema.NullOr(Schema.String),
  lastName: Schema.NullOr(Schema.String),
});
/** Parsed human profile. */
export interface User extends Schema.Schema.Type<typeof User> {}
/** Account with the authenticated caller's effective actions. */
export const AccountContext = Schema.Struct({
  ...Account.fields,
  permissions: Schema.Struct({
    createServer: Schema.Boolean,
    manageMembers: Schema.Boolean,
    manageBilling: Schema.Boolean,
    /** The owner renames the organization, on the website only. */
    rename: Schema.Boolean,
  }),
});
/** Parsed account context. */
export interface AccountContext extends Schema.Schema.Type<typeof AccountContext> {}
/** Organization directory entry; counts only servers the caller can access or manage. */
export const AccountSummary = Schema.Struct({
  ...AccountContext.fields,
  serverCount: M.Count,
});
/** Parsed organization directory summary. */
export interface AccountSummary extends Schema.Schema.Type<typeof AccountSummary> {}
/** Member with a displayable profile and caller-specific removal permission. */
export const MemberContext = Schema.Struct({
  ...Member.fields,
  user: User,
  permissions: Schema.Struct({ remove: Schema.Boolean }),
});
/** Parsed member context. */
export interface MemberContext extends Schema.Schema.Type<typeof MemberContext> {}
/** Management metadata does not confer permission to read the server. */
export const ServerContext = Schema.Struct({
  ...Server.fields,
  permissions: Schema.Struct({
    readMessages: Schema.Boolean,
    manageAccess: Schema.Boolean,
    resume: Schema.Boolean,
  }),
});
/** Parsed server management context. */
export interface ServerContext extends Schema.Schema.Type<typeof ServerContext> {}
/** Git remote agents clone and push; people point an agent at it from the Files tab. */
export const FileRepository = Schema.Struct({
  remote: Schema.String,
  defaultBranch: Schema.String,
});
/** Parsed file repository. */
export interface FileRepository extends Schema.Schema.Type<typeof FileRepository> {}
/** The files capability as one person sees it; `repository` is null until the store has answered. */
export const ServerFiles = Schema.Struct({ repository: Schema.NullOr(FileRepository) });
/** Parsed files capability. */
export interface ServerFiles extends Schema.Schema.Type<typeof ServerFiles> {}
/**
 * One managed server with the facts only the server itself answers. `files` is null when the
 * deployment has no file store or the caller cannot read messages; directory pages never carry
 * it because each value costs a call to the server.
 */
export const ServerDetail = Schema.Struct({
  ...ServerContext.fields,
  files: Schema.NullOr(ServerFiles),
});
/** Parsed server detail. */
export interface ServerDetail extends Schema.Schema.Type<typeof ServerDetail> {}
/** Provider invitation identity, always checked against the selected account. */
export const InvitationId = Schema.String.check(Schema.isPattern(/^invitation_[A-Za-z0-9]+$/)).pipe(
  Schema.brand("InvitationId"),
);
/** Parsed invitation identity. */
export type InvitationId = typeof InvitationId.Type;
/** Public invitation lifecycle without acceptance credentials. */
export const Invitation = Schema.Struct({
  id: InvitationId,
  organizationId: OrganizationId,
  email: Schema.String,
  state: Schema.Literals(["pending", "accepted", "expired", "revoked"]),
  createdAt: M.Timestamp,
  expiresAt: M.Timestamp,
});
/** Parsed invitation. */
export interface Invitation extends Schema.Schema.Type<typeof Invitation> {}
/** Send one invitation; list invitations before retrying an ambiguous email action. */
export const Invite = Schema.Struct({
  email: Schema.Trim.check(Schema.isMaxLength(254), Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
/** Parsed invitation request. */
export interface Invite extends Schema.Schema.Type<typeof Invite> {}
/** Completed removal and revocation delivery. */
export const RemovedMember = Schema.Struct({ userId: UserId, status: Schema.Literal("removed") });
/** Parsed completed member removal. */
export interface RemovedMember extends Schema.Schema.Type<typeof RemovedMember> {}
/** Explicit access and its durable delivery status. */
export const Grant = Schema.Struct({
  id: M.GrantId,
  serverId: M.ServerId,
  userId: UserId,
  membershipId: MembershipId,
  createdAt: M.Timestamp,
  revokedAt: Schema.NullOr(M.Timestamp),
  revision: Schema.Int,
  appliedRevision: Schema.Int,
});
/** Parsed access grant. */
export interface Grant extends Schema.Schema.Type<typeof Grant> {}
/** Grantee profile for access management; a deleted user retains their grant and ID. */
export const GrantContext = Schema.Struct({ ...Grant.fields, user: Schema.NullOr(User) });
/** Parsed grant with display context. */
export interface GrantContext extends Schema.Schema.Type<typeof GrantContext> {}
/** Idempotent creation input shared by accounts and servers. */
export const Create = Schema.Struct({ name: M.ServerName, requestKey: M.RequestKey }).annotate({
  parseOptions: { onExcessProperty: "error" },
});
/** Parsed creation request. */
export interface Create extends Schema.Schema.Type<typeof Create> {}
/**
 * Rename an organization or a server, on the website only. The name follows creation's rules. The
 * request key makes a retry safe: the same key and name return the earlier result unchanged; the
 * same key with another name is `idempotency_conflict`.
 */
export const Rename = Schema.Struct({ name: M.ServerName, requestKey: M.RequestKey }).annotate({
  parseOptions: { onExcessProperty: "error" },
});
/** Parsed rename request. */
export interface Rename extends Schema.Schema.Type<typeof Rename> {}
/** The organization after a rename; `changed` is false for a retry or the exact current name. */
export const RenamedAccount = Schema.Struct({ account: AccountContext, changed: Schema.Boolean });
/** Parsed organization rename result. */
export interface RenamedAccount extends Schema.Schema.Type<typeof RenamedAccount> {}
/** The server after a rename; `changed` is false for a retry or the exact current name. */
export const RenamedServer = Schema.Struct({ server: ServerContext, changed: Schema.Boolean });
/** Parsed server rename result. */
export interface RenamedServer extends Schema.Schema.Type<typeof RenamedServer> {}
/** Most server renames one listing returns, newest first. */
export const maxServerRenames = 25;
/**
 * One recorded server name change. `renamedBy` is the person's display name, or null when their
 * profile is gone.
 */
export const ServerRename = Schema.Struct({
  id: Schema.String.check(Schema.isUUID(4)),
  previousName: M.ServerName,
  name: M.ServerName,
  renamedAt: M.Timestamp,
  renamedBy: Schema.NullOr(Schema.String),
});
/** Parsed server rename. */
export interface ServerRename extends Schema.Schema.Type<typeof ServerRename> {}
/** A server's recent renames, newest first. */
export const ServerRenames = Schema.Struct({ items: Schema.Array(ServerRename) });
/** Parsed server rename listing. */
export interface ServerRenames extends Schema.Schema.Type<typeof ServerRenames> {}
/** Exact-name confirmation for irreversible server deletion. */
export const DeleteServer = Schema.Struct({ confirmation: M.ServerName }).annotate({
  parseOptions: { onExcessProperty: "error" },
});
/** Parsed deletion confirmation. */
export interface DeleteServer extends Schema.Schema.Type<typeof DeleteServer> {}
/** Deletion has settled usage and removed the server's content. */
export const DeletedServer = Schema.Struct({
  serverId: M.ServerId,
  status: Schema.Literal("deleted"),
});
/** Parsed completed deletion. */
export interface DeletedServer extends Schema.Schema.Type<typeof DeletedServer> {}
/** Bounded cursor query for platform collections. */
export const Listing = Schema.Struct({
  after: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
/** Platform envelope carries the same instruction metadata without inventing a current server. */
export const response = <S extends Schema.Top>(data: S) =>
  Schema.Struct({ data, meta: Envelope.Meta });
/** Cursor page shared across platform and provider listings. */
export const page = <S extends Schema.Top>(item: S) =>
  Schema.Struct({ items: Schema.Array(item), nextCursor: Schema.NullOr(Schema.String) });
/** Typed bounded platform page. */
export interface Page<A> {
  readonly items: ReadonlyArray<A>;
  readonly nextCursor: string | null;
}
/** Public login discovery for the API helper; no credentials are returned. */
export const Authentication = Schema.Struct({
  clientId: Schema.String,
  issuer: Schema.String,
  flow: Schema.Literal("workos-device"),
});
/** Public authentication discovery contract, served before bearer verification. */
export const AuthApi = HttpApi.make("talkto-authentication").add(
  HttpApiGroup.make("authentication").add(
    HttpApiEndpoint.get("authentication", "/auth", {
      success: response(Authentication),
      error: Envelope.failures,
    }),
    HttpApiEndpoint.get("browserLogin", "/auth/login", {
      query: Schema.Struct({
        invitation_token: Schema.optionalKey(Schema.String),
        return_to: Schema.optionalKey(Schema.String),
      }),
      success: HttpApiSchema.Empty(303),
      error: Envelope.failures,
    }),
    HttpApiEndpoint.get("browserCallback", "/auth/callback", {
      query: Schema.Struct({ code: Schema.String, state: Schema.String }),
      success: HttpApiSchema.Empty(303),
      error: Envelope.failures,
    }),
    HttpApiEndpoint.post("browserLogout", "/auth/logout", {
      success: HttpApiSchema.Empty(303),
      error: Envelope.failures,
    }),
  ),
);
/** Initial account activity search or a continuation scoped to the caller and account. */
export const ActivityInput = Schema.Union([
  Schema.Struct({
    query: Schema.optionalKey(I.SearchQuery),
    limit: Schema.optionalKey(D.FeedLimit),
  }),
  Schema.Struct({ cursor: M.Cursor, limit: Schema.optionalKey(D.FeedLimit) }),
]).annotate({ parseOptions: { onExcessProperty: "error" } });
/** Parsed account activity selection. */
export type ActivityInput = typeof ActivityInput.Type;
/** The oldest confirmed export among readable servers; missing or unfinished exports are explicit. */
export const ActivityFreshness = Schema.Struct({
  indexedThrough: Schema.NullOr(M.Timestamp),
  pendingServers: M.Count,
});
/** Parsed projection freshness. */
export interface ActivityFreshness extends Schema.Schema.Type<typeof ActivityFreshness> {}
/**
 * Which servers a search page covered. Searches run inside each server; a page asks at most
 * `serverLimit` readable servers, most recently active first. A server that did not answer is
 * counted in `unavailableServers`; its matches are missing from this page, not hidden as none.
 */
export const SearchCoverage = Schema.Struct({
  serverLimit: M.Count,
  searchedServers: M.Count,
  unavailableServers: M.Count,
  notSearchedServers: M.Count,
});
/** Parsed search coverage. */
export interface SearchCoverage extends Schema.Schema.Type<typeof SearchCoverage> {}
/** Full authoritative messages, with related records grouped by their server scope. */
export const AccountFeed = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ serverId: M.ServerId, serverName: M.ServerName, message: M.Message }),
  ),
  included: Schema.Array(Schema.Struct({ serverId: M.ServerId, ...M.Included.fields })),
  nextCursor: Schema.NullOr(M.Cursor),
  liveCursor: M.Cursor,
  caughtUp: Schema.Boolean,
  freshness: ActivityFreshness,
  /** Present on search pages only. */
  search: Schema.optionalKey(SearchCoverage),
});
/** Parsed aggregate message page. */
export interface AccountFeed extends Schema.Schema.Type<typeof AccountFeed> {}
/** Initial Home feed size; omitted limits preserve the existing 50-message response. */
export const DashboardInput = Schema.Struct({ limit: Schema.optionalKey(D.FeedLimit) });
/** Parsed Home selection. */
export type DashboardInput = typeof DashboardInput.Type;
/** Bounded Home response; rank counts use the declared window and indexed freshness. */
export const Dashboard = Schema.Struct({
  serverSelection: Schema.Literals(["all", "active"]),
  servers: Schema.Array(
    Schema.Struct({
      summary: D.Summary,
      activity: D.Activity,
      permissions: ServerContext.fields.permissions,
    }),
  ),
  windowStart: M.Timestamp,
  windowEnd: M.Timestamp,
  feedLimit: Schema.optionalKey(D.FeedLimit),
  feed: AccountFeed,
});
/** Parsed account Home context. */
export interface Dashboard extends Schema.Schema.Type<typeof Dashboard> {}
/** Management directory filters; continuations retain the name query. */
export const ServerListing = Schema.Struct({
  after: Schema.optionalKey(M.Cursor),
  query: Schema.optionalKey(I.DirectoryQuery),
  limit: Schema.optionalKey(M.Limit),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
/** Parsed management directory input. */
export interface ServerListing extends Schema.Schema.Type<typeof ServerListing> {}
/** A page scans at most limit provider memberships; matches may be empty before the last page. */
export const IdentityListing = ServerListing;
/** Parsed account/member directory request. */
export interface IdentityListing extends Schema.Schema.Type<typeof IdentityListing> {}
/** HTTP contract for ownership and access management, separate from messaging. */
export const Api = HttpApi.make("talkto-platform").add(
  HttpApiGroup.make("platform")
    .add(
      HttpApiEndpoint.get("dashboard", "/v1/accounts/:accountId/dashboard", {
        params: { accountId: AccountId },
        query: DashboardInput,
        success: response(Dashboard),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.get("activity", "/v1/accounts/:accountId/activity", {
        params: { accountId: AccountId },
        query: Schema.Struct({
          query: Schema.optionalKey(I.SearchQuery),
          cursor: Schema.optionalKey(M.Cursor),
          limit: Schema.optionalKey(D.FeedLimit),
        })
          .pipe(Schema.decodeTo(ActivityInput))
          .annotate({ parseOptions: { onExcessProperty: "error" } }),
        success: response(AccountFeed),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.get("managedServer", "/v1/accounts/:accountId/servers/:serverId", {
        params: { accountId: AccountId, serverId: M.ServerId },
        success: response(ServerDetail),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.post("renameServer", "/v1/accounts/:accountId/servers/:serverId/rename", {
        params: { accountId: AccountId, serverId: M.ServerId },
        payload: Rename,
        success: response(RenamedServer),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.get("serverRenames", "/v1/accounts/:accountId/servers/:serverId/renames", {
        params: { accountId: AccountId, serverId: M.ServerId },
        success: response(ServerRenames),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.post("deleteServer", "/v1/accounts/:accountId/servers/:serverId/delete", {
        params: { accountId: AccountId, serverId: M.ServerId },
        payload: DeleteServer,
        success: response(DeletedServer),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.get("currentUser", "/v1/me", {
        success: response(
          Schema.Struct({
            user: User,
            permissions: Schema.Struct({ createAccount: Schema.Literal(true) }),
            connection: Schema.Struct({
              mcpUrl: Schema.String,
              instructionsUrl: Schema.String,
              /**
               * Present on a self-hosted copy that signs people in with Cloudflare Access or Better
               * Auth: there, invitations send no email. With Access they are accepted at the
               * invitee's first sign-in; with Better Auth the invitee creates an account from the
               * invitation's sign-up link.
               */
              signIn: Schema.optionalKey(Schema.Literals(["cloudflare-access", "better-auth"])),
            }),
          }),
        ),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.get("listAccounts", "/v1/accounts", {
        query: IdentityListing,
        success: response(page(AccountSummary)),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.get("getAccount", "/v1/accounts/:accountId", {
        params: { accountId: AccountId },
        success: response(AccountContext),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.post("createAccount", "/v1/accounts", {
        payload: Create,
        success: response(AccountContext),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.post("renameAccount", "/v1/accounts/:accountId/rename", {
        params: { accountId: AccountId },
        payload: Rename,
        success: response(RenamedAccount),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.get("listMembers", "/v1/accounts/:accountId/members", {
        params: { accountId: AccountId },
        query: IdentityListing,
        success: response(page(MemberContext)),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.post("createServer", "/v1/accounts/:accountId/servers", {
        params: { accountId: AccountId },
        payload: Create,
        success: response(Server),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.get("managedServers", "/v1/accounts/:accountId/servers", {
        params: { accountId: AccountId },
        query: ServerListing,
        success: response(page(ServerContext)),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.post("resumeServer", "/v1/accounts/:accountId/servers/:serverId/resume", {
        params: { accountId: AccountId, serverId: M.ServerId },
        success: response(ServerContext),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.get("listInvitations", "/v1/accounts/:accountId/invitations", {
        params: { accountId: AccountId },
        query: Listing,
        success: response(page(Invitation)),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.post("sendInvitation", "/v1/accounts/:accountId/invitations", {
        params: { accountId: AccountId },
        payload: Invite,
        success: response(Invitation),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.post(
        "resendInvitation",
        "/v1/accounts/:accountId/invitations/:invitationId/resend",
        {
          params: { accountId: AccountId, invitationId: InvitationId },
          success: response(Invitation),
          error: Envelope.failures,
        },
      ),
      HttpApiEndpoint.delete(
        "cancelInvitation",
        "/v1/accounts/:accountId/invitations/:invitationId",
        {
          params: { accountId: AccountId, invitationId: InvitationId },
          success: response(Invitation),
          error: Envelope.failures,
        },
      ),
      HttpApiEndpoint.delete("removeMember", "/v1/accounts/:accountId/members/:userId", {
        params: { accountId: AccountId, userId: UserId },
        success: response(RemovedMember),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.get("discoverServers", "/v1/servers", {
        query: Listing,
        success: response(page(Server)),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.get("listGrants", "/v1/servers/:serverId/access", {
        params: { serverId: M.ServerId },
        query: Listing,
        success: response(page(GrantContext)),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.get("listGrantCandidates", "/v1/servers/:serverId/access/candidates", {
        params: { serverId: M.ServerId },
        query: IdentityListing,
        success: response(page(User)),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.put("grantAccess", "/v1/servers/:serverId/access/:userId", {
        params: { serverId: M.ServerId, userId: UserId },
        success: response(Grant),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.delete("revokeAccess", "/v1/servers/:serverId/access/:userId", {
        params: { serverId: M.ServerId, userId: UserId },
        success: response(Grant),
        error: Envelope.failures,
      }),
    )
    .middleware(Authorization),
);
