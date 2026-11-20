import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import * as M from "@talkto/api/models";
import type * as P from "@talkto/api/platform";
import { useRequest, useServices } from "../session/session";

/*
  Reads mirror apps/web: the same generated client and endpoints, query keys scoped to the
  reader ("human", who, server, kind), and polling only while the screen is in front. React
  Query pauses intervals when the app is in the background (see focus in app/_layout.tsx).
*/

/** Lists refresh every 30 seconds while visible. */
export const listInterval = 30_000;
/** Directory pages are read to the end, within a bound that keeps one refresh cheap. */
const maxPages = 10;

/** Follow continuation cursors to the end of a directory, at most `maxPages` pages. */
async function readAll<T, C>(
  first: () => Promise<{ readonly items: ReadonlyArray<T>; readonly nextCursor: C | null }>,
  next: (cursor: C) => Promise<{ readonly items: ReadonlyArray<T>; readonly nextCursor: C | null }>,
) {
  let page = await first();
  const items = [...page.items];
  for (let read = 1; page.nextCursor !== null && read < maxPages; read++) {
    page = await next(page.nextCursor);
    items.push(...page.items);
  }
  return items;
}

/** Key prefix for everything one reader sees. */
export function useScope() {
  const { scope } = useServices();
  return useMemo(() => ["human", scope] as const, [scope]);
}

/** A server the person can read, under the organization that holds it. */
export interface DirectoryEntry {
  readonly id: M.ServerId;
  readonly name: string;
}
/** One organization's readable servers. */
export interface DirectorySection {
  readonly id: string;
  readonly title: string;
  readonly data: ReadonlyArray<DirectoryEntry>;
}

/** Every server the person can read, grouped by organization (one "Local" group locally). */
export function useDirectory() {
  const { api, connection } = useServices();
  const run = useRequest();
  const focused = useIsFocused();
  return useQuery({
    queryKey: [...useScope(), "directory"],
    refetchInterval: focused ? 60_000 : false,
    queryFn: async ({ signal }): Promise<ReadonlyArray<DirectorySection>> => {
      if (connection.kind === "local") {
        const servers = await readAll(
          async () => (await run(api.server.listServers(), signal)).data,
          async () => ({ items: [], nextCursor: null }),
        );
        return [{ id: "local", title: "Local development", data: servers }];
      }
      const accounts = await readAll(
        async () => (await run(api.platform.listAccounts({ query: { limit: 100 } }), signal)).data,
        async (after: string) =>
          (
            await run(
              api.platform.listAccounts({ query: { after: M.Cursor.make(after), limit: 100 } }),
              signal,
            )
          ).data,
      );
      const sections = await Promise.all(
        accounts.map(async (account: P.AccountSummary) => {
          const params = { accountId: account.id };
          const servers = await readAll(
            async () =>
              (await run(api.platform.managedServers({ params, query: { limit: 100 } }), signal))
                .data,
            async (after: string) =>
              (
                await run(
                  api.platform.managedServers({
                    params,
                    query: { after: M.Cursor.make(after), limit: 100 },
                  }),
                  signal,
                )
              ).data,
          );
          return {
            id: account.id,
            title: account.name,
            // Management access alone never shows messages; the app lists what it can read.
            data: servers.filter(
              (server) => server.status === "ready" && server.permissions.readMessages,
            ),
          };
        }),
      );
      return sections.filter((section) => section.data.length > 0);
    },
  });
}

/** The newest message on a server, for its row in the directory. */
export function useLatestMessage(serverId: M.ServerId) {
  const { api } = useServices();
  const run = useRequest();
  const focused = useIsFocused();
  return useQuery({
    queryKey: [...useScope(), serverId, "latest"],
    refetchInterval: focused ? listInterval : false,
    queryFn: async ({ signal }) => {
      const result = await run(
        api.server.serverFeed({ params: { serverId }, query: { limit: 1 } }),
        signal,
      );
      const message = result.data.items[0] ?? null;
      return {
        message,
        sender:
          message === null
            ? null
            : (result.included.participants.find((p) => p.id === message.senderId) ?? null),
      };
    },
  });
}

/** Server name and totals. */
export function useServer(serverId: M.ServerId) {
  const { api } = useServices();
  const run = useRequest();
  return useQuery({
    queryKey: [...useScope(), serverId, "server"],
    queryFn: async ({ signal }) =>
      (await run(api.server.getServer({ params: { serverId } }), signal)).data,
  });
}

/** Agents by most recent message, for the row at the top of a server. */
export function useRecentAgents(serverId: M.ServerId) {
  const { api } = useServices();
  const run = useRequest();
  const focused = useIsFocused();
  return useQuery({
    queryKey: [...useScope(), serverId, "summary"],
    refetchInterval: focused ? listInterval : false,
    queryFn: async ({ signal }) =>
      (await run(api.server.serverSummary({ params: { serverId } }), signal)).data,
  });
}

/** A channel or direct chat with the participants needed to name it. */
export interface ConversationEntry {
  readonly conversation: M.Conversation;
  readonly activityAt: string;
}

/** Channels and direct chats together, most recent activity first. */
export function useConversations(serverId: M.ServerId) {
  const { api } = useServices();
  const run = useRequest();
  const focused = useIsFocused();
  return useQuery({
    queryKey: [...useScope(), serverId, "conversations"],
    refetchInterval: focused ? 15_000 : false,
    queryFn: async ({ signal }) => {
      const participants = new Map<M.ParticipantId, M.Participant>();
      const remember = (included: M.Included) => {
        for (const participant of included.participants)
          participants.set(participant.id, participant);
      };
      const params = { serverId };
      const [channels, directs] = await Promise.all([
        readAll(
          async () => {
            const result = await run(
              api.server.listChannels({ params, query: { state: "active", limit: 100 } }),
              signal,
            );
            remember(result.included);
            return result.data;
          },
          async (cursor: M.Cursor) => {
            const result = await run(
              api.server.listChannels({ params, query: { cursor, limit: 100 } }),
              signal,
            );
            remember(result.included);
            return result.data;
          },
        ),
        readAll(
          async () => {
            const result = await run(
              api.server.listDirectConversations({ params, query: { limit: 100 } }),
              signal,
            );
            remember(result.included);
            return result.data;
          },
          async (cursor: M.Cursor) => {
            const result = await run(
              api.server.listDirectConversations({ params, query: { cursor, limit: 100 } }),
              signal,
            );
            remember(result.included);
            return result.data;
          },
        ),
      ]);
      const entries: Array<ConversationEntry> = [...channels, ...directs].map((conversation) => ({
        conversation,
        activityAt: conversation.lastMessageAt ?? conversation.createdAt,
      }));
      entries.sort((a, b) => b.activityAt.localeCompare(a.activityAt));
      return { entries, participants };
    },
  });
}

/** Every participant on a server, for the agent picker. */
export function useParticipants(serverId: M.ServerId) {
  const { api } = useServices();
  const run = useRequest();
  return useQuery({
    queryKey: [...useScope(), serverId, "participants"],
    queryFn: async ({ signal }) =>
      readAll(
        async () =>
          (
            await run(
              api.server.listParticipants({ params: { serverId }, query: { limit: 100 } }),
              signal,
            )
          ).data,
        async (cursor: M.Cursor) =>
          (
            await run(
              api.server.listParticipants({ params: { serverId }, query: { cursor, limit: 100 } }),
              signal,
            )
          ).data,
      ),
  });
}

/** One participant's profile. */
export function useParticipant(serverId: M.ServerId, participantId: M.ParticipantId) {
  const { api } = useServices();
  const run = useRequest();
  return useQuery({
    queryKey: [...useScope(), serverId, "participant", participantId],
    queryFn: async ({ signal }) =>
      (await run(api.server.getParticipant({ params: { serverId, participantId } }), signal)).data,
  });
}

/** One conversation and its participants. */
export function useConversation(serverId: M.ServerId, conversationId: M.ConversationId) {
  const { api } = useServices();
  const run = useRequest();
  const focused = useIsFocused();
  return useQuery({
    queryKey: [...useScope(), serverId, "conversation", conversationId],
    refetchInterval: focused ? listInterval : false,
    queryFn: ({ signal }) =>
      run(api.server.getConversation({ params: { serverId, conversationId } }), signal),
  });
}
