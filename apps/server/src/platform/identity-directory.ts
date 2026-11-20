import { Effect, Encoding, Result, Schema } from "effect";
import * as P from "@talkto/api/platform";
import * as I from "@talkto/api/inputs";
import * as M from "@talkto/api/models";
import * as Model from "./model.js";

const Cursor = Schema.Struct({
  kind: Schema.Literals(["accounts", "members", "grant-candidates"]),
  userId: P.UserId,
  accountId: Schema.NullOr(P.AccountId),
  serverId: Schema.optionalKey(Schema.NullOr(M.ServerId)),
  after: P.MembershipId,
  query: Schema.NullOr(I.DirectoryQuery),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
type Cursor = typeof Cursor.Type;
/** Bind provider continuations to the caller, directory and unchanged search. */
export const selection = Effect.fn("IdentityDirectory.selection")(function* (
  userId: P.UserId,
  accountId: P.AccountId | null,
  input: P.IdentityListing,
  serverId: M.ServerId | null = null,
) {
  const kind = serverId !== null ? "grant-candidates" : accountId === null ? "accounts" : "members";
  let query: string | null = input.query ?? null;
  let after: string | undefined;
  if (input.after !== undefined) {
    // Existing clients can finish unfiltered provider pages issued before scoped cursors.
    const legacy = Schema.decodeUnknownResult(P.MembershipId)(input.after);
    if (Result.isSuccess(legacy) && input.query === undefined && serverId === null)
      after = legacy.success;
    else {
      const invalid = () =>
        new Model.Failure({
          code: "invalid_input",
          message: "The directory continuation does not match this caller or search.",
        });
      const raw = Encoding.decodeBase64UrlString(input.after);
      if (Result.isFailure(raw)) return yield* invalid();
      const cursor = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Cursor))(
        raw.success,
      ).pipe(Effect.mapError(invalid));
      if (
        cursor.userId !== userId ||
        cursor.accountId !== accountId ||
        (cursor.serverId ?? null) !== serverId ||
        cursor.kind !== kind ||
        input.query !== undefined
      )
        return yield* invalid();
      after = cursor.after;
      query = cursor.query;
    }
  }
  return {
    after,
    limit: input.limit ?? 100,
    matches: (value: string) => query === null || value.toLowerCase().includes(query.toLowerCase()),
    next: (position: string | null) =>
      position === null
        ? null
        : Encoding.encodeBase64Url(
            JSON.stringify({
              kind,
              userId,
              accountId,
              serverId,
              after: position,
              query,
            }),
          ),
  };
});
