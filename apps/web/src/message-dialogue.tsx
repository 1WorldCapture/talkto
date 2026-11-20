import { Fragment, useLayoutEffect, useRef, type ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";
import type * as M from "@talkto/api/models";
import { describeAgentType } from "@talkto/api/agent-types";
import { AppLink, ParticipantMark } from "./components.js";
import { MessageBody } from "./message-body.js";
import { RemovedTag } from "./removed-tag.js";
import "./message-dialogue.css";

/** Agent-reported size in the dashboard's units; the sharer's number is reported, not verified. */
export function formatShareSize(bytes: number) {
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024).toLocaleString()} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toLocaleString([], { maximumFractionDigits: 1 })} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toLocaleString([], { maximumFractionDigits: 2 })} GB`;
}

/** Ref, short commit and size, exactly as the sharing agent announced them. */
export function shareReference(share: M.FileShare) {
  const size = share.bytes === undefined ? [] : [formatShareSize(share.bytes)];
  return [share.ref, share.commit.slice(0, 7), ...size].join(" · ");
}

/** A transfer offer renders like a share chip; people see what was offered and when it expires. */
function TransferChip({ transfer }: { readonly transfer: M.FileTransfer }) {
  const files = transfer.fileCount;
  const count =
    files === null ? [] : [`${files.toLocaleString()} ${files === 1 ? "file" : "files"}`];
  const reference = [
    formatShareSize(transfer.bytes),
    ...count,
    `expires ${transfer.expiresAt.slice(0, 10)}`,
  ];
  return (
    <p
      className="ops-share"
      data-kind={transfer.kind}
      aria-label={`Sent ${transfer.kind} ${transfer.name}`}
    >
      <span className="ops-share-mark" aria-hidden="true" />
      <span className="ops-share-path">{transfer.name}</span>
      <span className="ops-share-reference">
        {reference.map((part, index) => (
          <Fragment key={part}>
            {index > 0 && " · "}
            <span>{part}</span>
          </Fragment>
        ))}
      </span>
    </p>
  );
}

/**
 * A share is an ordinary message; its file reference renders as a chip under the agent's note.
 * Where the server no longer offers Git sharing (hosted TalkTo since 2026-11-16) the chip names
 * the file plainly and says it can no longer be fetched, rather than linking a Files view that is gone.
 */
function ShareChip({ share, files }: { readonly share: M.FileShare; readonly files: boolean }) {
  // The dialogue always renders inside one server's own path, so Files is a sibling view.
  const path = useLocation({ select: (location) => location.pathname.slice(5) });
  return (
    <p className="ops-share" aria-label={`Shared file ${share.path}`}>
      <span className="ops-share-mark" aria-hidden="true" />
      <span className="ops-share-path">{share.path}</span>
      <span className="ops-share-reference">
        {shareReference(share)} ·{" "}
        {files ? (
          <AppLink path={path} search={{ tab: "files" }}>
            open in Files
          </AppLink>
        ) : (
          <span>Git sharing has ended; this file can no longer be fetched</span>
        )}
      </span>
    </p>
  );
}

/** The description line TalkTo wrote into a channel notice, if the channel has one. */
export function noticeDescription(body: string) {
  const line = body.split("\n").find((item) => item.startsWith("Description: "));
  return line === undefined ? null : line.slice("Description: ".length);
}

/** TalkTo's own notice about a new channel: one quiet line, not a message in the creator's voice. */
function ChannelNotice({
  notice,
  creator,
  description,
  at,
  createdAt,
}: {
  readonly notice: M.MessageNotice;
  readonly creator: string;
  readonly description: string | null;
  readonly at: Date;
  readonly createdAt: string;
}) {
  return (
    <p>
      <span className="ops-dialogue-notice-mark" aria-hidden="true" />
      <span>
        <strong>{creator}</strong> created <strong>#{notice.channelName}</strong>
        {description !== null && (
          <span className="ops-dialogue-notice-detail"> · {description}</span>
        )}
      </span>
      <time dateTime={createdAt} title={at.toLocaleString()}>
        {at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </time>
    </p>
  );
}

/** Full-text dialogue for a single authorized conversation, ordered by its immutable sequence. */
export function MessageDialogue({
  rows,
  position,
  target,
  empty,
  history,
  onBottom,
  self = null,
  senderAction,
  files = false,
}: {
  readonly rows: ReadonlyArray<{
    readonly message: M.Message;
    readonly included: M.Included;
  }>;
  readonly position: "latest" | "history" | "search";
  /** Sequence of the message the reader opened; it starts in view and stays marked. */
  readonly target?: number | undefined;
  readonly empty: string;
  readonly history?: ReactNode;
  readonly onBottom?: ((atBottom: boolean) => void) | undefined;
  /** The signed-in person's own participant here, whose messages read "you". */
  readonly self?: M.ParticipantId | null;
  /** An action offered beside a sender's name, such as messaging that agent. */
  readonly senderAction?: ((sender: M.Participant) => ReactNode) | undefined;
  /** Whether this server offers Git sharing, so a share chip can open its Files view. */
  readonly files?: boolean | undefined;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const anchor = useRef<{
    height: number;
    top: number;
    count: number;
    newest: string | undefined;
  } | null>(null);
  // Prepending older history keeps the same message at the reader's position.
  // A new latest snapshot is an explicit action and returns to its newest message.
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const newest = rows.reduce<(typeof rows)[number] | undefined>(
      (latest, row) => (!latest || row.message.sequence > latest.message.sequence ? row : latest),
      undefined,
    )?.message.id;
    const previous = anchor.current;
    const opened = element.querySelector<HTMLElement>(`[data-sequence="${target}"]`);
    if (previous && previous.newest === newest && rows.length > previous.count)
      element.scrollTop = previous.top + element.scrollHeight - previous.height;
    else if (opened && !previous?.count)
      element.scrollTop +=
        opened.getBoundingClientRect().top -
        element.getBoundingClientRect().top -
        Math.max(12, (element.clientHeight - opened.offsetHeight) / 2);
    else element.scrollTop = position === "latest" ? element.scrollHeight : 0;
    anchor.current = {
      height: element.scrollHeight,
      top: element.scrollTop,
      count: rows.length,
      newest,
    };
  }, [rows, position, target]);
  const ordered = [...rows].sort((a, b) => a.message.sequence - b.message.sequence);
  return (
    <div
      className="ops-dialogue"
      ref={viewport}
      role="region"
      aria-label="Conversation, oldest first"
      tabIndex={0}
      onScroll={() => {
        const element = viewport.current;
        if (!element) return;
        if (anchor.current)
          anchor.current = {
            ...anchor.current,
            height: element.scrollHeight,
            top: element.scrollTop,
          };
        onBottom?.(element.scrollHeight - element.scrollTop - element.clientHeight < 32);
      }}
    >
      {history}
      {ordered.length === 0 ? (
        <p className="ops-empty" role="status">
          {empty}
        </p>
      ) : (
        <ol className="ops-dialogue-messages">
          {ordered.map(({ message, included }, index) => {
            const sender = included.participants.find((agent) => agent.id === message.senderId);
            const at = new Date(message.createdAt);
            const previous = ordered[index - 1];
            const startsDay =
              !previous ||
              new Date(previous.message.createdAt).toDateString() !== at.toDateString();
            return (
              <Fragment key={message.id}>
                {startsDay && (
                  <li className="ops-dialogue-day">
                    <time dateTime={message.createdAt}>
                      {at.toLocaleDateString([], {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </time>
                  </li>
                )}
                {message.notice ? (
                  <li
                    className="ops-dialogue-notice"
                    data-message-id={message.id}
                    data-sequence={message.sequence}
                    aria-current={message.sequence === target ? "true" : undefined}
                  >
                    <ChannelNotice
                      notice={message.notice}
                      creator={sender?.name ?? "An agent"}
                      description={noticeDescription(message.body)}
                      at={at}
                      createdAt={message.createdAt}
                    />
                  </li>
                ) : (
                  <li
                    className="ops-dialogue-message"
                    data-message-id={message.id}
                    data-sequence={message.sequence}
                    aria-current={message.sequence === target ? "true" : undefined}
                  >
                    <ParticipantMark participant={sender} />
                    <div>
                      <header>
                        <strong
                          title={
                            sender &&
                            (sender.kind === "person"
                              ? "Person, named from their sign-in"
                              : describeAgentType(sender.agentType).label)
                          }
                        >
                          {sender?.name ?? "Unknown sender"}
                        </strong>
                        <RemovedTag participant={sender} />
                        {self !== null && message.senderId === self && (
                          <span className="ops-dialogue-you">you</span>
                        )}
                        <time dateTime={message.createdAt} title={at.toLocaleString()}>
                          {at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </time>
                        {message.priority === "urgent" && (
                          <span className="ops-urgent-tag">Urgent</span>
                        )}
                        {self !== null && message.mentions?.includes(self) && (
                          <span className="ops-mention-tag">Mentions you</span>
                        )}
                        {sender && senderAction?.(sender)}
                      </header>
                      <MessageBody className="ops-dialogue-body" body={message.body} />
                      {message.share && <ShareChip share={message.share} files={files} />}
                      {message.transfer && <TransferChip transfer={message.transfer} />}
                    </div>
                  </li>
                )}
              </Fragment>
            );
          })}
        </ol>
      )}
    </div>
  );
}
