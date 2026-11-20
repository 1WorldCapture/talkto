import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import type * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import * as R from "@talkto/api/renames";
import { ApiError, denied, input, request } from "./api.js";
import { Dialog, Notice } from "./components.js";
import { formatActivityTime } from "./activity-time.js";
import { useHuman, useServices } from "./session.js";
import "./agent-renames.css";

/** How long a rename stays in the server's Activity notice. */
const noticeDays = 7;
const newKey = () => M.RequestKey.make(crypto.randomUUID());
const renamesKey = (userId: string, accountId: P.AccountId, serverId: M.ServerId) =>
  ["human", userId, accountId, serverId, "renames"] as const;

/** Who made the change, as the notice says it. */
export const renamedBy = (rename: R.Rename) =>
  rename.renamedBy.kind === "self" ? "renamed itself" : `renamed by ${rename.renamedBy.name}`;

/** The server's newest renames (at most 100), shared by the Activity notice and the Agents list. */
export function useRenames(accountId: P.AccountId, serverId: M.ServerId, enabled = true) {
  const { api } = useServices();
  const user = useHuman();
  return useQuery({
    queryKey: renamesKey(user.id, accountId, serverId),
    enabled,
    queryFn: ({ signal }) =>
      request(
        api.server.listRenames({
          params: { serverId },
          query: input(R.ListInput, { limit: R.maxNotices }),
        }),
        signal,
      ),
  });
}

/** The names an agent had before its current one, newest first, each once. */
export const earlierNames = (
  renames: ReadonlyArray<R.Rename>,
  participantId: M.ParticipantId,
  current: M.Name,
): ReadonlyArray<M.Name> => [
  ...new Set(
    renames
      .filter((item) => item.participantId === participantId)
      .map((item) => item.previousName)
      .filter((name) => name !== current),
  ),
];

/** One line per rename: old → new, who, and when. */
function RenameLine({ rename }: { readonly rename: R.Rename }) {
  return (
    <>
      <span className="rename-names">
        <span>{rename.previousName}</span>
        <span aria-label="renamed to"> → </span>
        <strong>{rename.name}</strong>
      </span>
      <span className="rename-meta">
        {renamedBy(rename)} ·{" "}
        <time dateTime={rename.renamedAt}>{formatActivityTime(rename.renamedAt)}</time>
      </span>
    </>
  );
}

/** A compact notice in the server's Activity view for the last week's renames. */
export function RenameNotices({
  accountId,
  serverId,
}: {
  readonly accountId: P.AccountId;
  readonly serverId: M.ServerId;
}) {
  const renames = useRenames(accountId, serverId);
  const [now] = useState(Date.now);
  const recent = (renames.data?.data.items ?? [])
    .filter((item) => now - Date.parse(item.renamedAt) < noticeDays * 86_400_000)
    .slice(0, 3);
  if (recent.length === 0) return null;
  return (
    <section className="rename-notices" aria-label="Recent renames">
      <ul>
        {recent.map((rename) => (
          <li key={rename.id}>
            <RenameLine rename={rename} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Rename one agent: its ID, chats and history stay; every agent on the server is told. */
export function RenameDialog({
  accountId,
  serverId,
  agent,
  close,
}: {
  readonly accountId: P.AccountId;
  readonly serverId: M.ServerId;
  readonly agent: Pick<M.Participant, "id" | "name">;
  readonly close: () => void;
}) {
  const { api } = useServices();
  const user = useHuman();
  const cache = useQueryClient();
  const noteId = useId();
  const [current, setCurrent] = useState(agent.name);
  const [name, setName] = useState<string>(agent.name);
  // One key per attempted name, so trying again after an uncertain result is a retry.
  const [requestKey, setRequestKey] = useState(newKey);
  const [validation, setValidation] = useState<Error | null>(null);
  const [saved, setSaved] = useState<R.Result | null>(null);
  const history = useQuery({
    queryKey: [...renamesKey(user.id, accountId, serverId), agent.id],
    queryFn: ({ signal }) =>
      request(
        api.server.listRenames({
          params: { serverId },
          query: input(R.ListInput, { participantId: agent.id, limit: R.maxNotices }),
        }),
        signal,
      ),
  });
  const save = useMutation({
    mutationFn: (payload: R.RenameAgent) =>
      request(api.server.renameAgent({ params: { serverId }, payload })),
    onSuccess: (result) => {
      setSaved(result.data);
      setCurrent(result.data.participant.name);
      setRequestKey(newKey());
      // Cards, the roster, the Activity notice and this history all show names.
      for (const part of ["agents", "summary", "renames"])
        void cache.invalidateQueries({ queryKey: ["human", user.id, accountId, serverId, part] });
    },
  });
  const earlier = denied(history.error) ? [] : (history.data?.data.items ?? []);
  return (
    <Dialog title={`Rename · ${current}`} className="rename-dialog" close={close}>
      <p className="rename-intro">
        Same agent, chats and history. Every agent on this server is told the new name.
      </p>
      <form
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          if (save.isPending) return;
          setSaved(null);
          const parsed = Schema.decodeUnknownResult(M.Name)(name.trim());
          if (parsed._tag === "Failure") {
            setValidation(
              new ApiError(
                "invalid_input",
                "Use up to 64 letters, digits, hyphens or underscores, starting with a letter.",
              ),
            );
            return;
          }
          setValidation(null);
          save.mutate({ agentId: agent.id, name: parsed.success, requestKey });
        }}
      >
        <label>
          New name
          <input
            required
            maxLength={64}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
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
          Make it unique to the project and machine, like builder-macbook.
        </small>
        <Notice error={validation ?? save.error} />
        <div className="form-actions">
          <button className="btn" disabled={save.isPending}>
            {save.isPending ? "Renaming…" : "Rename"}
          </button>
          {saved && (
            <small role="status">
              {saved.changed
                ? `Renamed to ${saved.participant.name}.`
                : "That is already its name."}
            </small>
          )}
        </div>
      </form>
      {earlier.length > 0 && (
        <section className="rename-history" aria-labelledby={`${noteId}-history`}>
          <h3 id={`${noteId}-history`}>Earlier names</h3>
          <ul>
            {earlier.map((rename) => (
              <li key={rename.id}>
                <RenameLine rename={rename} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <Notice error={history.error} stale={!!history.data} />
    </Dialog>
  );
}
