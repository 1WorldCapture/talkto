import { useCallback, useEffect, useMemo } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import type * as M from "@talkto/api/models";
import { useRequest, useServices } from "../session/session";
import { useScope } from "./queries";

/** The open conversation checks for new messages this often while it is on screen. */
export const liveInterval = 3_000;
const pageSize = 50;

interface Page {
  /** Newest first, as the inverted list draws them. */
  readonly messages: ReadonlyArray<M.Message>;
  readonly participants: ReadonlyArray<M.Participant>;
  readonly nextCursor: M.Cursor | null;
  readonly liveCursor: M.Cursor;
  readonly caughtUp: boolean;
}

/**
 * A conversation's messages, as the web dashboard reads them (apps/web/src/activity.tsx): the
 * server feed's history pages walk back from a captured head, and its live cursor brings newer
 * messages forward. Forward pages are oldest first; they are reversed into the head page.
 */
export function useConversationFeed(serverId: M.ServerId, conversationId: M.ConversationId) {
  const { api } = useServices();
  const run = useRequest();
  const client = useQueryClient();
  const focused = useIsFocused();
  const scope = useScope();
  const key = useMemo(
    () => [...scope, serverId, "feed", conversationId],
    [scope, serverId, conversationId],
  );
  const read = useCallback(
    async (cursor: M.Cursor | undefined, signal: AbortSignal): Promise<Page> => {
      const result = await run(
        api.server.serverFeed({
          params: { serverId },
          query:
            cursor === undefined
              ? { conversationId, limit: pageSize }
              : { cursor, limit: pageSize },
        }),
        signal,
      );
      return {
        messages: result.data.items,
        participants: result.included.participants,
        nextCursor: result.data.nextCursor,
        liveCursor: result.data.liveCursor,
        caughtUp: result.data.caughtUp,
      };
    },
    [api, run, serverId, conversationId],
  );
  const history = useInfiniteQuery<
    Page,
    Error,
    InfiniteData<Page, M.Cursor | undefined>,
    ReadonlyArray<string>,
    M.Cursor | undefined
  >({
    queryKey: key,
    initialPageParam: undefined,
    queryFn: ({ pageParam, signal }) => read(pageParam, signal),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const head = history.data?.pages[0];
  const live = useQuery({
    queryKey: [...key, "live", head?.liveCursor],
    enabled: head !== undefined && focused,
    queryFn: ({ signal }) => read(head?.liveCursor, signal),
    staleTime: 0,
    gcTime: 0,
    // Keep draining without a pause while the server says more are waiting.
    refetchInterval: (query) => (query.state.data?.messages.length ? false : liveInterval),
  });
  /** Add messages to the head page, newest first, without losing older pages. */
  const merge = useCallback(
    (
      arrived: ReadonlyArray<M.Message>,
      page?: Pick<Page, "liveCursor" | "caughtUp" | "participants">,
    ) => {
      client.setQueryData<InfiniteData<Page, M.Cursor | undefined>>(key, (previous) => {
        const [first, ...rest] = previous?.pages ?? [];
        if (previous === undefined || first === undefined) return previous;
        const known = new Set(first.messages.map((message) => message.id));
        const fresh = arrived.filter((message) => !known.has(message.id));
        return {
          ...previous,
          pages: [
            {
              ...first,
              messages: [...fresh].sort((a, b) => b.sequence - a.sequence).concat(first.messages),
              participants:
                page === undefined
                  ? first.participants
                  : [...first.participants, ...page.participants],
              liveCursor: page?.liveCursor ?? first.liveCursor,
              caughtUp: page?.caughtUp ?? first.caughtUp,
            },
            ...rest,
          ],
        };
      });
    },
    [client, key],
  );
  useEffect(() => {
    const arrived = live.data;
    if (arrived === undefined || arrived.messages.length === 0) return;
    merge(arrived.messages, arrived);
  }, [live.data, merge]);

  const messages = useMemo(() => {
    const seen = new Set<M.MessageId>();
    const rows: Array<M.Message> = [];
    for (const page of history.data?.pages ?? [])
      for (const message of page.messages)
        if (!seen.has(message.id)) {
          seen.add(message.id);
          rows.push(message);
        }
    return rows;
  }, [history.data]);
  const participants = useMemo(() => {
    const byId = new Map<M.ParticipantId, M.Participant>();
    for (const page of history.data?.pages ?? [])
      for (const participant of page.participants) byId.set(participant.id, participant);
    return byId;
  }, [history.data]);

  return {
    history,
    live,
    messages,
    participants,
    /** Show a message the person just sent, before the live cursor reaches it. */
    add: (message: M.Message) => merge([message]),
  };
}
