import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import * as P from "@talkto/api/platform";
import * as Share from "@talkto/api/share";
import { share } from "@talkto/api/pricing";
import { ApiError, denied, request } from "./api.js";
import { useHuman, useServices } from "./session.js";
import { forgetShareCode, readShareCode } from "./share-link.js";
import { showsGrant, useStarter } from "./starter.js";
import "./share.css";

/*
  Share TalkTo (docs/share-links-spec.md): one plain place on Billing with the owner's link, one
  sentence about what both people get, and a plain list of sign-ups. No counters, totals, progress
  or celebrations.
*/

const number = new Intl.NumberFormat("en-US");
const day = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
/** A date the way the share list writes it: "November 16". */
export const shareDate = (at: string) => day.format(new Date(at));

/** The one sentence both people read. */
export const shareSentence = (offer: Share.Offer) =>
  `When someone signs up with your link, you both get ${number.format(offer.messages)} free messages. Yours are added once their agents have sent ${number.format(offer.qualifyingMessages)} messages on ${offer.qualifyingDays} different days.`;
export const limitLine = (offer: Share.Offer) =>
  `You can receive this up to ${offer.sharerLimit} times.`;
export const paidLine = `This organization is on a paid plan, so your ${number.format(share.messages)} messages won’t be added here. The person you share with still gets theirs.`;
export const exhaustedLine =
  "You’ve received the most share messages. Your link no longer adds messages.";

/** One sign-up, naming nobody. */
export const referralLine = (referral: Share.Referral) => {
  const joined = `Joined ${shareDate(referral.joinedAt)}`;
  const messages = number.format(share.messages);
  switch (referral.status) {
    case "waiting":
      return `${joined} — waiting for ${number.format(share.qualifyingMessages)} messages on ${share.qualifyingDays} different days, until ${shareDate(referral.windowEndsAt)}`;
    case "qualified":
      if (referral.bonus === null || referral.bonus.status === "pending")
        return `${joined} — ${messages} messages being added`;
      if (referral.bonus.status === "not_added")
        return `${joined} — earned while on a paid plan, so not added`;
      return `${joined} — ${messages} messages added${referral.bonus.appliedAt === null ? "" : ` ${shareDate(referral.bonus.appliedAt)}`}`;
    case "capped":
      return `${joined} — joined after you received the most`;
    case "excluded":
      return `${joined} — not counted`;
    case "expired":
      return `${joined} — ended without qualifying`;
  }
};

/** What this organization got from signing up with someone's link. */
export const joinedLine = (joined: NonNullable<Share.State["joined"]>) => {
  const messages = number.format(share.messages);
  switch (joined.status) {
    case "added":
      return `You joined with a share link: ${messages} free messages were added.`;
    case "pending":
      return `You joined with a share link: ${messages} messages are being added.`;
    case "not_added":
      return "You joined with a share link, but this organization had no free allowance then, so nothing was added.";
  }
};

const shareKey = (userId: P.UserId, accountId: P.AccountId) =>
  ["human", userId, accountId, "share"] as const;
const accountParams = (accountId: P.AccountId) => ({ params: { accountId } });

/** The organization's share state. */
function useShare(accountId: P.AccountId) {
  const { api } = useServices();
  const user = useHuman();
  return useQuery({
    queryKey: shareKey(user.id, accountId),
    queryFn: ({ signal }) => request(api.share.state(accountParams(accountId)), signal),
    retry: false,
  });
}

/** The Billing page's share place, for the organization owner. */
export function SharePanel({ accountId }: { readonly accountId: P.AccountId }) {
  const { api } = useServices();
  const user = useHuman();
  const queries = useQueryClient();
  const result = useShare(accountId);
  const create = useMutation({
    mutationFn: () => request(api.share.link(accountParams(accountId))),
    onSuccess: (value) => queries.setQueryData(shareKey(user.id, accountId), value),
  });
  if (denied(result.error) || !result.data) return null;
  return (
    <ShareView
      state={result.data.data}
      creating={create.isPending}
      failed={create.isError}
      create={() => {
        if (!create.isPending) create.mutate();
      }}
    />
  );
}

/** Copy the link, saying plainly whether it worked. */
function CopyLink({ url }: { readonly url: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "manual">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setStatus("copied");
    } catch {
      setStatus("manual");
    }
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus("idle"), 2500);
  };
  return (
    <div className="share-link">
      <input
        type="text"
        readOnly
        value={url}
        aria-label="Your share link"
        onFocus={(event) => event.currentTarget.select()}
      />
      <button className="btn secondary" onClick={() => void copy()}>
        Copy
      </button>
      <span className="share-copy-status" role="status">
        {status === "copied"
          ? "Copied"
          : status === "manual"
            ? "Select the link and press ⌘C or Ctrl+C."
            : ""}
      </span>
    </div>
  );
}

/** The share place for one state; it holds no requests, so every state can be rendered. */
export function ShareView({
  state,
  creating = false,
  failed = false,
  create,
}: {
  readonly state: Share.State;
  readonly creating?: boolean;
  readonly failed?: boolean;
  readonly create: () => void;
}) {
  if (state.status === "unavailable") return null;
  const joined =
    state.joined === null ? null : <p className="share-joined">{joinedLine(state.joined)}</p>;
  if (state.status === "owner_only" || state.offer === null)
    return joined === null ? null : <div className="share-standalone">{joined}</div>;
  return (
    <section className="billing-panel share-panel" aria-label="Share TalkTo">
      <header>
        <h2>Share TalkTo</h2>
      </header>
      <div className="billing-panel-body">
        {joined}
        <p>{shareSentence(state.offer)}</p>
        {state.link === null ? (
          <div className="share-actions">
            <button className="btn secondary" aria-disabled={creating} onClick={create}>
              {creating ? "Getting your link…" : "Get my link"}
            </button>
            {failed && (
              <span className="share-copy-status" role="status">
                Your link could not be made. Try again.
              </span>
            )}
          </div>
        ) : (
          <CopyLink url={state.link.url} />
        )}
        <p className="starter-note">{limitLine(state.offer)}</p>
        {!state.free && <p className="starter-note">{paidLine}</p>}
        {state.exhausted && <p className="starter-note">{exhaustedLine}</p>}
        {state.referrals.length > 0 && (
          <ul className="share-list" aria-label="Sign-ups with your link">
            {state.referrals.map((referral) => (
              <li key={`${referral.joinedAt}:${referral.windowEndsAt}`}>
                {referralLine(referral)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

const Code = Schema.decodeUnknownOption(Share.Code);
/** Failures that say nothing about the code, so it is kept and sent again later. */
const transient = (error: Error) =>
  error instanceof ApiError &&
  [
    "connection_unavailable",
    "storage_unavailable",
    "identity_unavailable",
    "internal_error",
  ].includes(error.code);

/**
 * Send a share code kept from sign-up once the person owns an organization and has claimed its free
 * start (the organization is created first; the claim comes with its first server, and a join
 * before it would be refused). Renders nothing. The code is forgotten on any answer except a
 * failure to reach TalkTo; while no claim exists it is kept until it expires. The free-start state
 * is read only while a code is kept.
 */
export function ShareJoin({ account }: { readonly account: P.AccountContext }) {
  const { api } = useServices();
  const user = useHuman();
  const queries = useQueryClient();
  const sent = useRef(false);
  const owner = account.createdBy === user.id;
  // Only a kept code needs the free-start state. Without one, reading it would poll once a minute
  // on every page and wake each live server just to learn there is nothing to send.
  const [waiting, setWaiting] = useState(() => readShareCode() !== null);
  const starter = useStarter(owner && waiting ? account.id : null);
  const claimed = showsGrant(starter.data?.data);
  const join = useMutation({
    mutationFn: (code: Share.Code) =>
      request(api.share.join({ ...accountParams(account.id), payload: { code } })),
    onSuccess: (answer) => {
      forgetShareCode();
      setWaiting(false);
      if (!answer.data.joined) return;
      queries.setQueryData(shareKey(user.id, account.id), {
        data: answer.data.state,
        meta: answer.meta,
      });
      void queries.invalidateQueries({ queryKey: ["human", user.id, account.id, "starter"] });
    },
    onError: (error) => {
      // Kept for the next visit when TalkTo could not be reached; forgotten on any real answer.
      if (transient(error)) return;
      forgetShareCode();
      setWaiting(false);
    },
  });
  const { mutate } = join;
  useEffect(() => {
    if (!owner || !claimed || sent.current) return;
    const kept = readShareCode();
    if (kept === null) {
      setWaiting(false);
      return;
    }
    const code = Code(kept);
    if (code._tag === "None") {
      forgetShareCode();
      setWaiting(false);
      return;
    }
    sent.current = true;
    mutate(code.value);
  }, [owner, claimed, mutate]);
  return null;
}
