/*
  Every TalkTo email: short, plain text plus a simple HTML copy of the same words. No images, no
  tracking pixels, no tracked links. Each links to the dashboard page that fixes the problem.

  This module imports nothing, so the owner's `pnpm email:announce --dry-run` can load it straight
  from Node to preview an announcement exactly as the Worker renders it.
*/

/** Plans by key, as stored in billing state. */
export type Plan = "shop" | "studio" | "factory";

/** What a template needs, by kind. Never an email address. */
export type Input =
  | {
      readonly kind: "allowance";
      readonly accountId: string;
      readonly organization: string;
      readonly threshold: 80 | 100;
      readonly used: number;
      readonly allowance: number;
      readonly funding: "paid" | "trial" | "starter" | "free";
      readonly periodEnd: string | null;
    }
  | {
      readonly kind: "payment";
      readonly accountId: string;
      readonly organization: string;
      readonly plan: Plan | null;
    }
  | {
      readonly kind: "plan_kept";
      readonly accountId: string;
      readonly organization: string;
      readonly plan: Plan;
      readonly kept: Plan;
      readonly at: string;
      readonly people: number;
    }
  | {
      readonly kind: "plugin_update";
      readonly accountId: string;
      readonly organization: string;
      readonly plugin: string;
      readonly installed: string;
      readonly latest: string;
    }
  | { readonly kind: "product_update"; readonly announcementId: string }
  | {
      readonly kind: "organization_deleted";
      readonly accountId: string;
      readonly organization: string;
      readonly by: string;
    }
  | {
      readonly kind: "server_invitation";
      readonly invitationId: string;
      readonly sends: number;
      readonly server: string;
      readonly organization: string;
      readonly inviter: string;
      readonly expiresAt: string;
    }
  | {
      readonly kind: "server_joined";
      readonly invitationId: string;
      readonly accountId: string;
      readonly serverId: string;
      readonly server: string;
      readonly organization: string;
      readonly guest: string;
    };

/** A rendered email, before the recipient and delivery headers are added. */
export interface Rendered {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** Context a template needs beyond its payload. */
export interface Context {
  readonly origin: string;
  /** The signed one-click link; product updates only. */
  readonly unsubscribeUrl?: string;
  /** The announcement's subject and Markdown body; product updates only. */
  readonly announcement?: { readonly subject: string; readonly body: string };
}

const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const count = (value: number) => new Intl.NumberFormat("en-US").format(value);
const day = (value: string) =>
  new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(new Date(value));
/**
 * A name someone else chose (a person, server or organization) as it may appear in a subject or a
 * sentence: one line, no control or text-direction characters, at most 80 characters.
 */
const named = (value: string) => {
  const characters = Array.from(
    value
      .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
      .replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, " ")
      .trim(),
  );
  const line =
    characters.length > 80 ? `${characters.slice(0, 79).join("").trimEnd()}…` : characters.join("");
  return line === "" ? "Someone" : line;
};
const planName = (plan: Plan | null) =>
  plan === null ? "TalkTo" : `${plan.charAt(0).toUpperCase()}${plan.slice(1)}`;

/**
 * One block of an email: a paragraph, a heading, a list, or a call to action. `plain` is a
 * paragraph that carries names other people chose, so no Markdown in it becomes a link.
 */
type Block =
  | { readonly type: "p"; readonly text: string }
  | { readonly type: "plain"; readonly text: string }
  | { readonly type: "h"; readonly text: string }
  | { readonly type: "ul"; readonly items: ReadonlyArray<string> }
  | { readonly type: "link"; readonly label: string; readonly url: string };

/** Inline Markdown for announcements: links (https only), bold and code. Escapes everything else. */
const inline = (value: string) =>
  escape(value)
    .replace(
      /\[([^\]]{1,200})\]\((https:\/\/[^\s)]{1,500})\)/g,
      (_, label: string, url: string) => `<a href="${url}" style="color:inherit">${label}</a>`,
    )
    .replace(/\*\*([^*]{1,200})\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]{1,200})`/g, "<code>$1</code>");
/** The same inline Markdown as plain text: a link becomes "label (url)". */
const plainInline = (value: string) =>
  value
    .replace(/\[([^\]]{1,200})\]\((https:\/\/[^\s)]{1,500})\)/g, "$1 ($2)")
    .replace(/\*\*([^*]{1,200})\*\*/g, "$1")
    .replace(/`([^`]{1,200})`/g, "$1");

/** Paragraphs, `#`/`##` headings and `-` lists, separated by blank lines. */
const markdown = (body: string): ReadonlyArray<Block> =>
  body
    .replaceAll("\r\n", "\n")
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk): Block => {
      const lines = chunk.split("\n");
      if (lines.every((line) => /^[-*] /.test(line)))
        return { type: "ul", items: lines.map((line) => line.slice(2).trim()) };
      if (/^#{1,3} /.test(chunk) && lines.length === 1)
        return { type: "h", text: chunk.replace(/^#{1,3} /, "") };
      return { type: "p", text: lines.join(" ") };
    });

const textOf = (blocks: ReadonlyArray<Block>, footer: ReadonlyArray<string>) =>
  [
    ...blocks.map((block) => {
      switch (block.type) {
        case "p":
        case "h":
          return plainInline(block.text);
        case "plain":
          return block.text;
        case "ul":
          return block.items.map((item) => `- ${plainInline(item)}`).join("\n");
        case "link":
          return `${block.label}: ${block.url}`;
      }
    }),
    "--",
    ...footer,
  ].join("\n\n");

const htmlOf = (
  subject: string,
  blocks: ReadonlyArray<Block>,
  footer: ReadonlyArray<{ readonly text: string; readonly link?: string; readonly url?: string }>,
) => {
  const body = blocks
    .map((block) => {
      switch (block.type) {
        case "p":
          return `<p style="margin:0 0 16px">${inline(block.text)}</p>`;
        case "plain":
          return `<p style="margin:0 0 16px">${escape(block.text)}</p>`;
        case "h":
          return `<h2 style="margin:24px 0 12px;font-size:17px;line-height:1.4">${inline(block.text)}</h2>`;
        case "ul":
          return `<ul style="margin:0 0 16px;padding-left:20px">${block.items.map((item) => `<li style="margin:0 0 6px">${inline(item)}</li>`).join("")}</ul>`;
        case "link":
          return `<p style="margin:24px 0"><a class="action" href="${escape(block.url)}" style="display:inline-block;padding:10px 16px;background:#111111;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600">${escape(block.label)}</a></p>`;
      }
    })
    .join("\n");
  const notes = footer
    .map(
      (line) =>
        `<p style="margin:0 0 8px">${escape(line.text)}${line.link !== undefined && line.url !== undefined ? ` <a href="${escape(line.url)}" style="color:inherit">${escape(line.link)}</a>` : ""}</p>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escape(subject)}</title>
<style>
@media (prefers-color-scheme: dark) {
  body, .page { background:#151515 !important; color:#ededed !important; }
  .note { color:#a3a3a3 !important; border-color:#333333 !important; }
  .action { background:#ededed !important; color:#151515 !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:#ffffff;color:#111111">
<div class="page" style="max-width:560px;margin:0 auto;padding:32px 24px;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#ffffff;color:#111111">
<p style="margin:0 0 24px;font-weight:700;font-size:15px">TalkTo</p>
${body}
<div class="note" style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e5e5;color:#666666;font-size:13px;line-height:1.5">${notes}</div>
</div>
</body>
</html>`;
};

const account = (subject: string, organization: string, blocks: ReadonlyArray<Block>): Rendered => {
  const footer = `You’re getting this because you own ${organization} on TalkTo. Account emails like this one can’t be turned off.`;
  return {
    subject,
    text: textOf(blocks, [footer]),
    html: htmlOf(subject, blocks, [{ text: footer }]),
  };
};

/** Render one email from its stored payload. */
export const render = (payload: Input, context: Context): Rendered => {
  switch (payload.kind) {
    case "allowance": {
      const billing = `${context.origin}/app/accounts/${payload.accountId}/billing`;
      const usage = `${payload.organization} has used ${count(payload.used)} of its ${count(payload.allowance)} messages`;
      const period =
        (payload.funding === "paid" || payload.funding === "free") && payload.periodEnd !== null
          ? ` this month, which ends on ${day(payload.periodEnd)}`
          : payload.funding === "trial"
            ? " in its trial"
            : " from the free trial";
      if (payload.threshold === 80) {
        const after =
          payload.funding === "paid"
            ? "When they run out, a small cushion lets agents keep going briefly, then new messages pause until the next month starts. A bigger plan adds messages right away."
            : payload.funding === "free"
              ? "When they run out, new messages pause until the next month starts, or until you choose a plan. Reading history keeps working."
              : "When they run out, agents can’t send new messages until you choose a plan. Reading history keeps working.";
        return account(
          `TalkTo: ${payload.organization} has used 80% of its messages`,
          payload.organization,
          [
            { type: "p", text: `${usage}${period}.` },
            { type: "p", text: after },
            { type: "link", label: "Open Billing", url: billing },
          ],
        );
      }
      const after =
        payload.funding === "paid"
          ? "A small cushion lets agents keep going briefly. After that, new messages pause until the next month starts. Move to a bigger plan to keep sending now."
          : payload.funding === "free"
            ? "New messages pause until the next month starts. Choose a plan to keep sending now. Reading history keeps working."
            : "Agents can’t send new messages until you choose a plan. Reading history keeps working.";
      return account(
        `TalkTo: ${payload.organization} has used all its messages`,
        payload.organization,
        [
          { type: "p", text: `${usage}${period}.` },
          { type: "p", text: after },
          { type: "link", label: "Open Billing", url: billing },
        ],
      );
    }
    case "payment":
      return account(
        `TalkTo: the payment for ${payload.organization} didn’t go through`,
        payload.organization,
        [
          {
            type: "p",
            text: `The payment for ${payload.organization}’s ${planName(payload.plan)} plan didn’t go through. Stripe retries it over the next two weeks.`,
          },
          {
            type: "p",
            text: "Until it’s paid, agents can’t send new messages. Reading history keeps working. Update the card from Billing and sending resumes as soon as the payment succeeds.",
          },
          {
            type: "link",
            label: "Open Billing",
            url: `${context.origin}/app/accounts/${payload.accountId}/billing`,
          },
        ],
      );
    case "plan_kept":
      return account(
        `TalkTo: ${payload.organization} stays on ${planName(payload.kept)}`,
        payload.organization,
        [
          {
            type: "p",
            text: `${payload.organization} was set to move to ${planName(payload.plan)} at its renewal, but it has ${payload.people} people, counting pending invitations, and ${planName(payload.plan)} includes fewer. So the move is canceled and ${planName(payload.kept)} continues at its usual price.`,
          },
          {
            type: "p",
            text: `To switch to ${planName(payload.plan)}, remove people or cancel invitations until it fits, then choose ${planName(payload.plan)} again from Billing.`,
          },
          {
            type: "link",
            label: "Open Billing",
            url: `${context.origin}/app/accounts/${payload.accountId}/billing`,
          },
        ],
      );
    case "plugin_update":
      return account(`TalkTo: update the ${payload.plugin} plugin`, payload.organization, [
        {
          type: "p",
          text: `An agent in ${payload.organization} uses the TalkTo ${payload.plugin} plugin ${payload.installed}. Version ${payload.latest} is out, and the older one may stop working with TalkTo.`,
        },
        { type: "p", text: "Update the plugin in that tool, then restart the agent." },
        { type: "link", label: "How to update", url: `${context.origin}/docs` },
      ]);
    case "server_invitation": {
      const inviter = named(payload.inviter);
      const server = named(payload.server);
      const subject = `${inviter} invited you to ${server} on TalkTo`;
      const blocks: ReadonlyArray<Block> = [
        {
          type: "plain",
          text: `${inviter} invited you to ${server}, a server in ${named(payload.organization)} on TalkTo.`,
        },
        {
          type: "plain",
          text: "Sign in, or create your TalkTo account, with this email address. Then you can connect your agents to the server.",
        },
        {
          type: "link",
          label: `Join ${server}`,
          url: `${context.origin}/app/join/${payload.invitationId}`,
        },
        {
          type: "plain",
          text: `The invitation expires in 7 days, on ${day(payload.expiresAt)}. Only this email address can accept it.`,
        },
      ];
      const footer = `You’re getting this because ${inviter} invited this address to a server on TalkTo. If you didn’t expect it, you can ignore this email.`;
      return {
        subject,
        text: textOf(blocks, [footer]),
        html: htmlOf(subject, blocks, [{ text: footer }]),
      };
    }
    case "organization_deleted": {
      const organization = named(payload.organization);
      const by = named(payload.by);
      const subject = `${by} deleted ${organization} on TalkTo`;
      const blocks: ReadonlyArray<Block> = [
        {
          type: "plain",
          text: `${by}, its owner, deleted the organization ${organization}. Its servers, with their messages, agents and files, are deleted, and you no longer have access to them.`,
        },
        {
          type: "plain",
          text: "Your TalkTo account and your other organizations are not affected.",
        },
        { type: "link", label: "Open TalkTo", url: `${context.origin}/app` },
      ];
      const footer = `You’re getting this because you were a member of ${organization} on TalkTo. Account emails like this one can’t be turned off.`;
      return {
        subject,
        text: textOf(blocks, [footer]),
        html: htmlOf(subject, blocks, [{ text: footer }]),
      };
    }
    case "server_joined": {
      const guest = named(payload.guest);
      const server = named(payload.server);
      const subject = `${guest} joined ${server}`;
      const blocks: ReadonlyArray<Block> = [
        {
          type: "plain",
          text: `${guest} accepted your invitation to ${server} in ${named(payload.organization)}. Their agents can join the server once ${guest} connects them.`,
        },
        {
          type: "plain",
          text: `${guest} sees only this server. To remove them, open Access on the server page.`,
        },
        {
          type: "link",
          label: `Open ${server}`,
          url: `${context.origin}/app/accounts/${payload.accountId}/servers/${payload.serverId}`,
        },
      ];
      const footer = `You’re getting this because you invited ${guest} to ${server} on TalkTo. Account emails like this one can’t be turned off.`;
      return {
        subject,
        text: textOf(blocks, [footer]),
        html: htmlOf(subject, blocks, [{ text: footer }]),
      };
    }
    case "product_update": {
      const subject = context.announcement?.subject ?? "TalkTo";
      const blocks = markdown(context.announcement?.body ?? "");
      const unsubscribe = context.unsubscribeUrl ?? `${context.origin}/app/account`;
      const reason = "You’re getting TalkTo product updates because you have a TalkTo account.";
      return {
        subject,
        text: textOf(blocks, [reason, `Unsubscribe: ${unsubscribe}`]),
        html: htmlOf(subject, blocks, [
          { text: reason },
          { text: "Don’t want these?", link: "Unsubscribe", url: unsubscribe },
        ]),
      };
    }
  }
};
