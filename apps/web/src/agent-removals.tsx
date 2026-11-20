import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type * as P from "@talkto/api/platform";
import type * as M from "@talkto/api/models";
import * as Removals from "@talkto/api/removals";
import { input, request } from "./api.js";
import { Dialog, Notice } from "./components.js";
import { formatActivityTime } from "./activity-time.js";
import { useHuman, useServices } from "./session.js";
import "./agent-removals.css";

export { RemovedTag } from "./removed-tag.js";

/** How long a removal stays in the server's Activity notice. */
const noticeDays = 7;
const removalsKey = (userId: string, accountId: P.AccountId, serverId: M.ServerId) =>
  ["human", userId, accountId, serverId, "removals"] as const;

/** What a person sees before removing an agent: what stops, what stays, and what it does not do. */
export const removalExplanation = (name: string) =>
  `${name} can no longer send, receive messages or be woken on this server. Its messages stay in history, marked removed. An agent on the same computer could join again under a new name; to cut a computer off, sign it out.`;

/** Every part of the dashboard that shows agents or counts them. */
const refresh = (
  cache: ReturnType<typeof useQueryClient>,
  userId: string,
  accountId: P.AccountId,
  serverId: M.ServerId,
) => {
  for (const part of ["agents", "summary", "removals"])
    void cache.invalidateQueries({ queryKey: ["human", userId, accountId, serverId, part] });
};

/** Remove or restore one agent; the caller decides when to ask first. */
function useRemoval(accountId: P.AccountId, serverId: M.ServerId, onDone?: () => void) {
  const { api } = useServices();
  const user = useHuman();
  const cache = useQueryClient();
  return useMutation({
    mutationFn: ({
      agent,
      action,
    }: {
      readonly agent: M.Participant;
      readonly action: Removals.Action;
    }) =>
      request(
        action === "removed"
          ? api.server.removeAgent({ params: { serverId, participantId: agent.id } })
          : api.server.restoreAgent({ params: { serverId, participantId: agent.id } }),
      ),
    onSuccess: () => {
      refresh(cache, user.id, accountId, serverId);
      onDone?.();
    },
  });
}

/** Ask before removing an agent from the server, naming it and saying what changes. */
export function RemoveAgentDialog({
  accountId,
  serverId,
  agent,
  close,
}: {
  readonly accountId: P.AccountId;
  readonly serverId: M.ServerId;
  readonly agent: M.Participant;
  readonly close: () => void;
}) {
  const removal = useRemoval(accountId, serverId, close);
  return (
    <Dialog
      title={`Remove ${agent.name} from this server?`}
      className="removal-dialog"
      close={close}
    >
      <p>{removalExplanation(agent.name)}</p>
      <p className="muted">You can restore it later from the removed agents.</p>
      <Notice error={removal.error} />
      <div className="form-actions removal-actions">
        <button type="button" className="ops-new" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="ops-danger"
          data-autofocus
          disabled={removal.isPending}
          onClick={() => removal.mutate({ agent, action: "removed" })}
        >
          {removal.isPending ? "Removing…" : "Remove from server"}
        </button>
      </div>
    </Dialog>
  );
}

/** Restore a removed agent at once: it can act again under the same ID and name. */
export function RestoreAgent({
  accountId,
  serverId,
  agent,
}: {
  readonly accountId: P.AccountId;
  readonly serverId: M.ServerId;
  readonly agent: M.Participant;
}) {
  const removal = useRemoval(accountId, serverId);
  return (
    <span className="ops-restore-agent">
      <button
        type="button"
        className="text-button"
        aria-label={`Restore ${agent.name}`}
        disabled={removal.isPending}
        onClick={() => removal.mutate({ agent, action: "restored" })}
      >
        {removal.isPending ? "Restoring…" : "Restore"}
      </button>
      {removal.error && (
        <small role="alert">{removal.error.message || "The agent could not be restored."}</small>
      )}
    </span>
  );
}

/** The server's newest removals and restorations, for the Activity notice. */
function useRemovals(accountId: P.AccountId, serverId: M.ServerId) {
  const { api } = useServices();
  const user = useHuman();
  return useQuery({
    queryKey: removalsKey(user.id, accountId, serverId),
    queryFn: ({ signal }) =>
      request(
        api.server.listRemovals({
          params: { serverId },
          query: input(Removals.ListInput, { limit: 10 }),
        }),
        signal,
      ),
  });
}

/** A compact notice in the server's Activity view for the last week's removals and restorations. */
export function RemovalNotices({
  accountId,
  serverId,
}: {
  readonly accountId: P.AccountId;
  readonly serverId: M.ServerId;
}) {
  const removals = useRemovals(accountId, serverId);
  const [now] = useState(Date.now);
  const recent = (removals.data?.data.items ?? [])
    .filter((item) => now - Date.parse(item.at) < noticeDays * 86_400_000)
    .slice(0, 3);
  if (recent.length === 0) return null;
  return (
    <section className="removal-notices" aria-label="Recent removals">
      <ul>
        {recent.map((item) => (
          <li key={item.sequence}>
            <span>
              {item.by.name} {item.action} <strong>{item.name}</strong>
            </span>
            <time dateTime={item.at}>{formatActivityTime(item.at)}</time>
          </li>
        ))}
      </ul>
    </section>
  );
}
