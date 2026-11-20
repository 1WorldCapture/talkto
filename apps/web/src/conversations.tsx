import { useId, useState, type ReactNode } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Schema } from "effect";
import type * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import * as I from "@talkto/api/inputs";
import { denied, input, request } from "./api.js";
import { AppLink, ClampedText, Notice, Pagination, ParticipantMark } from "./components.js";
import { SelectedConversation } from "./person-chat.js";
import { useHuman, useServices } from "./session.js";
import { useServerPath } from "./server-path.js";
import { formatCount } from "./format.js";

const conversationParams = Schema.Struct({
  serverId: M.ServerId,
  conversationId: M.ConversationId,
});

function ConversationName({
  conversation,
  participants,
}: {
  readonly conversation: M.Conversation;
  readonly participants: ReadonlyArray<M.Participant>;
}) {
  if (conversation.kind === "channel") return <># {conversation.name}</>;
  return (
    <span className="ops-conversation-pair">
      {conversation.participantIds.map((id, index) => {
        const agent = participants.find((participant) => participant.id === id);
        return (
          <span className="ops-conversation-peer" key={id}>
            {index > 0 && <span aria-hidden="true">↔</span>}
            <ParticipantMark participant={agent} />
            <span>{agent?.name ?? id}</span>
          </span>
        );
      })}
    </span>
  );
}

/** Browse bounded direct-chat pages with participant context from the same authorized response. */
export function DirectChats({
  accountId,
  serverId,
}: {
  readonly accountId: P.AccountId;
  readonly serverId: M.ServerId;
}) {
  const { api } = useServices();
  const user = useHuman();
  const { cursor } = useSearch({ strict: false });
  const navigate = useNavigate();
  const path = useServerPath(accountId, serverId);
  const result = useQuery({
    queryKey: ["human", user.id, accountId, serverId, "direct-chats", cursor],
    queryFn: ({ signal }) =>
      request(
        api.server.listDirectConversations({
          params: { serverId },
          query: input(I.ListDirectConversations, { cursor, limit: 20 }),
        }),
        signal,
      ),
  });
  const page = denied(result.error) ? undefined : result.data;
  return (
    <section aria-label="Direct chats">
      <div className="ops-page-bar">
        <h2 className="ops-page-title">Direct chats</h2>
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
          Loading direct chats…
        </p>
      )}
      {page && (
        <>
          {page.data.items.length === 0 ? (
            <p className="ops-empty">No direct chats found.</p>
          ) : (
            <div className="ops-channel-directory">
              {page.data.items.map((conversation) => (
                <div className="ops-channel-row" key={conversation.id}>
                  <AppLink path={path} search={{ tab: "directs", channel: conversation.id }}>
                    <ConversationName
                      conversation={conversation}
                      participants={page.included.participants}
                    />
                  </AppLink>
                  <span>{formatCount(conversation.messageCount, "message")}</span>
                </div>
              ))}
            </div>
          )}
          <Pagination
            cursor={cursor}
            next={page.data.nextCursor}
            count={page.data.items.length}
            onChange={(next) => {
              void navigate({
                to: "/app/$",
                params: { _splat: path },
                search: { tab: "directs", cursor: next },
              });
            }}
          />
        </>
      )}
    </section>
  );
}

/** One authorized selection supplies the parent navigation and conversation details. */
export function useConversationSelection({
  accountId,
  serverId,
  conversationId,
  enabled,
}: {
  readonly accountId: P.AccountId;
  readonly serverId: M.ServerId;
  readonly conversationId: string | undefined;
  readonly enabled: boolean;
}) {
  const { api } = useServices();
  const user = useHuman();
  return useQuery({
    queryKey: ["human", user.id, accountId, serverId, "conversation", conversationId],
    queryFn:
      enabled && conversationId
        ? ({ signal }) =>
            request(
              api.server.getConversation({
                params: input(conversationParams, { serverId, conversationId }),
              }),
              signal,
            )
        : skipToken,
    refetchInterval: enabled && conversationId ? 30_000 : false,
  });
}

/** Legacy conversation URLs resolve their navigation from the authorized record's kind. */
export function conversationTab(kind: M.Conversation["kind"] | undefined, hint?: string) {
  return kind === "direct" || (kind === undefined && hint === "directs") ? "directs" : "channels";
}

/** Dedicated channel/direct-chat heading, metadata and its scoped message history. */
export function ConversationSelection({
  path,
  result,
  children,
}: {
  readonly path: string;
  readonly result: ReturnType<typeof useConversationSelection>;
  readonly children: ReactNode;
}) {
  const selected = denied(result.error) ? undefined : result.data;
  const search = useSearch({ strict: false });
  const tab = conversationTab(selected?.data.kind, search.tab);
  return (
    <>
      <Notice
        error={result.error}
        stale={!!selected}
        retry={() => {
          void result.refetch();
        }}
      />
      {result.isPending && (
        <p className="ops-empty" role="status">
          Loading conversation…
        </p>
      )}
      {selected ? (
        <SelectedConversation.Provider
          value={{ conversation: selected.data, participants: selected.included.participants }}
        >
          <ConversationDetails
            path={path}
            conversation={selected.data}
            participants={selected.included.participants}
          />
          {children}
        </SelectedConversation.Provider>
      ) : (
        <AppLink path={path} search={{ tab }}>
          {tab === "directs" ? "Browse direct chats" : "Browse channels"} →
        </AppLink>
      )}
    </>
  );
}

function ConversationTime({ value }: { readonly value: M.Timestamp | null }) {
  return value ? (
    <time dateTime={value} title={value}>
      {new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
    </time>
  ) : (
    <>None yet</>
  );
}

/** Metadata is conversation-wide, independent of the currently loaded or searched messages. */
export function ConversationDetails({
  path,
  conversation,
  participants,
}: {
  readonly path: string;
  readonly conversation: M.Conversation;
  readonly participants: ReadonlyArray<M.Participant>;
}) {
  const channel = conversation.kind === "channel" ? conversation : undefined;
  // Narrow screens fold the description and counts behind a button; wide screens always show them.
  const [expanded, setExpanded] = useState(false);
  const moreId = useId();
  return (
    <header className="ops-conversation-details">
      <h2 className="ops-page-title ops-conversation-title">
        <AppLink
          path={path}
          search={{
            tab: conversationTab(conversation.kind),
            state: channel?.archivedAt ? "archived" : undefined,
          }}
        >
          {channel ? "Channels" : "Direct chats"}
        </AppLink>
        <span aria-hidden="true">/</span>
        <ConversationName conversation={conversation} participants={participants} />
      </h2>
      <button
        type="button"
        className="ops-details-toggle"
        aria-expanded={expanded}
        aria-controls={moreId}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="sr-only">{channel ? "Channel details" : "Chat details"}</span>
      </button>
      <div id={moreId} className="ops-conversation-more" data-open={expanded || undefined}>
        {channel?.description && (
          <ClampedText className="ops-conversation-description" text={channel.description} />
        )}
        <dl
          className="ops-conversation-metadata"
          aria-label={channel ? "Channel details" : "Direct chat details"}
        >
          <div>
            <dt>Messages</dt>
            <dd>{conversation.messageCount.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>
              <ConversationTime value={conversation.createdAt} />
            </dd>
          </div>
          <div>
            <dt>Last message</dt>
            <dd>
              <ConversationTime value={conversation.lastMessageAt} />
            </dd>
          </div>
          {channel?.archivedAt && (
            <div>
              <dt>Archived</dt>
              <dd>
                <ConversationTime value={channel.archivedAt} />
              </dd>
            </div>
          )}
        </dl>
      </div>
    </header>
  );
}
