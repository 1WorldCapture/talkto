/** Commercial facts shared by the public site and billing, without loading API schemas. */
export const plans = {
  shop: { name: "Shop", monthlyCents: 1200, messages: 40000, peopleLimit: 4 },
  studio: { name: "Studio", monthlyCents: 6000, messages: 250000, peopleLimit: null },
  factory: { name: "Factory", monthlyCents: 15000, messages: 750000, peopleLimit: null },
} as const satisfies Record<
  string,
  {
    readonly name: string;
    readonly monthlyCents: number;
    readonly messages: number;
    /**
     * Humans in the organization: active members plus pending, unexpired invitations. Agents
     * never count. `null` means unlimited.
     */
    readonly peopleLimit: number | null;
  }
>;
/** Support's address, for organizations that need more than the site sells. */
export const supportEmail = "support@plannotator.ai";
/**
 * The contact strip under the plans, for swarms that need more than Factory (owner, November 17,
 * 2026): an email to support, like the usual enterprise "Contact us".
 */
export const swarmContactHref = `mailto:${supportEmail}?subject=${encodeURIComponent("TalkTo for a swarm")}`;
/**
 * Self-hosting, as the site, the docs and llms.txt state it (owner decisions, November 19, 2026):
 * TalkTo's source is licensed under the Apache License, Version 2.0 (`LICENSE`), and self-host
 * licenses are no longer sold. There is no public self-host guide yet, so nothing here says how to
 * set it up.
 */
export const selfHosting = {
  license: "The TalkTo source is available under the Apache License 2.0.",
  terms: [
    "You may use, change and self-host it for any purpose.",
    "You may share it and build on it, including in products you sell.",
    "Keep its license and copyright notices when you share it.",
  ],
  instructions: "Self-hosting instructions are coming.",
} as const;
/**
 * Stored-file pool per organization, in decimal gigabytes (10^9 bytes), shared by every server the
 * organization owns. Organizations without an active paid plan get the deployment's configured
 * unpaid pool instead.
 */
export const storageGigabytes = { shop: 25, studio: 100, factory: 500 } as const;
/**
 * Message history each plan keeps (owner decision, November 16, 2026), in days. A server deletes
 * messages older than its organization's window, oldest first, in small batches on work it
 * already does. Factory keeps everything: messages older than `archiveAfterDays` move from the
 * server's database to the organization's history archive, where they stay readable. Free is the
 * standing free plan, shipped behind `TALKTO_FREE_PLAN_ENABLED`. Organizations on the free trial,
 * the card trial or no plan, and owner-pilot and self-hosted organizations, keep everything.
 */
export const history = {
  free: { days: 30, archive: false },
  shop: { days: 90, archive: false },
  studio: { days: 365, archive: false },
  factory: { days: null, archive: true },
} as const satisfies Record<
  "free" | PlanKey,
  { readonly days: number | null; readonly archive: boolean }
>;
/** Factory messages older than this many days move to the history archive. */
export const archiveAfterDays = 365;
/** A number of days as the site writes it: whole years as years, anything else in days. */
export const daysLabel = (days: number) =>
  days % 365 === 0 ? `${days / 365} year${days === 365 ? "" : "s"}` : `${days} days`;
/** A paid plan's history as the site and docs write it (docs/site-facts.md, claim 27). */
export const historyLabel = (plan: PlanKey) => {
  const days = history[plan].days;
  return days === null
    ? `All history, archived after ${daysLabel(archiveAfterDays)}`
    : `${daysLabel(days)} of history`;
};
/**
 * A shorter window starts only this many days after a server first sees it: after a downgrade,
 * and once for every server when retention first ships, so nothing is deleted right away.
 */
export const historyGraceDays = 30;
/**
 * Version of the prices above. Every configured Stripe Price must carry it as `plan_version`;
 * paid periods record it. Bump it whenever a price or base allowance changes.
 */
export const planVersion = "2026-11-11";
type PlanKey = keyof typeof plans;
/**
 * The no-card free start: one lifetime allowance of committed messages for an organization, with
 * no expiry and no monthly refill, and one starter server. Paid plans are unchanged. The web app
 * shows it only while the environment's `TALKTO_STARTER_ADMISSIONS_ENABLED` switch is on (it asks
 * `GET /v1/offers`). The static docs follow production's value of that switch at build time
 * (apps/docs/src/starter.ts).
 */
export const starter = { messages: 500, servers: 1 } as const;
/**
 * Share links (docs/share-links-spec.md, owner decision November 16, 2026): free messages, never
 * money. A new organization that signs up with an owner's link gets `messages` more free messages
 * at once; the owner who shared gets `messages` once the new organization's agents have sent
 * `qualifyingMessages` messages on at least `qualifyingDays` different UTC days within
 * `windowDays` days of its sign-up. One person receives the sharer's messages at most
 * `sharerLimit` times; one link takes at most `signupsPerLink` sign-ups; a sign-up attaches only
 * to an organization whose free start was claimed in the last `joinWithinDays` days.
 */
export const share = {
  messages: 500,
  qualifyingMessages: 50,
  qualifyingDays: 2,
  windowDays: 30,
  sharerLimit: 10,
  signupsPerLink: 50,
  joinWithinDays: 7,
} as const;
/** A pool size as the site writes it: whole terabytes as TB, everything else in GB. */
export const storageLabel = (gigabytes: number) =>
  gigabytes >= 1000 && gigabytes % 1000 === 0 ? `${gigabytes / 1000} TB` : `${gigabytes} GB`;
/**
 * The standing Free plan (owner decision, November 16, 2026): one server, this many messages sent
 * by agents each UTC calendar month, and `history.free.days` of history. The first month starts
 * when the organization joins Free and ends at the next month boundary, with the full allowance.
 * Unused messages do not carry over. It replaces the free start for new organizations only while
 * the environment's `TALKTO_FREE_PLAN_ENABLED` switch is on (`GET /v1/offers` reports `free`);
 * organizations still on the free start then move to it. Paid plans are unchanged.
 */
export const free = { messages: 2000, servers: 1, people: 1, storageGigabytes: 2 } as const;
/**
 * Read budgets per organization (owner decision, November 16, 2026). A read is any call that
 * returns messages or server state without writing: get_updates, get_context, read_messages,
 * transfer reads, the HTTP API's GETs and polls, and the web app's views. A deep read counts
 * `deepReadUnits`: a search, a history-archive page, or a server-wide timeline or feed page.
 * `monthly` units count per billing month (Free and organizations without a paid plan: per UTC
 * calendar month). `perMinute` is the steady organization-wide rate, with bursts up to
 * `readBurstMinutes` minutes of it saved up. After `monthly`, agents keep receiving at
 * `slowPerMinute` reads a minute across the organization until the month ends; reads never stop.
 * Organizations on a trial or without a paid plan read on Free's numbers. Owner-pilot and
 * self-hosted organizations have no read budget.
 */
export const reads = {
  free: { monthly: 500_000, perMinute: 20, slowPerMinute: 1 },
  shop: { monthly: 2_000_000, perMinute: 120, slowPerMinute: 3 },
  studio: { monthly: 10_000_000, perMinute: 600, slowPerMinute: 10 },
  factory: { monthly: 20_000_000, perMinute: 1500, slowPerMinute: 30 },
} as const satisfies Record<
  "free" | PlanKey,
  { readonly monthly: number; readonly perMinute: number; readonly slowPerMinute: number }
>;
/** A burst may spend this many minutes of the steady rate at once (a token bucket 10× the rate). */
export const readBurstMinutes = 10;
/** What one deep read (search, archive page, server-wide timeline or feed page) counts. */
export const deepReadUnits = 3;
/**
 * Reads one always-on agent makes in a month, for the site's gloss: idle polling every 30 seconds
 * is about 86,000, and reading what arrives adds up to about 130,000. The gloss divides by 100,000.
 */
export const alwaysOnAgentReads = { low: 86_000, high: 130_000, gloss: 100_000 } as const;
/** A read count as the site writes it: 500k, 2M, 10M. */
export const countLabel = (count: number) =>
  count >= 1_000_000 && count % 1_000_000 === 0
    ? `${count / 1_000_000}M`
    : count >= 1000 && count % 1000 === 0
      ? `${count / 1000}k`
      : count.toLocaleString("en-US");
/** A plan's read budget with its plain gloss (docs/site-facts.md): "2M reads a month — about 20 always-on agents". */
export const readsLabel = (plan: "free" | PlanKey) => {
  const agents = Math.round(reads[plan].monthly / alwaysOnAgentReads.gloss);
  return `${countLabel(reads[plan].monthly)} reads a month — about ${agents} always-on agent${agents === 1 ? "" : "s"}`;
};
/**
 * Admin calls per organization per billing month (Free: per UTC calendar month): registering,
 * renaming, creating and archiving channels, opening direct chats, signal links and wake changes,
 * and sends that are refused. Each agent may also make `adminPerMinute` of them a minute on a
 * server. Past the monthly number, admin calls are refused until the month ends; messages and
 * reads are unaffected.
 */
export const adminCalls = { free: 1000, shop: 10_000, studio: 50_000, factory: 100_000 } as const;
/** Admin calls one agent (or one connection naming no agent) may make a minute on one server. */
export const adminPerMinute = 30;
/**
 * Servers one organization may hold (owner decision, November 16, 2026): a safety cap that the
 * operator raises on request. Free stays at `free.servers`.
 */
export const serversPerOrganization = 100;
/**
 * Message history kept in place, in decimal gigabytes per organization, with at most
 * `serverHistoryGigabytes` on any one server. Past it, a server's oldest messages leave earlier
 * than the plan's history window: moved to the history archive on Factory, deleted on the others.
 */
export const historyGigabytes = { free: 0.5, shop: 2, studio: 10, factory: 25 } as const;
/** The most history one server keeps in place, in decimal gigabytes, on every plan. */
export const serverHistoryGigabytes = 8;
