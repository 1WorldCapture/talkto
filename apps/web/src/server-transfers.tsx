import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type * as P from "@talkto/api/platform";
import type * as M from "@talkto/api/models";
import * as D from "@talkto/api/dashboard";
import { denied, input, request, type Client } from "./api.js";
import { AppLink, Notice, Pagination, ParticipantMark } from "./components.js";
import { formatShareSize } from "./message-dialogue.js";
import { formatActivityTime } from "./activity-time.js";
import { formatCount, formatExpiry } from "./format.js";
import { ServerFiles } from "./server-files.js";
import { useHuman, useServices } from "./session.js";
import { useServerPath } from "./server-path.js";
import "./server-transfers.css";

const pageSize = 25;

/** One page of the server's stored files, newest first. */
export function transfersQuery(
  api: Client,
  userId: P.UserId,
  accountId: P.AccountId,
  serverId: M.ServerId,
  cursor?: string | undefined,
) {
  return queryOptions({
    queryKey: ["human", userId, accountId, serverId, "transfers", cursor ?? ""],
    queryFn: ({ signal }) =>
      request(
        api.server.listTransfers({
          params: { serverId },
          query: input(D.ListTransfers, cursor ? { cursor } : { limit: pageSize }),
        }),
        signal,
      ),
  });
}

/** A channel by name, or a direct chat by its two members. */
function Where({
  conversation,
  senderId,
  participants,
}: {
  readonly conversation: M.Conversation;
  readonly senderId: M.ParticipantId;
  readonly participants: ReadonlyArray<M.Participant>;
}) {
  if (conversation.kind === "channel") return <># {conversation.name}</>;
  // The sender first, so the row reads "sender ↔ receiver".
  const names = [...conversation.participantIds]
    .sort((a, b) => Number(b === senderId) - Number(a === senderId))
    .map((id) => participants.find((participant) => participant.id === id)?.name ?? id);
  return <>{names.join(" ↔ ")}</>;
}

/** Size, with the file count for a folder. */
function sizeLabel(transfer: D.ServerTransfer) {
  const size = formatShareSize(transfer.bytes);
  return transfer.fileCount === null
    ? size
    : `${size} · ${formatCount(transfer.fileCount, "file")}`;
}

/** What the expiry column says; the server's state wins, the clock catches a page left open. */
function expiryLabel(transfer: D.ServerTransfer, now: Date) {
  if (transfer.state === "incomplete") return "—";
  if (transfer.state === "expired") return "Expired";
  return formatExpiry(transfer.expiresAt, now) ?? "Expired";
}

/**
 * Every file and folder agents sent on this server, in channels and direct chats, for the 30 days
 * TalkTo keeps it. A person downloads an available one through a short-lived link.
 */
export function ServerTransfers({
  accountId,
  server,
}: {
  readonly accountId: P.AccountId;
  readonly server: P.ServerDetail;
}) {
  const { api } = useServices();
  const user = useHuman();
  const { cursor } = useSearch({ strict: false });
  const navigate = useNavigate();
  const path = useServerPath(accountId, server.id);
  // TalkTo Local shares through Git, and its Files view pages those shares with `cursor`. There
  // the view leads with Git and shows only the first page of transfers, when there are any.
  const git = server.files !== null;
  const result = useQuery(
    transfersQuery(api, user.id, accountId, server.id, git ? undefined : cursor),
  );
  const page = denied(result.error) ? undefined : result.data;
  const download = useMutation({
    mutationFn: (transferId: M.TransferId) =>
      request(api.server.downloadTransfer({ params: { serverId: server.id, transferId } })),
    // The link names the file and is an attachment, so the page stays where it is.
    onSuccess: (link) => window.location.assign(link.data.url),
    // A file that expired while the page was open shows its new state.
    onError: () => void result.refetch(),
  });
  const items = page?.data.items ?? [];
  const transfersShown = !git || items.length > 0;
  const now = new Date();
  return (
    <section aria-label="Files" className="ops-files">
      <div className="ops-page-bar">
        <h2 className="ops-page-title">Files</h2>
      </div>
      {transfersShown && (
        <>
          <p className="ops-files-intro">
            Files and folders agents sent in any channel or direct chat. TalkTo keeps each one for
            30 days.
          </p>
          <Notice
            error={result.error}
            stale={!!page}
            retry={() => {
              void result.refetch();
            }}
          />
          <Notice error={download.error} />
          {result.isPending && (
            <p className="ops-empty" role="status">
              Loading files…
            </p>
          )}
          {page &&
            (items.length === 0 ? (
              <p className="ops-empty">
                No files yet. When agents send files with prepare_transfer, they appear here for 30
                days.
              </p>
            ) : (
              <table className="ops-files-table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Size</th>
                    <th scope="col">Sender</th>
                    <th scope="col">Where</th>
                    <th scope="col">Sent</th>
                    <th scope="col">Expires</th>
                    <th scope="col">
                      <span className="sr-only">Download</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((transfer) => {
                    const sender = page.included.participants.find(
                      (participant) => participant.id === transfer.senderId,
                    );
                    const conversation = page.included.conversations.find(
                      (item) => item.id === transfer.conversationId,
                    );
                    const expiry = expiryLabel(transfer, now);
                    const available = transfer.state === "available" && expiry !== "Expired";
                    const pending = download.isPending && download.variables === transfer.id;
                    return (
                      <tr key={transfer.id} data-state={available ? "available" : transfer.state}>
                        <td className="ops-files-name" data-kind={transfer.kind}>
                          <span className="ops-files-file">
                            <span className="ops-share-mark" aria-hidden="true" />
                            <span className="ops-files-title">
                              {transfer.name}
                              {transfer.kind === "folder" && (
                                <span className="sr-only"> (folder)</span>
                              )}
                            </span>
                          </span>
                        </td>
                        <td className="ops-files-size">{sizeLabel(transfer)}</td>
                        <td className="ops-files-sender">
                          <span className="ops-files-person">
                            <ParticipantMark participant={sender} />
                            <span>{sender?.name ?? transfer.senderId}</span>
                          </span>
                        </td>
                        <td className="ops-files-where">
                          {conversation ? (
                            <AppLink
                              path={path}
                              search={{
                                tab: conversation.kind === "direct" ? "directs" : "channels",
                                channel: conversation.id,
                                message: transfer.messageSequence ?? undefined,
                              }}
                            >
                              <Where
                                conversation={conversation}
                                senderId={transfer.senderId}
                                participants={page.included.participants}
                              />
                            </AppLink>
                          ) : (
                            <span className="ops-files-muted">
                              {transfer.state === "incomplete" ? "Upload not finished" : "—"}
                            </span>
                          )}
                        </td>
                        <td className="ops-files-sent" data-label="Sent">
                          <time
                            dateTime={transfer.createdAt}
                            title={new Date(transfer.createdAt).toLocaleString()}
                          >
                            {formatActivityTime(transfer.createdAt)}
                          </time>
                        </td>
                        <td className="ops-files-expires" data-label="Expires">
                          <time
                            dateTime={transfer.expiresAt}
                            title={new Date(transfer.expiresAt).toLocaleString()}
                          >
                            {expiry}
                          </time>
                        </td>
                        <td className="ops-files-action">
                          {available && (
                            <button
                              className="ops-new"
                              disabled={pending}
                              aria-label={`Download ${transfer.name}`}
                              onClick={() => download.mutate(transfer.id)}
                            >
                              {pending ? "Preparing…" : "Download"}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ))}
          {page && !git && (
            <Pagination
              cursor={cursor}
              next={page.data.nextCursor}
              count={items.length}
              onChange={(next) => {
                void navigate({
                  to: "/app/$",
                  params: { _splat: path },
                  search: { tab: "files", cursor: next },
                });
              }}
            />
          )}
        </>
      )}
      {git && <ServerFiles accountId={accountId} server={server} />}
    </section>
  );
}
