import { Clock, Effect, Option, Schema } from "effect";
import * as A from "@talkto/api/agent";
import * as M from "@talkto/api/models";
import * as T from "@talkto/api/tasks";
import * as U from "@talkto/api/updates";
import type * as P from "@talkto/api/platform";
import type * as Access from "./access.js";
import { atStep, describeFailure, runtimeFlags, type Step } from "./failure-log.js";
import * as Telemetry from "./telemetry.js";
import * as Updates from "./updates.js";
import * as Signal from "./update-signal.js";
import * as ReadRetry from "./read-retry.js";

/**
 * The Worker half of a waiting get_updates call (see update-signal.ts), and of a claim_task for
 * next that waits for work: the same watch, deadline and re-reads, where an empty claim stands for
 * an empty page and each re-read claims again. The Worker that received
 * the call asks the server object, in one request, to register a hibernatable watch and read
 * once; when nothing matched it waits on the watch until the call's deadline, reading again
 * whenever the object says `recheck`. Workers are billed for CPU, not for waiting, so a held call
 * costs nothing while it waits; the server object is idle and hibernation-eligible the whole time.
 *
 * Every rule of the former in-object wait holds: the watch is registered before the first read,
 * so a send that commits after that read still wakes it; a page with messages, renames or a
 * continuation answers at once; a re-read continues from the checkpoint already read, so a wait
 * that started at "now" keeps what arrived; `end` and the deadline answer with the last page;
 * each re-read is a full read under current access, so a revoked grant ends the wait with its
 * failure; and the call counts as one read however often it reads again.
 *
 * When the watch fails to open (Cloudflare sometimes fails to reach the object), the call reads
 * every few seconds until its deadline instead, so the caller still gets a held answer, not an
 * error. Sentry records each such failure as a warning.
 */

type Server = ReturnType<Env["SERVERS"]["getByName"]>;
/** The verified caller a Worker opens a watch for; the server object resolves it again. */
export interface Authority {
  readonly principalKey: Access.PrincipalKey;
  readonly organizationId: P.OrganizationId | null;
}
/** How one wait on a watch ended. */
type Outcome = "recheck" | "end" | "closed" | "timeout";
/** Where a held read ended, and whether it found nothing yet. */
interface Held {
  readonly empty: boolean;
}
/** Where a get_updates page ends, so a re-read continues from it. */
interface PageEnd extends Held {
  readonly checkpoint: M.Cursor;
}
/** Whether a read answered with a page, and whether that page can be held for more. */
interface Read<R, P extends Held> {
  readonly reply: R;
  /** Null when the read failed (or claimed): a failure answers at once, as it always did. */
  readonly page: P | null;
}
/** A held claim's empty answer: nothing to continue from, the same claim runs again. */
const emptyClaim: Held = { empty: true };

/** The private URL of a server object's watch route; the host is never resolved. */
const watchUrl = `https://server.talkto.internal${Signal.watchPath}`;
const timedOut: Outcome = "timeout";
const rechecked: Outcome = "recheck";
/**
 * The largest first read sent in a header. A first read is a few KiB at most unless an HTTP
 * caller pads its body or headers; a larger one goes as before: the watch, then a separate read.
 */
const firstReadLimit = 16 * 1024;
/** How often a call whose watch failed to open reads again while it waits. */
const fallbackPollMillis = 3_000;

/**
 * Name the step of a server-object call that rejected, for its failure log and report. The
 * rejection itself, and so what the caller receives, is unchanged.
 */
const at =
  (step: Step) =>
  <A>(effect: Effect.Effect<A>): Effect.Effect<A> =>
    effect.pipe(Effect.tapDefect((defect) => Effect.sync(() => atStep(defect, step))));

/** What a held call waits on between reads. */
interface Waiter {
  /** Wait up to `millis` for a reason to read again. */
  readonly next: (millis: number) => Effect.Effect<Outcome>;
  readonly close: () => void;
}

/** The Worker's end of one watch. Frames that arrive during a read are kept, not lost. */
class Watcher implements Waiter {
  private recheck = false;
  private ended: "end" | "closed" | null = null;
  private wake: (() => void) | null = null;
  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) =>
      this.signal(event.data === Signal.endFrame ? "end" : "recheck"),
    );
    socket.addEventListener("close", () => this.signal("closed"));
    socket.addEventListener("error", () => this.signal("closed"));
    socket.accept();
  }
  /** Wait up to `millis` for the next frame, or answer at once with one already received. */
  next(millis: number): Effect.Effect<Outcome> {
    return Effect.callback<Outcome>((resume) => {
      const ready = this.take();
      if (ready !== null) {
        resume(Effect.succeed(ready));
        return;
      }
      this.wake = () => {
        const woken = this.take();
        if (woken !== null) resume(Effect.succeed(woken));
      };
      return Effect.sync(() => {
        this.wake = null;
      });
    }).pipe(
      Effect.timeoutOption(millis),
      Effect.map((outcome) => Option.getOrElse(outcome, () => timedOut)),
    );
  }
  close() {
    try {
      this.socket.close(1000, "done");
    } catch {
      // Already closed by the server object.
    }
  }
  private signal(kind: "recheck" | "end" | "closed") {
    if (kind === "recheck") this.recheck = true;
    else if (this.ended === null) this.ended = kind;
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
  /** A pending recheck reads first: a send that raced an `end` is then still delivered. */
  private take(): Outcome | null {
    if (this.recheck) {
      this.recheck = false;
      return "recheck";
    }
    return this.ended;
  }
}

/**
 * Stands in for a watch that failed to open: the call reads again every few seconds, and the
 * deadline still answers with the last page.
 */
const poller: Waiter = {
  next: (millis) =>
    millis <= fallbackPollMillis
      ? Effect.as(Effect.sleep(millis), timedOut)
      : Effect.as(Effect.sleep(fallbackPollMillis), rechecked),
  close: () => {},
};

/** What asking for a watch and a first read found; null parts mean the object did not do them. */
interface Opened {
  readonly watcher: Waiter | null;
  /** The watch route's answer when the first read answered at once. */
  readonly answer: Response | null;
  /** The empty first page an opened watch holds. */
  readonly page: string | null;
}
const nothing: Opened = { watcher: null, answer: null, page: null };

/**
 * Register a watch and read once, in that order, in one request to the server object. An object
 * still on code from before first reads only opens the watch, and a full, erasing or unready one
 * refuses before reading; the call then reads separately, and without a watch answers at once.
 * A request that fails falls back to polling in `hold`.
 */
const open = (server: Server, authority: Authority, watch: Signal.Watch, first: () => string) =>
  Effect.promise(() => {
    const headers = new Headers({
      upgrade: "websocket",
      [Signal.principalHeader]: authority.principalKey,
      [Signal.watchHeader]: JSON.stringify(watch),
    });
    const read = first();
    if (read.length <= firstReadLimit) headers.set(Signal.firstReadHeader, read);
    if (authority.organizationId !== null)
      headers.set(Signal.organizationHeader, authority.organizationId);
    return server.fetch(new Request(watchUrl, { headers }));
  }).pipe(
    at("watch"),
    Effect.map((response): Opened => {
      if (response.headers.has(Signal.answeredHeader)) return { ...nothing, answer: response };
      const socket = response.webSocket;
      if (response.status === 101 && socket !== null)
        return {
          watcher: new Watcher(socket),
          answer: null,
          page: response.headers.get(Signal.pageHeader),
        };
      void response.body?.cancel();
      return nothing;
    }),
  );
/** How one kind of call sends its first read with its watch, and reads the answers. */
interface First<R, P extends Held> {
  /** The first read, as the first-read header carries it. */
  readonly request: () => string;
  /** The reply when the first read answered at once. */
  readonly answered: (response: Response) => Effect.Effect<R>;
  /** The empty page an opened watch holds. */
  readonly held: (page: string) => Effect.Effect<Read<R, P>>;
}
/** What one held call waits on, for how long, and what it reads again. */
interface Plan<I, P extends Held> {
  /** The watch, or null to read once: no wait, or a token whose selection does not parse. */
  readonly watch: Signal.Watch | null;
  readonly waitMillis: number;
  /** The input a re-read sends after an empty `page`. */
  readonly again: (page: P) => I;
}

/** Where a re-read continues: the checkpoint already read, never "start at now" again. */
const continuation = (input: U.Input, checkpoint: M.Cursor): U.Input => {
  const next: U.Input = {
    participantId: input.participantId,
    mode: "poll",
    checkpoint,
    limit: input.limit ?? 25,
  };
  // Re-reads keep reporting the plugin, so the page that answers still names its newest version.
  return input.plugin === undefined ? next : { ...next, plugin: input.plugin };
};
/**
 * Hold one call: read, then wait on a watch and read again until a page answers or time is up.
 *
 * A watch that fails to open does not fail the call: it reads on a new stub, since Cloudflare
 * may break a stub after a failure, and then polls (`poller`). If the object did read before
 * failing, that call counts two reads. An object Cloudflare reports overloaded still fails the
 * call, so polling never adds load to it.
 */
const hold = Effect.fn("UpdateWait.hold")(function* <I, R, P extends Held>(
  connect: () => Server,
  authority: Authority,
  input: I,
  plan: Plan<I, P>,
  first: First<R, P>,
  read: (server: Server, input: I, reread: boolean) => Effect.Effect<Read<R, P>>,
) {
  let server = connect();
  const watch = plan.waitMillis === 0 ? null : plan.watch;
  if (watch === null) return (yield* read(server, input, false)).reply;
  const deadline = (yield* Clock.currentTimeMillis) + plan.waitMillis;
  return yield* Effect.acquireUseRelease(
    // The watch is registered before the first read: a send that commits after that read wakes it.
    open(server, authority, watch, first.request).pipe(
      Effect.catchDefect((defect) =>
        runtimeFlags(defect).overloaded === true
          ? Effect.die(defect)
          : Effect.sync((): Opened => {
              console.warn("update-wait: watch failed to open; polling", describeFailure(defect));
              Telemetry.watchFallback(defect);
              server = connect();
              return { ...nothing, watcher: poller };
            }),
      ),
    ),
    (opened) =>
      Effect.gen(function* () {
        if (opened.answer !== null) return yield* first.answered(opened.answer);
        const watcher = opened.watcher;
        let step =
          opened.page === null ? yield* read(server, input, false) : yield* first.held(opened.page);
        if (watcher === null) return step.reply;
        for (;;) {
          if (step.page === null || !step.page.empty) return step.reply;
          const left = deadline - (yield* Clock.currentTimeMillis);
          if (left <= 0) return step.reply;
          const outcome = yield* watcher.next(left);
          if (outcome === "end" || outcome === "timeout") return step.reply;
          // A watch the runtime dropped (a deploy, a reset) gets one last read, then answers. A
          // reset breaks this stub for every later call, so that read goes through a new one.
          if (outcome === "closed") server = connect();
          step = yield* read(server, plan.again(step.page), true);
          if (outcome === "closed") return step.reply;
        }
      }),
    (opened) => Effect.sync(() => opened.watcher?.close()),
  );
});

/** The plan of a get_updates call: its own selection, continued from each page's checkpoint. */
const updatesPlan = (input: U.Input): Effect.Effect<Plan<U.Input, PageEnd>> =>
  Effect.gen(function* () {
    const waitMillis = (input.waitSeconds ?? 0) * 1000;
    const selection = waitMillis === 0 ? null : yield* Updates.selectionOf(input);
    return {
      watch: selection === null ? null : { participantId: input.participantId, selection },
      waitMillis,
      again: (page) => continuation(input, page.checkpoint),
    };
  });
/** The plan of a claim for next that waits: the claimer's watch, and the same claim again. */
const claimPlan = <I>(
  participantId: M.ParticipantId,
  waitSeconds: number,
  input: I,
): Plan<I, Held> => ({
  watch: Signal.claimWatch(participantId),
  waitMillis: waitSeconds * 1000,
  again: () => input,
});
/** The wait a claim asks for: only a claim for next waits. */
const claimWait = (body: T.ClaimTaskBody) => ("next" in body ? (body.next.waitSeconds ?? 0) : 0);

/**
 * Invoke a tool on a server object. A get_updates call with waitSeconds, or a claim_task for next
 * with next.waitSeconds, is held here, in the Worker; every other call, and every read, is one
 * private RPC. A failed call rejects as before. The reply is not decoded here: the MCP boundary
 * checks it against the tool's contract once.
 */
export const invokeAgent = (
  connect: () => Server,
  authority: Authority,
  command: A.Command,
  meta: A.Meta,
): Effect.Effect<A.UncheckedReply> => {
  const attempt = (server: Server, current: A.Command, reread: boolean) =>
    Effect.promise(
      async () =>
        await server.invokeAgent(
          authority.principalKey,
          authority.organizationId,
          current,
          meta,
          reread,
        ),
    ).pipe(
      at("invoke"),
      Effect.flatMap(Schema.decodeUnknownEffect(A.UncheckedReply)),
      Effect.orDie,
    );
  // A read that failed transiently is tried once more on a fresh stub (read-retry.ts); twice, and
  // the agent is told the server is briefly unavailable, not that something broke.
  const call = (server: Server, current: A.Command, reread: boolean) =>
    ReadRetry.readTools.has(current.tool)
      ? ReadRetry.twice((fresh) => attempt(fresh ? connect() : server, current, reread)).pipe(
          Effect.map((retried): A.UncheckedReply => {
            if (retried.kind === "answered") return retried.value;
            Telemetry.readUnavailable(retried.defect, current.tool);
            return {
              error: { code: "storage_unavailable", message: ReadRetry.unavailableMessage },
              meta,
            };
          }),
        )
      : attempt(server, current, reread);
  const answered = (response: Response) =>
    Effect.promise(() => response.text()).pipe(
      at("first_read"),
      Effect.flatMap(Schema.decodeUnknownEffect(Signal.AgentReply)),
      Effect.orDie,
    );
  const request = () => Schema.encodeSync(Signal.FirstRead)({ kind: "agent", command, meta });
  if (command.tool === T.claimToolName && claimWait(command.input) > 0) {
    // An empty claim is held; a claim, or any failure, answers at once.
    const toRead = (reply: A.UncheckedReply): Read<A.UncheckedReply, Held> => ({
      reply,
      page: Option.isSome(decodeEmptyClaim(reply)) ? emptyClaim : null,
    });
    return hold(
      connect,
      authority,
      command,
      claimPlan(command.input.participantId, claimWait(command.input), command),
      {
        request,
        answered,
        held: (page) =>
          Schema.decodeUnknownEffect(Signal.AgentPage)(page).pipe(Effect.orDie, Effect.map(toRead)),
      },
      (server, current, reread) => call(server, current, reread).pipe(Effect.map(toRead)),
    );
  }
  if (command.tool !== U.toolName || (command.input.waitSeconds ?? 0) === 0)
    return call(connect(), command, false);
  const { serverId, ...input } = command.input;
  // Holding needs only where the page ends; a failure or any other reply answers at once.
  const toRead = (reply: A.UncheckedReply): Read<A.UncheckedReply, PageEnd> => {
    const page = decodePage(reply);
    return { reply, page: Option.isSome(page) ? Signal.summary(page.value) : null };
  };
  const first: First<A.UncheckedReply, PageEnd> = {
    request,
    answered,
    held: (page) =>
      Schema.decodeUnknownEffect(Signal.AgentPage)(page).pipe(Effect.orDie, Effect.map(toRead)),
  };
  return updatesPlan(input).pipe(
    Effect.flatMap((plan) =>
      hold(connect, authority, input, plan, first, (server, current, reread) =>
        call(server, { tool: U.toolName, input: { ...current, serverId } }, reread).pipe(
          Effect.map(toRead),
        ),
      ),
    ),
  );
};
/** Where an MCP page ends; the reply itself is checked once, at the MCP boundary. */
const decodePage = Schema.decodeUnknownOption(Signal.Page);
const decodeEmptyClaim = Schema.decodeUnknownOption(Signal.EmptyClaim);

const updatesPath = /^\/v1\/servers\/[^/]+\/updates$/;
const claimPath = /^\/v1\/servers\/[^/]+\/participants\/([^/]+)\/tasks\/claim$/;
const decodeInput = Schema.decodeUnknownOption(Schema.fromJsonString(U.Input));
const decodeClaim = Schema.decodeUnknownOption(Schema.fromJsonString(T.ClaimTaskBody));
const decodeParticipant = Schema.decodeUnknownOption(M.ParticipantId);
/** Only what deciding to hold needs; the body itself passes through unchanged. */
const decodeJsonPage = Schema.decodeUnknownOption(Schema.fromJsonString(Signal.Page));
const decodeJsonClaim = Schema.decodeUnknownOption(Schema.fromJsonString(Signal.EmptyClaim));
/** An HTTP read's reply, and its page when it answered with one. */
const httpRead = (text: string, init: ResponseInit): Read<Response, PageEnd> => {
  const page = init.status === 200 ? decodeJsonPage(text) : Option.none();
  return {
    reply: new Response(text, init),
    page: Option.isSome(page) ? Signal.summary(page.value) : null,
  };
};
/** An HTTP claim's reply, held when it claimed nothing. */
const httpClaim = (text: string, init: ResponseInit): Read<Response, Held> => ({
  reply: new Response(text, init),
  page: init.status === 200 && Option.isSome(decodeJsonClaim(text)) ? emptyClaim : null,
});

/**
 * Forward an authenticated HTTP request to its server object. `POST …/updates` with waitSeconds,
 * and `POST …/tasks/claim` for next with next.waitSeconds, are held here like the MCP tools;
 * anything else, including a body the API would refuse, goes straight through. `request` carries
 * the Worker's authority headers and `payload` its body.
 */
export const forward = (
  connect: () => Server,
  authority: Authority,
  request: Request,
  payload: Uint8Array | null,
): Effect.Effect<Response> => {
  const direct = Effect.promise(() => connect().fetch(request));
  // A read (GET, or a get_updates that does not wait) that failed transiently is sent once more,
  // rebuilt from its body, on a fresh stub; twice, and it fails as before (503).
  const read =
    request.method === "GET" ||
    (request.method === "POST" && updatesPath.test(new URL(request.url).pathname))
      ? ReadRetry.twice((fresh) =>
          fresh
            ? Effect.promise(() =>
                connect().fetch(
                  new Request(request.url, {
                    method: request.method,
                    headers: request.headers,
                    body: payload,
                  }),
                ),
              )
            : direct,
        ).pipe(
          Effect.flatMap((retried) =>
            retried.kind === "answered"
              ? Effect.succeed(retried.value)
              : Effect.die(retried.defect),
          ),
        )
      : null;
  const once = read ?? direct;
  if (request.method !== "POST" || payload === null) return once;
  const pathname = new URL(request.url).pathname;
  const claimed = claimPath.exec(pathname);
  if (!updatesPath.test(pathname) && claimed === null) return once;
  const text = new TextDecoder().decode(payload);
  /** One read on `server`: the body given (the caller's own on the first read), and its reply. */
  const send = <P extends Held>(
    server: Server,
    body: string | Uint8Array,
    reread: boolean,
    parse: (text: string, init: ResponseInit) => Read<Response, P>,
  ) => {
    const headers = new Headers(request.headers);
    if (reread) headers.set(Signal.rereadHeader, "1");
    return Effect.promise(async () => {
      const response = await server.fetch(
        new Request(request.url, { method: "POST", headers, body }),
      );
      return parse(await response.text(), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    });
  };
  const first = <P extends Held>(
    parse: (text: string, init: ResponseInit) => Read<Response, P>,
  ): First<Response, P> => ({
    // The first read sends the caller's body unchanged; the server object reads once either way.
    request: () =>
      Schema.encodeSync(Signal.FirstRead)({
        kind: "http",
        url: request.url,
        headers: [...request.headers],
        body: text,
      }),
    answered: (response) =>
      Effect.sync(() => {
        const headers = new Headers(response.headers);
        headers.delete(Signal.answeredHeader);
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }),
    held: (page) =>
      Schema.decodeUnknownEffect(Signal.HttpPage)(page).pipe(
        Effect.orDie,
        Effect.map((held) => parse(held.body, { status: 200, headers: held.headers })),
      ),
  });
  if (claimed !== null) {
    const body = decodeClaim(text);
    const participantId = decodeParticipant(claimed[1]);
    if (Option.isNone(body) || Option.isNone(participantId) || claimWait(body.value) === 0)
      return once;
    // Each re-read sends the same claim: an empty claim is not recorded, so its key claims later.
    return hold(
      connect,
      authority,
      text,
      claimPlan(participantId.value, claimWait(body.value), text),
      first(httpClaim),
      (server, current, reread) => send(server, reread ? current : payload, reread, httpClaim),
    );
  }
  const input = decodeInput(text);
  if (Option.isNone(input) || (input.value.waitSeconds ?? 0) === 0) return once;
  return updatesPlan(input.value).pipe(
    Effect.flatMap((plan) =>
      hold(connect, authority, input.value, plan, first(httpRead), (server, current, reread) =>
        send(server, reread ? JSON.stringify(current) : payload, reread, httpRead),
      ),
    ),
  );
};
