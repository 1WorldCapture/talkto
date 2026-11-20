import { useEffect, useId, useRef, useState } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import * as P from "@talkto/api/platform";
import type * as M from "@talkto/api/models";
import type * as B from "@talkto/api/billing";
import type * as S from "@talkto/api/starter";
import type * as Guests from "@talkto/api/guests";
import * as I from "@talkto/api/inputs";
import { plans } from "@talkto/api/pricing";
import { describeAgentType } from "@talkto/api/agent-types";
import { ApiError, denied, input, request, type Client } from "./api.js";
import { AppLink, Dialog, Notice } from "./components.js";
import { useHuman, useServices } from "./session.js";
import { useAction } from "./management.js";
import { currentPaidPeriod, hasTrialUsage } from "./billing-state.js";
import { starterQuery } from "./dashboard-queries.js";
import { formatActivityTime } from "./activity-time.js";
import {
  allowanceRule,
  guestExpiry,
  guestInviteScope,
  guestInvited,
  guestLinkRule,
  guestLinksRule,
  guestPeopleLimit,
} from "./invite-copy.js";
import "./server-invites.css";

/** How often the page asks again while someone is invited but has not arrived yet. */
export const pollMs = 10_000;
/** An accepted guest's first agent is awaited this long before polling stops. */
const awaitAgentMs = 3_600_000;
/** An arrival this recent is also named on the server page, beside Invite. */
const freshMs = 86_400_000;

/** The join link of an invitation; it admits only the invited, verified address. */
export const joinLink = (origin: string, id: Guests.InvitationId) => `${origin}/app/join/${id}`;

/** One line of "who arrived": the guest, then each of their agents. */
export interface Arrival {
  readonly key: string;
  readonly text: string;
  readonly detail: string | null;
  readonly at: string;
}

/** An agent's tool in a sentence: "Claude · Code" reads "Claude Code". */
export const toolName = (agentType: string) =>
  describeAgentType(agentType).label.replace(" · Legacy", "").replaceAll(" · ", " ");

/** The guest's name as the inviter reads it; the invited address when the person is gone. */
const guestName = (invitation: Guests.Invitation) =>
  invitation.guest?.name?.trim() || invitation.email;

/**
 * Who arrived through these invitations, newest first: "Alex joined", then "Alex’s Claude Code
 * joined" for each agent whose `registeredBy` is that guest and that registered after accepting.
 * People's own participants and removed agents are left out; so are guests removed since.
 */
export function arrivals(
  invitations: ReadonlyArray<Guests.Invitation>,
  participants: ReadonlyArray<M.Participant>,
): ReadonlyArray<Arrival> {
  const lines: Array<Arrival> = [];
  for (const invitation of invitations) {
    const guest = invitation.guest;
    if (invitation.state !== "accepted" || guest === null || invitation.acceptedAt === null)
      continue;
    if (guest.access === "removed") continue;
    const name = guestName(invitation);
    const acceptedAt = invitation.acceptedAt;
    lines.push({ key: invitation.id, text: `${name} joined`, detail: null, at: acceptedAt });
    for (const agent of participants)
      if (
        agent.registeredBy?.userId === guest.userId &&
        agent.kind === undefined &&
        agent.removedAt === undefined &&
        Date.parse(agent.createdAt) >= Date.parse(acceptedAt)
      )
        lines.push({
          key: `${invitation.id}:${agent.id}`,
          text: `${name}’s ${toolName(agent.agentType)} joined`,
          detail: agent.name,
          at: agent.createdAt,
        });
  }
  return lines.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/**
 * Keep asking while an invitation is pending, or a guest accepted within the hour and none of
 * their agents has arrived yet.
 */
export function awaiting(
  invitations: ReadonlyArray<Guests.Invitation>,
  participants: ReadonlyArray<M.Participant> | undefined,
  now = Date.now(),
) {
  return invitations.some(
    (invitation) =>
      invitation.state === "pending" ||
      (invitation.state === "accepted" &&
        invitation.guest !== null &&
        invitation.guest.access !== "removed" &&
        invitation.acceptedAt !== null &&
        now - Date.parse(invitation.acceptedAt) < awaitAgentMs &&
        !(participants ?? []).some(
          (agent) => agent.registeredBy?.userId === invitation.guest?.userId && !agent.kind,
        )),
  );
}

/**
 * The plan whose people limit refused an invitation, as the server decides it (`limitName` in
 * platform/people.ts): Free with no paid period or trial where this environment has the Free plan,
 * otherwise Shop.
 */
export const limitPlan = (
  billing: B.State | undefined,
  starter: S.State | undefined,
): "Free" | "Shop" =>
  billing !== undefined &&
  currentPaidPeriod(billing) === null &&
  !hasTrialUsage(billing) &&
  starter?.free !== undefined
    ? "Free"
    : "Shop";

const peopleLimited = (error: Error | null) =>
  error instanceof ApiError && error.code === "people_limit_reached";

/** Copy a join link; where the browser refuses, show it to copy by hand. */
export function CopyLink({
  link,
  label = "Copy link",
}: {
  readonly link: string;
  readonly label?: string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "manual">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setStatus("copied");
    } catch {
      setStatus("manual");
    }
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus((now) => (now === "copied" ? "idle" : now)), 2500);
  };
  return (
    <>
      <button type="button" onClick={() => void copy()} aria-live="polite">
        {status === "copied" ? "Copied" : label}
      </button>
      {status === "manual" && (
        <input
          className="server-invites-manual"
          readOnly
          value={link}
          aria-label="Join link"
          onFocus={(event) => event.currentTarget.select()}
        />
      )}
    </>
  );
}

/**
 * The organization read that decides whether this person may invite, made only by someone who
 * manages the server's access. A guest's read of the organization is refused, and a refused
 * account read clears every query under that organization (session.tsx), which would empty the
 * guest's own view of the shared server.
 */
export const inviterAccountQuery = (
  api: Client,
  userId: string,
  accountId: P.AccountId,
  server: Pick<P.ServerContext, "permissions">,
) =>
  queryOptions({
    queryKey: ["human", userId, accountId, "account"],
    enabled: server.permissions.manageAccess,
    queryFn: ({ signal }) => request(api.platform.getAccount({ params: { accountId } }), signal),
  });

/**
 * Invite someone by email to this one server, on its page beside Access. Shown to a person who
 * can manage the server's access and the organization's members: the owner who created it.
 */
export function ServerInvites({
  accountId,
  server,
}: {
  readonly accountId: P.AccountId;
  readonly server: P.ServerContext;
}) {
  const { api } = useServices();
  const user = useHuman();
  const [open, setOpen] = useState(false);
  const account = useQuery(inviterAccountQuery(api, user.id, accountId, server));
  const allowed =
    server.permissions.manageAccess &&
    !denied(account.error) &&
    account.data?.data.permissions.manageMembers === true;
  // The latest agents read, so the invitation poll can tell whether a guest's agent has arrived.
  const agents = useRef<ReadonlyArray<M.Participant> | undefined>(undefined);
  const invitations = useQuery({
    queryKey: ["human", user.id, accountId, server.id, "invitations"],
    enabled: allowed,
    queryFn: ({ signal }) =>
      request(api.guests.listServerInvitations({ params: { serverId: server.id } }), signal),
    refetchInterval: (query) =>
      awaiting(query.state.data?.data.items ?? [], agents.current) ? pollMs : false,
  });
  const items = denied(invitations.error) ? [] : (invitations.data?.data.items ?? []);
  const guests = items.some((item) => item.state === "accepted" && item.guest !== null);
  const participants = useQuery({
    queryKey: ["human", user.id, accountId, server.id, "invite-arrivals"],
    enabled: allowed && guests && server.status === "ready" && server.permissions.readMessages,
    queryFn: ({ signal }) =>
      request(
        api.server.listParticipants({
          params: { serverId: server.id },
          query: input(I.ListParticipants, { limit: 100 }),
        }),
        signal,
      ),
    // Pending invitations are the invitation poll's; this one waits for a guest's first agent.
    refetchInterval: (query) =>
      awaiting(
        items.filter((item) => item.state === "accepted"),
        query.state.data?.data.items,
      )
        ? pollMs
        : false,
  });
  const listed = denied(participants.error) ? undefined : participants.data?.data.items;
  useEffect(() => {
    agents.current = listed;
  }, [listed]);
  if (!allowed) return null;
  const arrived = arrivals(items, listed ?? []);
  const latest = arrived[0];
  const fresh = latest !== undefined && Date.now() - Date.parse(latest.at) < freshMs;
  return (
    <>
      {fresh && <LatestArrival arrival={latest} open={() => setOpen(true)} />}
      <button className="ops-new" onClick={() => setOpen(true)}>
        Invite
      </button>
      {open && (
        <InviteDialog
          accountId={accountId}
          server={server}
          invitations={invitations}
          items={items}
          arrived={arrived}
          close={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** The latest arrival beside Invite, in the same words as the dialog's Joined list. */
export function LatestArrival({
  arrival,
  open,
}: {
  readonly arrival: Arrival;
  readonly open: () => void;
}) {
  return (
    <button
      className="text-button server-invites-news"
      onClick={open}
      title={formatActivityTime(arrival.at)}
    >
      {arrival.text}
    </button>
  );
}

/** The dialog's Joined list: each arrival, when, and the agent's own name. */
export function JoinedList({ arrived }: { readonly arrived: ReadonlyArray<Arrival> }) {
  if (arrived.length === 0) return null;
  return (
    <section aria-label="Joined">
      <h3>Joined</h3>
      {arrived.map((line) => (
        <div className="management-row" key={line.key}>
          <div>
            <strong>{line.text}</strong>
            <small>
              {formatActivityTime(line.at)}
              {line.detail !== null && ` · ${line.detail}`}
            </small>
          </div>
        </div>
      ))}
    </section>
  );
}

function InviteDialog({
  accountId,
  server,
  invitations,
  items,
  arrived,
  close,
}: {
  readonly accountId: P.AccountId;
  readonly server: P.ServerContext;
  readonly invitations: { readonly error: Error | null; readonly isPending: boolean };
  readonly items: ReadonlyArray<Guests.Invitation>;
  readonly arrived: ReadonlyArray<Arrival>;
  readonly close: () => void;
}) {
  const { api } = useServices();
  const user = useHuman();
  const field = useId();
  const [email, setEmail] = useState("");
  const [answer, setAnswer] = useState<Guests.Invited | null>(null);
  const params = { serverId: server.id };
  const invite = useAction(
    (value: string) => request(api.guests.inviteGuest({ params, payload: { email: value } })),
    (result) => {
      setAnswer(result.data);
      setEmail("");
    },
  );
  const resend = useAction(
    (invitationId: Guests.InvitationId) =>
      request(api.guests.resendServerInvitation({ params: { ...params, invitationId } })),
    (result) => setAnswer(result.data),
  );
  const cancel = useAction((invitationId: Guests.InvitationId) =>
    request(api.guests.cancelServerInvitation({ params: { ...params, invitationId } })),
  );
  const refused = invite.error ?? resend.error;
  const limited = peopleLimited(refused);
  // Which plan's limit applied is read only once the limit refuses someone.
  const billing = useQuery({
    queryKey: ["human", user.id, accountId, "billing"],
    enabled: limited,
    queryFn: ({ signal }) => request(api.billing.state({ params: { accountId } }), signal),
  });
  const starter = useQuery({ ...starterQuery(api, user.id, accountId), enabled: limited });
  const waiting = items.filter((item) => item.state === "pending" || item.state === "expired");
  const busy = invite.isPending || resend.isPending || cancel.isPending;
  const origin = typeof location === "undefined" ? "" : location.origin;
  return (
    <Dialog title={`Invite to ${server.name}`} close={close} className="server-invites">
      <p className="muted">{guestInviteScope}</p>
      <form
        className="server-invites-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!invite.isPending) invite.mutate(email.trim());
        }}
      >
        <label htmlFor={field}>Email</label>
        <div className="server-invites-row">
          <input
            id={field}
            type="email"
            name="email"
            autoComplete="off"
            required
            maxLength={254}
            value={email}
            data-autofocus
            onChange={(event) => setEmail(event.target.value)}
          />
          <button className="btn" disabled={invite.isPending}>
            {invite.isPending ? "Inviting…" : "Invite"}
          </button>
        </div>
      </form>
      {answer && !refused && (
        <div className="server-invites-answer" role="status">
          <p>{guestInvited(answer.invitation.email, answer.emailed)}</p>
          <div className="actions">
            <CopyLink link={answer.link} />
          </div>
          <small className="muted">{guestLinkRule(answer.invitation.email)}</small>
        </div>
      )}
      {limited ? (
        <PeopleLimit
          accountId={accountId}
          plan={limitPlan(billing.data?.data, starter.data?.data)}
          billing={billing.data?.data.permissions.manageBilling ?? true}
        />
      ) : (
        <Notice error={refused} />
      )}
      <Notice error={cancel.error ?? invitations.error} />
      {invitations.isPending && <p role="status">Loading invitations…</p>}
      {waiting.length > 0 && (
        <section aria-label="Invited">
          <h3>Invited</h3>
          <p className="muted server-invites-note">{guestLinksRule}</p>
          {waiting.map((invitation) => (
            <div className="management-row" key={invitation.id}>
              <div>
                <strong>{invitation.email}</strong>
                <small>{guestExpiry(invitation.expiresAt)}</small>
              </div>
              <div className="actions">
                {invitation.state === "pending" && (
                  <CopyLink link={joinLink(origin, invitation.id)} />
                )}
                <button disabled={busy} onClick={() => resend.mutate(invitation.id)}>
                  Resend
                </button>
                <button disabled={busy} onClick={() => cancel.mutate(invitation.id)}>
                  Cancel
                </button>
              </div>
            </div>
          ))}
        </section>
      )}
      <JoinedList arrived={arrived} />
      <p className="muted server-invites-rule">{allowanceRule}</p>
    </Dialog>
  );
}

/** The people limit refused an invitation: what the plan includes and the way to more. */
function PeopleLimit({
  accountId,
  plan,
  billing,
}: {
  readonly accountId: P.AccountId;
  readonly plan: "Free" | "Shop";
  readonly billing: boolean;
}) {
  const line = guestPeopleLimit(plan, plans.shop.peopleLimit ?? 4);
  return (
    <div className="notice" role="alert">
      <p>
        {line.text}{" "}
        {billing ? (
          <AppLink path={`accounts/${accountId}/billing`}>{line.action}</AppLink>
        ) : (
          "Only the organization owner can change the plan."
        )}
      </p>
    </div>
  );
}
