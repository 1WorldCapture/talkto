import { useState } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type * as P from "@talkto/api/platform";
import type * as M from "@talkto/api/models";
import * as I from "@talkto/api/inputs";
import { denied, input, request, type Client } from "./api.js";
import { AgentIcon, AppLink, Notice, Pagination } from "./components.js";
import { shareReference } from "./message-dialogue.js";
import { formatActivityTime } from "./activity-time.js";
import { useHuman, useServices } from "./session.js";
import { useServerPath } from "./server-path.js";
import "./server-files.css";

const pageSize = 25;

/** One page of shares, newest first; the server tabs and the Files view read the same first page. */
export function fileSharesQuery(
  api: Client,
  userId: P.UserId,
  accountId: P.AccountId,
  serverId: M.ServerId,
  cursor?: string | undefined,
) {
  return queryOptions({
    queryKey: ["human", userId, accountId, serverId, "file-shares", cursor ?? ""],
    queryFn: ({ signal }) =>
      request(
        api.server.listFileShares({
          params: { serverId },
          query: input(I.ListShares, cursor ? { cursor } : { limit: pageSize }),
        }),
        signal,
      ),
  });
}

/** The sharer's own conversation, named the way the rest of the dashboard names it. */
function conversationLabel(
  conversation: M.Conversation | undefined,
  senderId: M.ParticipantId,
  participants: ReadonlyArray<M.Participant>,
) {
  if (!conversation) return "Conversation";
  if (conversation.kind === "channel") return `# ${conversation.name}`;
  const peer = conversation.participantIds.find((id) => id !== senderId);
  const agent = participants.find((participant) => participant.id === peer);
  return agent ? `direct chat with ${agent.name}` : "direct chat";
}

/** The remote in code with a copy control; the hint stands alone until the store has answered. */
function RemoteLine({ repository }: { readonly repository: P.FileRepository | null }) {
  const [copied, setCopied] = useState<{
    readonly remote: string;
    readonly message: string;
  } | null>(null);
  const copy = async (remote: string) => {
    try {
      await navigator.clipboard.writeText(remote);
      setCopied({ remote, message: "Copied." });
    } catch {
      setCopied({ remote, message: "Select the remote and press ⌘C or Ctrl+C." });
    }
  };
  return (
    <div className="ops-remote">
      <span className="ops-remote-label">Remote</span>
      {repository && (
        <>
          <code>{repository.remote}</code>
          <button className="ops-new" onClick={() => void copy(repository.remote)}>
            Copy
          </button>
          <span className="ops-remote-status" role="status">
            {copied?.remote === repository.remote ? copied.message : ""}
          </span>
        </>
      )}
      <p>
        Agents get access with <b>get_files_access</b>.
      </p>
    </div>
  );
}

/**
 * Shares announced on this server, newest first. Git carries the bytes: the dashboard shows
 * what an agent said it shared and links to the message that said it.
 */
export function ServerFiles({
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
  const result = useQuery(fileSharesQuery(api, user.id, accountId, server.id, cursor));
  const page = denied(result.error) ? undefined : result.data;
  const rows = (page?.data.items ?? []).flatMap((message) =>
    message.share ? [{ message, share: message.share }] : [],
  );
  const files = new Set(rows.map((row) => row.share.path)).size;
  // Counts describe the loaded page; the continuation never implies a total.
  const paged = !!cursor || !!page?.data.nextCursor;
  const scope = paged ? " on this page" : "";
  return (
    <section aria-label="Files">
      <RemoteLine repository={server.files?.repository ?? null} />
      <div className="ops-strip">
        <span>
          <b>{rows.length}</b> {rows.length === 1 ? "share" : "shares"}
          {scope}
        </span>
        <span>
          <b>{files}</b> {files === 1 ? "file" : "files"}
          {scope}
        </span>
        <span>People read a shared file through an agent until the file view ships.</span>
      </div>
      <Notice
        error={result.error}
        stale={!!page}
        retry={() => {
          void result.refetch();
        }}
      />
      {result.isPending && (
        <p className="ops-empty" role="status">
          Loading files…
        </p>
      )}
      {page && (
        <>
          {rows.length === 0 ? (
            <p className="ops-empty">No files shared yet. Agents share with share_file.</p>
          ) : (
            <div className="ops-share-list">
              {rows.map(({ message, share }) => {
                const sender = page.included.participants.find(
                  (participant) => participant.id === message.senderId,
                );
                const conversation = page.included.conversations.find(
                  (item) => item.id === message.conversationId,
                );
                const at = new Date(message.createdAt);
                return (
                  <div className="ops-share-row" key={message.id}>
                    <AgentIcon type={sender?.agentType ?? ""} />
                    <div>
                      <AppLink
                        className="ops-share-path"
                        path={path}
                        search={{
                          tab: conversation?.kind === "direct" ? "directs" : "channels",
                          channel: message.conversationId,
                        }}
                      >
                        {share.path}
                      </AppLink>
                      <p className="ops-share-note">{message.body}</p>
                      <p className="ops-share-commit">{shareReference(share)}</p>
                    </div>
                    <div className="ops-share-who">
                      {sender?.name ?? message.senderId}
                      <small>
                        {conversationLabel(
                          conversation,
                          message.senderId,
                          page.included.participants,
                        )}
                      </small>
                    </div>
                    <time
                      className="ops-share-when"
                      dateTime={message.createdAt}
                      title={at.toLocaleString()}
                    >
                      {formatActivityTime(message.createdAt)}
                    </time>
                  </div>
                );
              })}
            </div>
          )}
          <Pagination
            cursor={cursor}
            next={page.data.nextCursor}
            count={rows.length}
            onChange={(next) => {
              void navigate({
                to: "/app/$",
                params: { _splat: path },
                search: { tab: "files", cursor: next },
              });
            }}
          />
        </>
      )}
    </section>
  );
}
