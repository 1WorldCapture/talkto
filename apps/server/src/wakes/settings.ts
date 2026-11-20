import { Context } from "effect";
import { parseKey } from "./crypto.js";

/** What this deployment offers. Both follow from the environment and never change at runtime. */
export interface Settings {
  /** A valid TALKTO_WAKE_KEY is bound: subscribed hosts (ChatGPT) can be woken. */
  readonly events: boolean;
  /** TALKTO_WAKE_TOKENS=on as well: pasted Claude routine, Grok Bot and Town tokens are stored. */
  readonly tokens: boolean;
}
/** Application port for the deployment's wake switches. */
export class WakeSettings extends Context.Service<WakeSettings, Settings>()(
  "@talkto/WakeSettings",
) {}
/** Read the switches; a malformed key turns every wake off rather than failing requests. */
export const fromEnv = (env: Env): Settings => {
  const events = parseKey(env.TALKTO_WAKE_KEY) !== null;
  return { events, tokens: events && env.TALKTO_WAKE_TOKENS === "on" };
};
/** Standalone and unit compositions: no wakes. */
export const off: Settings = { events: false, tokens: false };
