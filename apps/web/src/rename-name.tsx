import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import { ApiError, denied, request } from "./api.js";
import { Dialog, Notice } from "./components.js";
import { formatActivityTime } from "./activity-time.js";
import { useAction } from "./management.js";
import { useHuman, useServices } from "./session.js";
import "./agent-renames.css";

/** How long a server rename stays in the server's Activity notice, like agent renames. */
const noticeDays = 7;
const newKey = () => M.RequestKey.make(crypto.randomUUID());
const serverRenamesKey = (userId: string, accountId: P.AccountId, serverId: M.ServerId) =>
  ["human", userId, accountId, serverId, "server-renames"] as const;

/** What the person is renaming, and what everyone else sees change. */
type Subject =
  | { readonly kind: "organization"; readonly account: P.AccountContext }
  | { readonly kind: "server"; readonly server: P.ServerContext };

const noun = (subject: Subject) => (subject.kind === "organization" ? "organization" : "server");
const currentName = (subject: Subject) =>
  subject.kind === "organization" ? subject.account.name : subject.server.name;

/** What renaming changes, shown in Settings and the dialog. */
export const renameEffect = (subject: Subject) =>
  subject.kind === "organization"
    ? "Members see the new name right away, here and on the sign-in page. IDs, servers, members and billing stay the same."
    : "People and agents see the new name right away. The server’s ID, messages, agents and access stay the same.";

/** A Settings section with the current name and a Rename control for the people who may. */
export function RenameSection({ subject }: { readonly subject: Subject }) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const label = noun(subject);
  return (
    <section className="ops-server-settings ops-rename-settings" aria-labelledby={titleId}>
      <h2 id={titleId}>{label === "organization" ? "Organization name" : "Server name"}</h2>
      <p>
        <strong className="ops-current-name">{currentName(subject)}</strong>
        <br />
        {renameEffect(subject)}
      </p>
      <button className="ops-new" onClick={() => setOpen(true)}>
        Rename {label}…
      </button>
      {open && <RenameNameDialog subject={subject} close={() => setOpen(false)} />}
    </section>
  );
}

/**
 * Rename an organization or server. One request key per attempted name, so trying again after an
 * uncertain result is a retry; the server checks the owner and the website session itself.
 */
export function RenameNameDialog({
  subject,
  close,
}: {
  readonly subject: Subject;
  readonly close: () => void;
}) {
  const { api, queries } = useServices();
  const user = useHuman();
  const noteId = useId();
  // The name when the dialog opened; the subject updates as soon as a rename lands.
  const [original] = useState(() => currentName(subject));
  const [name, setName] = useState<string>(original);
  const [requestKey, setRequestKey] = useState(newKey);
  const [validation, setValidation] = useState<Error | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const save = useAction(
    async (payload: P.Rename): Promise<string> => {
      if (subject.kind === "organization") {
        const result = await request(
          api.platform.renameAccount({ params: { accountId: subject.account.id }, payload }),
        );
        // Every header and picker reads this entry; the refetch that follows confirms it.
        queries.setQueryData(["human", user.id, subject.account.id, "account"], {
          data: result.data.account,
          meta: result.meta,
        });
        return result.data.account.name;
      }
      const { accountId, id: serverId } = subject.server;
      const result = await request(
        api.platform.renameServer({ params: { accountId, serverId }, payload }),
      );
      queries.setQueryData<{ readonly data: P.ServerDetail }>(
        ["human", user.id, accountId, serverId, "management"],
        (previous) =>
          previous && { ...previous, data: { ...previous.data, name: result.data.server.name } },
      );
      return result.data.server.name;
    },
    (renamed) => {
      setSaved(renamed);
      setName(renamed);
      setRequestKey(newKey());
    },
  );
  const label = noun(subject);
  return (
    <Dialog title={`Rename ${label}`} className="rename-dialog" close={close}>
      <p className="rename-intro">{renameEffect(subject)}</p>
      <form
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          if (save.isPending) return;
          setSaved(null);
          const parsed = Schema.decodeUnknownResult(P.Rename)({ name, requestKey });
          if (parsed._tag === "Failure") {
            setValidation(
              new ApiError("invalid_input", "Enter a name between 1 and 100 characters."),
            );
            return;
          }
          setValidation(null);
          save.mutate(parsed.success);
        }}
      >
        <label>
          {label === "organization" ? "Organization name" : "Server name"}
          <input
            name="name"
            required
            maxLength={100}
            data-autofocus
            aria-describedby={noteId}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setSaved(null);
              setRequestKey(newKey());
            }}
          />
        </label>
        <small id={noteId} className="rename-note">
          Up to 100 characters.
          {label === "server" ? " Other servers in the organization may share it." : ""}
        </small>
        <Notice error={validation ?? save.error} />
        <div className="form-actions">
          <button className="btn" disabled={save.isPending}>
            {save.isPending ? "Renaming…" : save.error ? "Retry rename" : "Rename"}
          </button>
          <button type="button" className="text-button" onClick={close}>
            {saved === null ? "Cancel" : "Done"}
          </button>
          {saved !== null && (
            <small role="status">
              {saved === original ? "That is already its name." : `Renamed to ${saved}.`}
            </small>
          )}
        </div>
      </form>
    </Dialog>
  );
}

/** The server's recent renames, newest first; only organization members can read them. */
export function useServerRenames(accountId: P.AccountId, serverId: M.ServerId, enabled = true) {
  const { api } = useServices();
  const user = useHuman();
  return useQuery({
    queryKey: serverRenamesKey(user.id, accountId, serverId),
    enabled,
    queryFn: ({ signal }) =>
      request(api.platform.serverRenames({ params: { accountId, serverId } }), signal),
  });
}

/** A quiet line in the server's Activity view for the last week's server renames. */
export function ServerRenameNotices({
  accountId,
  serverId,
  enabled = true,
}: {
  readonly accountId: P.AccountId;
  readonly serverId: M.ServerId;
  readonly enabled?: boolean;
}) {
  const renames = useServerRenames(accountId, serverId, enabled);
  const [now] = useState(Date.now);
  if (denied(renames.error)) return null;
  const recent = (renames.data?.data.items ?? [])
    .filter((item) => now - Date.parse(item.renamedAt) < noticeDays * 86_400_000)
    .slice(0, 3);
  if (recent.length === 0) return null;
  return (
    <section className="rename-notices" aria-label="Server renames">
      <ul>
        {recent.map((rename) => (
          <li key={rename.id}>
            <span className="rename-names">
              <span>{rename.previousName}</span>
              <span aria-label="renamed to"> → </span>
              <strong>{rename.name}</strong>
            </span>
            <span className="rename-meta">
              server renamed{rename.renamedBy === null ? "" : ` by ${rename.renamedBy}`} ·{" "}
              <time dateTime={rename.renamedAt}>{formatActivityTime(rename.renamedAt)}</time>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
