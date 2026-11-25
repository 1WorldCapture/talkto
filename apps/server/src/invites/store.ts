import { Context, Effect, Layer, Schema } from "effect";
import * as AI from "@talkto/api/agent-invites";
import * as Model from "../platform/model.js";
import * as Telemetry from "../telemetry.js";

/*
  Agent invites in D1 (platform migration 0029): invite links, the waiting list and each server's
  mode. Codes and pickup secrets are stored only as SHA-256. Times are epoch milliseconds. A deleted
  server's links and requests stop working at once: every lookup joins `servers` and refuses a
  server whose deletion was requested.
*/

type Value = string | number | null;
const storage = (cause?: unknown) =>
  Telemetry.withCause(
    new Model.Failure({
      code: "storage_unavailable",
      message: "Agent invites are temporarily unavailable. Try again.",
    }),
    cause,
  );

/** A stored invite link, without its code. */
export const InviteRow = Schema.Struct({
  id: Schema.String,
  serverId: Schema.String,
  prefix: Schema.String,
  madeByPrincipal: Schema.String,
  madeByParticipantId: Schema.NullOr(Schema.String),
  madeByName: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  expiresAt: Schema.Number,
  usesLeft: Schema.Number,
});
export interface InviteRow extends Schema.Schema.Type<typeof InviteRow> {}

/** A stored request to join. */
export const RequestRow = Schema.Struct({
  id: Schema.String,
  serverId: Schema.String,
  name: Schema.String,
  agentType: Schema.String,
  note: Schema.NullOr(Schema.String),
  pickupHash: Schema.NullOr(Schema.String),
  renameAllowed: Schema.Literals([0, 1]),
  lineage: Schema.String,
  status: Schema.Literals(["waiting", "approved", "joined", "declined"]),
  requestedAt: Schema.Number,
  participantId: Schema.NullOr(Schema.String),
});
export interface RequestRow extends Schema.Schema.Type<typeof RequestRow> {}

/** A new invite link's row. */
export interface NewInvite {
  readonly id: string;
  readonly serverId: string;
  readonly codeHash: string;
  readonly prefix: string;
  readonly madeByPrincipal: string;
  readonly madeByParticipantId: string | null;
  readonly madeByName: string | null;
  readonly originUserId: string;
  readonly originName: string;
  readonly chain: string;
  readonly note: string | null;
  readonly requestKey: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly uses: number;
}

/** A new request to join, made from an invite's code. */
export interface NewRequest {
  readonly id: string;
  readonly codeHash: string;
  readonly name: string;
  readonly agentType: string;
  readonly note: string | null;
  readonly pickupHash: string;
  /** The lineage JSON, built by the caller from the invite (`Store.invite`). */
  readonly lineage: string;
  readonly at: number;
}

/** What redeeming a code found. */
export type Redeemed =
  | { readonly kind: "requested"; readonly request: RequestRow }
  | { readonly kind: "invalid" }
  | { readonly kind: "full" };

/** The invite a code names, with what a newcomer's lineage is made from. */
export const CodeRow = Schema.Struct({
  id: Schema.String,
  serverId: Schema.String,
  madeByParticipantId: Schema.NullOr(Schema.String),
  madeByName: Schema.NullOr(Schema.String),
  originUserId: Schema.String,
  originName: Schema.String,
  chain: Schema.String,
  mode: Schema.Literals(["ask", "open"]),
});
export interface CodeRow extends Schema.Schema.Type<typeof CodeRow> {}

type Operation<A> = Effect.Effect<A, Model.Failure>;
/** Storage for agent invites. */
export class Store extends Context.Service<
  Store,
  {
    /** Insert an invite link, once per maker and request key. The stored row, and whether new. */
    readonly create: (invite: NewInvite) => Operation<{ row: InviteRow; created: boolean } | null>;
    /** The server's open links: not revoked, not expired, with uses left. Newest first. */
    readonly open: (serverId: string, now: number) => Operation<ReadonlyArray<InviteRow>>;
    /** Revoke one link. Null when there is no such open link on the server. */
    readonly revoke: (serverId: string, id: string, at: number) => Operation<number | null>;
    /** Revoke every link one participant made on the server. How many were revoked. */
    readonly revokeMadeBy: (
      serverId: string,
      participantId: string,
      at: number,
    ) => Operation<number>;
    /** The usable invite a code names; null for an unknown, used up, expired or revoked code. */
    readonly invite: (codeHash: string, now: number) => Operation<CodeRow | null>;
    /**
     * Spend one use of the code and record the request, in one batch: `waiting` in mode `ask`,
     * `approved` in mode `open`. `full` when the server already has `maxWaiting` agents waiting.
     */
    readonly redeem: (request: NewRequest, mode: AI.Mode) => Operation<Redeemed>;
    /** A request by ID; null when unknown or its server is being deleted. */
    readonly request: (id: string) => Operation<RequestRow | null>;
    /** The server's waiting requests, oldest first. */
    readonly waiting: (serverId: string) => Operation<ReadonlyArray<RequestRow>>;
    /** Decide a waiting request. The request after the decision; null when unknown. */
    readonly decide: (
      serverId: string,
      id: string,
      decision: "approved" | "declined",
      by: string,
      at: number,
    ) => Operation<{ row: RequestRow; changed: boolean; decidedAt: number } | null>;
    /** Record that an approved request's agent joined as this participant, under this name. */
    readonly joined: (
      id: string,
      participantId: string,
      name: string,
      at: number,
    ) => Operation<void>;
    /**
     * Spend an approved request's pickup secret, so it admits once: true for the one caller that
     * spent it. A pickup that then fails for a reason the agent can fix gets it back (`restore`).
     */
    readonly claim: (id: string, pickupHash: string) => Operation<boolean>;
    /**
     * Give a spent pickup secret back after a pickup that did not admit the agent; `rename` when it
     * was refused for a taken name, which lets the next pickup choose another (`?name=`).
     */
    readonly restore: (id: string, pickupHash: string, rename: boolean) => Operation<void>;
    /** Hold the one wait allowed per request until `until`; false while another wait holds it. */
    readonly hold: (id: string, until: number, now: number) => Operation<boolean>;
    /** The server's mode; `ask` when never set. */
    readonly mode: (serverId: string) => Operation<AI.Mode>;
    /** Set the server's mode. */
    readonly setMode: (serverId: string, mode: AI.Mode, by: string, at: number) => Operation<void>;
  }
>()("@talkto/invites/Store") {}

const inviteColumns =
  "i.id,i.server_id AS serverId,i.prefix,i.made_by_principal AS madeByPrincipal,i.made_by_participant_id AS madeByParticipantId,i.made_by_name AS madeByName,i.note,i.created_at AS createdAt,i.expires_at AS expiresAt,i.uses_left AS usesLeft";
const requestColumns =
  "r.id,r.server_id AS serverId,r.name,r.agent_type AS agentType,r.note,r.pickup_hash AS pickupHash,r.rename_allowed AS renameAllowed,r.lineage,r.status,r.requested_at AS requestedAt,r.participant_id AS participantId";
const liveServer = (alias: string) =>
  `EXISTS(SELECT 1 FROM servers s WHERE s.id=${alias}.server_id AND s.deletion_requested_at IS NULL)`;

/** The D1 store. Statements are made inside the attempted operation, so a broken binding fails. */
export const layer = (database: D1Database) =>
  Layer.sync(Store, () => {
    let session: D1DatabaseSession | undefined;
    const db = () => (session ??= database.withSession("first-primary"));
    const sql = (query: string, values: ReadonlyArray<Value> = []) =>
      db()
        .prepare(query)
        .bind(...values);
    const run = (query: string, values: ReadonlyArray<Value> = []) =>
      Effect.tryPromise({ try: () => sql(query, values).run(), catch: storage });
    const all = <A>(schema: Schema.Decoder<A>, query: string, values: ReadonlyArray<Value> = []) =>
      Effect.tryPromise({ try: () => sql(query, values).all(), catch: storage }).pipe(
        Effect.flatMap((result) =>
          Schema.decodeUnknownEffect(Schema.Array(schema))(result.results).pipe(
            Effect.mapError(() => storage()),
          ),
        ),
      );
    const one = <A>(schema: Schema.Decoder<A>, query: string, values: ReadonlyArray<Value> = []) =>
      all(schema, query, values).pipe(Effect.map((rows) => rows[0] ?? null));
    const batch = (statements: ReadonlyArray<readonly [string, ReadonlyArray<Value>]>) =>
      Effect.tryPromise({
        try: () => db().batch(statements.map(([query, values]) => sql(query, values))),
        catch: storage,
      });
    const requestById = (id: string) =>
      one(
        RequestRow,
        `SELECT ${requestColumns} FROM agent_invite_requests r WHERE r.id=? AND ${liveServer("r")}`,
        [id],
      );
    const At = Schema.Struct({ at: Schema.Number });
    return Store.of({
      create: (invite) =>
        Effect.gen(function* () {
          const result = yield* run(
            `INSERT INTO agent_invites(id,server_id,code_hash,prefix,made_by_principal,made_by_participant_id,made_by_name,origin_user_id,origin_name,chain,note,request_key,created_at,expires_at,uses_left)
             SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM servers s WHERE s.id=? AND s.deletion_requested_at IS NULL)
             ON CONFLICT(server_id,made_by_principal,request_key) DO NOTHING`,
            [
              invite.id,
              invite.serverId,
              invite.codeHash,
              invite.prefix,
              invite.madeByPrincipal,
              invite.madeByParticipantId,
              invite.madeByName,
              invite.originUserId,
              invite.originName,
              invite.chain,
              invite.note,
              invite.requestKey,
              invite.createdAt,
              invite.expiresAt,
              invite.uses,
              invite.serverId,
            ],
          );
          const row = yield* one(
            InviteRow,
            `SELECT ${inviteColumns} FROM agent_invites i WHERE i.server_id=? AND i.made_by_principal=? AND i.request_key=?`,
            [invite.serverId, invite.madeByPrincipal, invite.requestKey],
          );
          return row === null ? null : { row, created: result.meta.changes === 1 };
        }),
      open: (serverId, now) =>
        all(
          InviteRow,
          `SELECT ${inviteColumns} FROM agent_invites i WHERE i.server_id=? AND i.revoked_at IS NULL
           AND i.expires_at>? AND i.uses_left>0 ORDER BY i.created_at DESC LIMIT 200`,
          [serverId, now],
        ),
      revoke: (serverId, id, at) =>
        one(
          At,
          "UPDATE agent_invites SET revoked_at=? WHERE id=? AND server_id=? AND revoked_at IS NULL RETURNING revoked_at AS at",
          [at, id, serverId],
        ).pipe(Effect.map((row) => row?.at ?? null)),
      revokeMadeBy: (serverId, participantId, at) =>
        run(
          "UPDATE agent_invites SET revoked_at=? WHERE server_id=? AND made_by_participant_id=? AND revoked_at IS NULL",
          [at, serverId, participantId],
        ).pipe(Effect.map((result) => result.meta.changes)),
      invite: (codeHash, now) =>
        one(
          CodeRow,
          `SELECT i.id,i.server_id AS serverId,i.made_by_participant_id AS madeByParticipantId,
             i.made_by_name AS madeByName,i.origin_user_id AS originUserId,i.origin_name AS originName,i.chain,
             COALESCE((SELECT m.mode FROM server_invite_modes m WHERE m.server_id=i.server_id),'ask') AS mode
           FROM agent_invites i WHERE i.code_hash=? AND i.revoked_at IS NULL AND i.expires_at>?
           AND i.uses_left>0 AND ${liveServer("i")}`,
          [codeHash, now],
        ),
      redeem: (request, mode) =>
        Effect.gen(function* () {
          const status = mode === "open" ? "approved" : "waiting";
          // One batch: the request is written only while the code is usable and, for a waiting
          // request, fewer than maxWaiting wait on the server; the use is spent only with it.
          const [inserted] = yield* batch([
            [
              `INSERT INTO agent_invite_requests(id,server_id,invite_id,name,agent_type,note,pickup_hash,lineage,status,requested_at,decided_at,decided_by)
               SELECT ?1,i.server_id,i.id,?2,?3,?4,?5,?6,?7,?8,CASE WHEN ?7='approved' THEN ?8 END,CASE WHEN ?7='approved' THEN 'open' END
               FROM agent_invites i WHERE i.code_hash=?9 AND i.revoked_at IS NULL AND i.expires_at>?8
               AND i.uses_left>0 AND ${liveServer("i")}
               AND (?7='approved' OR (SELECT COUNT(*) FROM agent_invite_requests w WHERE w.server_id=i.server_id AND w.status='waiting')<?10)`,
              [
                request.id,
                request.name,
                request.agentType,
                request.note,
                request.pickupHash,
                request.lineage,
                status,
                request.at,
                request.codeHash,
                AI.maxWaiting,
              ],
            ],
            [
              "UPDATE agent_invites SET uses_left=uses_left-1 WHERE code_hash=? AND EXISTS(SELECT 1 FROM agent_invite_requests WHERE id=?)",
              [request.codeHash, request.id],
            ],
          ]);
          if (inserted?.meta.changes === 1) {
            const row = yield* requestById(request.id);
            return row === null
              ? ({ kind: "invalid" } as const)
              : { kind: "requested", request: row };
          }
          // Nothing written: a full waiting list if the code is still usable, else a bad code.
          const usable = yield* one(
            Schema.Struct({ id: Schema.String }),
            `SELECT i.id FROM agent_invites i WHERE i.code_hash=? AND i.revoked_at IS NULL AND i.expires_at>? AND i.uses_left>0 AND ${liveServer("i")}`,
            [request.codeHash, request.at],
          );
          return usable === null ? { kind: "invalid" } : { kind: "full" };
        }),
      request: requestById,
      waiting: (serverId) =>
        all(
          RequestRow,
          `SELECT ${requestColumns} FROM agent_invite_requests r WHERE r.server_id=? AND r.status='waiting'
           AND ${liveServer("r")} ORDER BY r.requested_at LIMIT ${AI.maxWaiting}`,
          [serverId],
        ),
      decide: (serverId, id, decision, by, at) =>
        Effect.gen(function* () {
          const result = yield* run(
            "UPDATE agent_invite_requests SET status=?,decided_at=?,decided_by=? WHERE id=? AND server_id=? AND status='waiting'",
            [decision, at, by, id, serverId],
          );
          const row = yield* requestById(id);
          if (row === null || row.serverId !== serverId) return null;
          const decided = yield* one(
            At,
            "SELECT COALESCE(decided_at,requested_at) AS at FROM agent_invite_requests WHERE id=?",
            [id],
          );
          return { row, changed: result.meta.changes === 1, decidedAt: decided?.at ?? at };
        }),
      joined: (id, participantId, name, at) =>
        run(
          "UPDATE agent_invite_requests SET status='joined',participant_id=?,name=?,pickup_hash=NULL,joined_at=COALESCE(joined_at,?) WHERE id=? AND status IN ('approved','joined')",
          [participantId, name, at, id],
        ).pipe(Effect.asVoid),
      claim: (id, pickupHash) =>
        run(
          "UPDATE agent_invite_requests SET pickup_hash=NULL WHERE id=? AND pickup_hash=? AND status='approved'",
          [id, pickupHash],
        ).pipe(Effect.map((result) => result.meta.changes === 1)),
      restore: (id, pickupHash, rename) =>
        run(
          "UPDATE agent_invite_requests SET pickup_hash=?,rename_allowed=MAX(rename_allowed,?) WHERE id=? AND pickup_hash IS NULL AND status='approved'",
          [pickupHash, rename ? 1 : 0, id],
        ).pipe(Effect.asVoid),
      hold: (id, until, now) =>
        run(
          "UPDATE agent_invite_requests SET polling_until=? WHERE id=? AND (polling_until IS NULL OR polling_until<=?)",
          [until, id, now],
        ).pipe(Effect.map((result) => result.meta.changes === 1)),
      mode: (serverId) =>
        one(
          Schema.Struct({ mode: AI.Mode }),
          "SELECT mode FROM server_invite_modes WHERE server_id=?",
          [serverId],
        ).pipe(Effect.map((row) => row?.mode ?? "ask")),
      setMode: (serverId, mode, by, at) =>
        run(
          `INSERT INTO server_invite_modes(server_id,mode,changed_by,changed_at) VALUES(?,?,?,?)
           ON CONFLICT(server_id) DO UPDATE SET mode=excluded.mode,changed_by=excluded.changed_by,changed_at=excluded.changed_at`,
          [serverId, mode, by, at],
        ).pipe(Effect.asVoid),
    });
  });
