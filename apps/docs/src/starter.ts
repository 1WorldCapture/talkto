/*
  Whether the docs describe the free trial. The static docs cannot ask a Worker, so they read the
  one switch at build time: `TALKTO_STARTER_ADMISSIONS_ENABLED` in apps/server/wrangler.production.jsonc.
  Flip that value and the next build describes the offer (or stops). The production preflight
  refuses "true" unless the claim secret is installed, so the docs never promise an offer that
  production keeps closed.
*/
import { existsSync, readFileSync } from "node:fs";

const productionConfig = new URL("../../server/wrangler.production.jsonc", import.meta.url);

/**
 * A switch's value in the config text. It must appear exactly once, uncommented, as "true" or
 * "false"; anything else fails the build instead of guessing.
 */
const switchValue = (name: string) => (config: string) => {
  const values = [
    ...config.matchAll(new RegExp(`^\\s*"${name}":\\s*"(true|false)",?\\s*$`, "gm")),
  ].map((match) => match[1]);
  if (values.length !== 1 || (values[0] !== "true" && values[0] !== "false"))
    throw new Error(
      `Expected one "${name}": "true" or "false" line in ${productionConfig.pathname}`,
    );
  return values[0] === "true";
};
/** The free-start switch, `TALKTO_STARTER_ADMISSIONS_ENABLED`, in the config text. */
export const starterSwitch: (config: string) => boolean = switchValue(
  "TALKTO_STARTER_ADMISSIONS_ENABLED",
);
/** The Free plan switch, `TALKTO_FREE_PLAN_ENABLED`, in the config text. */
export const freeSwitch: (config: string) => boolean = switchValue("TALKTO_FREE_PLAN_ENABLED");

/**
 * Production's free-trial switch, as the docs build sees it. A self-hosted build
 * (`TALKTO_SELF_HOSTED=true pnpm build:selfhost`) and a checkout without TalkTo's production
 * config have no free trial, so they describe no offer. In this repository
 * the docs test still requires the file and checks this value against it.
 */
export const starterPublished =
  process.env.TALKTO_SELF_HOSTED === "true" || !existsSync(productionConfig)
    ? false
    : starterSwitch(readFileSync(productionConfig, "utf8"));
/**
 * Whether the published offer is the Free plan rather than the free trial. Claims open the Free
 * plan only while admissions are open too, so it follows both switches.
 */
export const freePublished = starterPublished && freeSwitch(readFileSync(productionConfig, "utf8"));
