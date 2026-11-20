import { queryOptions, useQuery } from "@tanstack/react-query";
import type * as P from "@talkto/api/platform";
import type * as G from "@talkto/api/guests";
import { denied, request, type Client } from "./api.js";
import { AppLink, Notice } from "./components.js";
import { useHuman, useServices } from "./session.js";
import { sharedServerPath } from "./app-routes.js";
import "./join.css";

/*
  Servers shared with the signed-in person as a guest, and invitations waiting for their verified
  address (GET /v1/shared, docs/dashboard-api.md "Server guests"). The organization list shows
  them under "Shared with you"; each server opens at /app/shared/<serverId>.
*/

/** One read shared by the organization list, /app's entry and the shared server view. */
export function sharedQuery(api: Client, userId: P.UserId) {
  return queryOptions({
    queryKey: ["human", userId, "shared"],
    queryFn: ({ signal }) => request(api.guests.shared(), signal),
  });
}

/** The signed-in person's shared servers and invitations. */
export function useShared() {
  const { api } = useServices();
  const user = useHuman();
  return useQuery(sharedQuery(api, user.id));
}

/** "Shared with you" on the organization list; nothing when nothing is shared. */
export function SharedWithYou() {
  const result = useShared();
  if (denied(result.error)) return null;
  if (!result.data) return <Notice error={result.error} retry={() => void result.refetch()} />;
  const { servers, invitations } = result.data.data;
  if (servers.length === 0 && invitations.length === 0) return null;
  return (
    <section className="shared-section" aria-labelledby="shared-with-you">
      <h2 id="shared-with-you" className="shared-title">
        Shared with you
      </h2>
      <Notice error={result.error} stale />
      <div className="organization-grid">
        {invitations.map((invitation) => (
          <InvitationCard key={invitation.id} invitation={invitation} />
        ))}
        {servers.map((server) => (
          <AppLink key={server.id} className="organization-card" path={sharedServerPath(server.id)}>
            <span className="organization-heading">
              <strong>{server.name}</strong>
            </span>
            <span className="organization-card-footer">
              <span className="muted">From {server.organizationName}</span>
              <span className="organization-open">Open →</span>
            </span>
          </AppLink>
        ))}
      </div>
    </section>
  );
}

function InvitationCard({ invitation }: { readonly invitation: G.Preview }) {
  return (
    <AppLink className="organization-card shared-invitation" path={`join/${invitation.id}`}>
      <span className="organization-heading">
        <strong>{invitation.serverName}</strong>
      </span>
      <span className="muted">
        {invitation.inviterName} invited you. From {invitation.organizationName}.
      </span>
      <span className="organization-card-footer">
        <span className="muted">Invitation</span>
        <span className="organization-open">Join →</span>
      </span>
    </AppLink>
  );
}
