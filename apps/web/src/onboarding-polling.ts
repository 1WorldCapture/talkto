import type * as O from "@talkto/api/onboarding";
/** How often setup checks for an agent or teammate while it waits for one. */
export const progressPollMs = 5_000;
/**
 * How long setup keeps checking after the last step change, focus, or "Check now". Installing
 * TalkTo and signing in often takes several minutes in another app, so this matches the invite
 * join page's 30 minutes rather than stopping while "Waiting…" is still on screen.
 */
export const progressWatchMs = 30 * 60_000;
/**
 * The steps that show a waiting state: agents joining, or a teammate accepting. While one is on
 * screen, setup polls and also checks as soon as the person returns to the page.
 */
export const awaitsProgress = (step: O.Step) => step === "agents" || step === "share";
/** How often the setup progress query polls now, or false when it should not. */
export function progressInterval(options: {
  readonly step: O.Step;
  readonly visible: boolean;
  readonly watchingSince: number;
  readonly now: number;
}): number | false {
  const watching = options.now - options.watchingSince < progressWatchMs;
  return awaitsProgress(options.step) && options.visible && watching ? progressPollMs : false;
}
