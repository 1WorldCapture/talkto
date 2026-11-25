import { Clock, DateTime, Effect, Schema } from "effect";
import * as AI from "@talkto/api/agent-invites";
import * as M from "@talkto/api/models";
import * as Access from "../access.js";
import * as Guard from "./guard.js";
import * as InviteModel from "./model.js";
import * as Store from "./store.js";

/*
  Agent invites at the Worker (docs/agent-invites.md). Links, the waiting list and the mode live in
  D1; whether the caller may use the server, and who the inviting agent is, come from the server
  object; admitting an agent creates its grant and participant there. Approving, declining and the
  mode are a person's acts: the website, or the person's API key.
*/

/** An invite failure, answered with this public code and message. */
export class InviteFailure extends Schema.TaggedError<InviteFailure>()("InviteFailure", {
  code: Schema.Literals([
    "forbidden",
    "not_found",
    "server_unavailable",
    "storage_unavailable",
    "idempotency_conflict",
    "name_taken",
    "waiting_list_full",
  ]),
  message: Schema.String,
}) {}
const fail = (code: InviteFailure["code"], message: string) => new InviteFailure({ code, message });

/** Who is calling: a person (by WorkOS user) or an invited agent (by its key, never a person). */
export interface Caller {
  readonly principal: Access.PrincipalKey;
  /** The WorkOS user; null for an invited agent. */
  readonly userId: string | null;
  /** The person's display name, for the lineage of links a person makes; null for an agent. */
  readonly name: string | null;
  /** Whether the person is acting: the website or their API key (Model.byPerson). */
  readonly byPerson: boolean;
}

/** The server object calls invites need. */
export interface Servers {
  readonly inviter: (
    serverId: string,
    principal: Access.PrincipalKey,
    participantId: string | null,
  ) => Promise<InviteModel.Inviter>;
  readonly admit: (input: InviteModel.Admit) => Promise<InviteModel.Admitted>;
  readonly name: (serverId: string, name: string) => Promise<"free" | "taken" | "unavailable">;
  readonly removeInvitedBy: (
    serverId: string,
    principal: Access.PrincipalKey,
    name: string,
    participantId: string,
  ) => Promise<InviteModel.RemovedInvited>;
}

const iso = (millis: number) => M.Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(millis)));
const hourMs = 3_600_000;
const unavailableServer = () =>
  fail("server_unavailable", "The server is unavailable, or you do not have access to it.");

const view = (row: Store.InviteRow): AI.Invite => ({
  id: AI.InviteId.make(row.id),
  serverId: M.ServerId.make(row.serverId),
  prefix: row.prefix,
  note: row.note,
  madeBy:
    row.madeByParticipantId === null
      ? null
      : {
          participantId: M.ParticipantId.make(row.madeByParticipantId),
          name: row.madeByName ?? "",
        },
  createdAt: iso(row.createdAt),
  expiresAt: iso(row.expiresAt),
  usesLeft: row.usesLeft,
});

/** The caller's access to the server, from its server object; fails when it has none. */
const access = Effect.fn("Invites.access")(function* (
  servers: Servers,
  serverId: string,
  caller: Caller,
  participantId: string | null,
) {
  const found = yield* Effect.promise(() =>
    servers.inviter(serverId, caller.principal, participantId),
  );
  if (found.kind === "denied") return yield* unavailableServer();
  if (found.kind === "unavailable")
    return yield* fail("storage_unavailable", "The server is temporarily unavailable. Try again.");
  return found;
});

/** A person acting on the website or with their API key, with access to the server. */
const person = Effect.fn("Invites.person")(function* (
  servers: Servers,
  serverId: string,
  caller: Caller,
) {
  if (!caller.byPerson || caller.userId === null)
    return yield* fail(
      "forbidden",
      "Only a person approves agents and sets the invite mode: on TalkTo's website or with their API key. Agents can invite but not approve.",
    );
  yield* access(servers, serverId, caller, null);
  return caller.userId;
});

/** Make an invite link. An agent names itself in `participantId`; a person leaves it out. */
export const create = Effect.fn("Invites.create")(function* (
  env: Env,
  servers: Servers,
  caller: Caller,
  serverId: string,
  input: AI.CreateInvite,
  origin: string,
) {
  const store = yield* Store.Store;
  const found = yield* access(servers, serverId, caller, input.participantId ?? null);
  if (found.kind === "not_own_agent")
    return yield* fail(
      "forbidden",
      Access.isInvited(caller.principal)
        ? "An invited agent invites as itself: send its own participant ID."
        : "Name one of your own agents in participantId, or leave it out to invite as yourself.",
    );
  const originUser =
    found.origin ??
    (caller.userId === null ? null : { userId: caller.userId, name: caller.name ?? "A person" });
  if (originUser === null) return yield* unavailableServer();
  const now = yield* Clock.currentTimeMillis;
  const code = yield* Guard.mint(env, "code", serverId);
  const made = yield* store.create({
    id: crypto.randomUUID(),
    serverId,
    codeHash: yield* Guard.hash(code),
    // The secret's first characters (the server ID is the same on every link of a server).
    prefix: `${AI.codePrefix}…${code.slice(code.indexOf(".") + 1, code.indexOf(".") + 7)}`,
    madeByPrincipal: caller.principal,
    madeByParticipantId: found.invitedBy?.participantId ?? null,
    madeByName: found.invitedBy?.name ?? null,
    originUserId: originUser.userId,
    originName: originUser.name,
    chain: JSON.stringify(found.chain),
    note: input.note ?? null,
    requestKey: input.requestKey,
    createdAt: now,
    expiresAt: now + (input.expiresInHours ?? AI.defaultHours) * hourMs,
    uses: input.uses ?? 1,
  });
  if (made === null) return yield* unavailableServer();
  return {
    invite: view(made.row),
    code: made.created ? AI.Code.make(code) : null,
    url: made.created ? `${origin}/join/agent#${code}` : null,
    created: made.created,
  } satisfies AI.CreatedInvite;
});

/** The server's open links. Anyone with access to the server, agents included. */
export const list = Effect.fn("Invites.list")(function* (
  servers: Servers,
  caller: Caller,
  serverId: string,
) {
  yield* access(servers, serverId, caller, null);
  const rows = yield* (yield* Store.Store).open(serverId, yield* Clock.currentTimeMillis);
  return { items: rows.map(view) } satisfies AI.Invites;
});

/** Revoke one link. Anyone with access to the server; agents who joined through it stay. */
export const revoke = Effect.fn("Invites.revoke")(function* (
  servers: Servers,
  caller: Caller,
  serverId: string,
  inviteId: AI.InviteId,
) {
  yield* access(servers, serverId, caller, null);
  const at = yield* (yield* Store.Store).revoke(serverId, inviteId, yield* Clock.currentTimeMillis);
  if (at === null) return yield* fail("not_found", "There is no such open invite link.");
  return { id: inviteId, revokedAt: iso(at) };
});

/**
 * Remove the agents one agent invited directly, and revoke every link it and they made. A person
 * only; the website offers it when removing an agent (removal alone revokes that agent's links).
 */
export const removeInvited = Effect.fn("Invites.removeInvited")(function* (
  servers: Servers,
  caller: Caller,
  serverId: string,
  participantId: M.ParticipantId,
) {
  yield* person(servers, serverId, caller);
  const result = yield* Effect.promise(() =>
    servers.removeInvitedBy(serverId, caller.principal, caller.name ?? "", participantId),
  );
  if (result.kind === "denied") return yield* unavailableServer();
  if (result.kind === "unavailable")
    return yield* fail("storage_unavailable", "The server is temporarily unavailable. Try again.");
  const store = yield* Store.Store;
  const at = yield* Clock.currentTimeMillis;
  let revokedLinks = 0;
  for (const id of [participantId, ...result.participantIds])
    revokedLinks += yield* store.revokeMadeBy(serverId, id, at);
  return { removed: result.participantIds, revokedLinks };
});

const lineageOf = (row: Store.RequestRow) =>
  Schema.decodeUnknownSync(InviteModel.StoredLineage)(JSON.parse(row.lineage));
const requestView = (row: Store.RequestRow): AI.Request => ({
  id: AI.RequestId.make(row.id),
  name: M.Name.make(row.name),
  agentType: M.AgentType.make(row.agentType),
  note: row.note === null ? null : M.JoinedNote.make(row.note),
  lineage: InviteModel.shown(lineageOf(row)),
  requestedAt: iso(row.requestedAt),
});

/** The agents waiting to join. A person only. */
export const requests = Effect.fn("Invites.requests")(function* (
  servers: Servers,
  caller: Caller,
  serverId: string,
) {
  yield* person(servers, serverId, caller);
  const rows = yield* (yield* Store.Store).waiting(serverId);
  return { items: rows.map(requestView) } satisfies AI.Requests;
});

/** Approve or decline a waiting agent. Any person with access to the server. */
export const decide = Effect.fn("Invites.decide")(function* (
  servers: Servers,
  caller: Caller,
  serverId: string,
  requestId: AI.RequestId,
  decision: "approved" | "declined",
) {
  const userId = yield* person(servers, serverId, caller);
  const decided = yield* (yield* Store.Store).decide(
    serverId,
    requestId,
    decision,
    `workos:${userId}`,
    yield* Clock.currentTimeMillis,
  );
  if (decided === null) return yield* fail("not_found", "There is no such request on this server.");
  const now = decided.row.status === "declined" ? "declined" : "approved";
  if (!decided.changed && now !== decision)
    return yield* fail(
      "idempotency_conflict",
      `This request was already ${now === "approved" ? "approved" : "declined"}.`,
    );
  return {
    id: requestId,
    decision,
    decidedAt: iso(decided.decidedAt),
    changed: decided.changed,
  } satisfies AI.Decided;
});

/** The server's invite mode. A person only. */
export const mode = Effect.fn("Invites.mode")(function* (
  servers: Servers,
  caller: Caller,
  serverId: string,
) {
  yield* person(servers, serverId, caller);
  return { mode: yield* (yield* Store.Store).mode(serverId) } satisfies AI.ModeSetting;
});

/** Set the server's invite mode. A person only. */
export const setMode = Effect.fn("Invites.setMode")(function* (
  servers: Servers,
  caller: Caller,
  serverId: string,
  setting: AI.ModeSetting,
) {
  const userId = yield* person(servers, serverId, caller);
  yield* (yield* Store.Store).setMode(
    serverId,
    setting.mode,
    `workos:${userId}`,
    yield* Clock.currentTimeMillis,
  );
  return setting;
});

/**
 * Admit an approved request's agent: spend its pickup secret, mint its key, make its participant
 * and record it joined. The secret works once; a pickup that fails for a reason the agent can fix
 * (a taken name, a busy server) gives it back.
 */
const admit = Effect.fn("Invites.admit")(function* (
  env: Env,
  servers: Servers,
  row: Store.RequestRow,
  pickupHash: string,
  name: M.Name,
) {
  const store = yield* Store.Store;
  if (!(yield* store.claim(row.id, pickupHash))) return yield* unknownRequest();
  const key = yield* Guard.mint(env, "key", row.serverId);
  const keyHash = yield* Guard.hash(key);
  const admitted = yield* Effect.promise(() =>
    servers.admit({
      serverId: M.ServerId.make(row.serverId),
      id: InviteModel.InvitedId.make(row.id),
      name,
      agentType: M.AgentType.make(row.agentType),
      note: row.note === null ? null : M.JoinedNote.make(row.note),
      keyHash,
      lineage: lineageOf(row),
    }),
  );
  if (admitted.kind === "revoked") return yield* newInvite();
  if (admitted.kind !== "joined") {
    yield* store.restore(row.id, pickupHash, admitted.kind === "name_taken");
    return yield* admitted.kind === "name_taken"
      ? fail(
          "name_taken",
          `${admitted.message} Check again with another name: add ?name=<name> to the request check.`,
        )
      : fail("storage_unavailable", "The server is temporarily unavailable. Try again.");
  }
  yield* store.joined(row.id, admitted.participantId, name, yield* Clock.currentTimeMillis);
  return {
    status: "joined",
    serverId: M.ServerId.make(row.serverId),
    participantId: admitted.participantId,
    key: AI.Key.make(key),
  } satisfies typeof AI.Joined.Type;
});

const unknownRequest = () =>
  fail("not_found", "There is no such request, the pickup secret is wrong, or it was used.");
/** Refused for good: say so, so the agent stops trying. */
const newInvite = () =>
  fail(
    "forbidden",
    "This invite no longer admits anyone: the agent that made it was removed. Ask for a new invite.",
  );

const wrongCode = () =>
  fail(
    "not_found",
    "That invite code is unknown, used up, expired or revoked. Ask whoever invited you for a new one.",
  );

/**
 * Join with an invite code; no sign-in. In mode `ask` the agent waits for a person, in mode `open`
 * it joins at once. A wrong code counts against the caller's network.
 */
export const redeem = Effect.fn("Invites.redeem")(function* (
  env: Env,
  servers: Servers,
  request: Request,
  input: AI.Redeem,
) {
  const store = yield* Store.Store;
  if ((yield* Guard.genuine(env, "code", input.code)) === null) {
    yield* Guard.failed(env, request);
    return yield* wrongCode();
  }
  const now = yield* Clock.currentTimeMillis;
  const codeHash = yield* Guard.hash(input.code);
  const invite = yield* store.invite(codeHash, now);
  if (invite === null) {
    yield* Guard.failed(env, request);
    return yield* wrongCode();
  }
  const lineage: InviteModel.StoredLineage = {
    invitedBy:
      invite.madeByParticipantId === null
        ? null
        : {
            participantId: M.ParticipantId.make(invite.madeByParticipantId),
            name: invite.madeByName ?? "",
          },
    origin: invite.originName,
    originUserId: invite.originUserId,
    chain: Schema.decodeUnknownSync(Schema.Array(AI.LineageStep))(JSON.parse(invite.chain)),
  };
  // A taken name is refused before a use is spent; the agent redeems again with another.
  const named = yield* Effect.promise(() => servers.name(invite.serverId, input.name));
  if (named === "taken")
    return yield* fail(
      "name_taken",
      `A participant on this server is already named ${input.name}. Redeem again with another name.`,
    );
  if (named === "unavailable")
    return yield* fail("storage_unavailable", "The server is temporarily unavailable. Try again.");
  const pickup = Guard.pickup();
  const pickupHash = yield* Guard.hash(pickup);
  const redeemed = yield* store.redeem(
    {
      id: crypto.randomUUID(),
      codeHash,
      name: input.name,
      agentType: input.agentType,
      note: input.note ?? null,
      pickupHash,
      lineage: JSON.stringify(lineage),
      at: now,
    },
    invite.mode,
  );
  if (redeemed.kind === "invalid") return yield* wrongCode();
  if (redeemed.kind === "full")
    return yield* fail(
      "waiting_list_full",
      `${AI.maxWaiting} agents are already waiting to join this server. Try again once a person has answered some of them.`,
    );
  const waiting = {
    status: "waiting",
    serverId: M.ServerId.make(redeemed.request.serverId),
    requestId: AI.RequestId.make(redeemed.request.id),
    pickup,
  } satisfies typeof AI.Waiting.Type;
  if (redeemed.request.status !== "approved") return waiting;
  // Mode `open`: in at once. Should that fail for a reason the agent can fix (a name taken since
  // the check above, a busy server), it keeps its request and checks it like a waiting one.
  return yield* admit(env, servers, redeemed.request, pickupHash, input.name).pipe(
    Effect.catchIf(
      (error): error is InviteFailure =>
        error._tag === "InviteFailure" &&
        (error.code === "name_taken" || error.code === "storage_unavailable"),
      () => Effect.succeed(waiting),
    ),
  );
});

/**
 * Check a request with its pickup secret, waiting up to `wait` seconds for a person's decision; one
 * wait runs at a time per request. An approved request is admitted here, once: the secret is then
 * spent. `name` picks another name when the first was taken.
 */
export const check = Effect.fn("Invites.check")(function* (
  env: Env,
  servers: Servers,
  request: Request,
  requestId: AI.RequestId,
  pickup: string | null,
  wait: number,
  name: M.Name | null,
) {
  const store = yield* Store.Store;
  let row = yield* store.request(requestId);
  const pickupHash = pickup === null ? null : yield* Guard.hash(pickup);
  if (row === null || pickupHash === null || row.pickupHash !== pickupHash) {
    yield* Guard.failed(env, request);
    return yield* unknownRequest();
  }
  // Wait for a decision: the request's status row, read again every two seconds.
  const now = yield* Clock.currentTimeMillis;
  const deadline = now + Math.min(wait, AI.maxWaitSeconds) * 1000;
  if (row.status === "waiting" && wait > 0 && (yield* store.hold(requestId, deadline, now)))
    while (row.status === "waiting" && (yield* Clock.currentTimeMillis) + 2000 <= deadline) {
      yield* Effect.sleep("2 seconds");
      row = (yield* store.request(requestId)) ?? row;
    }
  if (row.status === "declined")
    return {
      status: "declined",
      serverId: M.ServerId.make(row.serverId),
    } satisfies typeof AI.Declined.Type;
  if (row.status === "waiting")
    return {
      status: "waiting",
      serverId: M.ServerId.make(row.serverId),
      requestId,
      pickup: null,
    } satisfies typeof AI.Waiting.Type;
  // The name a person approved stands; another only after a pickup found it taken.
  if (name !== null && row.renameAllowed === 0 && name !== row.name)
    return yield* fail(
      "forbidden",
      "Choose another name only after picking up the key answered name_taken. Check again without ?name=.",
    );
  return yield* admit(env, servers, row, pickupHash, name ?? M.Name.make(row.name));
});
