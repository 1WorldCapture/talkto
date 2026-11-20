import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type * as M from "@talkto/api/models";
import type * as P from "@talkto/api/platform";
import * as D from "@talkto/api/dashboard";
import { AgentIcon, Dialog, Notice, Pagination } from "./components.js";
import { denied, input, request } from "./api.js";
import { useHuman, useServices } from "./session.js";
import { formatActivityTime } from "./activity-time.js";

/** All senders in the opened chart window, fetched only while the disclosure is open. */
export function TimelineSendersDialog({
  accountId,
  serverId,
  start,
  end,
  close,
}: {
  readonly accountId: P.AccountId;
  readonly serverId: M.ServerId;
  readonly start: M.Timestamp;
  readonly end: M.Timestamp;
  readonly close: () => void;
}) {
  const { api } = useServices();
  const user = useHuman();
  const [cursor, setCursor] = useState<string | undefined>();
  const list = useRef<HTMLDivElement>(null);
  const displayedCursor = useRef(cursor);
  const result = useQuery({
    queryKey: ["human", user.id, accountId, serverId, "timeline-senders", start, end, cursor],
    queryFn: ({ signal }) =>
      request(
        api.server.serverTimelineSenders({
          params: { serverId },
          query: input(D.TimelineSendersInput, cursor ? { cursor } : { start, end }),
        }),
        signal,
      ),
    // Every open and page change checks current access; the window and ranking stay fixed.
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const page = !denied(result.error) && !result.isFetching ? result.data?.data : undefined;
  useEffect(() => {
    if (page && displayedCursor.current !== cursor) {
      list.current?.focus({ preventScroll: true });
      displayedCursor.current = cursor;
    }
  }, [page, cursor]);
  return (
    <Dialog title="Sending agents" close={close}>
      <p className="ops-sender-window">
        <time dateTime={start}>{formatActivityTime(start)}</time> –{" "}
        <time dateTime={end}>{formatActivityTime(end)}</time>
      </p>
      <Notice
        error={result.error}
        stale={!!page}
        retry={() => {
          void result.refetch();
        }}
      />
      {result.isFetching && <p role="status">Loading agents…</p>}
      {page && (
        <>
          <div
            className="ops-sender-list"
            ref={list}
            tabIndex={0}
            role="region"
            aria-label="Sending agents and message counts"
            key={cursor ?? "first"}
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col">Messages</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((sender) => (
                  <tr key={sender.id}>
                    <td>
                      <div>
                        <AgentIcon type={sender.agentType} />
                        <span>{sender.name}</span>
                      </div>
                    </td>
                    <td>{sender.messageCount.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {page.items.length === 0 && <p>No messages in this window.</p>}
          </div>
          {(cursor || page.nextCursor) && (
            <Pagination
              cursor={cursor}
              next={page.nextCursor}
              onChange={setCursor}
              count={page.items.length}
            />
          )}
        </>
      )}
    </Dialog>
  );
}
