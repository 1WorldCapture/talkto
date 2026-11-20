import { Option, Schema } from "effect";
import type * as P from "@talkto/api/platform";

/** Persisted message display choices, scoped to the signed-in person. */
export const Preferences = Schema.Struct({
  mode: Schema.Literals(["scroll", "pages"]),
  size: Schema.Literals([10, 25, 50]),
});
const defaults: typeof Preferences.Type = { mode: "scroll", size: 50 };

/** Read validated display choices; unavailable browser storage uses the default. */
export function readPreferences(userId: P.UserId) {
  try {
    const saved = localStorage.getItem(`talkto:message-display:${userId}`);
    return saved === null
      ? defaults
      : Option.getOrElse(
          Schema.decodeUnknownOption(Schema.fromJsonString(Preferences))(saved),
          () => defaults,
        );
  } catch {
    return defaults;
  }
}

/** Persist display choices when browser storage is available. */
export function writePreferences(userId: P.UserId, value: typeof Preferences.Type) {
  try {
    localStorage.setItem(`talkto:message-display:${userId}`, JSON.stringify(value));
  } catch {
    /* The component's session preference still applies. */
  }
}
