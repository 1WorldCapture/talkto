import { Result, Schema } from "effect";
import * as B from "@talkto/api/billing";
import type * as P from "@talkto/api/platform";

/** A deliberate subscription change, retained unchanged until its result is confirmed. */
export const Action = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("renewal"), input: B.Renewal }),
  Schema.Struct({ kind: Schema.Literal("startPaid"), requestKey: B.Checkout.fields.requestKey }),
]).annotate({ parseOptions: { onExcessProperty: "error" } });
/** Parsed browser recovery state; never sufficient authorization to perform the action. */
export type Action = typeof Action.Type;

/** Browser recovery must work before a retryable billing action can start. */
export class Unavailable extends Schema.TaggedError<Unavailable>()("BillingRecoveryUnavailable", {
  message: Schema.String,
}) {}

const unavailable = () =>
  new Unavailable({
    message:
      "Your browser could not save billing recovery. Allow session storage and reload before trying again.",
  });

/** Bind recovery to the signed-in human and organization; access storage only inside its operations. */
export function storage(
  userId: P.User["id"],
  accountId: P.AccountId,
  browser: () => Pick<Storage, "getItem" | "setItem" | "removeItem"> = () => sessionStorage,
) {
  const key = `talkto-billing-action:${userId}:${accountId}`;
  const read = (): Result.Result<Action | null, Unavailable> => {
    try {
      const value = browser().getItem(key);
      if (value === null) return Result.succeed(null);
      return Schema.decodeUnknownResult(Schema.fromJsonString(Action))(value).pipe(
        Result.mapError(() => unavailable()),
      );
    } catch {
      return Result.fail(unavailable());
    }
  };
  const write = (action: Action | null): Result.Result<Action | null, Unavailable> => {
    try {
      if (action === null) browser().removeItem(key);
      else browser().setItem(key, JSON.stringify(action));
      return Result.succeed(action);
    } catch {
      return Result.fail(unavailable());
    }
  };
  return { read, write };
}
