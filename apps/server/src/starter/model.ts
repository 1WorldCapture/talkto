import { Context, Effect, Schema } from "effect";
import * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import * as S from "@talkto/api/starter";
import type * as Identity from "../platform/model.js";
import { free, history, starter } from "@talkto/api/pricing";

/** A claim was not granted; the reason is a starter status the client can explain. */
export class Denied extends Schema.TaggedError<Denied>()("StarterDenied", {
  reason: Schema.Literals([
    "unavailable",
    "verify_email",
    "sign_in_required",
    "used",
    "paused",
    "server_limit",
    "owner_only",
  ]),
  message: Schema.String,
}) {}
/** Free-start records could not be read or written; retrying the same request is safe. */
export class Unavailable extends Schema.TaggedError<Unavailable>()("StarterUnavailable", {
  operation: Schema.String,
  message: Schema.String,
}) {
  /** Shared operational code for scheduled-stage reporting. */
  get code() {
    return "storage_unavailable" as const;
  }
}
/** Expected outcomes of the free-start application operations. */
export type Failure = Denied | Unavailable;

export const unavailable = (operation: string) =>
  new Unavailable({
    operation,
    message: "Free setup is temporarily unavailable. Retry with the same request.",
  });
const messages: Record<Denied["reason"], string> = {
  unavailable: "The free start is not available for this organization. You can choose a plan.",
  verify_email: "Verify your email address, then create your server again.",
  sign_in_required: "Sign in on the TalkTo website to start with free messages.",
  used: "The free allowance is once per person. You can choose a plan to keep going.",
  paused:
    "Free starts are temporarily unavailable. Your details are kept; try again later or choose a plan.",
  server_limit:
    "You already have a server without a plan, which is the limit. Use that server, or choose a plan to add another.",
  owner_only: "Only the organization owner can start with free messages.",
};
export const denied = (reason: Denied["reason"]) =>
  new Denied({ reason, message: messages[reason] });

/** Request facts the HTTP boundary vouches for. */
export type Evidence = Identity.Evidence;

/** One organization's durable free-start record. */
export const Grant = Schema.Struct({
  id: Schema.String,
  accountId: P.AccountId,
  organizationId: P.OrganizationId,
  ownerId: P.UserId,
  requestKey: M.RequestKey,
  serverName: M.ServerName,
  serverId: Schema.NullOr(M.ServerId),
  allowance: M.Count,
  status: Schema.Literals(["reserved", "active"]),
  reservedAt: M.Timestamp,
  activatedAt: Schema.NullOr(M.Timestamp),
  publishedAt: Schema.NullOr(M.Timestamp),
  /** The terms the claim accepted; `free-…` means it opened the Free plan (configuration.ts). */
  offerVersion: Schema.String,
});
/** Parsed free-start record. */
export interface Grant extends Schema.Schema.Type<typeof Grant> {}
/** Spent-eligibility keys for one owner, organization and recognized inbox. */
export interface Keys {
  readonly owner: P.UserId;
  readonly inbox: string;
  /** The inbox key under the rule before November 16, 2026, when it differs; compared, never stored. */
  readonly previousInbox: string | null;
  /** The card-backed trial's verified-email key, when that trial's secret is configured. */
  readonly trialEmail: string | null;
  /** The card-backed trial's key before November 16, 2026 (lowercased address, tag kept). */
  readonly legacyEmail: string | null;
  readonly organization: P.OrganizationId | null;
  readonly account: P.AccountId | null;
}
/** Atomic admission input. */
export interface Reservation {
  readonly grantId: string;
  readonly namespace: string;
  readonly cohort: string;
  readonly offerVersion: string;
  readonly account: P.Account;
  readonly keys: Keys;
  readonly requestKey: M.RequestKey;
  readonly serverName: typeof M.ServerName.Type;
  readonly allowance: number;
  readonly at: M.Timestamp;
  readonly dailyLimit: number;
  readonly cohortLimit: number;
  readonly networkKey: string | null;
}
/** Why an atomic admission did not reserve a grant. */
export type Admission =
  | { readonly kind: "reserved" | "resumed"; readonly grant: Grant }
  | { readonly kind: "spent" | "full" | "ineligible" };
/** Facts that keep the free start to new, unpaid organizations. */
export interface Standing {
  readonly paid: boolean;
  readonly trial: boolean;
  readonly servers: ReadonlyArray<{
    readonly id: M.ServerId;
    readonly createdBy: P.UserId;
    readonly status: P.Server["status"];
  }>;
}
/**
 * Servers already counted against the platform's creation limits for a new server without a plan.
 * The same rules as server creation, so the offer is shown only when its server can be created.
 */
export interface Capacity {
  /** Live servers without a plan in every organization the owner created. */
  readonly owned: number;
  /** Servers the owner created, or that were created in their organizations, in the last hour. */
  readonly recent: number;
  /** Servers created without a plan since 00:00 UTC, across every organization. */
  readonly today: number;
}

type Operation<A> = Effect.Effect<A, Unavailable>;
/** D1 owns eligibility, admission counts, server binding and publication state. */
export class Store extends Context.Service<
  Store,
  {
    readonly grant: (accountId: P.AccountId) => Operation<Grant | null>;
    readonly spent: (namespace: string, keys: Keys) => Operation<boolean>;
    readonly admitted: (
      cohort: string,
      day: string,
    ) => Operation<{ readonly today: number; readonly total: number }>;
    readonly standing: (accountId: P.AccountId) => Operation<Standing>;
    readonly capacity: (
      owner: P.UserId,
      at: M.Timestamp,
      unlimited: ReadonlyArray<string>,
    ) => Operation<Capacity>;
    readonly reserve: (input: Reservation) => Operation<Admission>;
    /**
     * Finish an unbound reservation in one transaction: bind the server its request key created,
     * or, when no such server exists, delete the grant with its claims so the person is not marked
     * as having used the free start. Null means released. Nothing was ever published for it.
     */
    readonly settle: (grantId: string) => Operation<Grant | null>;
    /** Unbound reservations older than `before`, which no claim in progress still holds. */
    readonly stranded: (before: M.Timestamp) => Operation<ReadonlyArray<Grant>>;
    readonly bind: (grantId: string, serverId: M.ServerId) => Operation<Grant>;
    readonly activate: (grantId: string, at: M.Timestamp) => Operation<Grant>;
    readonly published: (grantId: string, at: M.Timestamp) => Operation<void>;
    /** Keep a newly verified inbox spent too; an existing claim is never released. */
    readonly remember: (
      namespace: string,
      grantId: string,
      inbox: string,
      at: M.Timestamp,
    ) => Operation<void>;
    readonly unpublished: () => Operation<ReadonlyArray<Grant>>;
    readonly forget: (before: M.Timestamp) => Operation<void>;
  }
>()("@talkto/starter/Store") {}

/** Unreported messages held by an organization's live servers; never refills or settles. */
export class Meters extends Context.Service<
  Meters,
  {
    readonly unreported: (
      serverIds: ReadonlyArray<M.ServerId>,
      periodStart: M.Timestamp,
    ) => Effect.Effect<number | null>;
  }
>()("@talkto/starter/Meters") {}

/**
 * Optional extra multi-account assessment at the first claim, after local eligibility and before
 * admission. The default proceeds without a provider call; a provider adapter (for example a
 * Stripe preview) belongs in its own reviewed change with its own budget records.
 */
export class Assessment extends Context.Service<
  Assessment,
  {
    readonly assess: (input: {
      readonly accountId: P.AccountId;
      readonly ownerId: P.UserId;
    }) => Effect.Effect<"proceed" | "deny", Unavailable>;
  }
>()("@talkto/starter/Assessment") {}
export const noAssessment = Assessment.of({ assess: () => Effect.succeed("proceed") });

/** Public offer facts for this environment. */
export const offer: S.Offer = { messages: starter.messages, servers: starter.servers };
/** The Free plan's public facts, offered instead of the free start while its switch is on. */
export const freeOffer: S.FreeOffer = {
  messages: free.messages,
  servers: free.servers,
  historyDays: history.free.days,
};
