import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as P from "@talkto/api/platform";
import { request, input } from "./api.js";
import { Dialog, Notice } from "./components.js";
import { useHuman, useServices } from "./session.js";
import "./server-settings.css";

/** Creator-only management; the API independently checks ownership and exact-name confirmation. */
export function ServerSettings({ server }: { readonly server: P.ServerContext }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <section className="ops-server-settings" aria-labelledby="server-settings-title">
      <h2 id="server-settings-title">Delete server</h2>
      <p>
        Permanently delete <strong>{server.name}</strong> and everything in it. This cannot be
        undone.
      </p>
      <button className="ops-danger" onClick={() => setConfirming(true)}>
        Delete server…
      </button>
      {confirming && <DeleteServerDialog server={server} close={() => setConfirming(false)} />}
    </section>
  );
}

function DeleteServerDialog({
  server,
  close,
}: {
  readonly server: P.ServerContext;
  readonly close: () => void;
}) {
  const { api } = useServices();
  const user = useHuman();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const field = useId();
  const description = useId();
  const [confirmation, setConfirmation] = useState("");
  const deletion = useMutation({
    mutationFn: () =>
      request(
        api.platform.deleteServer({
          params: { accountId: server.accountId, serverId: server.id },
          payload: input(P.DeleteServer, { confirmation }),
        }),
      ),
    onSuccess: async () => {
      // Remove cached message bodies as well as directory and onboarding references.
      await cache.cancelQueries({ queryKey: ["human", user.id, server.accountId] });
      cache.removeQueries({ queryKey: ["human", user.id, server.accountId] });
      await navigate({
        to: "/app/$",
        params: { _splat: `accounts/${server.accountId}/servers` },
        search: {},
        replace: true,
      });
      await cache.invalidateQueries({ queryKey: ["human", user.id] });
    },
  });
  return (
    <Dialog title="Delete this server?" close={close}>
      <form
        className="ops-delete-confirmation"
        onSubmit={(event) => {
          event.preventDefault();
          if (confirmation === server.name && !deletion.isPending) deletion.mutate();
        }}
      >
        <p id={description}>
          All messages, channels, direct chats, agent registrations, and access to this server will
          be permanently deleted. <strong>There is no undo.</strong>
        </p>
        <p className="muted">
          Your organization’s plan and message usage stay the same. Deleted messages still count
          toward your allowance.
        </p>
        <label htmlFor={field}>
          Type <strong>{server.name}</strong> to confirm
        </label>
        <input
          id={field}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={description}
          disabled={deletion.isPending}
        />
        <Notice error={deletion.error} />
        {deletion.isPending && <p role="status">Deleting server…</p>}
        <div className="ops-delete-actions">
          <button type="button" className="ops-new" onClick={close}>
            {deletion.isPending || deletion.error ? "Close" : "Cancel"}
          </button>
          <button
            type="submit"
            className="ops-danger"
            disabled={confirmation !== server.name || deletion.isPending}
          >
            {deletion.error ? "Retry deletion" : "Delete permanently"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
