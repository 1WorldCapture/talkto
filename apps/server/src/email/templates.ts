import { Schema } from "effect";
import * as B from "@talkto/api/billing";
import * as G from "@talkto/api/guests";
import * as M from "@talkto/api/models";
import * as P from "@talkto/api/platform";

/*
  The stored form of each email's data. Rendering lives in render.ts, which imports nothing.
*/

/** What each outbox row stores for its template. Never an email address. */
export const Payload = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("allowance"),
    accountId: P.AccountId,
    organization: Schema.String,
    /** Percent of the allowance used: 80 warns, 100 says it is used up. */
    threshold: Schema.Literals([80, 100]),
    used: M.Count,
    allowance: M.Count,
    funding: Schema.Literals(["paid", "trial", "starter", "free"]),
    periodEnd: Schema.NullOr(M.Timestamp),
  }),
  Schema.Struct({
    kind: Schema.Literal("payment"),
    accountId: P.AccountId,
    organization: Schema.String,
    plan: Schema.NullOr(B.Plan),
  }),
  Schema.Struct({
    kind: Schema.Literal("plan_kept"),
    accountId: P.AccountId,
    organization: Schema.String,
    plan: B.Plan,
    kept: B.Plan,
    at: M.Timestamp,
    people: M.Count,
  }),
  Schema.Struct({
    kind: Schema.Literal("plugin_update"),
    accountId: P.AccountId,
    organization: Schema.String,
    plugin: Schema.String,
    installed: Schema.String,
    latest: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("product_update"), announcementId: Schema.String }),
  /**
   * An invitation to one server, to the invited address (who may have no account). The address is
   * read from the invitation when sending; `sends` names the send this email is for, so a resend
   * supersedes an earlier email still waiting.
   */
  Schema.Struct({
    kind: Schema.Literal("server_invitation"),
    invitationId: G.InvitationId,
    sends: Schema.Int,
    server: Schema.String,
    organization: Schema.String,
    inviter: Schema.String,
    expiresAt: M.Timestamp,
  }),
  /** The invited person accepted: to the person who invited them. */
  Schema.Struct({
    kind: Schema.Literal("server_joined"),
    invitationId: G.InvitationId,
    accountId: P.AccountId,
    serverId: M.ServerId,
    server: Schema.String,
    organization: Schema.String,
    guest: Schema.String,
  }),
]);
/** Parsed template data. */
export type Payload = typeof Payload.Type;

export { render, type Context, type Rendered } from "./render.js";
