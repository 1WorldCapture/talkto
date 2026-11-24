import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import type * as Guests from "@talkto/api/guests";
import { request, denied, ApiError, input } from "./api.js";
import { AppLink, Dialog, Notice, OrganizationIcon, Pagination, Search } from "./components.js";
import { clearAgentData, useHuman, useSelfHostedSignIn, useServices } from "./session.js";
import { CopyLink } from "./server-invites.js";
import { formatCount } from "./format.js";
import { StarterOffer, useStarter } from "./starter.js";
import {
  allowanceRule,
  guestInvited,
  guestLinkRule,
  inviteCopy,
  serverAccessScope,
  signUpLink,
} from "./invite-copy.js";
import "./removed-tag.css";
import { defaultOrganizationName } from "./organization-name.js";

/** Reconcile mutations even after their dialog unmounts; never optimistically invent authority. */
export function useAction<A, B>(
  operation: (input: A) => Promise<B>,
  completed?: (value: B) => void,
) {
  const { queries } = useServices();
  const user = useHuman();
  return useMutation({
    mutationFn: operation,
    onMutate: async () => {
      await queries.cancelQueries({ queryKey: ["human", user.id] });
    },
    onSuccess: (value) => completed?.(value),
    onSettled: async () => {
      await queries.cancelQueries({ queryKey: ["human", user.id] });
      await queries.invalidateQueries({ queryKey: ["human", user.id] });
    },
  });
}

function readIntent(key: string) {
  try {
    const value = sessionStorage.getItem(key);
    return value === null ? null : Schema.decodeUnknownSync(Schema.fromJsonString(P.Create))(value);
  } catch {
    return null;
  }
}

/** One durable browser intent per user/scope, retained across reload and ambiguous outcomes. */
export function CreateDialog({
  accountId,
  close,
  created,
}: {
  readonly accountId?: P.AccountId | undefined;
  readonly close: () => void;
  readonly created: (path: string) => void;
}) {
  const { api } = useServices();
  const user = useHuman();
  const storageKey = `talkto-create:${user.id}:${accountId ?? "account"}`;
  const [intent, setIntent] = useState(() => readIntent(storageKey));
  // A first organization starts with a name from the email or first name; a server starts empty.
  const [name, setName] = useState(
    () => intent?.name ?? (accountId ? "" : defaultOrganizationName(user.email, user.firstName)),
  );
  const [validation, setValidation] = useState<Error | null>(null);
  // The organization's first server opens the free start when its owner is eligible.
  const starter = useStarter(accountId ?? null);
  const claim = starter.data?.data.status === "eligible" && starter.data.data.offer !== null;
  const action = useAction(
    async (input: P.Create) => {
      if (accountId && claim) {
        try {
          const result = await request(
            api.starter.claim({ params: { accountId }, payload: input }),
          );
          return `accounts/${accountId}/servers/${result.data.server.id}`;
        } finally {
          // A denial explains itself through the refreshed state (paused, verify email, used).
          void starter.refetch();
        }
      }
      if (accountId) {
        const result = await request(
          api.platform.createServer({ params: { accountId }, payload: input }),
        );
        return `accounts/${accountId}/servers/${result.data.id}`;
      }
      const result = await request(api.platform.createAccount({ payload: input }));
      return `accounts/${result.data.id}`;
    },
    (path) => {
      sessionStorage.removeItem(storageKey);
      created(path);
    },
  );
  return (
    <Dialog title={accountId ? "New server" : "Create organization"} close={close}>
      {!accountId && <p>Use one for yourself or share it with a team.</p>}
      {accountId && <StarterOffer state={starter.data?.data} />}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (action.isPending) return;
          const parsed = Schema.decodeUnknownResult(P.Create)({
            name,
            requestKey: intent?.requestKey ?? crypto.randomUUID(),
          });
          if (parsed._tag === "Failure") {
            setValidation(
              new ApiError("invalid_input", "Enter a name between 1 and 100 characters."),
            );
            return;
          }
          try {
            sessionStorage.setItem(storageKey, JSON.stringify(parsed.success));
          } catch {
            setValidation(
              new ApiError(
                "invalid_input",
                "Allow browser session storage so this creation can be recovered safely.",
              ),
            );
            return;
          }
          setValidation(null);
          setIntent(parsed.success);
          action.mutate(parsed.success);
        }}
      >
        <label>
          {accountId ? "Server name" : "Organization name"}
          <input
            name="name"
            required
            maxLength={100}
            value={name}
            readOnly={intent !== null}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {intent && (
          <p className="muted">
            This request is saved. Retrying checks the same {accountId ? "server" : "organization"}.
          </p>
        )}
        <Notice error={validation ?? action.error} />
        <div className="form-actions">
          <button className="btn" disabled={action.isPending}>
            {action.isPending
              ? claim
                ? "Creating your server…"
                : "Confirming…"
              : intent
                ? "Retry same request"
                : claim
                  ? "Create server"
                  : "Create"}
          </button>
          <button type="button" className="text-button" onClick={close}>
            Close
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Share the directory cache; dashboard entry rechecks membership before choosing a default. */
export function useAccounts(cursor?: string, refreshOnMount = false) {
  const { api } = useServices();
  const user = useHuman();
  return useQuery({
    queryKey: ["human", user.id, "accounts", "", cursor],
    refetchOnMount: refreshOnMount ? "always" : true,
    queryFn: ({ signal }) =>
      request(
        api.platform.listAccounts({
          query: input(P.IdentityListing, { after: cursor, limit: 20 }),
        }),
        signal,
      ),
  });
}

/** Organization selector; API account IDs and provider continuations remain stable. */
export function Accounts({
  selected,
  presentation = "cards",
}: {
  readonly selected?: P.AccountId | undefined;
  readonly presentation?: "cards" | "list";
}) {
  const user = useHuman();
  const [cursor, setCursor] = useState<string>();
  const result = useAccounts(cursor);
  return (
    <>
      <Notice error={result.error} stale={!!result.data} retry={() => void result.refetch()} />
      {!denied(result.error) && result.data && (
        <div className={presentation === "cards" ? "organization-grid" : "organization-list"}>
          {result.data.data.items.map((account) => (
            <AppLink
              key={account.id}
              className={presentation === "cards" ? "organization-card" : "ops-account-option"}
              path={`accounts/${account.id}`}
              current={selected === account.id}
            >
              <span className="organization-heading">
                <OrganizationIcon />
                <strong>{account.name}</strong>
              </span>
              {presentation === "cards" ? (
                <span className="organization-card-footer">
                  <span className="muted" title="Servers you can access or manage">
                    {formatCount(account.serverCount, "server")}
                  </span>
                  <span className="organization-open">Open →</span>
                </span>
              ) : (
                <small>{selected === account.id ? "Current" : "→"}</small>
              )}
            </AppLink>
          ))}
        </div>
      )}
      {result.isPending && <p role="status">Loading organizations…</p>}
      {result.data && (
        <>
          <Empty items={result.data.data.items}>
            {!cursor && result.data.data.nextCursor === null
              ? `No organizations yet. Create one or accept an invitation sent to ${user.email}.`
              : "No organizations on this page."}
          </Empty>
          {(cursor || result.data.data.nextCursor) && (
            <Pagination
              cursor={cursor}
              next={result.data.data.nextCursor}
              count={result.data.data.items.length}
              onChange={setCursor}
            />
          )}
        </>
      )}
    </>
  );
}

/** Empty is distinct from failure, and an empty provider page may still have a continuation. */
export function Empty({
  items,
  children,
}: {
  readonly items: ReadonlyArray<unknown>;
  readonly children: ReactNode;
}) {
  return items.length === 0 ? <p className="ops-empty">{children}</p> : null;
}

/** Human membership and invitations stay separate from server grants. */
export function Members({ account }: { readonly account: P.AccountContext }) {
  const { api } = useServices();
  const user = useHuman();
  const signIn = useSelfHostedSignIn();
  const copy = inviteCopy(signIn);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string>();
  const [invitationCursor, setInvitationCursor] = useState<string>();
  const [email, setEmail] = useState("");
  const [remove, setRemove] = useState<P.MemberContext | null>(null);
  const params = { accountId: account.id };
  const members = useQuery({
    queryKey: ["human", user.id, account.id, "members", query, cursor],
    queryFn: ({ signal }) =>
      request(
        api.platform.listMembers({
          params,
          query: input(P.IdentityListing, { query, after: cursor, limit: 20 }),
        }),
        signal,
      ),
  });
  const invitations = useQuery({
    queryKey: ["human", user.id, account.id, "invitations", invitationCursor],
    enabled: account.permissions.manageMembers,
    queryFn: ({ signal }) =>
      request(
        api.platform.listInvitations({
          params,
          query: input(P.Listing, { after: invitationCursor }),
        }),
        signal,
      ),
  });
  const invite = useAction(
    (value: string) => request(api.platform.sendInvitation({ params, payload: { email: value } })),
    () => setEmail(""),
  );
  const cancel = useAction((invitationId: P.InvitationId) =>
    request(api.platform.cancelInvitation({ params: { ...params, invitationId } })),
  );
  const resend = useAction((invitationId: P.InvitationId) =>
    request(api.platform.resendInvitation({ params: { ...params, invitationId } })),
  );
  const removeAction = useAction(
    (userId: P.UserId) => request(api.platform.removeMember({ params: { ...params, userId } })),
    () => setRemove(null),
  );
  return (
    <section className="management">
      <div className="ops-page-bar">
        <h1 className="ops-page-title">Members</h1>
        <Search
          value={query}
          onChange={(value) => {
            setQuery(value);
            setCursor(undefined);
          }}
          label="Find members"
        />
      </div>
      {account.permissions.manageMembers && (
        <p className="muted management-intro">
          Invite people to your organization, then grant server access separately.
        </p>
      )}
      <Notice error={members.error} stale={!!members.data} />
      {!denied(members.error) &&
        members.data?.data.items.map((member) => (
          <div className="management-row" key={member.id}>
            <div>
              <strong>{displayUser(member.user)}</strong>
              <small>{member.user.email}</small>
            </div>
            {member.permissions.remove && (
              <button className="text-button" onClick={() => setRemove(member)}>
                Remove
              </button>
            )}
          </div>
        ))}
      {members.isPending && <p role="status">Loading members…</p>}
      {members.data && (
        <Pagination
          cursor={cursor}
          next={members.data.data.nextCursor}
          count={members.data.data.items.length}
          onChange={setCursor}
        />
      )}
      {account.permissions.manageMembers && (
        <>
          <div className="ops-page-bar">
            <h2>Invitations</h2>
          </div>
          <form
            className="inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!invite.isPending) invite.mutate(email);
            }}
          >
            <label>
              Email
              <input
                type="email"
                required
                maxLength={254}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <button className="btn" disabled={invite.isPending}>
              {invite.isPending ? "Sending…" : "Invite to organization"}
            </button>
          </form>
          {invite.isSuccess ? (
            <p className="muted management-note" role="status">
              {copy.sent(invite.variables)}
            </p>
          ) : (
            <p className="muted management-note">{copy.scope}</p>
          )}
          <p className="muted management-note">{allowanceRule}</p>
          <Notice error={invite.error ?? cancel.error ?? resend.error ?? invitations.error} />
          {/* Billing offers Studio either way: plan cards when unpaid, Change plan on Shop. */}
          {peopleLimit(invite.error ?? resend.error) ? (
            account.permissions.manageBilling ? (
              <p className="muted">
                <AppLink path={`accounts/${account.id}/billing`}>Move to Studio in Billing</AppLink>{" "}
                for unlimited people.
              </p>
            ) : (
              <p className="muted">Only the organization owner can move it to Studio.</p>
            )
          ) : (
            invite.error &&
            !invitationLimited(invite.error) && (
              <p className="muted">
                Delivery is unconfirmed. Check the invitation list before sending again.
              </p>
            )
          )}
          {!denied(invitations.error) &&
            invitations.data?.data.items.map((invitation) => (
              <div className="management-row" key={invitation.id}>
                <div>
                  {invitation.email}
                  <small>{invitation.state}</small>
                </div>
                {invitation.state === "pending" && (
                  <div className="actions">
                    {signIn === "better-auth" && (
                      <CopyLink
                        link={signUpLink(location.origin, invitation.id)}
                        label="Copy invitation link"
                      />
                    )}
                    <button
                      disabled={resend.isPending}
                      onClick={() => resend.mutate(invitation.id)}
                    >
                      Resend
                    </button>
                    <button
                      disabled={cancel.isPending}
                      onClick={() => cancel.mutate(invitation.id)}
                    >
                      Cancel invitation
                    </button>
                  </div>
                )}
              </div>
            ))}
          {invitations.data && (
            <Pagination
              cursor={invitationCursor}
              next={invitations.data.data.nextCursor}
              count={invitations.data.data.items.length}
              onChange={setInvitationCursor}
            />
          )}
        </>
      )}
      {remove && (
        <Dialog title="Remove organization member" close={() => setRemove(null)}>
          <p>
            Remove {displayUser(remove.user)} from {account.name}? Their access to this
            organization’s servers will also be revoked.
          </p>
          <Notice error={removeAction.error} />
          <div className="form-actions">
            <button
              className="btn"
              disabled={removeAction.isPending}
              onClick={() => removeAction.mutate(remove.userId)}
            >
              {removeAction.isPending ? "Confirming removal…" : "Remove member"}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

/** An invitation email budget refused the action; nothing was sent. */
const invitationLimited = (error: Error | null) =>
  error instanceof ApiError && error.code === "invitation_limited";
/** Shop's people limit refused the action; nothing was sent. */
const peopleLimit = (error: Error | null) =>
  error instanceof ApiError && error.code === "people_limit_reached";

/**
 * A server guest's grant: TalkTo writes their membership itself, `om_guest` and 32 hex characters
 * (docs/dashboard-api.md, "Server guests"). WorkOS memberships start with `om_01`.
 */
export const isGuestGrant = (grant: Pick<P.Grant, "membershipId">) =>
  grant.membershipId.startsWith("om_guest");

/** Human label uses actual WorkOS profile fields, including a safe email fallback. */
export const displayUser = (user: P.User) =>
  [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email;

/** Explicit grant management, including desired/applied revision acknowledgment. */
export function AccessDialog({
  accountId,
  server,
  close,
}: {
  readonly accountId: P.AccountId;
  readonly server: Pick<P.ServerContext, "id" | "name">;
  readonly close: () => void;
}) {
  const { api, queries } = useServices();
  const user = useHuman();
  const [cursor, setCursor] = useState<string>();
  const [query, setQuery] = useState("");
  const [memberCursor, setMemberCursor] = useState<string>();
  const [invited, setInvited] = useState<Guests.Invited | null>(null);
  const grants = useQuery({
    queryKey: ["human", user.id, accountId, server.id, "grants", cursor],
    queryFn: ({ signal }) =>
      request(
        api.platform.listGrants({
          params: { serverId: server.id },
          query: input(P.Listing, { after: cursor }),
        }),
        signal,
      ),
    refetchInterval: (result) =>
      result.state.data?.data.items.some((g) => g.revision !== g.appliedRevision) ? 2000 : false,
  });
  const members = useQuery({
    queryKey: ["human", user.id, accountId, server.id, "grant-candidates", query, memberCursor],
    queryFn: ({ signal }) =>
      request(
        api.platform.listGrantCandidates({
          params: { serverId: server.id },
          query: input(P.IdentityListing, {
            query: memberCursor ? undefined : query,
            after: memberCursor,
            limit: 10,
          }),
        }),
        signal,
      ),
  });
  const action = useAction(
    (input: { readonly userId: P.UserId; readonly grant: boolean }) =>
      request(
        input.grant
          ? api.platform.grantAccess({ params: { serverId: server.id, userId: input.userId } })
          : api.platform.revokeAccess({ params: { serverId: server.id, userId: input.userId } }),
      ),
    (result) => {
      setInvited(null);
      if (result.data.userId === user.id && result.data.revokedAt !== null)
        clearAgentData(
          queries,
          ["human", user.id, accountId],
          new ApiError("forbidden", "Your message access was revoked."),
        );
    },
  );
  // A removed guest is not a member, so access cannot be granted again: they are invited again.
  const inviteAgain = useAction(
    (email: string) =>
      request(api.guests.inviteGuest({ params: { serverId: server.id }, payload: { email } })),
    (result) => setInvited(result.data),
  );
  // The two reads may finish at different times after a grant; never repeat a visible person.
  const candidates =
    members.data?.data.items.filter(
      (member) => !grants.data?.data.items.some((grant) => grant.userId === member.id),
    ) ?? [];
  const showCandidates =
    members.isPending ||
    members.isError ||
    query !== "" ||
    memberCursor !== undefined ||
    candidates.length > 0 ||
    Boolean(members.data?.data.nextCursor);
  const accessDenied = denied(grants.error) || denied(members.error);
  return (
    <Dialog title={`Server access · ${server.name}`} close={close}>
      <p className="muted">{serverAccessScope}</p>
      <Notice error={grants.error ?? members.error ?? action.error ?? inviteAgain.error} />
      {invited && (
        <div className="notice" role="status">
          <p>{guestInvited(invited.invitation.email, invited.emailed)}</p>
          <input
            readOnly
            value={invited.link}
            aria-label="Join link"
            onFocus={(event) => event.currentTarget.select()}
          />
          <small>{guestLinkRule(invited.invitation.email)}</small>
        </div>
      )}
      {grants.isPending && <p role="status">Loading access…</p>}
      {!accessDenied &&
        grants.data?.data.items.map((grant) => (
          <div className="management-row" key={grant.id}>
            <div>
              <strong>{grant.user ? displayUser(grant.user) : grant.userId}</strong>
              {isGuestGrant(grant) && (
                <span className="guest-tag" title="Can open this server only">
                  Guest
                </span>
              )}
              {(grant.revision !== grant.appliedRevision || grant.revokedAt !== null) && (
                <small>
                  {grant.revision !== grant.appliedRevision
                    ? grant.revokedAt
                      ? "Revocation pending"
                      : "Grant pending"
                    : "Revoked"}
                </small>
              )}
            </div>
            {grant.revokedAt !== null && isGuestGrant(grant) ? (
              grant.user && (
                <button
                  className="text-button"
                  disabled={inviteAgain.isPending || grant.revision !== grant.appliedRevision}
                  onClick={() => {
                    if (grant.user) inviteAgain.mutate(grant.user.email);
                  }}
                >
                  {inviteAgain.isPending ? "Inviting…" : "Invite again"}
                </button>
              )
            ) : (
              <button
                className="text-button"
                disabled={action.isPending || grant.revision !== grant.appliedRevision}
                onClick={() =>
                  action.mutate({ userId: grant.userId, grant: grant.revokedAt !== null })
                }
              >
                {grant.revokedAt ? "Grant access" : "Revoke"}
              </button>
            )}
          </div>
        ))}
      {!accessDenied && grants.data && (cursor || grants.data.data.nextCursor) && (
        <Pagination
          cursor={cursor}
          next={grants.data.data.nextCursor}
          count={grants.data.data.items.length}
          onChange={setCursor}
        />
      )}
      {!accessDenied && showCandidates && (
        <>
          <h3>Grant access</h3>
          <div className="ops-page-bar">
            <Search
              value={query}
              onChange={(value) => {
                setQuery(value);
                setMemberCursor(undefined);
              }}
              label="Find a member"
            />
          </div>
          {members.isPending && <p role="status">Loading members…</p>}
          {candidates.map((member) => (
            <div className="management-row" key={member.id}>
              <span>{displayUser(member)}</span>
              <button
                disabled={action.isPending || members.isError}
                onClick={() => action.mutate({ userId: member.id, grant: true })}
              >
                Grant access
              </button>
            </div>
          ))}
          {members.isSuccess && candidates.length === 0 && (
            <p>
              {members.data.data.nextCursor
                ? "No eligible members on this page."
                : "No matching members."}
            </p>
          )}
          {members.data && (memberCursor || members.data.data.nextCursor) && (
            <Pagination
              cursor={memberCursor}
              next={members.data.data.nextCursor}
              count={candidates.length}
              onChange={setMemberCursor}
            />
          )}
        </>
      )}
      {!accessDenied && (
        <footer className="ops-access-members">
          <AppLink path={`accounts/${accountId}/members`} className="btn secondary">
            Members &amp; invitations →
          </AppLink>
          <p className="muted">Invite people to the organization, then grant server access here.</p>
        </footer>
      )}
    </Dialog>
  );
}

/** Reconcile one known provisioning reservation; a timeout does not create a replacement. */
export function Recovery({
  server,
  accountId,
}: {
  readonly server: P.ServerContext;
  readonly accountId: P.AccountId;
}) {
  const { api } = useServices();
  const action = useAction((serverId: M.ServerId) =>
    request(api.platform.resumeServer({ params: { accountId, serverId } })),
  );
  return (
    <div className="notice">
      <p>
        {server.status === "provisioning"
          ? "Server provisioning is not yet confirmed."
          : "You do not currently have message access to this server."}
      </p>
      {server.permissions.resume && (
        <button
          className="text-button"
          disabled={action.isPending}
          onClick={() => action.mutate(server.id)}
        >
          {action.isPending ? "Checking…" : "Resume provisioning"}
        </button>
      )}
      <Notice error={action.error} />
    </div>
  );
}
