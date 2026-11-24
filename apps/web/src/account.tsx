import { createContext, useContext, useId, useState } from "react";
import { flushSync } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as A from "@talkto/api/account";
import type * as E from "@talkto/api/email";
import { plans } from "@talkto/api/pricing";
import { request, type Client } from "./api.js";
import { AppLink, Dialog, Notice } from "./components.js";
import { useHuman, useServices } from "./session.js";
import { formatCount } from "./format.js";
import "./server-settings.css";
import "./account.css";

/** The email typed to confirm deletion; the server compares the same way. */
export const confirms = (email: string, typed: string) =>
  typed.trim().length > 0 && typed.trim().toLowerCase() === email.trim().toLowerCase();

/** The single irreversible request; the server also requires the website session. */
export const deleteAccount = (api: Client, confirmation: string) =>
  request(api.account.deleteAccount({ payload: { confirmation } }));

/** Turn product update emails on or off for the signed-in person. */
export const updateEmailPreferences = (api: Client, productUpdates: boolean) =>
  request(api.email.updatePreferences({ payload: { productUpdates } }));

/**
 * Set once the server confirms deletion. The dashboard then stops rendering every authenticated
 * view, so nothing asks for the session the response has just cleared.
 */
export const AccountDeleted = createContext<(status: A.DeletedAccount["status"]) => void>(() => {});

/** Signed-out result, shown in place of the dashboard after deletion. */
export function AccountDeletedPanel({ status }: { readonly status: A.DeletedAccount["status"] }) {
  return (
    <section className="session-panel" aria-live="polite">
      <h1>Your account is deleted</h1>
      <p>
        {status === "finishing"
          ? "You’re signed out. The remaining cleanup finishes automatically within a few minutes."
          : "Your sign-in, your profile and the organizations listed are gone. You’re signed out."}
      </p>
      <a className="btn secondary" href="/">
        Go to the TalkTo home page
      </a>
    </section>
  );
}

/** The person's own account: who is signed in, and permanent deletion. */
export function AccountSettings() {
  const { api } = useServices();
  const user = useHuman();
  const plan = useQuery({
    queryKey: ["human", user.id, "account-deletion"],
    queryFn: ({ signal }) => request(api.account.deletionPlan(), signal),
  });
  return (
    <section className="ops-account" aria-labelledby="account-title">
      <div className="ops-page-bar">
        <h1 className="ops-page-title" id="account-title">
          Account
        </h1>
      </div>
      <p className="ops-account-identity">
        Signed in as <strong>{user.email}</strong>
      </p>
      <EmailSection />
      <section className="ops-account-email" aria-labelledby="sign-ins-link-title">
        <h2 id="sign-ins-link-title">Signed-in computers</h2>
        <p>See where your agent apps are signed in to TalkTo, and sign any of them out.</p>
        <AppLink path="account/sign-ins">Signed-in computers</AppLink>
      </section>
      <Notice error={plan.error} retry={() => void plan.refetch()} />
      {plan.isPending && <p role="status">Loading account…</p>}
      {plan.data && <DeleteAccountSection plan={plan.data.data} />}
    </section>
  );
}

/** Product update emails on or off. Account emails have no switch: they always go. */
function EmailSection() {
  const { api } = useServices();
  const user = useHuman();
  const client = useQueryClient();
  const queryKey = ["human", user.id, "email"];
  const preferences = useQuery({
    queryKey,
    queryFn: ({ signal }) => request(api.email.preferences(), signal),
  });
  const update = useMutation({
    mutationFn: (productUpdates: boolean) => updateEmailPreferences(api, productUpdates),
    onSuccess: (result) => client.setQueryData(queryKey, result),
  });
  return (
    <section className="ops-account-email" aria-labelledby="email-title">
      <h2 id="email-title">Email</h2>
      <Notice error={preferences.error ?? update.error} retry={() => void preferences.refetch()} />
      {preferences.isPending && <p role="status">Loading email settings…</p>}
      {preferences.data && (
        <EmailChoices
          preferences={preferences.data.data}
          saving={update.isPending}
          change={(productUpdates) => update.mutate(productUpdates)}
        />
      )}
    </section>
  );
}

/** The switch and what each kind of email is; exported for rendering tests. */
export function EmailChoices({
  preferences,
  saving,
  change,
}: {
  readonly preferences: E.EmailPreferences;
  readonly saving: boolean;
  readonly change: (productUpdates: boolean) => void;
}) {
  const hint = useId();
  return (
    <>
      <label className="ops-account-email-choice">
        <input
          type="checkbox"
          role="switch"
          checked={preferences.productUpdates}
          disabled={saving}
          aria-describedby={hint}
          onChange={(event) => change(event.target.checked)}
        />
        <span>
          <strong>Product updates</strong>
          <small id={hint}>
            New features and releases. Every update email has an unsubscribe link too.
          </small>
        </span>
      </label>
      <p>
        Account emails always arrive: owners hear when an organization is running out of messages,
        when a payment fails, and when a TalkTo plugin needs updating.
      </p>
    </>
  );
}

/** What goes, what stays, and the one action; exported for rendering tests. */
export function DeleteAccountSection({ plan }: { readonly plan: A.DeletionPlan }) {
  const [confirming, setConfirming] = useState(false);
  const available = plan.website && plan.status !== "blocked";
  const servers = plan.deleted.reduce((sum, organization) => sum + organization.servers, 0);
  const paid = plan.deleted.filter((organization) => organization.plan !== null);
  return (
    <section className="ops-account-deletion" aria-labelledby="delete-account-title">
      <h2 id="delete-account-title">Delete account</h2>
      <p>Deleting your account is permanent. TalkTo cannot restore it.</p>
      {plan.status === "in_progress" && (
        <p role="status">
          Your account deletion has started and finishes automatically. You can retry it here.
        </p>
      )}
      <div className="ops-account-columns">
        <div>
          <h3>What is deleted</h3>
          <ul>
            <li>Your sign-in and profile.</li>
            {plan.deleted.length > 0 && (
              <li>
                {plan.deleted.length === 1
                  ? "The organization you own with no other members"
                  : "The organizations you own with no other members"}
                , with every server in {plan.deleted.length === 1 ? "it" : "them"}: messages,
                channels, direct chats, files, agents, invitations and access.
                <ul className="ops-account-organizations">
                  {plan.deleted.map((organization) => (
                    <li key={organization.accountId}>
                      <strong>{organization.name}</strong>
                      <small>
                        {formatCount(organization.servers, "server")}
                        {organization.plan !== null && ` · ${plans[organization.plan].name} plan`}
                      </small>
                    </li>
                  ))}
                </ul>
              </li>
            )}
            {paid.length > 0 && (
              <li>
                {paid.length === 1 ? "The paid plan on " : "The paid plans on "}
                {new Intl.ListFormat("en", { type: "conjunction" }).format(
                  paid.map((organization) => organization.name),
                )}
                {paid.length === 1 ? " ends at once and is" : " end at once and are"} not renewed.
              </li>
            )}
            {plan.memberships > 0 && (
              <li>
                Your membership of {formatCount(plan.memberships, "organization")} other people own.
              </li>
            )}
          </ul>
        </div>
        <div>
          <h3>What stays</h3>
          <ul>
            <li>
              Messages you and your agents sent in organizations other people own. They stay in that
              organization’s history: your agents’ under their names, and yours under a neutral name
              such as “former-person”.
            </li>
            <li>
              Billing records, and the records that stop a one-time message allowance being claimed
              twice. They hold IDs and keyed fingerprints, not your email address.
            </li>
            <li>Backups, which keep deleted data for up to 30 days before it is gone.</li>
          </ul>
          {plan.servers.length > 0 && (
            <div className="ops-account-created">
              <p>
                Servers you created in other people’s organizations stay with those organizations.
                To remove one, delete it first.
              </p>
              <ul className="ops-account-organizations">
                {plan.servers.map((server) => (
                  <li key={server.serverId}>
                    <span>
                      <strong>{server.name}</strong>
                      <small>{server.organization}</small>
                    </span>
                    <AppLink
                      path={`accounts/${server.accountId}/servers/${server.serverId}`}
                      search={{ tab: "settings" }}
                    >
                      Delete server
                    </AppLink>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
      {plan.blocked.length > 0 && (
        <div className="ops-account-blocked" role="note">
          {plan.blocked.map((organization) => (
            <p key={organization.accountId}>
              You own <strong>{organization.name}</strong>, which has{" "}
              {formatCount(organization.otherMembers, "other member")}. Ownership can’t be
              transferred yet: remove the other members on its{" "}
              <AppLink path={`accounts/${organization.accountId}/members`}>Members page</AppLink>,
              or delete it from its{" "}
              <AppLink path={`accounts/${organization.accountId}/settings`}>Settings</AppLink>, then
              come back.
            </p>
          ))}
        </div>
      )}
      {!plan.website && (
        <p className="ops-account-blocked" role="note">
          You can delete your account only while signed in on the TalkTo website.
        </p>
      )}
      <button className="ops-danger" disabled={!available} onClick={() => setConfirming(true)}>
        Delete account…
      </button>
      {confirming && (
        <DeleteAccountDialog plan={plan} servers={servers} close={() => setConfirming(false)} />
      )}
    </section>
  );
}

function DeleteAccountDialog({
  plan,
  servers,
  close,
}: {
  readonly plan: A.DeletionPlan;
  readonly servers: number;
  readonly close: () => void;
}) {
  const { api, queries } = useServices();
  const user = useHuman();
  const deleted = useContext(AccountDeleted);
  const [confirmation, setConfirmation] = useState("");
  const deletion = useMutation({
    mutationFn: () => deleteAccount(api, confirmation),
    onSuccess: (result) => {
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const key = sessionStorage.key(i);
        if (key?.includes(`:${user.id}:`)) sessionStorage.removeItem(key);
      }
      // Unmount every authenticated view first, so no query refetches with the cleared session.
      flushSync(() => deleted(result.data.status));
      void queries.cancelQueries();
      queries.clear();
    },
  });
  return (
    <Dialog title="Delete your account?" close={close}>
      <DeleteAccountForm
        plan={plan}
        servers={servers}
        confirmation={confirmation}
        change={setConfirmation}
        submit={() => deletion.mutate()}
        pending={deletion.isPending}
        error={deletion.error}
        close={close}
      />
    </Dialog>
  );
}

/** Stateless confirmation form; exported so the match rule can be rendered in tests. */
export function DeleteAccountForm({
  plan,
  servers,
  confirmation,
  change,
  submit,
  pending,
  error,
  close,
}: {
  readonly plan: A.DeletionPlan;
  readonly servers: number;
  readonly confirmation: string;
  readonly change: (value: string) => void;
  readonly submit: () => void;
  readonly pending: boolean;
  readonly error: Error | null;
  readonly close: () => void;
}) {
  const field = useId();
  const description = useId();
  const matches = confirms(plan.email, confirmation);
  return (
    <form
      className="ops-delete-confirmation"
      onSubmit={(event) => {
        event.preventDefault();
        if (matches && !pending) submit();
      }}
    >
      <p id={description}>
        This permanently deletes your sign-in
        {plan.deleted.length > 0 &&
          `, ${formatCount(plan.deleted.length, "organization")} and ${formatCount(servers, "server")}`}{" "}
        as listed on this page. <strong>There is no undo.</strong>
      </p>
      <label htmlFor={field}>
        Type <strong>{plan.email}</strong> to confirm
      </label>
      <input
        id={field}
        type="email"
        value={confirmation}
        onChange={(event) => change(event.target.value)}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={description}
        disabled={pending}
        data-autofocus
      />
      <Notice error={error} />
      {pending && <p role="status">Deleting your account…</p>}
      <div className="ops-delete-actions">
        <button type="button" className="ops-new" onClick={close}>
          {pending || error ? "Close" : "Cancel"}
        </button>
        <button type="submit" className="ops-danger" disabled={!matches || pending}>
          {error ? "Retry deletion" : "Delete account permanently"}
        </button>
      </div>
    </form>
  );
}
