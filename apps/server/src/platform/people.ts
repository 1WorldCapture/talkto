import { DateTime, Effect } from "effect";
import * as B from "@talkto/api/billing";
import { free } from "@talkto/api/pricing";
import type * as P from "@talkto/api/platform";
import type * as M from "@talkto/api/models";
import * as Model from "./model.js";
import type { Identity } from "./service.js";

/**
 * People limit that applies now: that of the paid period covering now, else of the active trial's
 * plan. Operator-granted accounts have none. With neither, an organization on the Free plan has
 * Free's one person, and any other (unpaid or lapsed) Shop's limit.
 */
export const limit = (standing: Model.Standing): number | null =>
  standing.unlimited
    ? null
    : standing.plan === null && standing.free
      ? free.people
      : B.plans[standing.plan ?? "shop"].peopleLimit;
/** The plan whose people limit applies, as refusals name it: Free on the Free plan, else Shop. */
export const limitName = (standing: Model.Standing): "Free" | "Shop" =>
  standing.plan === null && standing.free ? "Free" : "Shop";

/** A pending invitation holds a place until it expires. */
export const holdsPlace = (invitation: P.Invitation, at: M.Timestamp) =>
  invitation.state === "pending" &&
  DateTime.isGreaterThan(DateTime.makeUnsafe(invitation.expiresAt), DateTime.makeUnsafe(at));

const pages = 20;
const incomplete = () =>
  new Model.Failure({
    code: "identity_unavailable",
    message: "The organization's people could not be counted. Try again later.",
  });
const tally = Effect.fn("People.tally")(function* <A>(
  list: (after: string | undefined) => Effect.Effect<P.Page<A>, Model.Failure>,
  counts: (item: A) => boolean,
  stopAbove: number,
) {
  let total = 0;
  let after: string | undefined;
  for (let page = 0; page < pages; page++) {
    const result = yield* list(after);
    total += result.items.filter(counts).length;
    if (total > stopAbove || result.nextCursor === null) return total;
    after = result.nextCursor;
  }
  return yield* incomplete();
});

/**
 * Places server guests hold in an organization at `at` (docs/dashboard-api.md, "Server guests"):
 * each guest with access to at least one of its live servers who is not also an active member,
 * plus each other address with a pending, unexpired guest invitation to one of its live servers.
 */
export type GuestPlaces = (
  organizationId: P.OrganizationId,
  at: M.Timestamp,
) => Effect.Effect<number, Model.Failure>;

/**
 * Humans who hold a place in the organization: active members, pending unexpired invitations,
 * and server guests with their pending invitations. Agents are participants inside servers, never
 * organization members, so they never count. Counting stops once the total passes `stopAbove`.
 */
export const count = Effect.fn("People.count")(function* (
  identity: Identity["Service"],
  guestPlaces: GuestPlaces,
  organizationId: P.OrganizationId,
  at: M.Timestamp,
  stopAbove: number,
) {
  const guests = yield* guestPlaces(organizationId, at);
  if (guests > stopAbove) return guests;
  const members = yield* tally(
    (after) => identity.members(organizationId, after, 100),
    (member) => member.status === "active",
    stopAbove - guests,
  );
  if (guests + members > stopAbove) return guests + members;
  const invited = yield* tally(
    (after) => identity.invitations(organizationId, after),
    (invitation) => holdsPlace(invitation, at),
    stopAbove - guests - members,
  );
  return guests + members + invited;
});

/** Refusal that names the limit and the way out. */
export const reached = (
  people: number,
  peopleLimit: number,
  adding: boolean,
  plan: "Free" | "Shop" = "Shop",
) =>
  new Model.Failure({
    code: "people_limit_reached",
    message:
      plan === "Free"
        ? `Free includes ${peopleLimit} person, counting pending invitations. Choose Shop for up to ${B.plans.shop.peopleLimit} people or Studio for unlimited people, or cancel an invitation first.`
        : adding
          ? `Shop includes up to ${peopleLimit} people, counting pending invitations. Move to Studio for unlimited people, or cancel an invitation or remove someone first.`
          : `This organization has ${people} people, counting pending invitations. Shop includes up to ${peopleLimit}. Remove people or cancel invitations to ${peopleLimit} or fewer to switch to Shop, or choose Studio for unlimited people.`,
  });

/**
 * Fail unless the organization fits within `peopleLimit` after `adding` more people. `null` is
 * unlimited and makes no identity calls.
 */
export const ensureRoom = Effect.fn("People.ensureRoom")(function* (
  identity: Identity["Service"],
  guestPlaces: GuestPlaces,
  organizationId: P.OrganizationId,
  at: M.Timestamp,
  peopleLimit: number | null,
  adding: 0 | 1,
  plan: "Free" | "Shop" = "Shop",
) {
  if (peopleLimit === null) return;
  const people = yield* count(identity, guestPlaces, organizationId, at, peopleLimit - adding);
  if (people + adding > peopleLimit) return yield* reached(people, peopleLimit, adding === 1, plan);
});
