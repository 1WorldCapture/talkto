import { Clock, Context, Effect, Layer, Schema, type Semaphore } from "effect";
import * as M from "@talkto/api/models";
import * as T from "@talkto/api/tasks";
import * as E from "@talkto/api/errors";
import { memoryMetering } from "@talkto/api/pricing";
import type { AccessContext, PrincipalKey } from "../access.js";
import * as Store from "../persistence.js";
import * as Actors from "../actors.js";
import * as Metering from "../metering/model.js";
import * as Reads from "../reads.js";
import * as Signal from "../update-signal.js";
import * as TalkTo from "../talkto.js";
import * as Telemetry from "../telemetry.js";
import * as Files from "./files.js";
import * as Git from "./git.js";
import * as Model from "./model.js";
import type * as MemoryStore from "./store.js";
import * as Template from "./template.js";
import { present } from "../present.js";

/**
 * Swarm memory (docs/swarm-server-spec.md, 14): one Git repository per swarm server, read by claims
 * from a cache of its last good head, and changed by agents with real Git. TalkTo reads `main`'s
 * head at a claim (at most every 30 seconds), when a write token ends, and at its holder's next
 * update_task. Each new commit's one-line message is posted once to the memory channel, as a TalkTo
 * note that is never metered, mentions nobody and wakes nobody. A head that does not contain the
 * last good one (a force push), or a deleted `main`, is put back by TalkTo's own Git writer.
 *
 * Memory has no switch (owner, November 25, 2026): every swarm server whose board is on has it.
 * The first claim, task creation, read, Git grant or context that needs it sets it up (the
 * repository, its seed and the memory channel), once, under this object's lock; a failure leaves
 * the call working without memory, and a later call tries again.
 */

/** What the deployment decides about memory, and the server object's own levers. */
export class Deployment extends Context.Service<
  Deployment,
  {
    /**
     * The board, `TALKTO_MEMORY=on` and a `MEMORY_ARTIFACTS` binding: every swarm server has memory.
     * `TALKTO_MEMORY` is the operator's kill switch for the whole deployment, never a server's.
     */
    readonly offered: boolean;
    /** One head check, provision or sweep at a time on this server object. */
    readonly lock: Semaphore.Semaphore;
    /**
     * The memory repository of another swarm server, when `principalKey` may read it there (a live
     * grant) and it has memory; null otherwise. Used only to fork it.
     */
    readonly source: (
      serverId: M.ServerId,
      principalKey: PrincipalKey,
    ) => Effect.Effect<string | null>;
    /** Keep the alarm no later than `at`, so a write token's end is checked on time. */
    readonly arm: (at: number) => Effect.Effect<void>;
    /** The server's creator, whose person sends the lines no single agent wrote; null if unknown. */
    readonly creator: () => Effect.Effect<PrincipalKey | null>;
  }
>()("@talkto/memory/Deployment") {}
/** Compositions without memory. */
export const absent = (lock: Semaphore.Semaphore) =>
  Deployment.of({
    offered: false,
    lock,
    source: () => Effect.succeed(null),
    arm: () => Effect.void,
    creator: () => Effect.succeed(null),
  });

type Base = E.ServerAccessDenied | E.StorageUnavailable | E.MemoryUnavailable;
type Acting = E.ParticipantNotFound | E.NotAnAgent | E.ParticipantRemoved | E.AgentNotOwned;
/** The memory settings `PUT …/board` changes; memory itself has no switch. */
export interface SettingsInput {
  readonly tokens?: number;
  readonly from?: M.ServerId;
}

export interface Interface {
  readonly offered: boolean;
  /**
   * Create and seed the repository now, for `PUT …/board`: from the template, or a fork of `from`.
   * Idempotent; the server's creator has been checked by the caller.
   */
  readonly provision: (
    access: AccessContext,
    from: M.ServerId | undefined,
  ) => Effect.Effect<void, Base | E.Forbidden | E.InvalidInput>;
  /**
   * Set memory up if it is not yet, on a swarm server whose board is on: the repository from the
   * template, its seed, and the memory channel (created by the creator's person when it is on the
   * server, otherwise by `participantId`'s agent). Never fails: memory that is not ready leaves the
   * caller without it, and the next call tries again. Returns the channel's notice in General, for
   * the caller to announce.
   */
  readonly ensure: (
    access: AccessContext,
    participantId: M.ParticipantId | null,
  ) => Effect.Effect<M.Outcome<M.Created<M.Message>> | null>;
  /**
   * Save the settings inside the caller's transaction, creating the memory channel if it is
   * missing. Null when there is nothing to save (memory not set up yet).
   */
  readonly save: (
    tx: Store.Session,
    access: AccessContext,
    person: M.Participant,
    input: SettingsInput,
    at: number,
  ) => Effect.Effect<
    {
      readonly settings: T.MemorySettings | null;
      readonly changed: boolean;
      readonly notice: M.Outcome<M.Created<M.Message>> | null;
    },
    E.StorageUnavailable
  >;
  /** The stored settings as `PUT …/board` returns them, or null before memory was set up. */
  readonly settings: (
    tx: Store.Session,
  ) => Effect.Effect<T.MemorySettings | null, E.StorageUnavailable>;
  /** What a claim carries, from the cache; null until memory is set up. */
  readonly deliver: (
    tx: Store.Session,
    labels: ReadonlyArray<string>,
  ) => Effect.Effect<T.ClaimMemory | null, E.StorageUnavailable>;
  /** `get_context.board.memory`, present wherever memory is offered (`enabled` is always true). */
  readonly context: (
    tx: Store.Session,
  ) => Effect.Effect<T.ContextBoard["memory"] | null, E.StorageUnavailable>;
  /** Read main's head; `force` skips the 30-second cache. Never fails: delivery keeps the cache. */
  readonly refresh: (force: boolean) => Effect.Effect<void>;
  readonly read: (
    access: AccessContext,
    input: Omit<T.ReadMemory, "serverId">,
  ) => Effect.Effect<M.Outcome<T.MemoryRead>, Base | Acting | E.InvalidInput>;
  readonly access: (
    access: AccessContext,
    input: Omit<T.GetMemoryAccess, "serverId">,
  ) => Effect.Effect<
    M.Outcome<T.MemoryAccess>,
    Base | Acting | E.ClaimLost | E.TaskNotFound | E.RateLimited | E.InvalidInput
  >;
  /**
   * Revoke tokens whose access or claim ended, then read the head if a write token ended. Returns
   * how many revocations are still owed. Never fails.
   */
  readonly sweep: () => Effect.Effect<number>;
  /** After an update_task: sweep, and read the head now if the participant writes memory. */
  readonly afterUpdate: (participantId: M.ParticipantId) => Effect.Effect<void>;
  /** When a write token next ends, for the alarm; null when none is live. */
  readonly nextDue: () => Effect.Effect<number | null, E.StorageUnavailable>;
}
export class Memory extends Context.Service<Memory, Interface>()("@talkto/memory/Memory") {}

const iso = (at: number) => M.Timestamp.make(new Date(at).toISOString());
const short = (hash: string) => hash.slice(0, 7);
const memoryChannelKey = M.RequestKey.make("talkto.memory-channel");
const channelDescription =
  "Memory change notes: TalkTo posts the one-line message of each new commit to this server's swarm memory. No reply needed; nothing here wakes anyone.";
const isPath = Schema.is(T.MemoryPath);
const decoder = new TextDecoder();
/** Commits one head check walks to find the last good head; past it the new head is accepted. */
const walkLimit = 200;

const unavailable = (operation: string, reason: "off" | "absent" | "failed", message?: string) =>
  new E.MemoryUnavailable({
    operation,
    reason,
    message:
      message ??
      (reason === "off"
        ? "Swarm memory comes with the task board, which is off on this server."
        : reason === "absent"
          ? "Swarm memory is not available on this TalkTo deployment."
          : "TalkTo could not reach this server's memory just now. Retry in a minute; claims still carry the last memory TalkTo read."),
  });
/**
 * A failed store call as `memory_unavailable`, after logging and reporting the store's own code,
 * status and message (already cut by `safeDetail`) with the step that made it. Tokens never reach
 * a failure, so none can reach a log.
 */
const reportStore = (step: string, error: Model.Failure) =>
  error._tag === "MemoryStoreUnavailable"
    ? Effect.void
    : Effect.logError("Swarm memory store call failed", {
        step,
        operation: error.operation,
        code: error.code,
        status: error.status ?? null,
        detail: error.detail ?? null,
      }).pipe(Effect.andThen(Effect.sync(() => Telemetry.memoryStore(step, error))));
const storeFailure = (step: string) => (error: Model.Failure) =>
  reportStore(step, error).pipe(
    Effect.andThen(
      Effect.fail(unavailable(step, error._tag === "MemoryStoreUnavailable" ? "absent" : "failed")),
    ),
  );
/** Run a store call for `step`, failing as `memory_unavailable` once its failure is reported. */
const atStep =
  (step: string) =>
  <A, R>(effect: Effect.Effect<A, Model.Failure, R>) =>
    effect.pipe(Effect.catch(storeFailure(step)));
const gitHeader = (token: string) => `git -c http.extraHeader="Authorization: Bearer ${token}"`;

export const layer = Layer.effect(
  Memory,
  Effect.gen(function* () {
    const persistence = yield* Store.Persistence;
    const ownership = yield* Actors.AgentOwnership;
    const ids = yield* TalkTo.Identifiers;
    const meter = yield* Metering.Meter;
    const signal = yield* Signal.UpdateSignal;
    const reads = yield* Reads.Reads;
    const repos = yield* Model.Repositories;
    const deployment = yield* Deployment;
    const offered = deployment.offered && repos.available;

    const transaction = <A, F>(
      operation: string,
      body: (tx: Store.Session) => Effect.Effect<A, F>,
    ) =>
      persistence
        .transaction(operation, body)
        .pipe(
          Effect.provideService(Actors.AgentOwnership, ownership),
          Effect.provideService(Actors.Operation, operation),
        );
    /** A transaction for one caller: its grant must still be live on this server. */
    const run = <A, F>(
      access: AccessContext,
      operation: string,
      body: (tx: Store.Session) => Effect.Effect<A, F>,
    ) =>
      transaction(operation, (tx) =>
        Effect.gen(function* () {
          const serverId = yield* tx.serverIdentity();
          const grant = yield* tx.grant(access.grantId);
          if (
            serverId !== access.serverId ||
            grant === null ||
            grant.principalKey !== access.principalKey ||
            grant.revokedAt !== null
          )
            return yield* new E.ServerAccessDenied({ message: "The server is unavailable." });
          return yield* body(tx);
        }),
      );
    /**
     * The repository once memory is set up on a board that is on, or `memory_unavailable`: `off`
     * with the board, `failed` while TalkTo could not set it up yet. A switch-off stored before
     * memory was always on is ignored.
     */
    const requireOn = Effect.fn("Memory.requireOn")(function* (
      tx: Store.Session,
      operation: string,
    ) {
      if (!offered) return yield* unavailable(operation, "absent");
      const board = yield* tx.board.settings();
      if (board === null || !board.enabled) return yield* unavailable(operation, "off");
      const row = yield* tx.memory.repository();
      if (row === null || !row.seeded) return yield* unavailable(operation, "failed");
      return row;
    });
    const settingsOf = (row: MemoryStore.RepositoryRow): T.MemorySettings => ({
      tokens: M.Count.make(row.tokens),
      ...present("channelId", row.channelId),
      ...present("version", row.goodHead === null ? null : T.MemoryVersion.make(row.goodHead)),
    });

    /**
     * The Markdown files of a tree, reusing the cached text of every blob that did not change.
     * Files past `maxMemoryFileBytes`, past `maxMemoryFiles`, or with paths read_memory cannot name
     * stay only in Git.
     */
    const load = Effect.fn("Memory.load")(function* (
      name: string,
      remote: string,
      tree: string,
      cached: ReadonlyArray<MemoryStore.FileRow>,
    ) {
      const known = new Map(cached.map((file) => [`${file.path} ${file.blob}`, file]));
      const files: MemoryStore.FileRow[] = [];
      const visit = Effect.fnUntraced(function* (
        hash: string,
        prefix: string,
        depth: number,
      ): Effect.fn.Return<void, Model.Failure> {
        const entries = (yield* repos.tree(name, hash)) ?? [];
        for (const entry of entries.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
          if (files.length >= T.maxMemoryFiles) return;
          const path = `${prefix}${entry.name}`;
          if (entry.kind === "tree" && depth < 4) yield* visit(entry.hash, `${path}/`, depth + 1);
          if (entry.kind !== "blob" || !isPath(path)) continue;
          const reused = known.get(`${path} ${entry.hash}`);
          if (reused !== undefined) {
            files.push(reused);
            continue;
          }
          const body = yield* repos.blob(name, remote, entry.hash);
          if (body === null || body.byteLength > T.maxMemoryFileBytes) continue;
          const text = decoder.decode(body);
          files.push({
            path,
            blob: entry.hash,
            text,
            bytes: body.byteLength,
            labels: Files.frontMatterLabels(text),
          });
        }
      });
      yield* visit(tree, "", 0);
      return files;
    });

    /**
     * The agent that wrote what a head check found: the one participant holding a write token
     * that could have pushed since the last check (live, or ended with no head read since), with
     * the grant it asked through. Null when none or several did, or that agent is gone.
     */
    const authorOf = Effect.fn("Memory.authorOf")(function* (tx: Store.Session, at: number) {
      const tokens = [...(yield* tx.memory.liveWrites(at)), ...(yield* tx.memory.unsettled(at))];
      const writers = new Set(tokens.map((token) => token.participantId));
      const token = tokens.at(-1);
      if (writers.size !== 1 || token === undefined) return null;
      const agent = yield* tx.participant(token.participantId);
      if (agent === null || agent.kind === "person" || agent.removedAt !== undefined) return null;
      return { participant: agent, grantId: token.grantId };
    });

    /**
     * Who sends a line no single agent wrote, and every restore line, so every line is posted:
     * the server creator's person (the poster) when it is on the server; otherwise the agent that
     * created the memory channel; when that agent was removed, the earliest-joined agent still on
     * the server. Never a person TalkTo would have to create.
     */
    const fallbackSender = Effect.fn("Memory.fallbackSender")(function* (
      tx: Store.Session,
      row: MemoryStore.RepositoryRow,
      channel: M.Channel,
    ) {
      if (row.posterId !== null && row.posterGrantId !== null) {
        const person = yield* tx.participant(row.posterId);
        if (person !== null) return { participant: person, grantId: row.posterGrantId };
      }
      const maker =
        channel.createdByParticipantId === null
          ? null
          : yield* tx.memory.agent(channel.createdByParticipantId);
      const agent = maker ?? (yield* tx.memory.firstAgent());
      if (agent === null) return null;
      const participant = yield* tx.participant(agent.participantId);
      return participant === null ? null : { participant, grantId: agent.grantId };
    });

    /**
     * Post one line to the memory channel: as `author` (the agent whose commit it reports) when
     * given, otherwise as `fallbackSender` says, as for TalkTo's channel notices.
     * Never metered, no mentions, never a wake: readers waiting on the channel see it, and
     * nothing else is told.
     */
    const post = Effect.fn("Memory.post")(function* (
      tx: Store.Session,
      row: MemoryStore.RepositoryRow,
      body: string,
      requestKey: M.RequestKey,
      at: number,
      author: { readonly participant: M.Participant; readonly grantId: M.GrantId } | null = null,
    ) {
      if (row.channelId === null) return null;
      const channel = yield* tx.conversation(row.channelId);
      if (channel?.kind !== "channel" || channel.archivedAt !== null) return null;
      const from = author ?? (yield* fallbackSender(tx, row, channel));
      if (from === null) return null;
      const sender = from.participant;
      const grantId = from.grantId;
      const prior = yield* tx.latestMessage();
      const createdAt =
        [iso(at), channel.createdAt, sender.createdAt, prior?.createdAt ?? iso(at)]
          .toSorted()
          .at(-1) ?? iso(at);
      const appended = yield* tx.append({
        id: M.MessageId.make(yield* ids.uuid()),
        conversationId: channel.id,
        senderId: sender.id,
        body: M.MessageBody.make(body),
        createdAt,
        grantId,
        requestKey,
      });
      return appended;
    });
    /**
     * Record the server creator's person as the poster when it is not yet and the creator has a
     * participant on this server; the creator is asked of the platform only then.
     */
    const ensurePoster = Effect.fn("Memory.ensurePoster")(function* () {
      const row = yield* transaction("memory.poster", (tx) => tx.memory.repository());
      if (row === null || row.posterId !== null) return;
      const creator = yield* deployment.creator();
      if (creator === null) return;
      yield* transaction("memory.poster", (tx) =>
        Effect.gen(function* () {
          const person = yield* tx.memory.person(creator);
          if (person !== null)
            yield* tx.memory.setPoster({
              posterId: person.participantId,
              posterGrantId: person.grantId,
            });
        }),
      );
    });
    /**
     * Create the memory channel once memory is seeded and has none: by the poster (the creator's
     * person) when there is one, otherwise by `actor`; with neither it waits for a later call.
     * Inside one transaction, so two first calls never make two channels. Returns the notice.
     */
    const openChannel = Effect.fn("Memory.openChannel")(function* (
      tx: Store.Session,
      access: AccessContext,
      actor: M.Participant | null,
      at: number,
    ) {
      const row = yield* tx.memory.repository();
      if (row === null || !row.seeded || row.channelId !== null) return null;
      const poster =
        row.posterId === null || row.posterGrantId === null
          ? null
          : yield* tx.participant(row.posterId);
      const by =
        poster !== null && row.posterGrantId !== null
          ? { participant: poster, grantId: row.posterGrantId }
          : actor === null
            ? null
            : { participant: actor, grantId: access.grantId };
      if (by === null) return null;
      let n = 1;
      let channelName = M.Name.make("memory");
      while ((yield* tx.channelNamed(channelName)) !== null) {
        n += 1;
        channelName = M.Name.make(`memory-${n}`);
      }
      const channel = M.Channel.make({
        kind: "channel",
        id: M.ConversationId.make(yield* ids.uuid()),
        name: channelName,
        description: M.ChannelDescription.make(channelDescription),
        isGeneral: false,
        createdByParticipantId: by.participant.id,
        createdAt: [iso(at), by.participant.createdAt].toSorted().at(-1) ?? iso(at),
        archivedAt: null,
        revision: 0,
        messageCount: 0,
        lastMessageAt: null,
        latestMessage: null,
      });
      yield* tx.addChannel({ item: channel, grantId: by.grantId, requestKey: memoryChannelKey });
      yield* tx.memory.setChannel(channel.id);
      return yield* TalkTo.channelNotice(
        tx,
        { ...access, grantId: by.grantId },
        channel,
        by.participant,
        M.MessageId.make(yield* ids.uuid()),
      );
    });
    const notify = (messages: ReadonlyArray<M.Message>) =>
      Effect.forEach(messages, (message) =>
        signal.notify({
          conversationId: message.conversationId,
          senderId: message.senderId,
          directParticipantIds: [],
          mentionedIds: [],
        }),
      );

    /** Post one commit once, metered as `commitMessages` messages when the organization has them. */
    const record = Effect.fn("Memory.record")(function* (commit: Model.Commit, at: number) {
      const subject = Files.subjectOf(commit.message);
      const write = (metered: boolean) =>
        transaction("memory.record", (tx) =>
          Effect.gen(function* () {
            if (yield* tx.memory.commitKnown(commit.hash)) return null;
            const row = yield* tx.memory.repository();
            if (row === null) return null;
            const usageId = metered ? Metering.MemoryUsageId.make(yield* ids.uuid()) : null;
            if (usageId !== null && memoryMetering.commitMessages > 0)
              yield* meter.consume(
                usageId,
                Metering.Units.make(memoryMetering.commitMessages),
                "message",
              );
            const message = yield* post(
              tx,
              row,
              subject,
              M.RequestKey.make(`talkto.memory:${commit.hash}`),
              at,
              yield* authorOf(tx, at),
            );
            yield* tx.memory.addCommit({
              hash: commit.hash,
              subject,
              messageId: message?.id ?? null,
              usageId,
              metered: usageId !== null,
              foundAt: at,
            });
            return message;
          }),
        );
      const units = Metering.Units.make(Math.max(1, memoryMetering.commitMessages));
      // The commit has landed: past the organization's messages it is still posted, unmetered.
      const message = yield* Metering.withCapacity(
        meter,
        units,
      )(write(true)).pipe(
        Effect.catchTags({
          MessageAllowanceExhausted: () => write(false),
          MessagePaymentRequired: () => write(false),
          SendingUnavailable: () => write(false),
        }),
      );
      if (message !== null) yield* notify([message]);
    });

    /** Accept `head` as the good head with its files, if no other check moved it meanwhile. */
    const accept = Effect.fn("Memory.accept")(function* (
      row: MemoryStore.RepositoryRow,
      head: Model.Commit,
      at: number,
    ) {
      const cached = yield* transaction("memory.cached", (tx) => tx.memory.files());
      const files = yield* load(row.name, row.remote, head.tree, cached);
      return yield* transaction("memory.accept", (tx) =>
        tx.memory.setHead({ expected: row.goodHead, head: head.hash, files, at }),
      );
    });

    /**
     * The safety net: put main back at the good head, say so in one line, and revoke the write
     * token that did it when exactly one was live. When the good commit is gone from the store, a
     * new commit with the cached files takes its place.
     */
    const restore = Effect.fn("Memory.restore")(function* (
      row: MemoryStore.RepositoryRow,
      good: string,
      current: Model.Commit | null,
      at: number,
    ) {
      const old = current?.hash ?? Model.zeroHash;
      const kept = yield* repos.commit(row.name, good);
      let target = good;
      let report: string;
      if (kept !== null) {
        report = yield* repos.push(
          row.name,
          row.remote,
          yield* Git.receivePack({ old, next: good, objects: [] }),
        );
      } else {
        const cached = yield* transaction("memory.cached", (tx) => tx.memory.files());
        const built = yield* Git.tree(cached.map((file) => ({ path: file.path, text: file.text })));
        if (built.root === null) return;
        const made = yield* Git.commit({
          tree: built.root,
          parents: current === null ? [] : [current.hash],
          message: `Restore swarm memory to ${short(good)}`,
          at,
        });
        target = made.id;
        report = yield* repos.push(
          row.name,
          row.remote,
          yield* Git.receivePack({ old, next: made.id, objects: [...built.objects, made] }),
        );
      }
      if (!Git.accepted(report)) {
        yield* Effect.logWarning("Swarm memory could not restore main", { repository: row.name });
        return;
      }
      const live = yield* transaction("memory.writers", (tx) => tx.memory.liveWrites(at));
      const culprit = live.length === 1 ? live[0] : undefined;
      if (culprit !== undefined) {
        yield* repos.revoke(row.name, culprit.tokenId).pipe(Effect.ignore);
        yield* transaction("memory.revoke", (tx) => tx.memory.markRevoked(culprit.id, at));
      }
      const why =
        current === null
          ? "main was deleted"
          : `main was replaced by ${short(current.hash)}, which does not contain ${short(good)} (a force push)`;
      const line = `TalkTo restored memory: ${why}. main is back at ${short(target)}${
        culprit === undefined ? "" : "; the write token that could do it is revoked"
      }. Pull before you push again.`;
      const message = yield* transaction("memory.restored", (tx) =>
        Effect.gen(function* () {
          const fresh = yield* tx.memory.repository();
          if (fresh === null) return null;
          if (target !== good) {
            const files = yield* tx.memory.files();
            yield* tx.memory.setHead({ expected: good, head: target, files, at });
            yield* tx.memory.addCommit({
              hash: target,
              subject: `Restore swarm memory to ${short(good)}`,
              messageId: null,
              usageId: null,
              metered: false,
              foundAt: at,
            });
          } else yield* tx.memory.setChecked(at);
          return yield* post(
            tx,
            fresh,
            line,
            M.RequestKey.make(`talkto.memory-restore:${yield* ids.uuid()}`),
            at,
          );
        }),
      );
      if (message !== null) yield* notify([message]);
    });

    /** The commits of `head` that the good head does not contain, oldest first, or null if none is it. */
    const newCommits = Effect.fn("Memory.newCommits")(function* (
      name: string,
      head: Model.Commit,
      good: string,
    ) {
      const found = new Map<string, Model.Commit>();
      let reached = false;
      const stack: Model.Commit[] = [head];
      while (stack.length > 0 && found.size < walkLimit) {
        const next = stack.pop();
        if (next === undefined || found.has(next.hash)) continue;
        if (next.hash === good) {
          reached = true;
          continue;
        }
        // A commit posted before needs no walk below it: the good head's history is there.
        const known = yield* transaction("memory.known", (tx) => tx.memory.commitKnown(next.hash));
        if (known) continue;
        found.set(next.hash, next);
        for (const parent of next.parents) {
          if (parent === good) {
            reached = true;
            continue;
          }
          if (found.has(parent)) continue;
          const commit = yield* repos.commit(name, parent);
          if (commit !== null) stack.push(commit);
        }
      }
      // Parents before children: a depth-first walk that emits each commit after its parents.
      const ordered: Model.Commit[] = [];
      const placed = new Set<string>();
      const place = (commit: Model.Commit) => {
        if (placed.has(commit.hash)) return;
        placed.add(commit.hash);
        for (const parent of commit.parents) {
          const inside = found.get(parent);
          if (inside !== undefined) place(inside);
        }
        ordered.push(commit);
      };
      place(head);
      for (const commit of found.values()) place(commit);
      const truncated = found.size >= walkLimit;
      return reached || truncated ? ordered : null;
    });

    const check = Effect.fn("Memory.check")(function* (force: boolean) {
      if (!offered) return;
      const at = yield* Clock.currentTimeMillis;
      const row = yield* transaction("memory.repository", (tx) => tx.memory.repository());
      if (row === null || !row.seeded) return;
      if (!force && at - row.checkedAt < T.memoryHeadSeconds * 1000) return;
      const head = yield* repos.head(row.name);
      if (row.goodHead === null) {
        if (head !== null) yield* accept(row, head, at);
        return;
      }
      if (head?.hash === row.goodHead) {
        yield* transaction("memory.checked", (tx) => tx.memory.setChecked(at));
        return;
      }
      // Whatever this check posts may be sent by the creator's person: find it first.
      yield* ensurePoster();
      if (head === null) return yield* restore(row, row.goodHead, null, at);
      const commits = yield* newCommits(row.name, head, row.goodHead);
      if (commits === null) return yield* restore(row, row.goodHead, head, at);
      // The organization's edits this month: counted once per check; past the number, read-only.
      const fresh = [];
      for (const commit of commits)
        if (!(yield* transaction("memory.known", (tx) => tx.memory.commitKnown(commit.hash))))
          fresh.push(commit);
      const { capped } = yield* reads.memoryCommits(fresh.length);
      if (capped) {
        const usage = yield* reads.memoryUsage();
        const until = usage === null ? at + 3_600_000 : Date.parse(usage.resetsAt);
        yield* transaction("memory.capped", (tx) => tx.memory.setCapped(until));
      }
      for (const commit of fresh) yield* record(commit, at);
      yield* accept(row, head, at);
    });
    const refresh: Interface["refresh"] = (force) =>
      deployment.lock
        .withPermits(1)(check(force))
        .pipe(
          Effect.tapError((error) =>
            error._tag === "MemoryStoreFailure" ? reportStore("head_check", error) : Effect.void,
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Swarm memory could not read its repository", { cause }),
          ),
        );

    /** Create (or fork) and seed the repository, then read its first head. Run under the lock. */
    const setup = Effect.fn("Memory.setup")(function* (
      access: AccessContext,
      from: M.ServerId | undefined,
    ) {
      const at = yield* Clock.currentTimeMillis;
      const name = Model.repositoryName(access.serverId);
      yield* Effect.gen(function* () {
        const existing = yield* run(access, "memory.provision", (tx) => tx.memory.repository());
        if (existing !== null && from !== undefined && existing.sourceServerId !== from)
          return yield* new E.InvalidInput({
            message:
              "This server already has memory. memory.from only starts a new memory; edit this one with Git instead.",
          });
        let row = existing;
        if (row === null) {
          if (from === access.serverId)
            return yield* new E.InvalidInput({
              message: "memory.from must name another server.",
            });
          const source =
            from === undefined ? null : yield* deployment.source(from, access.principalKey);
          if (from !== undefined && source === null)
            return yield* new E.Forbidden({
              message:
                "You cannot copy that server's memory: it has none, or you are not a member of it.",
            });
          const make = () => (source === null ? repos.create(name) : repos.fork(source, name));
          // A repository left by an attempt that failed before it was recorded held no one's work.
          const created = yield* make().pipe(
            Effect.catchIf(
              (error) => error._tag === "MemoryStoreFailure" && error.code === "ALREADY_EXISTS",
              () => repos.remove(name).pipe(Effect.flatMap(make)),
            ),
            atStep(source === null ? "create_repository" : "fork_repository"),
          );
          yield* run(access, "memory.created", (tx) =>
            tx.memory.createRepository({
              name,
              remote: created.remote,
              sourceServerId: from ?? null,
              tokens: T.defaultMemoryTokens,
              seeded: source !== null,
              at,
            }),
          );
          row = yield* run(access, "memory.provision", (tx) => tx.memory.repository());
          if (row === null) return yield* Effect.die("The memory repository was not recorded");
        }
        if (!row.seeded) {
          const head = yield* repos.head(name).pipe(atStep("seed_read_head"));
          if (head === null) {
            const built = yield* Git.tree(Template.files);
            if (built.root === null) return yield* Effect.die("The memory template is empty");
            const made = yield* Git.commit({
              tree: built.root,
              parents: [],
              message: Template.message,
              at,
            });
            const report = yield* repos
              .push(
                name,
                row.remote,
                yield* Git.receivePack({
                  old: Model.zeroHash,
                  next: made.id,
                  objects: [...built.objects, made],
                }),
              )
              .pipe(atStep("seed_push"));
            if (!Git.accepted(report)) {
              yield* reportStore(
                "seed_push",
                new Model.MemoryStoreFailure({
                  message: "The memory store did not move main to the seed commit.",
                  operation: "receivePack",
                  code: "REFUSED",
                  detail: Model.safeDetail(report),
                }),
              );
              return yield* unavailable("seed_push", "failed");
            }
          }
          yield* run(access, "memory.seeded", (tx) => tx.memory.setSeeded());
        }
        const current = yield* run(access, "memory.provision", (tx) => tx.memory.repository());
        if (current !== null && current.goodHead === null) {
          const head = yield* repos.head(name).pipe(atStep("first_read_head"));
          if (head !== null) {
            yield* accept(current, head, at).pipe(
              Effect.catchTags({
                MemoryStoreUnavailable: storeFailure("first_read_files"),
                MemoryStoreFailure: storeFailure("first_read_files"),
              }),
            );
            // Its own first commit (or the fork's history) is memory's start, never a change note.
            yield* run(access, "memory.start", (tx) =>
              tx.memory.addCommit({
                hash: head.hash,
                subject: Files.subjectOf(head.message),
                messageId: null,
                usageId: null,
                metered: false,
                foundAt: at,
              }),
            );
          }
        }
      });
    });
    const provision: Interface["provision"] = Effect.fn("Memory.provision")(
      function* (access, from) {
        if (!offered) return yield* unavailable("provision", "absent");
        return yield* deployment.lock.withPermits(1)(setup(access, from));
      },
    );
    /**
     * Setups that failed on this object. A call that waited on the lock while one failed does not
     * try again at once: calls queued behind a failing store go on without memory, and the next
     * call after them retries.
     */
    let failures = 0;
    const ensure: Interface["ensure"] = Effect.fn("Memory.ensure")(
      function* (access, participantId) {
        if (!offered) return null;
        const state = yield* run(access, "memory.state", (tx) =>
          Effect.gen(function* () {
            const board = yield* tx.board.settings();
            return { on: board?.enabled === true, row: yield* tx.memory.repository() };
          }),
        );
        if (!state.on) return null;
        const row = state.row;
        if (row !== null && row.seeded && row.goodHead !== null && row.channelId !== null)
          return null;
        if (row === null || !row.seeded || row.goodHead === null) {
          const before = failures;
          yield* deployment.lock
            .withPermits(1)(
              Effect.suspend(() => (failures === before ? setup(access, undefined) : Effect.void)),
            )
            .pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => {
                  failures += 1;
                }).pipe(
                  Effect.andThen(
                    Effect.logWarning("Swarm memory could not be set up yet", { cause }),
                  ),
                ),
              ),
            );
        }
        yield* ensurePoster();
        const at = yield* Clock.currentTimeMillis;
        return yield* run(access, "memory.channel", (tx) =>
          Effect.gen(function* () {
            const actor =
              participantId === null
                ? null
                : yield* Actors.requireOwnAgent(tx, access, participantId).pipe(
                    Effect.catchTags({
                      ParticipantNotFound: () => Effect.succeed(null),
                      NotAnAgent: () => Effect.succeed(null),
                      ParticipantRemoved: () => Effect.succeed(null),
                      AgentNotOwned: () => Effect.succeed(null),
                    }),
                  );
            return yield* openChannel(tx, access, actor, at);
          }),
        );
      },
      Effect.catchCause((cause) =>
        Effect.logWarning("Swarm memory could not be set up yet", { cause }).pipe(Effect.as(null)),
      ),
    );

    const save: Interface["save"] = Effect.fn("Memory.save")(
      function* (tx, access, person, input, at) {
        const row = offered ? yield* tx.memory.repository() : null;
        if (row === null) return { settings: null, changed: false, notice: null };
        const tokens = input.tokens ?? row.tokens;
        const changed = tokens !== row.tokens;
        if (changed) yield* tx.memory.setSettings({ tokens, changedBy: person.id, at });
        // The caller is the server's creator: their person sends the lines no single agent wrote.
        if (row.posterId === null)
          yield* tx.memory.setPoster({ posterId: person.id, posterGrantId: access.grantId });
        const notice = yield* openChannel(tx, access, person, at);
        const saved = yield* tx.memory.repository();
        return {
          settings: saved === null ? null : settingsOf(saved),
          changed: changed || notice !== null,
          notice,
        };
      },
    );
    const settings: Interface["settings"] = Effect.fn("Memory.settings")(function* (tx) {
      if (!offered) return null;
      const row = yield* tx.memory.repository();
      return row === null ? null : settingsOf(row);
    });
    const deliver: Interface["deliver"] = Effect.fn("Memory.deliver")(function* (tx, labels) {
      if (!offered) return null;
      const row = yield* tx.memory.repository();
      if (row === null || row.goodHead === null) return null;
      return Files.deliver({
        files: yield* tx.memory.files(),
        labels,
        budget: row.tokens,
        version: T.MemoryVersion.make(row.goodHead),
      });
    });
    const context: Interface["context"] = Effect.fn("Memory.context")(function* (tx) {
      if (!offered) return null;
      const row = yield* tx.memory.repository();
      const files = row === null ? [] : yield* tx.memory.files();
      return {
        // Always true: memory has no switch. Kept for sessions holding older output schemas.
        enabled: true,
        files: M.Count.make(files.length),
        ...present(
          "version",
          row === null || row.goodHead === null ? null : T.MemoryVersion.make(row.goodHead),
        ),
        ...present("channelId", row?.channelId ?? null),
      };
    });

    const read: Interface["read"] = Effect.fn("Memory.read")(function* (access, input) {
      yield* refresh(false);
      return yield* run(access, "memory.read", (tx) =>
        Effect.gen(function* () {
          yield* Actors.requireAgent(tx, input.participantId);
          const row = yield* requireOn(tx, "read_memory");
          if (row.goodHead === null) return yield* unavailable("read_memory", "failed");
          const version = T.MemoryVersion.make(row.goodHead);
          const files = yield* tx.memory.files();
          const path = input.path ?? T.memoryRoot;
          const file = files.find((item) => item.path === path);
          if (file === undefined && input.path !== undefined)
            return yield* new E.InvalidInput({
              message: `Memory has no file ${input.path} that TalkTo serves. read_memory without path lists the files; larger ones are only in Git (get_memory_access).`,
            });
          // Without a path, the root and the listing of every file TalkTo serves.
          const listing =
            input.path === undefined
              ? files.map((item) => ({
                  path: item.path,
                  bytes: M.Count.make(item.bytes),
                  labels: [...item.labels],
                }))
              : null;
          return {
            data: { path, text: file?.text ?? "", version, ...present("files", listing) },
            included: { participants: [], conversations: [] },
          } satisfies M.Outcome<T.MemoryRead>;
        }),
      );
    });

    const access: Interface["access"] = Effect.fn("Memory.access")(function* (caller, input) {
      const at = yield* Clock.currentTimeMillis;
      const scope = input.write === undefined ? "read" : "write";
      const usage = scope === "write" ? yield* reads.memoryUsage() : null;
      const planned = yield* run(caller, "memory.access", (tx) =>
        Effect.gen(function* () {
          const agent = yield* Actors.requireOwnAgent(tx, caller, input.participantId);
          const row = yield* requireOn(tx, "get_memory_access");
          const limit = memoryMetering.grantsPerHour[scope];
          const recent = yield* tx.memory.grantsSince(agent.id, scope, at - 3_600_000);
          const oldest = recent[0];
          if (recent.length >= limit && oldest !== undefined)
            return yield* new E.RateLimited({
              retryable: true,
              action: "retry_after",
              retryAfterSeconds: Math.min(
                3600,
                Math.max(1, Math.ceil((oldest + 3_600_000 - at) / 1000)),
              ),
              scope: "participant",
              message: `Too many memory tokens: an agent gets ${limit} ${scope} tokens an hour. Reuse the one you have until it expires; claim_task and read_memory deliver memory without Git.`,
            });
          let seconds = T.memoryAccessSeconds;
          let claim: { readonly taskId: string; readonly epoch: number } | null = null;
          if (input.write !== undefined) {
            const write = input.write;
            const task = yield* tx.board.task(write.taskId);
            if (task === null)
              return yield* new E.TaskNotFound({
                message: "No task with this ID exists on this server. List tasks with read_tasks.",
              });
            const held =
              task.state === "claimed" &&
              task.claimerId === agent.id &&
              task.leaseEpoch === write.epoch &&
              task.leaseToken === write.leaseToken &&
              task.leaseExpiresAt !== null &&
              task.leaseExpiresAt > at;
            if (!held || task.leaseExpiresAt === null)
              return yield* new E.ClaimLost({
                message:
                  "You do not hold this claim, so you get no write token for memory. Read-only access needs no write field.",
                state: task.state,
                epoch: task.leaseEpoch,
                ...present("holderId", task.state === "claimed" ? task.claimerId : null),
              });
            const capped = row.cappedUntil > at || (usage !== null && usage.used >= usage.limit);
            if (capped)
              return yield* new E.RateLimited({
                retryable: true,
                action: "retry_after",
                retryAfterSeconds: Math.min(
                  3600,
                  Math.max(
                    1,
                    Math.ceil(
                      ((usage === null ? row.cappedUntil : Date.parse(usage.resetsAt)) - at) / 1000,
                    ),
                  ),
                ),
                scope: "organization",
                message:
                  "The organization's memory edits for this month are spent, so memory is read-only until the month resets. Read it with read_memory or a read token; note what you learned in the task's result instead.",
              });
            seconds = Math.min(seconds, Math.floor((task.leaseExpiresAt - at) / 1000));
            if (seconds < T.memoryMinimumTokenSeconds)
              return yield* new E.InvalidInput({
                message: `Your lease ends in ${Math.max(0, seconds)} seconds, too soon for a write token. Renew it with update_task (action progress), then ask again.`,
              });
            claim = { taskId: task.id, epoch: task.leaseEpoch };
          }
          return { row, agent, seconds, claim };
        }),
      );
      const credential = yield* repos
        .mint(planned.row.name, scope, Model.TtlSeconds.make(planned.seconds))
        .pipe(atStep("get_memory_access"));
      const recordId = yield* ids.uuid();
      const recorded = yield* run(caller, "memory.granted", (tx) =>
        tx.memory
          .addToken({
            id: recordId,
            tokenId: credential.id,
            participantId: planned.agent.id,
            grantId: caller.grantId,
            scope,
            taskId: planned.claim?.taskId ?? null,
            epoch: planned.claim?.epoch ?? null,
            issuedAt: at,
            expiresAt: credential.expiresAt,
            revokedAt: null,
            settledAt: scope === "read" ? at : null,
          })
          .pipe(Effect.flatMap(() => Effect.succeed(true))),
      ).pipe(
        // A token TalkTo could not record must not stay live: revoke it before failing.
        Effect.tapError(() => repos.revoke(planned.row.name, credential.id).pipe(Effect.ignore)),
      );
      if (recorded && scope === "write") yield* deployment.arm(credential.expiresAt);
      const header = gitHeader(credential.token);
      const remote = planned.row.remote;
      return {
        data: {
          remote,
          token: credential.token,
          scope,
          expiresAt: iso(credential.expiresAt),
          ...present(
            "version",
            planned.row.goodHead === null ? null : T.MemoryVersion.make(planned.row.goodHead),
          ),
          commands: {
            clone: `${header} clone ${remote} swarm-memory`,
            pull: `${header} pull --rebase ${remote} main`,
            ...present("push", scope === "write" ? `${header} push ${remote} HEAD:main` : null),
          },
          note:
            scope === "write"
              ? `Run clone once, then pull and push inside swarm-memory. Pull before you push; if the push is rejected (non-fast-forward), pull again and push. One clear one-line commit message saying why. The token works until ${iso(credential.expiresAt)} and ends with your claim. Never write it into a file, a remote URL or a message.`
              : `Run clone once, then pull inside swarm-memory to update. The token reads only and works until ${iso(credential.expiresAt)}. Never write it into a file, a remote URL or a message.`,
        },
        included: { participants: [], conversations: [] },
      } satisfies M.Outcome<T.MemoryAccess>;
    });

    const sweepOnce = Effect.fn("Memory.sweepOnce")(function* () {
      if (!offered) return 0;
      const at = yield* Clock.currentTimeMillis;
      const row = yield* transaction("memory.repository", (tx) => tx.memory.repository());
      if (row === null) return 0;
      const due = yield* transaction("memory.revocable", (tx) =>
        tx.memory.revocable(at, row.cappedUntil > at),
      );
      let pending = 0;
      for (const token of due) {
        const revoked = yield* repos.revoke(row.name, token.tokenId).pipe(Effect.result);
        if (revoked._tag === "Failure") {
          pending += 1;
          continue;
        }
        yield* transaction("memory.revoke", (tx) => tx.memory.markRevoked(token.id, at));
      }
      // A write token that can no longer push: read the head once, after it ended.
      const ended = yield* transaction("memory.unsettled", (tx) => tx.memory.unsettled(at));
      if (ended.length > 0) {
        yield* refresh(true);
        yield* transaction("memory.settled", (tx) =>
          tx.memory.markSettled(
            ended.map((token) => token.id),
            at,
          ),
        );
      }
      return pending;
    });
    const sweep: Interface["sweep"] = () =>
      sweepOnce().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Swarm memory could not sweep its tokens", { cause }).pipe(
            Effect.as(1),
          ),
        ),
      );
    const afterUpdate: Interface["afterUpdate"] = Effect.fn("Memory.afterUpdate")(
      function* (participantId) {
        if (!offered) return;
        yield* sweep();
        const writing = yield* transaction("memory.writing", (tx) =>
          tx.memory.writing(participantId),
        ).pipe(Effect.orElseSucceed(() => false));
        if (writing) yield* refresh(true);
      },
    );
    const nextDue: Interface["nextDue"] = Effect.fn("Memory.nextDue")(function* () {
      if (!offered) return null;
      return yield* transaction("memory.nextDue", (tx) => tx.memory.nextExpiry());
    });

    return Memory.of({
      offered,
      provision,
      ensure,
      save,
      settings,
      deliver,
      context,
      refresh,
      read,
      access,
      sweep,
      afterUpdate,
      nextDue,
    });
  }),
);
