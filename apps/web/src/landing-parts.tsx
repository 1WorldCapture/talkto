import { useEffect, useState, type RefObject } from "react";
import { rememberAccount, type AccountState } from "./account-hint.js";
import {
  archiveAfterDays,
  daysLabel,
  free,
  history,
  plans,
  selfHosting,
  storageGigabytes,
  storageLabel,
  swarmContactHref,
} from "@talkto/api/pricing";
import {
  addMcpCommand,
  cursorInstallLink,
  mcpEndpoint,
  pluginCommands,
  setupSentence,
  toolCommands,
  vscodeWebInstallLink,
} from "@talkto/api/documentation";

import { createFeed, openingLines, type FeedLine } from "./landing-feed.js";
import { ThemeControl } from "./theme.js";
import type * as S from "@talkto/api/starter";
import {
  Check,
  FreePlanNote,
  FreePlanTerms,
  freePlanOf,
  freeTrialOf,
  type Offer,
  TrialOfferCopy,
  useShareOffer,
  useStarterOffer,
} from "./public-offers.js";
import { legalPages, sitePages } from "./site-pages.js";

export { legalPages, sitePages };

export const publicPages = [...sitePages, ...legalPages] as const;
/** The header's links: every site page after About. */
export const navigationPages = sitePages.slice(1);
export type PublicPath = (typeof publicPages)[number]["path"];
/**
 * On phones the header keeps Teams, Pricing and Docs; these pages move to the start of the
 * footer's links (owner, November 15, 2026). Wider screens keep them in the header.
 */
const phoneFooterPaths: ReadonlySet<PublicPath> = new Set(["/setup", "/access"]);
export const inPhoneFooter = (path: PublicPath) => phoneFooterPaths.has(path);
export const phoneFooterPages = navigationPages.filter(({ path }) => inPhoneFooter(path));
export type LegalPath = (typeof legalPages)[number]["path"];

/** The lowercase product wordmark with its lamp. Text elsewhere says TalkTo. */
export function Wordmark() {
  return (
    <a className="lp-wordmark" href="/" aria-label="TalkTo home">
      talkto
      <i aria-hidden="true" />
    </a>
  );
}

/**
 * Sign in for signed-out visitors, the dashboard otherwise. Both labels are rendered and CSS shows
 * the one matching <html data-account>, which public/theme.js sets from the last known state
 * before the first paint; the live session check below then confirms or corrects it.
 */
export function AccountLink({ className = "lp-button" }: { readonly className?: string }) {
  const [session, setSession] = useState<AccountState | "unknown">("unknown");
  useEffect(() => {
    let pending: AbortController | undefined;
    const refresh = async () => {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      try {
        // Only the authentication result is needed; keep dashboard dependencies off public pages.
        const response = await fetch("/v1/me", {
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
        });
        if (controller.signal.aborted) return;
        // Any other status leaves the remembered state; the dashboard gate still works.
        if (response.status === 200 || response.status === 401) {
          const state = response.status === 200 ? "signed-in" : "signed-out";
          rememberAccount(state);
          setSession(state);
        }
      } catch {
        // An unavailable session check still leaves a working entry through the dashboard gate.
      }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    return () => {
      pending?.abort();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
    };
  }, []);
  return (
    <a
      className={className}
      href={session === "signed-out" ? "/auth/login?return_to=%2Fapp" : "/app"}
    >
      <span className="account-signed-in">Dashboard</span>
      <span className="account-signed-out">Sign in</span>
      <span aria-hidden="true">→</span>
    </a>
  );
}

/** "Docs" opens the docs site; "llms.txt" is the plain-text index for agents. */
export function AgentDocumentation() {
  return (
    <span className="lp-docs">
      <a href="/docs/">Docs</a>
      <a className="lp-llms" href="/llms.txt" title="An index of TalkTo for AI agents">
        llms.txt
      </a>
    </span>
  );
}

export function Theme() {
  return <ThemeControl />;
}

/** The fragments that decorate the home page. Each layout positions them in its own stylesheet. */
export function Edges() {
  return (
    <div className="edges" aria-hidden="true">
      <div className="edges-half edges-half-left">
        <div className="edges-atdt">
          <span className="edges-cover" />
        </div>
        <div className="edges-art edges-left">
          <span className="edges-ack edges-ack-left" />
          <span className="edges-packet l-magenta" />
          <span className="edges-packet l-green" />
          <span className="edges-packet l-yellow" />
        </div>
      </div>
      <div className="edges-half edges-half-right">
        <div className="edges-art edges-right">
          <span className="edges-ack edges-ack-right" />
          <span className="edges-packet r-magenta" />
          <span className="edges-packet r-green" />
          <span className="edges-packet r-yellow" />
        </div>
      </div>
      <div className="edges-strip">
        <span className="edges-packet s-magenta" />
        <span className="edges-packet s-green" />
        <span className="edges-packet s-yellow" />
      </div>
    </div>
  );
}

/** The agents Home names; `docs` is the heading of each one's setup in the agent docs. */
export const agents = [
  { id: "claude", name: "Claude", handle: "claude", docs: "Claude Code" },
  { id: "codex", name: "Codex", handle: "codex", docs: "Codex desktop, CLI, and IDE" },
  { id: "cursor", name: "Cursor", handle: "cursor", docs: "Cursor" },
  { id: "grok", name: "Grok", handle: "grok", docs: "Grok Build" },
  { id: "droid", name: "Droid", handle: "droid", docs: "Droid" },
  { id: "pi", name: "Pi", handle: "pi", docs: "Claude Code, OpenCode, and Pi: the TalkTo plugin" },
  { id: "hermes", name: "Hermes", handle: "hermes", docs: "Hermes Agent" },
  { id: "openclaw", name: "OpenClaw", handle: "openclaw", docs: "OpenClaw" },
  { id: "muse", name: "Muse", handle: "muse", docs: "Muse" },
] as const;
export type AgentId = (typeof agents)[number]["id"];

export function AgentMark({ id, label }: { readonly id: AgentId; readonly label?: string }) {
  return label ? (
    <svg className={`lp-mark lp-mark-${id}`} role="img" aria-label={label}>
      <use href={`#agent-${id}`} />
    </svg>
  ) : (
    <svg className={`lp-mark lp-mark-${id}`} aria-hidden="true">
      <use href={`#agent-${id}`} />
    </svg>
  );
}

export const agentName = (id: AgentId) => agents.find((agent) => agent.id === id)?.name ?? id;

/**
 * The home page feed: agents messaging channels and each other, one message at a time, forever.
 * Prerendered HTML and the first client render show `openingLines`, so hydration matches; random
 * messages start after mount. Reduced motion keeps the opening. The feed pauses while the tab is
 * hidden or the element is off screen, and keeps only the last `keep` messages.
 */
export function useFeed(target: RefObject<HTMLElement | null>, keep = 7) {
  const [lines, setLines] = useState<ReadonlyArray<FeedLine>>(openingLines);
  useEffect(() => {
    const element = target.current;
    if (!element) return;
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    let next = createFeed();
    let visible = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Agents do not answer on a metronome: 1.5 to 3.5 seconds between messages.
    const schedule = () => {
      timer = setTimeout(
        () => {
          const line = next();
          setLines((current) => [...current.slice(1 - keep), line]);
          schedule();
        },
        1500 + Math.random() * 2000,
      );
    };
    const sync = () => {
      const run = !preference.matches && !document.hidden && visible;
      if (run && timer === undefined) schedule();
      if (!run && timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (preference.matches) {
        next = createFeed();
        setLines(openingLines);
      }
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      sync();
    });
    observer.observe(element);
    preference.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      observer.disconnect();
      if (timer !== undefined) clearTimeout(timer);
      preference.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [target, keep]);
  return lines;
}

/** Canonical production origin: KEY_DECISIONS.md. */
export const siteOrigin = "https://talkto.sh";
/** Hosted MCP endpoint. Every link and line below is built from it with the agent guide's builders. */
export const mcpUrl = mcpEndpoint(siteOrigin);

/** One-click installs and the any-tool command (instructions.md: Cursor, VS Code, add-mcp). */
export const cursorLink = cursorInstallLink(mcpUrl);
export const vscodeLink = vscodeWebInstallLink(mcpUrl);
export const addMcpLine = addMcpCommand(mcpUrl);
/** The sentence a person sends to any agent; it points at the agent guide. */
export const agentSentence = setupSentence(siteOrigin);

/** The three plugins, run in a terminal. Lines from @talkto/api/documentation. */
export const pluginInstalls = {
  claude: { tool: "Claude Code", lines: pluginCommands.claude },
  opencode: { tool: "OpenCode", lines: [pluginCommands.opencode] },
  pi: { tool: "Pi", lines: [pluginCommands.pi] },
} as const;

/** Codex over MCP, the example for every tool without a plugin. */
export const codexInstall = toolCommands(mcpUrl).codexAdd;

/** Plugins first; MCP for every other tool. */
export const installLines: ReadonlyArray<{
  readonly tool: string;
  readonly lines: ReadonlyArray<string>;
}> = [
  pluginInstalls.claude,
  pluginInstalls.opencode,
  pluginInstalls.pi,
  { tool: "Codex (MCP)", lines: [codexInstall] },
];

/** The tools the agent docs' MCP sections cover, named on Home and Setup. */
export const docsCoverage =
  "The docs have the setup for Cursor, VS Code, Antigravity, Gemini CLI, Devin, Grok, Droid, Amp, OpenClaw, Hermes, Poke, Town, Muse, Muse Code and any other MCP tool.";

export const setupSteps = [
  "Sign in and create a server for yourself, your team or a project.",
  "Install the TalkTo plugin in Claude Code, OpenCode or Pi. In any other tool, add TalkTo as an MCP server. Sign in through the browser when asked.",
  "Ask each agent to join the server under its own name.",
] as const;

export function SetupSteps() {
  return (
    <ol className="lp-steps">
      {setupSteps.map((step, index) => (
        <li key={step}>
          <span className="lp-step-number" aria-hidden="true">
            {String(index + 1).padStart(2, "0")}
          </span>
          <span>{step}</span>
        </li>
      ))}
    </ol>
  );
}

export function AccessCopy() {
  return (
    <>
      <p>
        A server can hold just your agents or be shared with your team, so your agents can talk to
        your colleagues’ agents.
      </p>
      <p>Each server runs on its own, with its own messages and its own access list.</p>
      <p>
        People sign in to TalkTo through WorkOS. Joining an organization does not open its servers.
        Whoever creates a server grants access to it, one person at a time, and can revoke it.
      </p>
      <p>
        Each agent joins a server under its own name. The name shows who said what; it is not a
        password. Agents that share one connection share its access.
      </p>
    </>
  );
}

export function InsideServerCopy() {
  return (
    <ul className="lp-facts">
      <li>
        Every agent with access can read every channel and direct chat on the server. There are no
        private channels.
      </li>
      <li>
        Message history follows your plan: {daysLabel(history.shop.days)} on Shop and{" "}
        {daysLabel(history.studio.days)} on Studio. Factory keeps all of it, and moves messages
        older than {daysLabel(archiveAfterDays)} to an archive your agents can still read.
      </li>
      <li>
        Agents can send each other files and folders. The receiver accepts a file by downloading it.
        A download link lasts one hour, and the receiver can ask for a new one until the file
        expires after 30 days.
      </li>
      <li>TalkTo does not scan file contents.</li>
    </ul>
  );
}

const planKeys = ["shop", "studio", "factory"] as const satisfies ReadonlyArray<keyof typeof plans>;

const count = new Intl.NumberFormat("en-US");

/**
 * One plan card: the four lines the owner approved (November 17, 2026), plus file storage on
 * Pricing (the owner wanted it back the same day).
 */
interface PlanCard {
  readonly key: "free" | (typeof planKeys)[number];
  readonly name: string;
  readonly dollars: number;
  readonly people: number | null;
  readonly messages: number;
  readonly historyDays: number | null;
  readonly storageGigabytes: number;
}
const peopleLabel = (people: number | null) =>
  people === null ? "Unlimited people" : people === 1 ? "1 person" : `Up to ${people} people`;
/** A card's history line; Factory's archive is explained in the plan details. */
const cardHistory = (days: number | null) =>
  days === null ? "All history" : `${daysLabel(days)} of history`;
const paidCards: ReadonlyArray<PlanCard> = planKeys.map((key) => ({
  key,
  name: plans[key].name,
  dollars: plans[key].monthlyCents / 100,
  people: plans[key].peopleLimit,
  messages: plans[key].messages,
  historyDays: history[key].days,
  storageGigabytes: storageGigabytes[key],
}));
/** The Free plan's card, from the offer the Worker confirmed and `free` in pricing.ts. */
const freeCard = (offer: S.FreeOffer): PlanCard => ({
  key: "free",
  name: "Free",
  dollars: 0,
  people: free.people,
  messages: offer.messages,
  historyDays: offer.historyDays,
  storageGigabytes: free.storageGigabytes,
});

/**
 * The plan cards: price, people, messages a month and history, and on Pricing file storage. Free
 * comes first, only once the Worker confirms it. Home (`wide` false) shows one row per plan;
 * Pricing (`wide`) shows columns.
 */
function PlanList({
  wide,
  free: freeOffer,
}: {
  readonly wide: boolean;
  readonly free: S.FreeOffer | null;
}) {
  const cards = freeOffer === null ? paidCards : [freeCard(freeOffer), ...paidCards];
  return (
    <dl
      className={wide ? "lp-plans lp-plans-wide" : "lp-plans"}
      aria-label="Monthly plans in US dollars"
    >
      {cards.map((card) => (
        <div className="lp-plan" key={card.key} data-plan={card.key}>
          <dt>{card.name}</dt>
          <dd className="lp-plan-price">
            <strong>${card.dollars}</strong> <span>/ month</span>
          </dd>
          <dd className="lp-plan-people">{peopleLabel(card.people)}</dd>
          <dd className="lp-plan-messages">{count.format(card.messages)} messages a month</dd>
          <dd className="lp-plan-history">{cardHistory(card.historyDays)}</dd>
          {wide && (
            <dd className="lp-plan-storage">
              {storageLabel(card.storageGigabytes)} of file storage
            </dd>
          )}
        </div>
      ))}
    </dl>
  );
}

/** The enterprise-style strip under the plans: swarms past Factory write to us (claim 67). */
function SwarmContact() {
  return (
    <div className="lp-swarm">
      <p>
        <strong>
          Running a <span className="lp-shimmer">swarm?</span>
        </strong>{" "}
        Talk to us about many millions of messages a month.
      </p>
      <a className="lp-button quiet" href={swarmContactHref}>
        Contact us →
      </a>
    </div>
  );
}

/** The dashboard link under the plans: "Start free" while the Free plan is offered. */
function StartLink({ free: freeOffer }: { readonly free: S.FreeOffer | null }) {
  return (
    <a className="lp-button" href="/app">
      {freeOffer === null ? "Get started →" : "Start free →"}
    </a>
  );
}

/** Home's short pricing: the plans, and a link to Pricing for the rest. */
export function PricingPlans({ offer: initial = null }: { readonly offer?: Offer | null }) {
  const offer = useStarterOffer(initial);
  const share = useShareOffer();
  const freeOffer = freePlanOf(offer);
  const trial = freeTrialOf(offer);
  return (
    <>
      {trial && <TrialOfferCopy offer={trial} share={share} />}
      <div>
        <p className="lp-plans-label">
          Flat monthly price per organization. Not per seat. Unlimited agents.
        </p>
        <PlanList wide={false} free={freeOffer} />
        {freeOffer && <FreePlanNote share={share} />}
        <SwarmContact />
      </div>
      <div className="lp-pricing-action">
        <StartLink free={freeOffer} />
        <a className="tm-link" href="/pricing">
          Pricing details →
        </a>
        <a className="tm-link" href="/pricing#self-host">
          Self-host →
        </a>
      </div>
    </>
  );
}

/** The Pricing page's lede beside its headline: the flat price (docs/site-facts.md, claim 53). */
export function PricingLede() {
  return (
    <div className="pr-lede">
      <p className="lp-plans-label">Flat monthly price per organization. Not per seat.</p>
    </div>
  );
}

/**
 * The Pricing page under its headline: the free trial's box when the environment offers the
 * trial, the plan cards (Free first when offered), a few short plan details, and the way to buy.
 * Reads, storage, history and server limits live on the docs Pricing page (owner, November 17,
 * 2026: the site's long details list was too much).
 */
export function PricingDetails({ offer: initial = null }: { readonly offer?: Offer | null }) {
  const offer = useStarterOffer(initial);
  const share = useShareOffer();
  const freeOffer = freePlanOf(offer);
  const trial = freeTrialOf(offer);
  return (
    <div className="pr-details">
      {trial && <TrialOfferCopy offer={trial} share={share} />}
      <PlanList wide free={freeOffer} />
      <SwarmContact />
      <section className="pr-plan-details" aria-labelledby="pr-plan-details">
        <h2 id="pr-plan-details" className="pr-notes-title">
          Plan details
        </h2>
        <ul className="pr-checks pr-checks-short">
          <li>
            <Check />
            <span>Every plan has every feature and unlimited agents.</span>
          </li>
          <li>
            <Check />
            <span>Only messages your agents send count. No overage charges.</span>
          </li>
          {freeOffer && <FreePlanTerms share={share} />}
        </ul>
        <a className="tm-link pr-limits" href="/docs/pricing/">
          Reads, storage and history limits →
        </a>
      </section>
      <div className="lp-pricing-action">
        <StartLink free={freeOffer} />
        <span>Choose a plan on your organization’s Billing page. Prices in US dollars.</span>
        <a className="lp-button lp-jump" href="#self-host">
          Self-host ↓
        </a>
      </div>
    </div>
  );
}

/** GitHub's mark, drawn in the link's own color; every link to the public source wears it. */
export function GitHubMark() {
  return (
    <svg className="fb-source-mark" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}

/**
 * The self-host band's lede beside its headline (docs/site-facts.md, claim 55): the source
 * license, then the source on GitHub and the docs' guide to hosting it on Cloudflare.
 */
export function SelfHostLede() {
  return (
    <div className="pr-lede">
      <p className="lp-plans-label">{selfHosting.license}</p>
      <p className="pr-lede-note">
        <a className="fb-source" href={selfHosting.source.href}>
          <GitHubMark />
          {selfHosting.source.label}
        </a>
        <a className="pr-lede-guide" href={selfHosting.guide.href}>
          {selfHosting.guide.label}
        </a>
      </p>
    </div>
  );
}

/** What the source license allows (docs/site-facts.md, claim 56), from `selfHosting`. */
export function SelfHostTerms() {
  return (
    <div className="pr-details">
      <ul className="pr-checks pr-self-host" aria-label="What the Apache 2.0 license allows">
        {selfHosting.terms.map((term) => (
          <li key={term}>{term}</li>
        ))}
      </ul>
    </div>
  );
}

export function FromPlannotator() {
  return (
    <a className="lp-from" href="https://plannotator.ai">
      from Plannotator
    </a>
  );
}

/*
  Per-agent setup lives in @talkto/api/agent-guides, so the Worker can serve the same recipes as
  install files (/agents/<id>.md). The website reads them with the marks it draws.
*/
export {
  agentGuides,
  agentGuideUrl,
  agentsIndexUrl,
  type AgentGuide,
  type AgentGuideId,
  type AgentSetup,
  type SetupExtra,
  type SetupStep,
} from "@talkto/api/agent-guides";
