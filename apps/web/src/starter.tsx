import { useQuery } from "@tanstack/react-query";
import { free, history, starter } from "@talkto/api/pricing";
import * as P from "@talkto/api/platform";
import type * as S from "@talkto/api/starter";
import { denied, request } from "./api.js";
import { useHuman, useServices } from "./session.js";
import { starterQuery } from "./dashboard-queries.js";
import "./starter.css";

const number = new Intl.NumberFormat("en-US");
/** The offer as the specification words it; numbers come from the shared pricing facts. */
export const offerHeadline = `Free trial: ${number.format(starter.messages)} messages.`;
export const offerDetail = "No credit card. No time limit.";
/** The owner's November 13 rule: paying early never costs the free messages. */
export const carryLine = "Leftover messages carry over when you choose a plan.";
/** What the person sees once the allowance is spent. */
export const exhaustedLine = `You’ve used your ${number.format(starter.messages)} free trial messages. Choose a plan to keep sending.`;

/** The Free plan as the specification words it, while the environment offers it. */
export const freeHeadline = `Free plan: ${number.format(free.messages)} messages a month.`;
export const freeDetail = "No credit card.";
export const freeTerms = `One server. The messages are shared by your organization and start again each month. Reading and searching don’t use them. Message history is kept for ${history.free.days} days.`;
/** What the person sees once this month's Free plan messages are spent. */
export const freeExhaustedLine = `You’ve used this month’s ${number.format(free.messages)} Free plan messages. Sending resumes next month, or choose a plan to keep sending now.`;
const renewal = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});
/** When a Free plan month's messages start again, in the words the panel uses. */
export const renewsLine = (at: string) => `Starts again on ${renewal.format(new Date(at))}.`;

/**
 * Setup's one quiet line about the free start (owner, November 18, 2026), only while creating the
 * first server would open it for this person: the free start, or the Free plan where it replaces
 * it. Every other status says nothing here; a denial the person can fix comes back from creating.
 */
export function freeStartLine(state: S.State | undefined): string | null {
  if (state?.status !== "eligible") return null;
  if (state.offer !== null)
    return `Free to start: ${number.format(state.offer.messages)} messages, no card.`;
  if (state.free !== undefined)
    return `Free plan: ${number.format(state.free.messages)} messages a month, no card.`;
  return null;
}

/** Organization free-start state; available even when paid billing is not configured. */
export function useStarter(accountId: P.AccountId | null) {
  const { api } = useServices();
  const user = useHuman();
  return useQuery({
    ...starterQuery(api, user.id, accountId),
    enabled: accountId !== null,
    refetchInterval: (query) =>
      denied(query.state.error)
        ? false
        : query.state.data?.data.status === "provisioning"
          ? 5000
          : 60_000,
  });
}

/** The person's own eligibility, before an organization exists. */
export function useStarterEligibility() {
  const { api } = useServices();
  const user = useHuman();
  return useQuery({
    queryKey: ["human", user.id, "starter"],
    queryFn: ({ signal }) => request(api.starter.eligibility(), signal),
    retry: false,
  });
}

/** Statuses with a claimed allowance to show. */
export const showsGrant = (state: S.State | undefined) =>
  state !== undefined &&
  state.grant !== null &&
  (state.status === "provisioning" || state.status === "active" || state.status === "exhausted");

/**
 * What to say beside a first-server form. The offer appears only while the environment accepts
 * new free starts; expected denials explain the next step without blaming the person.
 */
export function StarterOffer({ state }: { readonly state: S.State | undefined }) {
  if (state?.free && !state.offer) return <FreeOffer status={state.status} />;
  if (!state?.offer) return null;
  switch (state.status) {
    case "eligible":
      return (
        <div className="starter-offer" role="note">
          <p>
            <strong>{offerHeadline}</strong> {offerDetail}
          </p>
          <p>
            One starter server. The messages are shared by your organization and do not refill.
            Reading and searching don’t use them. {carryLine}
          </p>
        </div>
      );
    case "verify_email":
      return (
        <div className="starter-offer" role="status">
          <p>
            Verify your email to start your free trial of {number.format(state.offer.messages)}{" "}
            messages. Open the link in your inbox, then create the server again.
          </p>
        </div>
      );
    case "sign_in_required":
      return (
        <div className="starter-offer" role="status">
          <p>
            Sign in again on this website to start your free trial of{" "}
            {number.format(state.offer.messages)} messages. Your server name is kept.
          </p>
        </div>
      );
    case "paused":
      return (
        <div className="starter-offer" role="status">
          <p>Free trials are temporarily unavailable. Try again later or choose a plan.</p>
        </div>
      );
    case "used":
      return (
        <div className="starter-offer" role="status">
          <p>The free trial is once per person. Choose a plan to keep sending.</p>
        </div>
      );
    case "server_limit":
      return (
        <div className="starter-offer" role="status">
          <p>
            You already have a server without a plan, which is the limit. Use that server, or choose
            a plan to add another.
          </p>
        </div>
      );
    default:
      return null;
  }
}

/** The Free plan beside a first-server form, while a claim would open it. */
function FreeOffer({ status }: { readonly status: S.Status }) {
  switch (status) {
    case "eligible":
      return (
        <div className="starter-offer" role="note">
          <p>
            <strong>{freeHeadline}</strong> {freeDetail}
          </p>
          <p>{freeTerms}</p>
        </div>
      );
    case "verify_email":
      return (
        <div className="starter-offer" role="status">
          <p>
            Verify your email to start the Free plan. Open the link in your inbox, then create the
            server again.
          </p>
        </div>
      );
    case "sign_in_required":
      return (
        <div className="starter-offer" role="status">
          <p>Sign in again on this website to start the Free plan. Your server name is kept.</p>
        </div>
      );
    case "paused":
      return (
        <div className="starter-offer" role="status">
          <p>The Free plan is temporarily unavailable. Try again later or choose a plan.</p>
        </div>
      );
    case "used":
      return (
        <div className="starter-offer" role="status">
          <p>The Free plan is once per person. Choose a plan to keep sending here.</p>
        </div>
      );
    case "server_limit":
      return (
        <div className="starter-offer" role="status">
          <p>
            You already have a server without a plan, which is the limit. Use that server, or choose
            a plan to add another.
          </p>
        </div>
      );
    default:
      return null;
  }
}

/**
 * Remaining free messages, the exhausted state and the explicit paid-plan action. There is no
 * countdown: the allowance has no end date. `plans` is where choosing a plan happens: null when
 * this environment cannot take a paid plan yet, absent when another billing step is in progress.
 */
export function StarterPanel({
  state,
  manage,
  plans,
  compact = false,
}: {
  readonly state: S.State;
  readonly manage: boolean;
  readonly plans?: string | null | undefined;
  readonly compact?: boolean;
}) {
  const grant = state.grant;
  if (!grant || !showsGrant(state)) return null;
  const onFree = state.free !== undefined;
  const title = onFree ? "Free plan" : "Free trial";
  const renews = onFree && grant.renewsAt !== undefined ? `${renewsLine(grant.renewsAt)} ` : "";
  const used = Math.min(grant.allowance, grant.used);
  const share = grant.allowance === 0 ? 0 : (100 * used) / grant.allowance;
  const exhausted = state.status === "exhausted" || grant.remaining === 0;
  const action =
    plans === undefined ? null : plans === null ? (
      <p className="starter-note">Paid plans are not available here yet.</p>
    ) : manage ? (
      <a className={exhausted ? "btn" : "btn secondary"} href={plans}>
        Choose a plan
      </a>
    ) : (
      <p className="starter-note">Ask the organization owner to choose a plan.</p>
    );
  return (
    <section
      className={`billing-panel starter-panel${compact ? " starter-panel-compact" : ""}`}
      aria-label={title}
    >
      <header>
        <h2>{title}</h2>
      </header>
      <div className="billing-panel-body">
        {state.status === "provisioning" ? (
          <p>
            Your starter server is being set up. Its {number.format(grant.allowance)} messages open
            when it is ready.
          </p>
        ) : exhausted ? (
          <>
            <p className="billing-usage-number">
              0<span> of {number.format(grant.allowance)} left</span>
            </p>
            <div className="billing-meter" aria-hidden="true">
              <span style={{ width: "100%" }} />
            </div>
            <p className="starter-exhausted" role="status">
              {onFree ? freeExhaustedLine : exhaustedLine}
            </p>
            <p className="starter-note">
              {renews}History stays readable. Nothing is charged automatically.
            </p>
            {action}
          </>
        ) : (
          <>
            <p className="billing-usage-number">
              {number.format(grant.remaining)}
              <span> of {number.format(grant.allowance)} left</span>
            </p>
            <div
              className="billing-meter"
              role="meter"
              aria-label={`${title} messages used`}
              aria-valuemin={0}
              aria-valuemax={grant.allowance}
              aria-valuenow={used}
            >
              <span style={{ width: `${share}%` }} />
            </div>
            {onFree ? (
              <p className="starter-note">
                {renews}Shared across this organization’s servers. Reading and searching don’t use
                messages. History is kept for {history.free.days} days.
              </p>
            ) : (
              <p className="starter-note">
                No time limit. Shared across this organization’s servers. Reading and searching
                don’t use messages. {carryLine}
              </p>
            )}
            {action}
          </>
        )}
      </div>
    </section>
  );
}

/** Home's first-server prompt and allowance summary, for the organization owner. */
export function StarterHome({
  account,
  create,
}: {
  readonly account: P.AccountContext;
  readonly create: () => void;
}) {
  const result = useStarter(account.id);
  const state = denied(result.error) ? undefined : result.data?.data;
  if (!state) return null;
  const plans = `/app/accounts/${account.id}/billing#plans`;
  if (state.status === "eligible" && state.free && account.permissions.createServer)
    return (
      <section className="starter-home" aria-label="Free plan">
        <div>
          <p>
            <strong>{freeHeadline}</strong> {freeDetail}
          </p>
          <p className="starter-note">One server for this organization.</p>
        </div>
        <button className="btn" onClick={create}>
          Create server
        </button>
      </section>
    );
  if (state.status === "eligible" && state.offer && account.permissions.createServer)
    return (
      <section className="starter-home" aria-label="Free trial">
        <div>
          <p>
            <strong>{offerHeadline}</strong> {offerDetail}
          </p>
          <p className="starter-note">One starter server for this organization.</p>
        </div>
        <button className="btn" onClick={create}>
          Create server
        </button>
      </section>
    );
  if (!showsGrant(state)) return null;
  return (
    <StarterPanel state={state} manage={account.permissions.manageBilling} plans={plans} compact />
  );
}
