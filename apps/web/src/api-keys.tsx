import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as K from "@talkto/api/api-keys";
import type * as P from "@talkto/api/platform";
import { input, request, type Client } from "./api.js";
import { Dialog, Notice } from "./components.js";
import { useAccounts } from "./management.js";
import { formatDay } from "./sign-ins.js";
import { useHuman, useServices } from "./session.js";
import "./server-settings.css";
import "./account.css";

/** Make a key; only the website may. */
export const createKey = (api: Client, payload: K.CreateApiKey) =>
  request(api.apiKeys.create({ payload: input(K.CreateApiKey, payload) }));
/** Revoke one of the person's keys. */
export const revokeKey = (api: Client, id: K.ApiKeyId) =>
  request(api.apiKeys.revoke({ params: { id } }));

/** The lifetimes offered when making a key, in days; null never expires. */
export const lifetimes: ReadonlyArray<{ readonly days: number | null; readonly label: string }> = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
  { days: null, label: "Never" },
];

/** One line about a key: what it may do, where, and when it was last used and expires. */
export const describeKey = (
  key: K.ApiKey,
  organizations: ReadonlyMap<string, string>,
  now = new Date(),
) => {
  const scope =
    key.accountId === null
      ? "All your organizations"
      : (organizations.get(key.accountId) ?? "One organization");
  const used =
    key.lastUsedAt === null ? "Never used" : `Last used ${formatDay(key.lastUsedAt, now)}`;
  const expiry =
    key.expiresAt === null
      ? "Never expires"
      : new Date(key.expiresAt) <= now
        ? `Expired ${formatDay(key.expiresAt, now)}`
        : `Expires ${formatDay(key.expiresAt, now)}`;
  return {
    access: key.access === "full" ? "Full access" : "Read only",
    scope,
    details: `${used} · ${expiry}`,
  };
};

/** The person's API keys: make one, see each, revoke any. */
export function ApiKeys() {
  const { api } = useServices();
  const user = useHuman();
  const list = useQuery({
    queryKey: ["human", user.id, "api-keys"],
    queryFn: ({ signal }) => request(api.apiKeys.list(), signal),
  });
  const accounts = useAccounts();
  const organizations = new Map<string, string>(
    (accounts.data?.data.items ?? []).map((account) => [account.id, account.name]),
  );
  const [making, setMaking] = useState(false);
  const [revoking, setRevoking] = useState<K.ApiKey | null>(null);
  const full = (list.data?.data.items.length ?? 0) >= K.maxKeys;
  return (
    <section className="ops-account" aria-labelledby="api-keys-title">
      <div className="ops-page-bar">
        <h1 className="ops-page-title" id="api-keys-title">
          API keys
        </h1>
        <button className="ops-new" disabled={!list.data || full} onClick={() => setMaking(true)}>
          Make a key
        </button>
      </div>
      <p className="ops-account-identity">
        Scripts and services use a key to call the TalkTo API as <strong>{user.email}</strong>. A
        key can do what you can, except billing, removing organization members, making keys and
        deleting your account or an organization. Keys don't work for agents' MCP sign-in.
      </p>
      <Notice error={list.error} retry={() => void list.refetch()} />
      {list.isPending && <p role="status">Loading API keys…</p>}
      {full && (
        <p className="ops-account-blocked" role="note">
          You have {K.maxKeys} keys, the most you can have. Revoke one to make another.
        </p>
      )}
      {list.data && (
        <ApiKeyList
          keys={list.data.data.items}
          organizations={organizations}
          now={new Date()}
          revoke={setRevoking}
        />
      )}
      {making && (
        <MakeKeyDialog accounts={accounts.data?.data.items ?? []} close={() => setMaking(false)} />
      )}
      {revoking && <RevokeDialog apiKey={revoking} close={() => setRevoking(null)} />}
    </section>
  );
}

/** The list and its empty state; exported for rendering tests. */
export function ApiKeyList({
  keys,
  organizations,
  now,
  revoke,
}: {
  readonly keys: ReadonlyArray<K.ApiKey>;
  readonly organizations: ReadonlyMap<string, string>;
  readonly now: Date;
  readonly revoke: (key: K.ApiKey) => void;
}) {
  return (
    <section className="ops-sign-ins" aria-label="API keys">
      {keys.length === 0 ? (
        <div className="ops-sign-ins-empty">
          <p>
            <strong>You have no API keys.</strong>
          </p>
          <p>Make one for a script or service that calls the TalkTo API.</p>
        </div>
      ) : (
        <ul>
          {keys.map((key) => {
            const line = describeKey(key, organizations, now);
            return (
              <li key={key.id}>
                <div className="ops-sign-in">
                  <strong>{key.name}</strong>
                  <small>
                    <code>{key.prefix}…</code> · {line.access} · {line.scope}
                  </small>
                  <small>
                    Made {formatDay(key.createdAt, now)} · {line.details}
                  </small>
                </div>
                <div className="ops-sign-in-actions">
                  <button type="button" className="ops-new" onClick={() => revoke(key)}>
                    Revoke
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function MakeKeyDialog({
  accounts,
  close,
}: {
  readonly accounts: ReadonlyArray<P.Account>;
  readonly close: () => void;
}) {
  const { api } = useServices();
  const user = useHuman();
  const cache = useQueryClient();
  const mutation = useMutation({
    mutationFn: (payload: K.CreateApiKey) => createKey(api, payload),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["human", user.id, "api-keys"] }),
  });
  return (
    <Dialog title={mutation.data ? "Copy your new key" : "Make an API key"} close={close}>
      {mutation.data ? (
        <NewKey secret={mutation.data.data.secret} close={close} />
      ) : (
        <MakeKeyForm
          accounts={accounts}
          submit={(payload) => mutation.mutate(payload)}
          pending={mutation.isPending}
          error={mutation.error}
          close={close}
        />
      )}
    </Dialog>
  );
}

/** A key request as the form builds it, field by field. */
interface Draft {
  name: string;
  access: K.Access;
  accountId?: P.AccountId;
  expiresInDays?: number;
}

/** The form; stateless apart from its fields, exported for rendering tests. */
export function MakeKeyForm({
  accounts,
  submit,
  pending,
  error,
  close,
}: {
  readonly accounts: ReadonlyArray<P.Account>;
  readonly submit: (payload: K.CreateApiKey) => void;
  readonly pending: boolean;
  readonly error: Error | null;
  readonly close: () => void;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const [access, setAccess] = useState<K.Access>("full");
  const [accountId, setAccountId] = useState("");
  const [days, setDays] = useState("90");
  const named = name.trim().length > 0 && name.trim().length <= 80;
  return (
    <form
      className="ops-delete-confirmation ops-api-key-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!named || pending) return;
        const payload: Draft = {
          name: name.trim(),
          access,
        };
        const account = accounts.find((item) => item.id === accountId);
        if (account !== undefined) payload.accountId = account.id;
        if (days !== "never") payload.expiresInDays = Number(days);
        submit(payload);
      }}
    >
      <label htmlFor={`${id}-name`}>Name</label>
      <input
        id={`${id}-name`}
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={80}
        autoComplete="off"
        placeholder="For example: Deploy script"
        disabled={pending}
        data-autofocus
      />
      <fieldset disabled={pending}>
        <legend>What it can do</legend>
        <label>
          <input
            type="radio"
            name={`${id}-access`}
            checked={access === "full"}
            onChange={() => setAccess("full")}
          />{" "}
          Full access: read and make changes
        </label>
        <label>
          <input
            type="radio"
            name={`${id}-access`}
            checked={access === "read"}
            onChange={() => setAccess("read")}
          />{" "}
          Read only
        </label>
      </fieldset>
      <label htmlFor={`${id}-organization`}>Organizations</label>
      <select
        id={`${id}-organization`}
        value={accountId}
        onChange={(event) => setAccountId(event.target.value)}
        disabled={pending}
      >
        <option value="">All your organizations</option>
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            Only {account.name}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-expiry`}>Expires after</label>
      <select
        id={`${id}-expiry`}
        value={days}
        onChange={(event) => setDays(event.target.value)}
        disabled={pending}
      >
        {lifetimes.map((lifetime) => (
          <option key={lifetime.label} value={lifetime.days ?? "never"}>
            {lifetime.label}
          </option>
        ))}
      </select>
      <Notice error={error} />
      {pending && <p role="status">Making key…</p>}
      <div className="ops-delete-actions">
        <button type="button" className="ops-new" onClick={close}>
          Cancel
        </button>
        <button type="submit" className="ops-new primary" disabled={!named || pending}>
          {error ? "Try again" : "Make key"}
        </button>
      </div>
    </form>
  );
}

/** The new key, shown once. Exported for rendering tests. */
export function NewKey({ secret, close }: { readonly secret: string; readonly close: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ops-delete-confirmation ops-api-key-new">
      <p>
        <strong>Copy this key now. TalkTo shows it only once</strong> and keeps no copy it could
        show you later. If you lose it, revoke it and make a new one.
      </p>
      <code className="ops-api-key-secret">{secret}</code>
      <p>
        Send it as <code>Authorization: Bearer</code> followed by the key. Keep it out of messages,
        code you commit and anything you share.
      </p>
      <div className="ops-delete-actions">
        <button
          type="button"
          className="ops-new"
          onClick={() =>
            void navigator.clipboard.writeText(secret).then(
              () => setCopied(true),
              () => {},
            )
          }
        >
          {copied ? "Copied" : "Copy key"}
        </button>
        <button type="button" className="ops-new primary" onClick={close} data-autofocus>
          Done
        </button>
      </div>
    </div>
  );
}

/** Confirm revoking a key. Exported for rendering tests. */
export function RevokeDialog({
  apiKey,
  close,
}: {
  readonly apiKey: K.ApiKey;
  readonly close: () => void;
}) {
  const { api } = useServices();
  const user = useHuman();
  const cache = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => revokeKey(api, apiKey.id),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["human", user.id, "api-keys"] });
      close();
    },
  });
  return (
    <Dialog title={`Revoke ${apiKey.name}?`} close={close}>
      <form
        className="ops-delete-confirmation"
        onSubmit={(event) => {
          event.preventDefault();
          if (!mutation.isPending) mutation.mutate();
        }}
      >
        <p>
          Anything using this key stops working within 30 seconds. This can't be undone; make a new
          key if you need one again.
        </p>
        <Notice error={mutation.error} />
        {mutation.isPending && <p role="status">Revoking…</p>}
        <div className="ops-delete-actions">
          <button type="button" className="ops-new" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="ops-danger" disabled={mutation.isPending} data-autofocus>
            {mutation.error ? "Try again" : "Revoke key"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
