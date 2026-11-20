import { Context, Effect, Option, Schema } from "effect";
import * as A from "@talkto/api/agent";
import * as M from "@talkto/api/models";
import * as U from "@talkto/api/updates";

/**
 * Waiting get_updates calls, held where Cloudflare does not bill for waiting.
 *
 * A Durable Object is billed for wall-clock time while any request to it is still running, but
 * not while its only open connections are WebSockets accepted with the Hibernation API. A Worker
 * is billed for CPU, never for time spent waiting. So a waiting call is held by the Worker that
 * received it: it opens a hibernatable WebSocket to the server object (a "watch"), reads once,
 * and if nothing matched it waits on the socket until its own deadline. A committed send wakes
 * the object, which writes one `recheck` frame to every matching watch and goes idle again; the
 * Worker then reads again. The object keeps no timer, promise or request open for a waiting call.
 *
 * Watches are hints only. Every answer comes from a normal read, so a lost frame or a dropped
 * socket can delay an answer to the deadline but never change what a read returns.
 */

/** What a committed message tells waiting readers: enough to match a selection without storage. */
export interface Arrival {
  readonly conversationId: M.ConversationId;
  readonly senderId: M.ParticipantId;
  /** Both members of a direct chat; empty for a channel. */
  readonly directParticipantIds: ReadonlyArray<M.ParticipantId>;
  /** Participants a channel message @mentions; they receive it as they receive their direct chats. */
  readonly mentionedIds: ReadonlyArray<M.ParticipantId>;
}
/** The reader and selection one wait listens for; the same rule get_updates reads with. */
export const Watch = Schema.Struct({ participantId: M.ParticipantId, selection: U.Selection });
/** Parsed watch. */
export interface Watch extends Schema.Schema.Type<typeof Watch> {}

/**
 * Open watches across one server object; above this, calls answer at once instead of waiting.
 * Hibernated sockets cost no duration, so the bound is the per-send match scan, not money: a send
 * checks every open watch. Cloudflare allows 32,768 hibernatable sockets per object.
 */
export const objectWaitLimit = 5000;
/** Open waits per reader; a newer wait ends the oldest so a reconnecting client never stacks waits. */
export const participantWaitLimit = 2;

/** Frame telling a watch's Worker to read again. */
export const recheckFrame = "recheck";
/** Frame telling a watch's Worker to answer with what it already read. */
export const endFrame = "end";
/** The server object's private watch route. Workers forward only `/v1/` paths, never this one. */
export const watchPath = "/internal/updates/watch";
/** Verified principal the watch is opened for; set only by a Worker. */
export const principalHeader = "x-talkto-principal";
/** The verified caller's organization, for hosted MCP callers; set only by a Worker. */
export const organizationHeader = "x-talkto-organization";
/** The watched reader and selection, as JSON; set only by a Worker. */
export const watchHeader = "x-talkto-watch";
/**
 * Marks a read a Worker makes because a watch said `recheck`. The call that started the wait was
 * already measured and admitted as one read, so these reads are not admitted again. Every
 * ingress removes copies a caller sends.
 */
export const rereadHeader = "x-talkto-wait-reread";

/**
 * The first read of a held call; set only by a Worker. The watch route then registers the watch
 * and reads, in that order, in one request: it answers at once with the reply, or opens the watch
 * holding the empty page. A route without this header only opens a watch, as before.
 */
export const firstReadHeader = "x-talkto-first-read";
/** Set on a watch route's answer when the first read answered at once; the body is its reply. */
export const answeredHeader = "x-talkto-answered";
/** Set on an opened watch: the empty first page, which answers at the deadline or on `end`. */
export const pageHeader = "x-talkto-page";

/** JSON in a URI component, so any text fits in one header. */
const inHeader = <S extends Schema.Top>(schema: S) =>
  Schema.StringFromUriComponent.pipe(Schema.decodeTo(Schema.fromJsonString(schema)));
/** A held MCP call's first read: the tool command and the metadata its reply starts from. */
const AgentRead = Schema.Struct({
  kind: Schema.Literal("agent"),
  command: A.Command,
  meta: A.Meta,
});
const HeaderList = Schema.Array(Schema.Tuple([Schema.String, Schema.String]));
/** A held HTTP call's first read: the request a Worker would forward, body unchanged. */
const HttpRead = Schema.Struct({
  kind: Schema.Literal("http"),
  url: Schema.String,
  headers: HeaderList,
  body: Schema.String,
});
/** A held call's first read, as the first-read header carries it. */
export const FirstRead = inHeader(Schema.Union([AgentRead, HttpRead]));
/** A parsed first read. */
export type FirstRead = typeof FirstRead.Type;
/** An empty HTTP page held on a watch: the 200 response it answers with. */
export const HttpPage = inHeader(Schema.Struct({ headers: HeaderList, body: Schema.String }));
/** An empty MCP page held on a watch: the tool reply, checked once at the MCP boundary. */
export const AgentPage = inHeader(A.UncheckedReply);
/** An MCP first read that answered at once: the watch route's body. */
export const AgentReply = Schema.fromJsonString(A.UncheckedReply);

/** Only what deciding to hold needs; a reply passes through unchanged. */
export const Page = Schema.Struct({
  data: Schema.Struct({
    messages: Schema.Array(Schema.Unknown),
    checkpoint: M.Cursor,
    nextCursor: Schema.NullOr(M.Cursor),
    renames: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  }),
});
/** Where a page ends, and whether it is empty: no messages, renames or continuation. */
export const summary = (page: typeof Page.Type) => ({
  checkpoint: page.data.checkpoint,
  empty:
    page.data.messages.length === 0 &&
    (page.data.renames?.length ?? 0) === 0 &&
    page.data.nextCursor === null,
});

/** True when the message would appear in a read with this watch's selection. */
export const matches = (watch: Watch, arrival: Arrival) =>
  arrival.senderId !== watch.participantId &&
  (watch.selection.channelIds.includes(arrival.conversationId) ||
    (watch.selection.directChats === "own" &&
      (arrival.directParticipantIds.includes(watch.participantId) ||
        arrival.mentionedIds.includes(watch.participantId))));

/** What each hibernatable socket remembers across hibernation (at most 16 KiB). */
const Attachment = Schema.Struct({
  watch: Watch,
  /** When the watch opened, and a tiebreak within one instant, to end a reader's oldest first. */
  at: Schema.Number,
  order: Schema.Number,
});
type Attachment = typeof Attachment.Type;
const decodeAttachment = Schema.decodeUnknownOption(Attachment);
/** Tag on every watch socket. */
const watchTag = "updates-watch";
/** Tag on one reader's watch sockets; participant IDs are well under the 256-character limit. */
const readerTag = (participantId: M.ParticipantId) => `updates-reader:${participantId}`;

/** The hibernatable socket operations of a Durable Object's state. */
export interface Sockets {
  readonly acceptWebSocket: (ws: WebSocket, tags: string[]) => void;
  readonly getWebSockets: (tag: string) => WebSocket[];
}

/**
 * A held call's watch while its first read runs, before its socket exists. A send that commits
 * from registration on is remembered, so the socket opens already woken and the Worker reads
 * again: nothing committed between registering and opening is missed.
 */
export interface Registration {
  /**
   * Open the socket, with the empty first page on its response, or null when this object takes no
   * more; the call then answers at once. Either way the registration ends.
   */
  readonly open: (at: number, page: string) => Response | null;
  /** End the registration without a socket: the first read answered. Idempotent. */
  readonly end: () => void;
}

/**
 * The watches attached to one server object. Nothing here waits or keeps a timer: accepting a
 * watch returns at once, and a wake only writes frames. Every pass works on the array
 * `getWebSockets` returns, a snapshot, and writing a frame never opens a watch, so a wake can
 * never re-wake a watch it opened itself (the 2026 CPU-limit incident).
 */
export class Watches {
  private closed = false;
  private order = 0;
  /** Decoded attachments while this instance is in memory; refilled lazily after hibernation. */
  private readonly known = new WeakMap<WebSocket, Attachment | null>();
  /** Registered watches whose first read runs now; a request in flight keeps them in memory. */
  private readonly reading = new Set<{ readonly watch: Watch; woken: boolean }>();
  constructor(private readonly sockets: Sockets) {}
  /** Register a watch before its first read (see `Registration`). */
  register(watch: Watch): Registration {
    const entry = { watch, woken: false };
    this.reading.add(entry);
    return {
      open: (at, page) => {
        this.reading.delete(entry);
        return this.accept(watch, at, { page, woken: entry.woken });
      },
      end: () => {
        this.reading.delete(entry);
      },
    };
  }
  /**
   * Accept a watch, or null when this object takes no more; the caller then answers at once. A
   * registered watch's socket carries its first page and, if a send woke it meanwhile, a recheck.
   */
  accept(
    watch: Watch,
    at: number,
    registered?: { readonly page: string; readonly woken: boolean },
  ): Response | null {
    if (this.closed || this.sockets.getWebSockets(watchTag).length >= objectWaitLimit) return null;
    const own = this.sockets
      .getWebSockets(readerTag(watch.participantId))
      .map((socket) => ({ socket, attachment: this.attachment(socket) }))
      .sort((a, b) => rank(a.attachment) - rank(b.attachment) || order(a) - order(b));
    for (const stale of own.slice(0, Math.max(0, own.length - participantWaitLimit + 1)))
      end(stale.socket);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: Attachment = { watch, at, order: this.order++ };
    this.sockets.acceptWebSocket(server, [watchTag, readerTag(watch.participantId)]);
    server.serializeAttachment(attachment);
    this.known.set(server, attachment);
    if (registered?.woken === true) send(server, recheckFrame);
    const headers = new Headers();
    if (registered !== undefined) headers.set(pageHeader, registered.page);
    return new Response(null, { status: 101, webSocket: client, headers });
  }
  /** Wake every watch the committed message would appear in. */
  notify(arrival: Arrival) {
    for (const entry of this.reading) if (matches(entry.watch, arrival)) entry.woken = true;
    for (const socket of this.sockets.getWebSockets(watchTag)) {
      const attachment = this.attachment(socket);
      if (attachment === null || matches(attachment.watch, arrival)) send(socket, recheckFrame);
    }
  }
  /** Make every watch read again under current access, e.g. after a grant changes. */
  recheckAll() {
    for (const entry of this.reading) entry.woken = true;
    for (const socket of this.sockets.getWebSockets(watchTag)) send(socket, recheckFrame);
  }
  /** End every watch now and refuse new ones; used once the server object starts erasing. */
  close() {
    this.closed = true;
    for (const socket of this.sockets.getWebSockets(watchTag)) end(socket);
  }
  /** Watches open right now. */
  get size() {
    return this.sockets.getWebSockets(watchTag).length;
  }
  private attachment(socket: WebSocket): Attachment | null {
    const cached = this.known.get(socket);
    if (cached !== undefined) return cached;
    const decoded = Option.getOrNull(decodeAttachment(socket.deserializeAttachment()));
    this.known.set(socket, decoded);
    return decoded;
  }
}
const rank = (attachment: Attachment | null) => attachment?.at ?? 0;
const order = (item: { readonly attachment: Attachment | null }) => item.attachment?.order ?? 0;
/** A socket the client already closed throws on write; one bad socket must not stop a pass. */
const send = (socket: WebSocket, frame: string) => {
  try {
    socket.send(frame);
  } catch {
    // The Worker's own deadline or a final read answers that call.
  }
};
const end = (socket: WebSocket) => {
  send(socket, endFrame);
  try {
    socket.close(1000, endFrame);
  } catch {
    // Already closing.
  }
};

/** Application port that wakes waiting readers after a commit; the runtime owns the watches. */
export class UpdateSignal extends Context.Service<
  UpdateSignal,
  {
    readonly notify: (arrival: Arrival) => Effect.Effect<void>;
    /** Wake every wait, for a change every reader receives, such as a participant's rename. */
    readonly notifyAll: () => Effect.Effect<void>;
  }
>()("@talkto/UpdateSignal") {}

/** Adapt one object's watches to the application port. */
export const fromWatches = (watches: Watches) =>
  UpdateSignal.of({
    notify: (arrival) => Effect.sync(() => watches.notify(arrival)),
    notifyAll: () => Effect.sync(() => watches.recheckAll()),
  });
