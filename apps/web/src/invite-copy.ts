/**
 * What an invitation does and who pays for messages, in the same words on Members, in onboarding
 * and on Billing. An invitation adds a person to the organization, never to a server; each server
 * is shared on its own. Messages count against the allowance of the organization that owns the
 * server they are sent on, whoever sends them.
 */
export const inviteScope =
  "They get an email invite to your organization. They see no server until you share it with them.";

export const inviteSent = (email: string) =>
  `Invitation sent to ${email}. Share each server with them from its Access button once they accept.`;

/**
 * The same, on a self-hosted copy that signs people in with Cloudflare Access: no email is sent,
 * and the invitation is accepted the first time that address signs in through Access.
 */
export const accessInviteScope =
  "No email is sent. They join your organization the first time they sign in here with this address, so your Cloudflare Access policy must let them in. They see no server until you share it with them.";

export const accessInviteSent = (email: string) =>
  `Invitation saved for ${email}. Send them this page's address; they join when they sign in. Then share each server with them from its Access button.`;

export const allowanceRule =
  "Messages on a server count toward its owner organization’s allowance, whoever sends them.";

/**
 * Inviting someone to one server from its page (docs/dashboard-api.md, "Server guests"). They
 * become a guest: they open that server and nothing else of the organization, and keep their own.
 */
export const guestInviteScope =
  "They can open this server and nothing else in your organization. They sign in with the address you invite.";

/** The answer to Invite or Resend. Until TalkTo sends these emails itself, `emailed` is false. */
export const guestInvited = (email: string, emailed: boolean) =>
  emailed
    ? `Invitation sent to ${email}.`
    : `Invitation ready for ${email}. Copy the link and send it yourself.`;

/** Beside every copyable join link. */
export const guestLinkRule = (email: string) => `The link works only for ${email}.`;

/** Above the list of pending invitations. */
export const guestLinksRule = "Each link works only for the address it was sent to.";

/** The people limit refused an invitation, by the plan whose limit applies. */
export const guestPeopleLimit = (plan: "Free" | "Shop", shopPeople: number) =>
  plan === "Free"
    ? { text: "Free includes only you.", action: "Choose a plan to invite people →" }
    : { text: `Shop includes ${shopPeople} people.`, action: "Move to Studio to invite more →" };

/** When a pending invitation's link stops working, or that it already has. */
export const guestExpiry = (expiresAt: string, now = new Date()) => {
  const left = new Date(expiresAt).getTime() - now.getTime();
  if (left <= 0) return "Expired. Resend to renew it.";
  if (left < 3_600_000) return "Expires in less than an hour";
  if (left < 86_400_000) {
    const hours = Math.floor(left / 3_600_000);
    return `Expires in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const days = Math.round(left / 86_400_000);
  return `Expires in ${days} ${days === 1 ? "day" : "days"}`;
};
