import { useEffect, useState } from "react";
import { Schema } from "effect";
import * as S from "@talkto/api/starter";
import type * as Share from "@talkto/api/share";

const Response = Schema.Struct({ data: S.PublicOffers });
const decode = Schema.decodeUnknownOption(Response);
const number = new Intl.NumberFormat("en-US");

let pending: Promise<S.PublicOffers | null> | undefined;
/** One `/v1/offers` request per page load, shared by every offer on the page. */
const publicOffers = () => {
  pending ??= (async () => {
    try {
      const response = await fetch("/v1/offers", {
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return null;
      const parsed = decode(await response.json());
      return parsed._tag === "Some" ? parsed.value.data : null;
    } catch {
      // No answer means no offer: the plans stand on their own.
      return null;
    }
  })();
  return pending;
};
/** The no-card offer an environment makes: the Free plan or the free trial, never both. */
export type Offer = S.Offer | S.FreeOffer;
const isFree = (offer: Offer): offer is S.FreeOffer => "historyDays" in offer;
const starterOf = (offers: S.PublicOffers): Offer | null => offers.free ?? offers.starter;
const shareOf = (offers: S.PublicOffers) => offers.share ?? null;
function usePublicOffer<A>(initial: A, pick: (offers: S.PublicOffers) => A) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    let mounted = true;
    void publicOffers().then((offers) => {
      if (mounted && offers !== null) setValue(pick(offers));
    });
    return () => {
      mounted = false;
    };
  }, [pick]);
  return value;
}

/**
 * The Free plan or the free start, as this environment offers it. Prerendered pages start without
 * it and show it only after the Worker confirms its switch is on, so the site never advertises an
 * offer the environment cannot honor.
 */
export const useStarterOffer = (initial: Offer | null = null) => usePublicOffer(initial, starterOf);
/**
 * This environment's share-link offer (docs/share-links-spec.md). Prerendered pages have none; the
 * line appears only once the Worker says share links are on.
 */
export const useShareOffer = (initial: Share.Offer | null = null) =>
  usePublicOffer(initial, shareOf);

/** The share-link line in the no-card offer's terms (docs/site-facts.md, claim 66). */
function ShareTerm({ share }: { readonly share: Share.Offer | null | undefined }) {
  if (!share) return null;
  return (
    <li>
      <Check />
      <span>
        Share your link: when someone signs up with it, you both get {number.format(share.messages)}{" "}
        free messages.
      </span>
    </li>
  );
}

/** The check that marks a short fact line on Pricing; decoration, so hidden from assistive tech. */
export function Check() {
  return (
    <svg className="lp-check" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 8.5 6.5 12 13 4.5" />
    </svg>
  );
}

/** The Free plan, when that is the offer the environment makes; otherwise null. */
export const freePlanOf = (offer: Offer | null): S.FreeOffer | null =>
  offer !== null && isFree(offer) ? offer : null;
/** The free trial, when that is the offer the environment makes; otherwise null. */
export const freeTrialOf = (offer: Offer | null): S.Offer | null =>
  offer !== null && !isFree(offer) ? offer : null;

/**
 * The Free plan's terms (docs/site-facts.md, claim 64), as one line in Pricing's plan details. The
 * Free plan itself is the first card in the plan table, so it has no box of its own.
 */
export function FreePlanTerms({ share = null }: { readonly share?: Share.Offer | null }) {
  return (
    <>
      <li data-offer="free">
        <Check />
        <span>
          Free needs no credit card and is once per person. Nothing is charged automatically.
        </span>
      </li>
      <ShareTerm share={share} />
    </>
  );
}

/** Home's one line under the plans while the Free plan is offered (claims 64 and 66). */
export function FreePlanNote({ share = null }: { readonly share?: Share.Offer | null }) {
  return (
    <p className="lp-plans-note" data-offer="free">
      Free needs no credit card and is once per person. Nothing is charged automatically.
      {share && (
        <>
          {" "}
          Share your link: when someone signs up with it, you both get{" "}
          {number.format(share.messages)} free messages.
        </>
      )}
    </p>
  );
}

/**
 * The free trial's box above the plans, where the environment offers the trial rather than the
 * Free plan; see docs/site-facts.md, claims 49 to 52. The offer and its action
 * lead; the terms follow as short lines. No nested `div`: the copy test reads the block up to its
 * first closing `div`.
 */
export function TrialOfferCopy({
  offer,
  share = null,
}: {
  readonly offer: S.Offer;
  readonly share?: Share.Offer | null;
}) {
  const messages = number.format(offer.messages);
  return (
    <div className="lp-starter" data-offer="starter">
      <p className="lp-starter-head">
        <strong>
          <em>Free trial:</em> {messages} messages.
        </strong>{" "}
        No credit card. No time limit.
      </p>
      <a className="lp-button lp-starter-action" href="/app">
        Start free trial →
      </a>
      <ul className="lp-starter-terms">
        <li>
          <Check />
          <span>One starter server, once per person.</span>
        </li>
        <li>
          <Check />
          <span>The {messages} messages are shared by your organization and do not refill.</span>
        </li>
        <li>
          <Check />
          <span>When they run out, sending pauses until you choose a plan.</span>
        </li>
        <li>
          <Check />
          <span>Nothing is charged automatically.</span>
        </li>
        <li>
          <Check />
          <span>Leftover messages carry over when you choose a plan.</span>
        </li>
        <ShareTerm share={share} />
      </ul>
    </div>
  );
}
