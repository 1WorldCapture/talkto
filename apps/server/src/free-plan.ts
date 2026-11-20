import { Config, Schema } from "effect";
import * as Entitlements from "./account-entitlements.js";

/**
 * The standing Free plan's switch (owner decision, November 16, 2026). Off by default and off in
 * production until the owner turns it on (docs/production-deployment.md, "Turning on the Free
 * plan"). On: new organizations get the Free plan instead of the one-time free trial, and every
 * organization still on the free trial moves to Free at its next send or Billing read. Off: the
 * free trial works exactly as before. An organization already on Free keeps it if the switch is
 * turned off again. A self-hosted copy never has it.
 */
export const switchName = "TALKTO_FREE_PLAN_ENABLED";
const Flag = Schema.Union([Schema.Boolean, Schema.Literals(["true", "false"])]);
const Setting = Schema.Struct({ [switchName]: Schema.optionalKey(Flag) });

/** The switch as Config, for configuration read through a provider. */
export const enabledConfig = Config.all({
  value: Config.schema(Flag, switchName).pipe(Config.withDefault(false)),
  selfHosted: Entitlements.selfHosted,
}).pipe(Config.map(({ value, selfHosted }) => (value === true || value === "true") && !selfHosted));

/** The same switch where no Config provider is in scope (the quota object). Malformed is off. */
export const isEnabled = (env: Env) => {
  const parsed = Schema.decodeUnknownOption(Setting)(env);
  if (parsed._tag === "None" || Entitlements.isSelfHosted(env)) return false;
  const value = parsed.value[switchName];
  return value === true || value === "true";
};

const day = 86_400_000;
/** The first instant of the UTC calendar month containing `at`. */
export const monthStart = (at: number) => {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
};
/** The first instant of the next UTC calendar month after `at`. */
export const nextMonth = (at: number) => {
  const date = new Date(monthStart(at) + 32 * day);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
};
