import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as A from "@talkto/api/account";
import type * as P from "@talkto/api/platform";
import { plans } from "@talkto/api/pricing";
import { input, request } from "./api.js";
import { Dialog, Notice } from "./components.js";
import { formatCount } from "./format.js";
import { RenameSection } from "./rename-name.js";
import { useHuman, useServices } from "./session.js";
import "./server-settings.css";
import "./account.css";

/** The owner's organization settings; the API checks the owner and the website session itself. */
export function OrganizationSettings({ account }: { readonly account: P.AccountContext }) {
  const { api } = useServices();
  const user = useHuman();
  const plan = useQuery({
    queryKey: ["human", user.id, account.id, "organization-deletion"],
    queryFn: ({ signal }) =>
      request(api.account.organizationDeletionPlan({ params: { accountId: account.id } }), signal),
  });
  return (
    <section className="ops-settings-stack" aria-labelledby="organization-settings-title">
      <div className="ops-page-bar">
        <h1 className="ops-page-title" id="organization-settings-title">
          Settings
        </h1>
      </div>
      <RenameSection subject={{ kind: "organization", account }} />
      <Notice error={plan.error} retry={() => void plan.refetch()} />
      {plan.isPending && <p role="status">Loading what deletion would remove…</p>}
      {plan.data && <DeleteOrganizationSection plan={plan.data.data} />}
    </section>
  );
}

const paidThrough = (value: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));

/** The danger zone: what deleting removes, what stays, and the one action. Exported for tests. */
export function DeleteOrganizationSection({ plan }: { readonly plan: A.OrganizationDeletionPlan }) {
  const [confirming, setConfirming] = useState(false);
  const people = plan.otherMembers + plan.guests;
  return (
    <section
      className="ops-server-settings ops-account-deletion"
      aria-labelledby="delete-organization-title"
    >
      <h2 id="delete-organization-title">Delete organization</h2>
      <p>
        Permanently delete <strong>{plan.name}</strong> and everything in it. TalkTo cannot restore
        it.
      </p>
      {plan.status === "in_progress" ? (
        <p role="status">This organization’s deletion has started and finishes automatically.</p>
      ) : (
        <div className="ops-account-columns">
          <div>
            <h3>What is deleted</h3>
            <ul>
              <li>
                {plan.servers.length === 0
                  ? "Its servers: it has none."
                  : `${plan.servers.length === 1 ? "Its server" : `All ${plan.servers.length} servers`}, with their messages, channels, direct chats, files and agents.`}
                {plan.servers.length > 0 && (
                  <ul className="ops-account-organizations">
                    {plan.servers.map((server) => (
                      <li key={server.id}>
                        <strong>{server.name}</strong>
                        <small>
                          {server.agents === null
                            ? "agents unknown"
                            : formatCount(server.agents, "agent")}
                        </small>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
              {people > 0 && (
                <li>
                  Access for {formatCount(plan.otherMembers, "other member")}
                  {plan.guests > 0 && ` and ${formatCount(plan.guests, "guest")}`}. They keep their
                  TalkTo accounts
                  {plan.otherMembers > 0 && ", and each member gets an email that you deleted it"}.
                </li>
              )}
              {plan.pendingInvitations > 0 && (
                <li>{formatCount(plan.pendingInvitations, "pending invitation")}, canceled.</li>
              )}
              {plan.plan !== null && (
                <li>
                  The {plans[plan.plan].name} plan ends now, with no refund
                  {plan.paidThrough !== null &&
                    ` for the time paid through ${paidThrough(plan.paidThrough)}`}
                  .
                </li>
              )}
            </ul>
          </div>
          <div>
            <h3>What stays</h3>
            <ul>
              <li>
                Your TalkTo account
                {plan.lastOrganization ? "" : " and your other organizations"}.
              </li>
              <li>
                Messages already counted stay counted
                {plan.freeStart
                  ? ", and the free start this organization used does not return"
                  : ""}
                .
              </li>
              <li>Billing records, and backups that keep deleted data for up to 30 days.</li>
            </ul>
          </div>
        </div>
      )}
      {plan.status === "ready" && plan.lastOrganization && (
        <p className="ops-account-blocked" role="note">
          This is your last organization. You can create a new one afterwards
          {plan.freeStart ? ", but it won’t start free again" : ""}.
        </p>
      )}
      {!plan.website && (
        <p className="ops-account-blocked" role="note">
          You can delete an organization only while signed in on the TalkTo website.
        </p>
      )}
      <button className="ops-danger" disabled={!plan.website} onClick={() => setConfirming(true)}>
        Delete organization…
      </button>
      {confirming && <DeleteOrganizationDialog plan={plan} close={() => setConfirming(false)} />}
    </section>
  );
}

/** Type the current name, then delete. The server compares the same trimmed, exact name. */
export function DeleteOrganizationDialog({
  plan,
  close,
}: {
  readonly plan: A.OrganizationDeletionPlan;
  readonly close: () => void;
}) {
  const { api } = useServices();
  const user = useHuman();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const field = useId();
  const description = useId();
  const [confirmation, setConfirmation] = useState("");
  const matches = confirmation.trim() === plan.name || plan.status === "in_progress";
  const deletion = useMutation({
    mutationFn: () =>
      request(
        api.account.deleteOrganization({
          params: { accountId: plan.accountId },
          payload: input(A.DeleteOrganization, { confirmation }),
        }),
      ),
    onSuccess: async () => {
      // The organization is gone from every view: drop its cache, then show the organization list.
      await cache.cancelQueries({ queryKey: ["human", user.id, plan.accountId] });
      cache.removeQueries({ queryKey: ["human", user.id, plan.accountId] });
      await navigate({ to: "/app/$", params: { _splat: "accounts" }, search: {}, replace: true });
      await cache.invalidateQueries({ queryKey: ["human", user.id] });
    },
  });
  return (
    <Dialog title="Delete this organization?" close={close}>
      <form
        className="ops-delete-confirmation"
        onSubmit={(event) => {
          event.preventDefault();
          if (matches && !deletion.isPending) deletion.mutate();
        }}
      >
        <p id={description}>
          This permanently deletes <strong>{plan.name}</strong>
          {plan.servers.length > 0 && ` and ${formatCount(plan.servers.length, "server")}`}
          {plan.otherMembers > 0 &&
            `, and removes ${formatCount(plan.otherMembers, "other member")}`}
          {plan.plan !== null && `. The ${plans[plan.plan].name} plan ends now, with no refund`}.{" "}
          <strong>There is no undo.</strong>
        </p>
        <label htmlFor={field}>
          Type <strong>{plan.name}</strong> to confirm
        </label>
        <input
          id={field}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={description}
          disabled={deletion.isPending}
          data-autofocus
        />
        <Notice error={deletion.error} />
        {deletion.isPending && <p role="status">Deleting organization…</p>}
        <div className="ops-delete-actions">
          <button type="button" className="ops-new" onClick={close}>
            {deletion.isPending || deletion.error ? "Close" : "Cancel"}
          </button>
          <button type="submit" className="ops-danger" disabled={!matches || deletion.isPending}>
            {deletion.error ? "Retry deletion" : "Delete organization permanently"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
