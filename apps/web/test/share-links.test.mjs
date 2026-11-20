import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createServer as createVite } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from "@tanstack/react-router";
import { words } from "./copy-rules.mjs";

/*
  Share TalkTo (docs/share-links-spec.md): one plain place with the link, one sentence and a plain
  list naming nobody; the public line only while offered; the code carried through sign-up.
*/

const user = {
  id: "user_alice",
  email: "alice@example.com",
  emailVerified: true,
  firstName: "Alice",
  lastName: null,
  profilePictureUrl: null,
};
const asOf = "2026-11-16T12:00:00.000Z";
const offer = {
  messages: 500,
  qualifyingMessages: 50,
  qualifyingDays: 2,
  windowDays: 30,
  sharerLimit: 10,
};
const code = "AbCdEfGhIjKlMnOpQrStUv";
const link = { code, url: `https://talkto.sh/?ref=${code}`, createdAt: asOf };
const available = (extra = {}) => ({
  status: "available",
  offer,
  link,
  free: true,
  exhausted: false,
  referrals: [],
  joined: null,
  asOf,
  ...extra,
});
const referral = (status, bonus = null, joinedAt = "2026-11-16T09:00:00.000Z") => ({
  joinedAt,
  windowEndsAt: "2026-12-16T09:00:00.000Z",
  status,
  settledAt: status === "waiting" ? null : "2026-11-20T09:00:00.000Z",
  bonus,
});
/** Gamified or money words that never belong on the share place. */
const gamified = /bonus|streak|leaderboard|unlock|rank|%|congrat|🎉|invite \d+ more/i;

async function setup(t) {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const share = await vite.ssrLoadModule("/src/share.tsx");
  const shareLink = await vite.ssrLoadModule("/src/share-link.ts");
  const offers = await vite.ssrLoadModule("/src/public-offers.tsx");
  const { createServices, Services, Human } = await vite.ssrLoadModule("/src/session.tsx");
  const services = createServices("https://talkto.test");
  t.after(() => services.queries.clear());
  const render = async (component) => {
    const router = createRouter({
      routeTree: createRootRoute({ component }),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();
    return renderToStaticMarkup(
      createElement(
        Services.Provider,
        { value: services },
        createElement(
          QueryClientProvider,
          { client: services.queries },
          createElement(Human.Provider, { value: user }, createElement(RouterProvider, { router })),
        ),
      ),
    );
  };
  const view = (state) =>
    render(() => createElement(share.ShareView, { state, create: () => undefined }));
  return { share, shareLink, offers, render, view };
}

test("the owner sees one sentence, the link with Copy, and the limit, plainly", async (t) => {
  const { view } = await setup(t);
  const html = await view(available());
  assert.match(html, /<section class="billing-panel share-panel" aria-label="Share TalkTo">/);
  assert.match(html, /<h2>Share TalkTo<\/h2>/);
  const text = words(html);
  assert.match(
    text,
    /When someone signs up with your link, you both get 500 free messages\. Yours are added once their agents have sent 50 messages on 2 different days\./,
  );
  assert.match(html, /readOnly=""|readonly=""/);
  assert.match(html, new RegExp(`value="https://talkto.sh/\\?ref=${code}"`));
  assert.match(html, />Copy<\/button>/);
  assert.match(text, /You can receive this up to 10 times\./);
  assert.doesNotMatch(text, /paid plan|no longer adds/);
  assert.doesNotMatch(html, /share-list/, "no list before anyone signed up");
  assert.doesNotMatch(text, gamified);
});

test("without a link the owner gets one plain button", async (t) => {
  const { view } = await setup(t);
  const html = await view(available({ link: null }));
  assert.match(html, />Get my link<\/button>/);
  assert.doesNotMatch(html, /<input/);
});

test("a paid organization and a spent link say so in one line each", async (t) => {
  const { view } = await setup(t);
  assert.match(
    words(await view(available({ free: false }))),
    /This organization is on a paid plan, so your 500 messages won’t be added here\. The person you share with still gets theirs\./,
  );
  assert.match(
    words(await view(available({ exhausted: true }))),
    /You’ve received the most share messages\. Your link no longer adds messages\./,
  );
});

test("each sign-up is one plain line that names nobody", async (t) => {
  const { view } = await setup(t);
  const added = { status: "added", appliedAt: "2026-11-09T10:00:00.000Z" };
  const html = await view(
    available({
      referrals: [
        referral("waiting"),
        referral("qualified", added, "2026-11-02T09:00:00.000Z"),
        referral("qualified", { status: "pending", appliedAt: null }),
        referral("qualified", { status: "not_added", appliedAt: "2026-11-20T09:00:00.000Z" }),
        referral("capped"),
        referral("excluded"),
        referral("expired"),
      ],
    }),
  );
  const items = [...html.matchAll(/<li>(.*?)<\/li>/g)].map((m) => words(m[1]));
  assert.deepEqual(items, [
    "Joined November 16 — waiting for 50 messages on 2 different days, until December 16",
    "Joined November 2 — 500 messages added November 9",
    "Joined November 16 — 500 messages being added",
    "Joined November 16 — earned while on a paid plan, so not added",
    "Joined November 16 — joined after you received the most",
    "Joined November 16 — not counted",
    "Joined November 16 — ended without qualifying",
  ]);
  assert.doesNotMatch(words(html), /alice|@|example\.com/i, "no name or address of anyone");
  assert.doesNotMatch(words(html), gamified);
  assert.doesNotMatch(html, /role="meter"|billing-meter|progress/, "no progress bars");
});

test("an organization that joined with a link sees what it got; members see only that", async (t) => {
  const { view } = await setup(t);
  const joined = (status) => ({
    joinedAt: asOf,
    status,
    appliedAt: status === "pending" ? null : asOf,
  });
  assert.match(
    words(await view(available({ joined: joined("added") }))),
    /You joined with a share link: 500 free messages were added\./,
  );
  assert.match(
    words(await view(available({ joined: joined("pending") }))),
    /You joined with a share link: 500 messages are being added\./,
  );
  assert.match(
    words(await view(available({ joined: joined("not_added") }))),
    /You joined with a share link, but this organization had no free allowance then, so nothing was added\./,
  );
  const member = {
    ...available(),
    status: "owner_only",
    link: null,
    joined: joined("added"),
  };
  const memberHtml = await view(member);
  assert.match(words(memberHtml), /You joined with a share link/);
  assert.doesNotMatch(memberHtml, /Share TalkTo|<input|Get my link/);
  assert.equal(await view({ ...member, joined: null }), "");
  assert.equal(await view({ ...available(), status: "unavailable", offer: null, link: null }), "");
});

test("a share code is taken from any address once, and only a well-formed one", async (t) => {
  const { shareLink } = await setup(t);
  assert.deepEqual(shareLink.shareCodeIn(`https://talkto.sh/?ref=${code}`), {
    code,
    cleaned: "/",
  });
  assert.deepEqual(
    shareLink.shareCodeIn(`https://talkto.sh/pricing?utm=x&ref=${code}#plans`),
    { code, cleaned: "/pricing?utm=x#plans" },
    "other parameters and the hash stay",
  );
  assert.equal(shareLink.shareCodeIn("https://talkto.sh/?ref=short"), null);
  assert.equal(shareLink.shareCodeIn(`https://talkto.sh/?ref=${code}!`), null);
  assert.equal(shareLink.shareCodeIn("https://talkto.sh/"), null);
  const now = Date.parse(asOf);
  const kept = JSON.stringify({ code, at: now - 86_400_000 });
  assert.equal(shareLink.storedCode(kept, now), code);
  assert.equal(
    shareLink.storedCode(JSON.stringify({ code, at: now - 31 * 86_400_000 }), now),
    null,
    "kept 30 days",
  );
  assert.equal(shareLink.storedCode("not json", now), null);
  assert.equal(shareLink.storedCode(JSON.stringify({ code: "bad", at: now }), now), null);
  assert.equal(shareLink.storedCode(null, now), null);
});

test("the public free-trial box and Free plan terms name sharing only while it is offered, never as a bonus", async (t) => {
  const { offers, render } = await setup(t);
  const { createElement: h } = await import("react");
  const trial = { messages: 500, servers: 1 };
  const line = /Share your link: when someone signs up with it, you both get 500 free messages\./;
  // The trial has its box; the Free plan's terms sit in Pricing's details and Home's note.
  const places = [
    (share) => h(offers.TrialOfferCopy, { offer: trial, share }),
    (share) => h("ul", null, h(offers.FreePlanTerms, { share })),
    (share) => h(offers.FreePlanNote, { share }),
  ];
  for (const place of places) {
    const shown = words(await render(() => place(offer)));
    assert.match(shown, line);
    assert.doesNotMatch(shown, /bonus/i);
    const hidden = words(await render(() => place(null)));
    assert.doesNotMatch(hidden, /Share your link/);
  }
});

test("an owner's pages read the free-start state for a kept share code only", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { ShareJoin } = await vite.ssrLoadModule("/src/share.tsx");
  const { createServices, Services, Human } = await vite.ssrLoadModule("/src/session.tsx");
  // ShareJoin renders nothing, so React needs only a container and the globals its commit reads.
  const stored = new Map();
  const ignore = () => undefined;
  const document = { nodeType: 9, activeElement: null, body: null, addEventListener: ignore };
  const globals = {
    window: globalThis,
    document,
    HTMLIFrameElement: class {},
    localStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, String(value)),
      removeItem: (key) => stored.delete(key),
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  t.after(() => {
    for (const name of Object.keys(globals)) delete globalThis[name];
  });
  const { createRoot } = await import("react-dom/client");
  const accountId = "6f0c3e1b-9a52-4c1e-8f0d-2b6c7a1e4d90";
  const reads = [];
  const server = createServer((req, res) => {
    reads.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: { offer: null, status: "unavailable", grant: null, asOf },
        meta: {
          requestId: "11111111-1111-4111-8111-111111111111",
          serverTime: asOf,
          instructions: { url: "https://talkto.test/instructions", text: "Instructions" },
        },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const mount = async () => {
    const services = createServices(`http://127.0.0.1:${server.address().port}`);
    const container = {
      nodeType: 1,
      tagName: "DIV",
      ownerDocument: document,
      addEventListener: ignore,
    };
    const root = createRoot(container);
    root.render(
      createElement(
        Services.Provider,
        { value: services },
        createElement(
          QueryClientProvider,
          { client: services.queries },
          createElement(
            Human.Provider,
            { value: user },
            createElement(ShareJoin, { account: { id: accountId, createdBy: user.id } }),
          ),
        ),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    root.unmount();
    services.queries.clear();
    // Let the unmount finish while the globals it reads still exist.
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  const starter = `/v1/accounts/${accountId}/starter`;

  await mount();
  assert.deepEqual(reads, [], "no kept code: the owner's page makes no free-start read");

  stored.set("talkto-share-ref", JSON.stringify({ code, at: Date.now() }));
  await mount();
  assert.deepEqual(reads, [starter], "a kept code waits for the claim, so its state is read");
  assert.equal(stored.size, 1, "the code is kept until the organization has claimed");
});
