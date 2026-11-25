import type { Effect } from "effect";
import type * as E from "@talkto/api/errors";
import type * as M from "@talkto/api/models";
import type { PrincipalKey } from "../access.js";

/**
 * Swarm memory's ledger in the server's SQLite (migrations/memory-repository.sql): the repository,
 * the cache of its last good head, the commits posted, and the Git tokens granted. Synchronous
 * statements inside a server transaction; the repository itself is reached outside them.
 */
type Op<A> = Effect.Effect<A, E.StorageUnavailable>;

/**
 * The server's memory repository and its settings. Memory has no switch (owner, November 25,
 * 2026): the table's `enabled` column is written 1 and never read.
 */
export interface RepositoryRow {
  readonly tokens: number;
  readonly name: string;
  readonly remote: string;
  readonly sourceServerId: M.ServerId | null;
  readonly seeded: boolean;
  readonly channelId: M.ConversationId | null;
  /** The server creator's person participant, who sends lines no single agent wrote, and its grant. */
  readonly posterId: M.ParticipantId | null;
  readonly posterGrantId: M.GrantId | null;
  /** The last head of main TalkTo accepted, or null before the first read. */
  readonly goodHead: string | null;
  readonly checkedAt: number;
  /** Until when the month's memory edits are spent (epoch ms); 0 when they are not. */
  readonly cappedUntil: number;
  readonly createdAt: number;
}
/** One Markdown file of the good head. */
export interface FileRow {
  readonly path: string;
  readonly blob: string;
  readonly text: string;
  readonly bytes: number;
  readonly labels: ReadonlyArray<string>;
}
/** One commit found on main and posted once. */
export interface CommitRow {
  readonly hash: string;
  readonly subject: string;
  readonly messageId: M.MessageId | null;
  readonly usageId: string | null;
  readonly metered: boolean;
  readonly foundAt: number;
}
/** One Git token TalkTo granted; never the token itself. */
export interface TokenRow {
  readonly id: string;
  readonly tokenId: string;
  readonly participantId: M.ParticipantId;
  readonly grantId: M.GrantId;
  readonly scope: "read" | "write";
  readonly taskId: string | null;
  readonly epoch: number | null;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
  readonly settledAt: number | null;
}
/** Why a live token must be revoked now. */
export type RevokeReason = "access" | "claim" | "capped";

export interface MemoryStore {
  readonly repository: () => Op<RepositoryRow | null>;
  /** Record a new repository. */
  readonly createRepository: (input: {
    readonly name: string;
    readonly remote: string;
    readonly sourceServerId: M.ServerId | null;
    readonly tokens: number;
    readonly seeded: boolean;
    readonly at: number;
  }) => Op<void>;
  readonly setSeeded: () => Op<void>;
  readonly setSettings: (input: {
    readonly tokens: number;
    readonly changedBy: M.ParticipantId;
    readonly at: number;
  }) => Op<void>;
  readonly setChannel: (channelId: M.ConversationId) => Op<void>;
  readonly setPoster: (input: {
    readonly posterId: M.ParticipantId;
    readonly posterGrantId: M.GrantId;
  }) => Op<void>;
  /**
   * The person participant bound to `principalKey` on this server, not removed, with the grant it
   * was created through; null when that person never joined the server.
   */
  readonly person: (
    principalKey: PrincipalKey,
  ) => Op<{ readonly participantId: M.ParticipantId; readonly grantId: M.GrantId } | null>;
  /** This agent with the grant it registered through, while it is not removed; null otherwise. */
  readonly agent: (
    participantId: M.ParticipantId,
  ) => Op<{ readonly participantId: M.ParticipantId; readonly grantId: M.GrantId } | null>;
  /** The earliest-joined agent not removed, with the grant it registered through; null if none. */
  readonly firstAgent: () => Op<{
    readonly participantId: M.ParticipantId;
    readonly grantId: M.GrantId;
  } | null>;
  readonly setChecked: (at: number) => Op<void>;
  /**
   * Accept `head` as the good head, replacing the cached files, only if the good head is still
   * `expected`: two refreshes never overwrite each other's newer head. Reports whether it moved.
   */
  readonly setHead: (input: {
    readonly expected: string | null;
    readonly head: string;
    readonly files: ReadonlyArray<FileRow>;
    readonly at: number;
  }) => Op<boolean>;
  readonly setCapped: (until: number) => Op<void>;
  readonly files: () => Op<ReadonlyArray<FileRow>>;
  readonly file: (path: string) => Op<FileRow | null>;
  readonly commitKnown: (hash: string) => Op<boolean>;
  readonly addCommit: (row: CommitRow) => Op<void>;
  readonly commitCount: () => Op<number>;
  readonly addToken: (row: TokenRow) => Op<void>;
  /** When tokens of `scope` were granted to the participant since `since`, oldest first. */
  readonly grantsSince: (
    participantId: M.ParticipantId,
    scope: "read" | "write",
    since: number,
  ) => Op<ReadonlyArray<number>>;
  /**
   * Live tokens that must be revoked now: their grant was revoked or their participant removed;
   * for write tokens also a claim no longer held, or the month's edits spent (`capped`).
   */
  readonly revocable: (
    at: number,
    capped: boolean,
  ) => Op<ReadonlyArray<TokenRow & { readonly reason: RevokeReason }>>;
  /** Live write tokens of one claim's holder, or of every holder. */
  readonly liveWrites: (at: number) => Op<ReadonlyArray<TokenRow>>;
  readonly markRevoked: (id: string, at: number) => Op<void>;
  /** Write tokens that can no longer push (revoked or expired) whose head was not read since. */
  readonly unsettled: (at: number) => Op<ReadonlyArray<TokenRow>>;
  readonly markSettled: (ids: ReadonlyArray<string>, at: number) => Op<void>;
  /** The earliest expiry of a write token not settled yet, for the alarm; null when none. */
  readonly nextExpiry: () => Op<number | null>;
  /** Whether this participant holds or held a write token not settled yet. */
  readonly writing: (participantId: M.ParticipantId) => Op<boolean>;
  /** Forget every row: the repository was deleted with the server. */
  readonly erase: () => Op<void>;
}
