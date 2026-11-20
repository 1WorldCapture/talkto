/**
 * The sign-in, account and consent pages of Better Auth mode (docs/self-host-better-auth.md). They
 * are plain HTML forms rendered by the Worker: no script, and every value is escaped.
 */

const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const style = `
:root { color-scheme: light dark; --ink: #1d1d1f; --muted: #6e6e73; --line: #d2d2d7; --bg: #f5f5f7; --card: #fff; --accent: #1d1d1f; --accent-ink: #fff; --bad: #b3261e; }
@media (prefers-color-scheme: dark) { :root { --ink: #f5f5f7; --muted: #a1a1a6; --line: #3a3a3c; --bg: #000; --card: #1c1c1e; --accent: #f5f5f7; --accent-ink: #000; --bad: #ff8a80; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 24px; }
main { width: 100%; max-width: 400px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px; }
h1 { font-size: 20px; margin: 0 0 4px; }
p { margin: 0 0 16px; color: var(--muted); }
label { display: block; font-weight: 600; margin: 12px 0 4px; }
input { width: 100%; font: inherit; padding: 9px 11px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; }
button { font: inherit; font-weight: 600; padding: 9px 16px; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-ink); cursor: pointer; }
button.secondary { background: transparent; color: var(--ink); border-color: var(--line); }
.actions { display: flex; gap: 8px; margin-top: 20px; }
.error { color: var(--bad); font-weight: 600; }
.switch { margin: 20px 0 0; font-size: 14px; }
.switch a { color: inherit; }
dl { margin: 0 0 16px; }
dt { font-weight: 600; }
dd { margin: 0 0 8px; color: var(--muted); overflow-wrap: anywhere; }
`;

const page = (title: string, body: string, status: number) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)} · TalkTo</title><style>${style}</style></head><body><main>${body}</main></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // Not no-referrer: under it, Chrome sends `Origin: null` with this site's own form posts,
        // and the origin check refuses them. same-origin sends no referrer to other sites.
        "referrer-policy": "same-origin",
        "x-frame-options": "DENY",
        "x-content-type-options": "nosniff",
        // No script at all. Forms post to this site; the redirect after consent goes to the app.
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      },
    },
  );

const hidden = (name: string, value: string | null) =>
  value === null || value === ""
    ? ""
    : `<input type="hidden" name="${name}" value="${escape(value)}">`;

/** What the sign-in page shows. */
export interface SignIn {
  readonly returnTo: string;
  /** The signed OAuth request of an agent's sign-in, passed on untouched. */
  readonly oauthQuery: string | null;
  readonly invitation: string | null;
  /** An account link's code (better-auth-claim.ts), carried to the sign-up form. */
  readonly claim: string | null;
  readonly email: string;
  readonly name: string;
  readonly error: string | null;
  readonly mode: "sign-in" | "sign-up";
  readonly status: number;
}

/** Sign in, or create an account with an invitation's link or an account link. */
export const signIn = (view: SignIn) => {
  // An invitation travels with both forms: signing in with it joins its organization.
  const carried =
    hidden("return_to", view.returnTo) +
    hidden("oauth_query", view.oauthQuery) +
    hidden("invitation", view.invitation) +
    (view.mode === "sign-up" ? hidden("claim", view.claim) : "");
  const error =
    view.error === null ? "" : `<p class="error" role="alert">${escape(view.error)}</p>`;
  const others = new URLSearchParams(view.oauthQuery ?? "");
  if (view.oauthQuery === null) others.set("return_to", view.returnTo);
  if (view.invitation !== null) others.set("invitation", view.invitation);
  if (view.claim !== null) others.set("claim", view.claim);
  others.set("create", "1");
  const signUpLink = `/auth/sign-in?${others}`;
  const back = new URLSearchParams(view.oauthQuery ?? { return_to: view.returnTo });
  // `account` keeps an invitation's link on the sign-in form, for someone who has an account.
  if (view.invitation !== null) {
    back.set("invitation", view.invitation);
    back.set("account", "1");
  }
  const signInLink = `/auth/sign-in?${back}`;
  const agent = view.oauthQuery === null ? "" : " An agent app asked to sign in as you.";
  if (view.mode === "sign-up")
    return page(
      "Create your account",
      `<h1>Create your TalkTo account</h1>
<p>Use the address your link was sent to.${agent}</p>${error}
<form method="post" action="/auth/sign-up">${carried}
<label for="name">Your name</label><input id="name" name="name" autocomplete="name" required maxlength="120" value="${escape(view.name)}">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="254" value="${escape(view.email)}">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" required minlength="10" maxlength="128">
<div class="actions"><button type="submit">Create account</button></div>
</form>
<p class="switch">Already have an account? <a href="${escape(signInLink)}">Sign in</a></p>`,
      view.status,
    );
  return page(
    "Sign in",
    `<h1>Sign in to TalkTo</h1>
<p>Manage your servers and connect your agents.${agent}</p>${error}
<form method="post" action="/auth/sign-in">${carried}
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required maxlength="254" value="${escape(view.email)}">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="128">
<div class="actions"><button type="submit">Sign in</button></div>
</form>
<p class="switch">New here? <a href="${escape(signUpLink)}">Create an account</a> from the link you were sent.</p>`,
    view.status,
  );
};

/** What the consent page shows about an agent app. */
export interface Consent {
  /** The name the app gave itself when it registered. Nothing has checked it. */
  readonly app: string;
  readonly email: string;
  readonly redirectUri: string;
  readonly oauthQuery: string;
}

/** Where a redirect URI sends the code, in words a person can check. */
const destination = (value: string) => {
  if (!URL.canParse(value)) return { place: value, warning: "" };
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && loopback)
    return {
      place: url.host,
      warning:
        "A program on this computer receives the sign-in. Continue only if you just started it.",
    };
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return {
      place: `${url.protocol}//`,
      warning: "The app that owns this link type on this computer receives the sign-in.",
    };
  return { place: url.host, warning: "" };
};

/** Ask the signed-in person whether an agent app may act as them on this TalkTo. */
export const consent = (view: Consent) => {
  const target = destination(view.redirectUri);
  const app = view.app.trim().slice(0, 120) || "An app with no name";
  return page(
    "Allow agent app",
    `<h1>Allow ${escape(app)}?</h1>
<p>It will act as you on this TalkTo: it can reach the servers you can reach. Each agent still joins a server under its own name.</p>
<dl>
<dt>Signed in as</dt><dd>${escape(view.email)}</dd>
<dt>App name</dt><dd>${escape(app)} (the app chose this name; TalkTo has not checked it)</dd>
<dt>Sends you back to</dt><dd>${escape(target.place)}${target.warning === "" ? "" : `<br>${escape(target.warning)}`}</dd>
</dl>
<form method="post" action="/auth/consent">${hidden("oauth_query", view.oauthQuery)}
<div class="actions"><button type="submit" name="accept" value="yes">Allow</button><button class="secondary" type="submit" name="accept" value="no">Deny</button></div>
</form>
<p class="switch">You can sign this app out later on the Signed-in computers page.</p>`,
    200,
  );
};

/** What the join page shows a signed-in person who opened an organization invitation's link. */
export interface Join {
  readonly organization: string;
  readonly email: string;
  readonly invitation: string;
  readonly returnTo: string;
}

/** Ask before joining: opening a link must never be enough, since any site can open one. */
export const join = (view: Join) =>
  page(
    "Join organization",
    `<h1>Join ${escape(view.organization)}?</h1>
<p>You were invited as ${escape(view.email)}. Joining lets its owners share servers with you, so their agents can reach yours.</p>
<form method="post" action="/auth/join">${hidden("invitation", view.invitation)}${hidden("return_to", view.returnTo)}
<div class="actions"><button type="submit">Join</button></div>
</form>
<p class="switch"><a href="/app">Not now</a></p>`,
    200,
  );

/** A short page for a sign-in that cannot go on. */
export const message = (title: string, text: string, status: number) =>
  page(title, `<h1>${escape(title)}</h1><p>${escape(text)}</p>`, status);
