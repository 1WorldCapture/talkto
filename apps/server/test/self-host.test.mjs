import assert from "node:assert/strict";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";
import { provider, event } from "./billing-provider.mjs";
import { storageGigabytes } from "@talkto/api/pricing";

/*
  TALKTO_SELF_HOSTED: a customer's own copy (docs/self-host-spec.md). Every organization is
  unlimited and billing is off, whatever else is configured; every access check stays.
*/
const message = (x, server, participantId, requestKey, status = 200, user = "user_alice") =>
  x
    .call(user, "GET", `/v1/servers/${server.id}`, undefined, user === "user_alice" ? 200 : 404)
    .then((detail) =>
      x.call(
        user,
        "POST",
        `/v1/servers/${server.id}/conversations/${detail.generalConversationId ?? "missing"}/messages`,
        { participantId, requestKey, body: "Hello from a self-hosted copy." },
        status,
      ),
    );

test("a self-hosted copy makes every organization unlimited and keeps every access check", async (t) => {
  const stripe = provider();
  // Billing, metering, the free start and tight unpaid limits are all switched on, so the test
  // shows the one switch overriding them.
  const x = await start(t, {
    selfHosted: true,
    stripeHandler: stripe.handler,
    metering: true,
    starter: true,
    unpaidServers: 1,
    unpaidServersPerDay: 1,
  });
  const account = await x.account();
  const servers = [await x.server(account.id), await x.server(account.id)];
  await x.server(account.id);
  const [server] = servers;
  const agent = (
    await x.call("user_alice", "POST", `/v1/servers/${server.id}/participants`, {
      name: "Builder",
      agentType: "codex",
      requestKey: "builder",
    })
  ).item;
  // Metered everywhere, yet no paid period is needed to send.
  for (let i = 0; i < 3; i++) await message(x, server, agent.id, `send-${i}`);

  // A second organization by another person is unlimited too.
  const other = await x.call("user_bob", "POST", "/v1/accounts", {
    name: "Other team",
    requestKey: "other",
  });
  const otherServer = await x.call("user_bob", "POST", `/v1/accounts/${other.id}/servers`, {
    name: "Theirs",
    requestKey: "theirs",
  });
  // Unlimited is not access: Bob cannot read or write Alice's server, nor she his.
  await x.call("user_bob", "GET", `/v1/servers/${server.id}`, undefined, 404);
  await x.call("user_alice", "GET", `/v1/servers/${otherServer.id}`, undefined, 404);
  await x.call(
    "user_bob",
    "POST",
    `/v1/accounts/${account.id}/servers`,
    { name: "Intruder", requestKey: "intruder" },
    404,
  );
  const anonymous = await x.raw(`/v1/servers/${server.id}`);
  assert.equal(anonymous.status, 401);

  // No plan people limit: more than Shop's 4 people can be invited.
  for (const email of ["a@example.com", "b@example.com", "c@example.com", "d@example.com"])
    await x.call("user_alice", "POST", `/v1/accounts/${account.id}/invitations`, { email });

  // The largest storage pool, with no paid plan.
  const pool = await (await x.control(`storage?account=${account.id}`)).json();
  assert.equal(pool.limitBytes, storageGigabytes.factory * 1_000_000_000);

  // Billing is off and says why; Stripe is never called, and its webhook route is gone.
  const billing = await x.call(
    "user_alice",
    "GET",
    `/v1/accounts/${account.id}/billing`,
    undefined,
    503,
  );
  assert.equal(billing.error.code, "billing_unavailable");
  assert.match(billing.error.message, /self-hosted TalkTo/);
  assert.equal((await event(x, "cus_any")).status, 404);
  assert.equal(stripe.requests.length, 0, "no Stripe request");
  assert.equal((await x.db.prepare("SELECT COUNT(*) AS n FROM workspace_billing").first()).n, 0);

  // No free start, and the public site pages send people to the dashboard.
  const offers = await (await x.raw("/v1/offers")).json();
  assert.equal(offers.data.starter, null);
  for (const path of ["/", "/pricing", "/pricing/", "/teams", "/setup", "/access", "/terms"]) {
    const page = await x.raw(path, { redirect: "manual" });
    assert.equal(page.status, 302, path);
    assert.equal(page.headers.get("location"), "https://talkto.test/app", path);
  }
});

test("hosted TalkTo keeps metering and limits, and offers no self-host licenses", async (t) => {
  const x = await start(t, { metering: true, unpaidServers: 1 });
  const account = await x.account();
  const server = await x.server(account.id);
  await x.call(
    "user_alice",
    "POST",
    `/v1/accounts/${account.id}/servers`,
    { name: "Second", requestKey: "second" },
    403,
  );
  const agent = (
    await x.call("user_alice", "POST", `/v1/servers/${server.id}/participants`, {
      name: "Builder",
      agentType: "codex",
      requestKey: "builder",
    })
  ).item;
  await message(x, server, agent.id, "unpaid", 402);
  const offers = (await (await x.raw("/v1/offers")).json()).data;
  assert.equal(Object.hasOwn(offers, "selfHost"), false, "no self-host buy links");
});

/*
  Self-host license sales ended on November 19, 2026 (LICENSE, Apache-2.0). Stripe may still send
  events for an old yearly subscription: each is acknowledged, so Stripe stops retrying, and
  ignored. Nothing is stored, and the minute cron no longer calls GitHub to deliver or revoke.
*/
test("old self-host Stripe events are acknowledged and ignored", async (t) => {
  const github = [];
  const x = await start(t, {
    githubHandler: (request) => {
      github.push(request.url);
      return new Response(null, { status: 204 });
    },
  });
  const licenses = async () =>
    (await x.db.prepare("SELECT COUNT(*) AS n FROM selfhost_licenses").first()).n;
  const before = await licenses();
  const deliver = (body) =>
    x.raw("/webhooks/stripe-selfhost", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=unverified" },
      body,
    });
  for (const type of [
    "checkout.session.completed",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.paid",
  ]) {
    const response = await deliver(
      JSON.stringify({
        id: `evt_${type}`,
        type,
        livemode: true,
        data: { object: { metadata: { app: "talkto", kind: "selfhost" } } },
      }),
    );
    assert.equal(response.status, 200, type);
    assert.deepEqual(await response.json(), { received: true }, type);
  }
  // Not even JSON: still acknowledged, never a crash.
  const garbage = await deliver("not json");
  assert.equal(garbage.status, 200);
  assert.equal(
    (await x.raw("/webhooks/stripe-selfhost", { method: "GET" })).status,
    405,
    "Stripe only POSTs",
  );
  await x.scheduled();
  assert.equal(await licenses(), before, "nothing recorded");
  assert.deepEqual(github, [], "GitHub is never called");
});
