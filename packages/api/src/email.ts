import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import * as P from "./platform.js";
import * as Envelope from "./envelope.js";
import { Authorization } from "./security.js";

/**
 * Whether a person who never chose gets product update emails. `true` is opt-out: updates go to
 * everyone with a TalkTo account until they unsubscribe (decided November 15, 2026). Flip it to
 * make product updates opt-in; stored choices are kept either way.
 */
export const productUpdatesByDefault = true;

/**
 * The person's email choices. Account emails (usage warnings, payment problems, plugin updates)
 * go to the people they concern and cannot be turned off; only product updates are optional.
 */
export const EmailPreferences = Schema.Struct({
  productUpdates: Schema.Boolean,
  accountEmails: Schema.Literal("always"),
});
/** Parsed email preferences. */
export interface EmailPreferences extends Schema.Schema.Type<typeof EmailPreferences> {}
/** Turn product update emails on or off. */
export const EmailPreferencesUpdate = Schema.Struct({ productUpdates: Schema.Boolean }).annotate({
  parseOptions: { onExcessProperty: "error" },
});
/** Parsed preference change. */
export interface EmailPreferencesUpdate extends Schema.Schema.Type<typeof EmailPreferencesUpdate> {}

/** The signed-in person's own email preferences. No MCP surface. */
export const Api = HttpApi.make("talkto-email").add(
  HttpApiGroup.make("email")
    .add(
      HttpApiEndpoint.get("preferences", "/v1/me/email", {
        success: P.response(EmailPreferences),
        error: Envelope.failures,
      }),
      HttpApiEndpoint.put("updatePreferences", "/v1/me/email", {
        payload: EmailPreferencesUpdate,
        success: P.response(EmailPreferences),
        error: Envelope.failures,
      }),
    )
    .middleware(Authorization),
);
