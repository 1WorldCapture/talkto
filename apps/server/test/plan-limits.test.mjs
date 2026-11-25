import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

const pause = (millis) => new Promise((resolve) => setTimeout(resolve, millis));
/** A person signed in on the TalkTo website: each call answers with its status and JSON body. */
const website = async (x, user = "user_alice") => {
  const flow = await x.browserLogin(user);
  const cookie = (await flow.callback()).headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-talkto-session="))
    .split(";")[0];
  return async (method, path, value) => {
    const response = await x.raw(path, {
      method,
      headers: { cookie, origin: "https://talkto.test", "content-type": "application/json" },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    return { status: response.status, json: JSON.parse(await response.text()) };
  };
};
/** Server objects the Worker looked up since the last call; none means no request reached one. */
const lookups = async (x) => (await (await x.control("server-lookups")).json()).names;

/**
 * One organization with budgets on, one server and one agent. `budgets` replaces the plan's
 * numbers in the organization's quota object before the first read.
 */
const setup = async (t, options = {}, budgets = null) => {
  const x = await start(t, { readBudgets: true, ...options });
  const account = await x.account();
  if (budgets !== null) await x.control(`quota/configure?account=${account.id}`, { budgets });
  const credential = await x.mcpToken(account.organizationId);
  const server = await x.server(account.id);
  const register = async (name, error = false, target = server) =>
    x.mcp(
      credential,
      "register_participant",
      { serverId: target.id, name, agentType: "claude-code", requestKey: randomUUID() },
      error,
    );
  const agent = (await register("first")).data;
  const poll = (error = false, participantId = agent.item.id) =>
    x.mcp(
      credential,
      "get_updates",
      {
        serverId: server.id,
        participantId,
        mode: "start",
        channelIds: [],
        directChats: "own",
        startAt: "now",
      },
      error,
    );
  const search = (error = false) =>
    x.mcp(
      credential,
      "read_messages",
      { serverId: server.id, mode: "search", query: "anything", limit: 5 },
      error,
    );
  const budgets_ = async () => (await x.control(`quota/budgets?account=${account.id}`)).json();
  /**
   * Hold the server object's rate-limit clock still, so its per-minute buckets refill only by
   * the minute the test describes, never by how slowly a loaded machine answers.
   */
  const holdLimits = async () =>
    assert.equal(
      (await x.control(`limiter-clock?server=${server.id}`, { hold: true })).status,
      200,
    );
  /**
   * Put the organization on a paid plan for the month around now. The overrides above still set
   * its numbers; only the plan changes, and with it whether the website's reads count.
   */
  const paid = async (plan = "shop") => {
    const day = 86_400_000;
    const response = await x.control(`storage/plan?account=${account.id}`, {
      accountId: account.id,
      plan,
      start: new Date(Date.now() - day).toISOString(),
      end: new Date(Date.now() + 29 * day).toISOString(),
    });
    assert.equal(response.status, 200);
    assert.equal((await budgets_()).usage.terms.paid, true);
  };
  return {
    x,
    account,
    credential,
    server,
    register,
    agent,
    poll,
    search,
    usage: budgets_,
    holdLimits,
    paid,
  };
};

test("reads count against the monthly budget in batches", async (t) => {
  const s = await setup(t, {}, { perMinute: 600 });
  for (let read = 0; read < 60; read++) await s.poll();
  for (let read = 0; read < 5; read++) await s.search();
  const { usage, calls } = await s.usage();
  const spent = 60 + 5 * 3;
  // A lease counts when granted: never below what was read, and above by what the server has not
  // spent, under an eighth of what it read.
  assert.ok(usage.reads.used >= spent, `${usage.reads.used} < ${spent}`);
  assert.ok(usage.reads.used <= spent + spent / 8, `${usage.reads.used} far above ${spent}`);
  assert.equal(usage.reads.limit, 500000);
  assert.equal(usage.terms.plan, "free");
  assert.equal(usage.terms.paid, false);
  // Fewer quota calls than reads: the first 16 units are leased as they are needed, then leases
  // grow by an eighth of what the server has spent, up to its recent pace.
  const readCalls = calls.filter((call) => call.lane === "read").length;
  assert.ok(readCalls <= 32, `${readCalls} lease calls for 65 reads`);
});

test("the per-minute bucket allows a burst, then slows reads with a retry delay naming the plan", async (t) => {
  const s = await setup(t, {}, { perMinute: 60, burst: 3 });
  for (let read = 0; read < 3; read++) await s.poll();
  const limited = await s.poll(true);
  assert.equal(limited.error.code, "rate_limited");
  assert.equal(limited.error.scope, "organization");
  assert.equal(limited.error.retryAfterSeconds, 1);
  assert.match(limited.error.message, /60 reads a minute across all of its servers/);
  assert.match(limited.error.message, /bursts up to 3/);
  assert.match(limited.error.message, /Free limits/);
  // A refusal is remembered locally: the next refused read costs no quota call.
  const before = (await s.usage()).calls.length;
  await s.poll(true);
  assert.equal((await s.usage()).calls.length, before);
  await pause(1100);
  await s.poll();
  // HTTP reads answer 429 with Retry-After from the same budget.
  for (let read = 0; read < 5; read++) {
    const response = await s.x.raw(`/v1/servers/${s.server.id}/participants`, {
      headers: { authorization: `Bearer ${await s.x.token("user_alice")}` },
    });
    if (response.status === 200) continue;
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get("retry-after")) >= 1);
    assert.equal((await response.json()).error.code, "rate_limited");
    return;
  }
  assert.fail("HTTP reads were never slowed");
});

test("after the monthly budget, agents keep receiving through the slow lane", async (t) => {
  const s = await setup(t, {}, { monthly: 5, perMinute: 600, slowPerMinute: 1 });
  for (let read = 0; read < 5; read++) await s.poll();
  // The budget is spent; one slow-lane read a minute still gets through.
  await s.poll();
  const slowed = await s.poll(true);
  assert.equal(slowed.error.code, "rate_limited");
  assert.equal(slowed.error.scope, "organization");
  assert.ok(slowed.error.retryAfterSeconds > 30 && slowed.error.retryAfterSeconds <= 60);
  assert.match(slowed.error.message, /used the 5 reads a month/);
  assert.match(slowed.error.message, /1 read a minute across the organization/);
  const { usage } = await s.usage();
  assert.equal(usage.reads.used, 5);
  assert.equal(usage.reads.beyond, 1);
  // Messages are not reads: sending still works.
  await s.x.mcp(s.credential, "send_message", {
    serverId: s.server.id,
    participantId: s.agent.item.id,
    requestKey: randomUUID(),
    target: { kind: "conversation", conversationId: s.agent.generalConversationId },
    body: "Still sending.",
  });
});

test("on Free dashboard reads never count or wait on the agents' bucket, and are bounded per person", async (t) => {
  const s = await setup(t, {}, { perMinute: 60, burst: 2 });
  await s.holdLimits();
  for (let read = 0; read < 2; read++) await s.poll();
  assert.equal((await s.poll(true)).error.code, "rate_limited");
  const searchAll = () =>
    s.x.call("user_alice", "GET", `/v1/accounts/${s.account.id}/activity?query=needle`);
  // The agents' bucket is empty, yet the website still searches this server.
  assert.equal((await searchAll()).search.unavailableServers, 0);
  const { usage } = await s.usage();
  // Two polls; on Free's numbers the website search counts nowhere.
  assert.deepEqual([usage.reads.used, usage.reads.beyond], [2, 0], JSON.stringify(usage));
  // Sixty a minute per person per server, then the server answers as unavailable. The limit's
  // clock is held, so however slowly a loaded machine answers, nothing refills: the first search
  // took one of the sixty, so exactly five of these are refused.
  const results = await Promise.all(Array.from({ length: 64 }, () => searchAll()));
  const refused = results.filter((result) => result.search.unavailableServers === 1).length;
  assert.equal(refused, 5, `${refused} of 64 refused after the first`);
});

test("a server's pages on the website never wait on the agents' bucket", async (t) => {
  const s = await setup(t, {}, { perMinute: 60, burst: 2 });
  await s.paid();
  await s.holdLimits();
  for (let read = 0; read < 2; read++) await s.poll();
  assert.equal((await s.poll(true)).error.code, "rate_limited");
  const callback = await (await s.x.browserLogin("user_alice")).callback();
  const cookie = callback.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-talkto-session="))
    .split(";")[0];
  const page = (headers) =>
    s.x.raw(`/v1/servers/${s.server.id}/messages`, { method: "GET", headers });
  // The Activity tab refreshes this feed: from the website it still loads, and on a paid plan
  // counts one read.
  const website = await page({ cookie, origin: "https://talkto.test" });
  assert.equal(website.status, 200, await website.clone().text());
  const { usage } = await s.usage();
  assert.ok(usage.reads.used >= 2 + 1, JSON.stringify(usage));
  // The same request with an access token is an API client, and waits with the agents.
  const client = await page({ authorization: `Bearer ${await s.x.token("user_alice")}` });
  const refusal = await client.text();
  assert.equal(client.status, 429, refusal);
  assert.match(JSON.parse(refusal).error.message, /reads a minute across all of its servers/);
});

test("a feed page without a search or time window counts one read; searches and windows count three", async (t) => {
  const s = await setup(t, {}, { monthly: 2_000_000, perMinute: 120 });
  await s.paid();
  for (const body of ["First.", "Second."])
    await s.x.mcp(s.credential, "send_message", {
      serverId: s.server.id,
      participantId: s.agent.item.id,
      requestKey: randomUUID(),
      target: { kind: "conversation", conversationId: s.agent.generalConversationId },
      body,
    });
  const callback = await (await s.x.browserLogin("user_alice")).callback();
  const cookie = callback.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-talkto-session="))
    .split(";")[0];
  const feed = async (query) => {
    const response = await s.x.raw(`/v1/servers/${s.server.id}/messages${query}`, {
      method: "GET",
      headers: { cookie, origin: "https://talkto.test" },
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return JSON.parse(text).data;
  };
  await s.x.control(`meter/configure?server=${s.server.id}`, { restart: true });
  const used = async () => (await s.usage()).usage.reads.used;
  const before = await used();
  const counted = async (query) => {
    const at = await used();
    const data = await feed(query);
    return { data, units: (await used()) - at };
  };
  const cursor = (value) => `?cursor=${encodeURIComponent(value)}`;
  // The Activity tab: its first page, an older page and the live check.
  const first = await counted("?limit=1");
  assert.equal(first.units, 1);
  assert.notEqual(first.data.nextCursor, null);
  assert.equal((await counted(cursor(first.data.nextCursor))).units, 1);
  assert.equal((await counted(cursor(first.data.liveCursor))).units, 1);
  // One conversation, as its reader opens it.
  const general = `?conversationId=${encodeURIComponent(s.agent.generalConversationId)}`;
  assert.equal((await counted(general)).units, 1);
  // A search stays a deep read, refreshed live or not, and so does a time window.
  const searched = await counted("?query=needle");
  assert.equal(searched.units, 3);
  assert.equal((await counted(cursor(searched.data.liveCursor))).units, 3);
  const end = new Date(Date.now() + 60_000).toISOString();
  const start = new Date(Date.now() - 3_600_000).toISOString();
  const windowed = await counted(`?start=${start}&end=${end}`);
  assert.equal(windowed.units, 3);
  assert.equal((await counted(cursor(windowed.data.liveCursor))).units, 3);
  assert.equal((await used()) - before, 4 * 1 + 4 * 3);
});

test("on a paid plan, past the monthly budget the website refreshes more slowly", async (t) => {
  const s = await setup(t, {}, { monthly: 3, perMinute: 600, slowPerMinute: 1 });
  await s.paid();
  await s.holdLimits();
  const searchAll = () =>
    s.x.call("user_alice", "GET", `/v1/accounts/${s.account.id}/activity?query=needle`);
  // The first search spends the month; ten more fit under the slower ceiling of ten a minute.
  for (let read = 0; read < 11; read++)
    assert.equal((await searchAll()).search.unavailableServers, 0, `search ${read}`);
  assert.equal((await searchAll()).search.unavailableServers, 1);
  const { usage } = await s.usage();
  assert.equal(usage.reads.used, 3);
  // Eleven searches of three units; leases may run one block (10) ahead.
  assert.ok(usage.reads.beyond >= 30 && usage.reads.beyond <= 40, String(usage.reads.beyond));
});

test("a website refusal says to wait 1 second, and the Worker still answers its early retry", async (t) => {
  const s = await setup(t);
  await s.holdLimits();
  const dashboard = await website(s.x);
  const page = () => dashboard("GET", `/v1/servers/${s.server.id}/participants`);
  // Sixty a minute per person per server; at that rate a refusal always waits one second.
  for (let read = 0; read < 60; read++) assert.equal((await page()).status, 200, `read ${read}`);
  const refused = await page();
  assert.equal(refused.status, 429, JSON.stringify(refused.json));
  assert.equal(refused.json.error.retryAfterSeconds, 1);
  assert.match(
    refused.json.error.message,
    /^Too many reads from the TalkTo website: .* Wait 1 second\.$/,
  );
  // The Worker recognised the refusal: the early retry gets it again without reaching the server.
  await lookups(s.x);
  const early = await page();
  assert.equal(early.status, 429);
  assert.equal(early.json.error.message, refused.json.error.message);
  assert.deepEqual(await lookups(s.x), []);
});

test("on Free the website's reads are not counted, and a spent month never slows them", async (t) => {
  const s = await setup(t, {}, { monthly: 3, perMinute: 600, slowPerMinute: 1 });
  await s.holdLimits();
  // The agents spend the month.
  for (let read = 0; read < 3; read++) await s.poll();
  const searchAll = () =>
    s.x.call("user_alice", "GET", `/v1/accounts/${s.account.id}/activity?query=needle`);
  // Past the ten a minute a paid plan's website gets once its month is spent.
  for (let read = 0; read < 20; read++)
    assert.equal((await searchAll()).search.unavailableServers, 0, `search ${read}`);
  const { usage } = await s.usage();
  assert.deepEqual([usage.reads.used, usage.reads.beyond], [3, 0], JSON.stringify(usage));
});

test("self-hosted copies have no read budget", async (t) => {
  const s = await setup(t, { selfHosted: true }, { perMinute: 60, burst: 1 });
  for (let read = 0; read < 5; read++) await s.poll();
  assert.equal((await s.usage()).calls.length, 0);
});

test("budgets off: reads are measured and only the old limits apply", async (t) => {
  const s = await setup(t, { readBudgets: false }, { perMinute: 60, burst: 1 });
  for (let read = 0; read < 5; read++) await s.poll();
  const { calls } = await s.usage();
  assert.equal(calls.length, 0);
});

test("a paid plan's numbers follow its billing month; a lapse keeps them three days, then Free's apply", async (t) => {
  const s = await setup(t);
  const quota = (path, body) => s.x.control(`${path}?account=${s.account.id}`, body);
  await quota("storage/plan", {
    accountId: s.account.id,
    plan: "shop",
    start: "2026-11-10T00:00:00.000Z",
    end: "2026-12-10T00:00:00.000Z",
  });
  await quota("quota/configure", { at: "2026-11-20T00:00:00.000Z" });
  let { usage } = await s.usage();
  assert.deepEqual(
    [usage.terms.plan, usage.terms.paid, usage.reads.limit, usage.admin.limit],
    ["shop", true, 2000000, 10000],
  );
  assert.equal(usage.terms.perMinute, 120);
  assert.equal(usage.terms.burst, 1200);
  assert.equal(usage.terms.slowPerMinute, 3);
  assert.equal(usage.terms.periodStart, "2026-11-10T00:00:00.000Z");
  // Renewal not confirmed yet: the next month starts where the last ended, on Shop's numbers.
  await quota("quota/configure", { at: "2026-12-11T00:00:00.000Z" });
  ({ usage } = await s.usage());
  assert.deepEqual(
    [usage.terms.plan, usage.terms.periodStart],
    ["shop", "2026-12-10T00:00:00.000Z"],
  );
  // Lapsed for good: Free's numbers per UTC calendar month.
  await quota("quota/configure", { at: "2026-12-14T00:00:00.000Z" });
  ({ usage } = await s.usage());
  assert.deepEqual(
    [usage.terms.plan, usage.terms.paid, usage.terms.periodStart, usage.reads.limit],
    ["free", false, "2026-12-01T00:00:00.000Z", 500000],
  );
});

const channel = (s, name, participantId = s.agent.item.id, error = false) =>
  s.x.mcp(
    s.credential,
    "create_channel",
    { serverId: s.server.id, participantId, requestKey: randomUUID(), name },
    error,
  );

test("a person's changes on the website have their own minute, refused in a person's words", async (t) => {
  const s = await setup(t, { readBudgets: false, adminBudgets: true });
  await s.holdLimits();
  // The agent spends its own thirty admin calls a minute.
  for (let call = 0; call < 30; call++) await channel(s, `room-${call}`);
  assert.equal(
    (await channel(s, "one-too-many", s.agent.item.id, true)).error.code,
    "rate_limited",
  );
  // The person can still change that agent's wake settings: thirty times, then a wait.
  const dashboard = await website(s.x);
  const choose = () =>
    dashboard("PUT", `/v1/servers/${s.server.id}/participants/${s.agent.item.id}/wake-cadence`, {
      cadence: "every_5_minutes",
    });
  for (let call = 0; call < 30; call++) {
    const answer = await choose();
    assert.equal(answer.status, 200, `change ${call}: ${JSON.stringify(answer.json)}`);
  }
  const refused = await choose();
  assert.equal(refused.status, 429, JSON.stringify(refused.json));
  assert.match(refused.json.error.message, /^Too many changes from the TalkTo website: /);
  assert.match(refused.json.error.message, /Wait \d+ seconds?, then try again\.$/);
  assert.doesNotMatch(refused.json.error.message, /connection|participant|retry the same call/);
});

test("each agent may make 30 admin calls a minute on a server", async (t) => {
  const s = await setup(t, { readBudgets: false, adminBudgets: true });
  await s.holdLimits();
  for (let call = 0; call < 30; call++) await channel(s, `room-${call}`);
  const limited = await channel(s, "one-too-many", s.agent.item.id, true);
  assert.equal(limited.error.code, "rate_limited");
  assert.equal(limited.error.scope, "participant");
  assert.match(limited.error.message, /30 times a minute on this server/);
  // Another agent has its own minute; reads and sends are not admin calls.
  const other = (await s.register("second")).data.item.id;
  await channel(s, "elsewhere", other);
  await s.poll();
  const { usage } = await s.usage();
  assert.ok(usage.admin.used >= 33, JSON.stringify(usage.admin));
  assert.equal(usage.admin.limit, 1000);
});

test("past the month's admin calls, admin calls are refused; messages and reads still work", async (t) => {
  const s = await setup(t, { readBudgets: false, adminBudgets: true }, { adminMonthly: 3 });
  // Registering counted one; two channels spend the rest.
  await channel(s, "one");
  await channel(s, "two");
  const refused = await channel(s, "three", s.agent.item.id, true);
  assert.equal(refused.error.code, "rate_limited");
  assert.equal(refused.error.scope, "organization");
  assert.match(refused.error.message, /used the 3 admin calls a month/);
  assert.match(refused.error.message, /Messages and reads still work/);
  await s.poll();
  await s.x.mcp(s.credential, "send_message", {
    serverId: s.server.id,
    participantId: s.agent.item.id,
    requestKey: randomUUID(),
    target: { kind: "conversation", conversationId: s.agent.generalConversationId },
    body: "Sending is not an admin call.",
  });
  const http = await s.x.raw(`/v1/servers/${s.server.id}/channels`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await s.x.token("user_alice")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      participantId: s.agent.item.id,
      requestKey: randomUUID(),
      name: "over-http",
    }),
  });
  assert.equal(http.status, 429);
  assert.ok(Number(http.headers.get("retry-after")) >= 1);
});

test("a spent month never stops a person removing or restoring an agent, on the website or with a key", async (t) => {
  const s = await setup(t, { readBudgets: false, adminBudgets: true }, { adminMonthly: 1 });
  // Registering spent the month's one admin call.
  assert.equal((await channel(s, "over", s.agent.item.id, true)).error.scope, "organization");
  const root = `/v1/servers/${s.server.id}/participants/${s.agent.item.id}`;
  const dashboard = await website(s.x);
  for (const action of ["remove", "restore"]) {
    const answer = await dashboard("POST", `${root}/${action}`, {});
    assert.equal(answer.status, 200, `website ${action}: ${JSON.stringify(answer.json)}`);
  }
  const made = await dashboard("POST", "/v1/me/api-keys", { name: "remover", access: "full" });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  for (const action of ["remove", "restore"]) {
    const response = await s.x.raw(`${root}/${action}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${made.json.data.secret}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(response.status, 200, `key ${action}: ${await response.text()}`);
  }
});

test("refused sends count as admin calls and slow down a looping agent", async (t) => {
  const s = await setup(t, { readBudgets: false, adminBudgets: true });
  await s.holdLimits();
  const send = (error) =>
    s.x.mcp(
      s.credential,
      "send_message",
      {
        serverId: s.server.id,
        participantId: s.agent.item.id,
        requestKey: randomUUID(),
        target: { kind: "conversation", conversationId: randomUUID() },
        body: "Nobody is there.",
      },
      error,
    );
  for (let call = 0; call < 30; call++)
    assert.equal((await send(true)).error.code, "conversation_not_found");
  const slowed = await send(true);
  assert.equal(slowed.error.code, "rate_limited");
  assert.match(slowed.error.message, /Too many refused sends/);
  assert.ok((await s.usage()).usage.admin.used >= 31);
});

test("an organization may hold 100 servers by default, raised per organization by the operator", async (t) => {
  const x = await start(t, { serversPerOrganization: 2 });
  const account = await x.account();
  await x.server(account.id);
  await x.server(account.id, { name: "Second" });
  const create = (name, status) =>
    x.call(
      "user_alice",
      "POST",
      `/v1/accounts/${account.id}/servers`,
      { name, requestKey: randomUUID() },
      status,
    );
  const refused = await create("Third", 409);
  assert.equal(refused.error.code, "server_limit_reached");
  assert.match(refused.error.message, /limit of 2 servers/);
  assert.match(refused.error.message, /raised on request/);
  await x.control("env", { TALKTO_SERVER_LIMITS: JSON.stringify({ [account.id]: 3 }) });
  await create("Third", 200);
  assert.match((await create("Fourth", 409)).error.message, /limit of 3 servers/);
});

test("the organization's history cap is shared in proportion to each server's size, with 8 GB per server at most", async (t) => {
  const x = await start(t);
  const account = await x.account();
  const gb = 1_000_000_000;
  const report = async (serverId, bytes) =>
    (
      await (
        await x.control(`quota/history-cap?account=${account.id}`, {
          accountId: account.id,
          serverId,
          bytes,
        })
      ).json()
    ).targetBytes;
  const [a, b] = [randomUUID(), randomUUID()];
  // No plan, no cap: trials and organizations without a plan keep everything.
  assert.equal(await report(a, 3 * gb), null);
  const plan = (name) =>
    x.control(`storage/plan?account=${account.id}`, {
      accountId: account.id,
      plan: name,
      start: new Date(Date.now() - 86_400_000).toISOString(),
      end: new Date(Date.now() + 29 * 86_400_000).toISOString(),
    });
  await plan("shop");
  // Shop keeps 2 GB per organization: 3 GB and 1 GB share it 3:1.
  await report(b, 1 * gb);
  assert.equal(await report(a, 3 * gb), 1.5 * gb);
  assert.equal(await report(b, 1 * gb), 0.5 * gb);
  // Factory's 25 GB fits both, but no server keeps more than 8 GB in place.
  await plan("factory");
  assert.equal(await report(a, 9 * gb), 8 * gb);
});

/**
 * The quota object's test clock, and its alarm run as Cloudflare runs it: once it is due on that
 * clock. The test clock stays across restarts.
 */
const quotaClock = (s) => {
  const quota = (path, body) => s.x.control(`quota/${path}?account=${s.account.id}`, body);
  const set = (ms) => quota("configure", { at: new Date(ms).toISOString() });
  const due = async () => (await (await quota("budget-due")).json()).due;
  return {
    set,
    due,
    /** Move the clock from `from` to `to` in steps, running the alarm whenever it is due. */
    pass: async (from, to, step = 500) => {
      for (let at = from; at <= to; at += step) {
        await set(at);
        const when = await due();
        if (when !== null && when <= at) await quota("alarm");
      }
    },
    /** Drop the object's memory, as Cloudflare does 10 seconds after its last request or alarm. */
    restart: () => quota("restart"),
  };
};
/**
 * The 15th of this UTC month, so the quota object's clock and the server objects' real clocks agree
 * on the month whatever the date the tests run.
 */
const day = (() => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15);
})();

test("read counts are kept in memory and saved once a minute, not on every lease", async (t) => {
  // perMinute 6 leases one read at a time, so each poll is one lease.
  const s = await setup(t, {}, { monthly: 1000, perMinute: 6 });
  const rows = async () => (await s.x.control(`quota/budget-rows?account=${s.account.id}`)).json();
  const before = (await s.usage()).usage.reads.used;
  for (let read = 0; read < 4; read++) await s.poll();
  const { usage, calls } = await s.usage();
  assert.ok(calls.filter((call) => call.lane === "read").length >= 4, JSON.stringify(calls));
  // The month's count is current at once, for limits and for Billing.
  assert.equal(usage.reads.used, before + 4);
  // Storage trails it: these leases wrote no budget rows.
  const saved = (await rows()).find((row) => row.lane === "read")?.used ?? 0;
  assert.ok(saved < before + 4, `saved ${saved} of ${before + 4}`);
  // The alarm, run once no lease has come for 5 seconds, saves what memory holds.
  await quotaClock(s).set(Date.now() + 6_000);
  const { scheduled, now } = await (
    await s.x.control(`quota/alarm?account=${s.account.id}`)
  ).json();
  assert.ok(scheduled !== null && scheduled - now <= 60_000, `alarm at ${scheduled}, now ${now}`);
  assert.equal((await rows()).find((row) => row.lane === "read").used, before + 4);
  assert.equal((await s.usage()).usage.reads.used, before + 4);
});

test("counts survive the quota object going idle: an isolated read is saved at once, close reads within seconds", async (t) => {
  // perMinute 6 leases one read at a time, so each poll is one lease.
  const s = await setup(t, {}, { monthly: 1000, perMinute: 6 });
  const clock = quotaClock(s);
  const before = (await s.usage()).usage.reads.used;
  await clock.set(day);
  await s.poll();
  await clock.restart();
  assert.equal((await s.usage()).usage.reads.used, before + 1);
  // Reads close behind each other wait for the alarm, due within 5 seconds of the last of them.
  for (let read = 0; read < 3; read++) {
    await clock.set(day + 20_000 + read * 1_000);
    await s.poll();
  }
  const due = await clock.due();
  assert.ok(due !== null && due <= day + 22_000 + 5_000, `alarm due at ${due}`);
  await clock.pass(day + 22_000, day + 31_500);
  await clock.restart();
  assert.equal((await s.usage()).usage.reads.used, before + 4);
});

test("a long burst of close reads is saved before the quota object can go idle", async (t) => {
  // perMinute 6 leases one read at a time, so each poll is one lease.
  const s = await setup(t, {}, { monthly: 1000, perMinute: 6 });
  const clock = quotaClock(s);
  const before = (await s.usage()).usage.reads.used;
  // One poll every 0.4 seconds for 8 seconds, more than 12 close calls, the alarm running whenever
  // it comes due.
  const reads = 20;
  for (let read = 0; read < reads; read++) {
    await clock.pass(day + read * 400, day + read * 400);
    await s.poll();
  }
  // The alarm runs within 5 seconds of the last lease, before the object can go idle.
  const last = day + (reads - 1) * 400;
  await clock.pass(last, last + 9_500);
  await clock.restart();
  assert.equal((await s.usage()).usage.reads.used, before + reads);
});

test("a busy quota object saves once a minute, and its alarm only moves on while leases come", async (t) => {
  // perMinute 6 leases one read at a time; a large burst keeps the bucket out of the way.
  const s = await setup(t, {}, { monthly: 1000, perMinute: 6, burst: 200 });
  const clock = quotaClock(s);
  const rows = async () =>
    (await (await s.x.control(`quota/budget-rows?account=${s.account.id}`)).json()).find(
      (row) => row.lane === "read",
    )?.used ?? 0;
  // Twenty seconds of leases, one a second: the first is saved at once, the rest wait.
  for (let read = 0; read < 20; read++) {
    await clock.pass(day + read * 1_000, day + read * 1_000);
    await s.poll();
  }
  const used = (await s.usage()).usage.reads.used;
  assert.ok((await rows()) < used, "a busy object saved on every lease");
  // Still busy: an alarm that runs while leases keep coming saves nothing and is due again 5
  // seconds after the last lease.
  assert.equal(await clock.due(), day + 19_000 + 5_000);
  await s.x.control(`quota/alarm?account=${s.account.id}`);
  assert.ok((await rows()) < used, "the alarm saved while leases kept coming");
  // A minute after the last save, it saves even while leases keep coming.
  for (let read = 20; read < 62; read++) {
    await clock.pass(day + read * 1_000, day + read * 1_000);
    await s.poll();
  }
  assert.ok((await rows()) >= used, `saved ${await rows()} of ${used}`);
});

test("a server whose clock is past the quota object's month spends each lease it waited for", async (t) => {
  // The quota object's clock is in last month, so every lease ends before this server's clock.
  const s = await setup(t, {}, { perMinute: 600, burst: 600 });
  const now = new Date();
  await quotaClock(s).set(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
  const measure = async (reads) => {
    const calls = (value) => value.calls.filter((call) => call.lane === "read").length;
    const before = await s.usage();
    await reads();
    const after = await s.usage();
    return {
      counted: after.usage.reads.used - before.usage.reads.used,
      calls: calls(after) - calls(before),
    };
  };
  const alone = await measure(async () => {
    for (let read = 0; read < 5; read++) await s.poll();
  });
  const together = await measure(() => Promise.all(Array.from({ length: 10 }, () => s.poll())));
  t.diagnostic(JSON.stringify({ alone, together }));
  // Each read is counted once, in the quota object's month.
  assert.equal(alone.counted, 5);
  assert.equal(together.counted, 10);
  // A lone read makes exactly one call: what the last lease left belongs to a month that has ended
  // on this server's clock.
  assert.equal(alone.calls, 5);
  // Reads share a call only when they wait for the same lease, which depends on when each request
  // reaches the server object. Every lease is spent first by the read that asked for it, so the
  // worst case is a call per read, never more; before, one read made hundreds.
  assert.ok(together.calls <= 10, JSON.stringify(together));
});

test("a search counts three units, over MCP as over HTTP", async (t) => {
  // perMinute 6 leases one unit at a time, so the month counts exactly what was read.
  const s = await setup(t, {}, { perMinute: 6 });
  const before = (await s.usage()).usage.reads.used;
  await s.poll();
  await s.search();
  const http = await s.x.raw(`/v1/servers/${s.server.id}/messages/search?query=anything`, {
    headers: { authorization: `Bearer ${await s.x.token("user_alice")}` },
  });
  assert.equal(http.status, 200);
  assert.equal((await s.usage()).usage.reads.used, before + 1 + 3 + 3);
});

/**
 * Bursts of reads with the server object leaving memory between them, as it does in production
 * while agents' waits are held in the Worker. Each burst runs at its own minute on the quota
 * object's clock, and the quota alarm runs when due, so the quota rows of each burst are saved.
 */
const bursts = async (s, sizes) => {
  const clock = quotaClock(s);
  const reads = (await s.usage()).calls.filter((call) => call.lane === "read").length;
  const before = (await s.usage()).usage.reads.used;
  await s.x.control(`quota/cost?account=${s.account.id}`);
  let rows = 0;
  let made = 0;
  for (const [index, size] of sizes.entries()) {
    const at = day + index * 60_000;
    await clock.set(at);
    await s.x.control(`meter/configure?server=${s.server.id}`, { restart: true });
    for (let read = 0; read < size; read++) await s.poll();
    made += size;
    await clock.pass(at, at + 9_500);
    rows += (await (await s.x.control(`quota/cost?account=${s.account.id}`)).json()).rows;
  }
  const { usage, calls } = await s.usage();
  return {
    made,
    counted: usage.reads.used - before,
    calls: calls.filter((call) => call.lane === "read").length - reads,
    rows,
  };
};

test("a server that leaves memory between short bursts is counted exactly what it read", async (t) => {
  // Shop's numbers: leases of at most 12 reads.
  const s = await setup(t, {}, { monthly: 2_000_000, perMinute: 120 });
  const measured = await bursts(s, [5, 5, 5, 5, 5, 5, 9, 9, 9, 9, 9, 9]);
  t.diagnostic(JSON.stringify(measured));
  assert.equal(measured.made, 84);
  assert.equal(measured.counted, measured.made);
});

test("a server that leaves memory after a longer burst is counted at most an eighth more", async (t) => {
  // Studio's numbers: leases of at most 60 reads.
  const s = await setup(t, {}, { monthly: 10_000_000, perMinute: 600 });
  const measured = await bursts(s, [30, 50, 100]);
  t.diagnostic(JSON.stringify(measured));
  assert.ok(measured.counted >= measured.made, JSON.stringify(measured));
  assert.ok(
    measured.counted - measured.made <= 30 / 8 + 50 / 8 + 100 / 8,
    JSON.stringify(measured),
  );
});

/**
 * Restart the server object, then make `count` reads at once on it, as agents waking together do.
 * Returns the units counted and the lease calls the wave made.
 */
const wave = async (s, count, read = () => s.poll(), lane = "read") => {
  await s.x.control(`meter/configure?server=${s.server.id}`, { restart: true });
  const calls = (value) => value.calls.filter((call) => call.lane === lane).length;
  const before = await s.usage();
  await Promise.all(Array.from({ length: count }, () => read()));
  const after = await s.usage();
  return {
    counted: after.usage.reads.used - before.usage.reads.used,
    calls: calls(after) - calls(before),
  };
};

for (const [plan, budgets] of [
  ["Free", { perMinute: 60 }],
  ["Shop", { monthly: 2_000_000, perMinute: 120 }],
  ["Factory", { monthly: 20_000_000, perMinute: 1500 }],
])
  test(`concurrent reads on a server fresh in memory are all counted (${plan})`, async (t) => {
    const s = await setup(t, { participantReadsPerMinute: 10_000 }, budgets);
    const waves = [];
    for (const count of [10, 40, 100]) waves.push({ count, ...(await wave(s, count)) });
    t.diagnostic(JSON.stringify(waves));
    for (const measured of waves) {
      // Every read is counted. Past 16, later leases may run ahead by under an eighth of the reads.
      assert.ok(measured.counted >= measured.count, JSON.stringify(measured));
      assert.ok(measured.counted - measured.count < measured.count / 8, JSON.stringify(measured));
      // One lease covers every read waiting then, so a read waits on the lease in flight and the
      // next one, never on a call per read ahead of it.
      assert.ok(measured.calls <= 3 + measured.count / 4, JSON.stringify(measured));
    }
  });

test("concurrent deep reads and website reads on a fresh server are all counted", async (t) => {
  const s = await setup(
    t,
    { participantReadsPerMinute: 10_000 },
    { monthly: 2_000_000, perMinute: 120 },
  );
  await s.paid();
  const deep = await wave(s, 10, () => s.search());
  const searchAll = () =>
    s.x.call("user_alice", "GET", `/v1/accounts/${s.account.id}/activity?query=needle`);
  const website = await wave(s, 20, searchAll, "dashboard");
  t.diagnostic(JSON.stringify({ deep, website }));
  // Every unit is counted, and later leases run ahead by under an eighth of what was read.
  for (const [measured, units] of [
    [deep, 10 * 3],
    [website, 20 * 3],
  ]) {
    assert.ok(measured.counted >= units, JSON.stringify(measured));
    assert.ok(measured.counted - units < units / 8, JSON.stringify(measured));
  }
});
