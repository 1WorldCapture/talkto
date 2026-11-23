import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

/** One organization, one server and two agents, with helpers for polls and reads. */
const setup = async (t, options = {}) => {
  const x = await start(t, options);
  const account = await x.account();
  const credential = await x.mcpToken(account.organizationId);
  const server = await x.server(account.id);
  const register = async (target, name) =>
    (
      await x.mcp(credential, "register_participant", {
        serverId: target.id,
        name,
        agentType: "claude-code",
        requestKey: randomUUID(),
      })
    ).data;
  const first = await register(server, "first");
  const second = await register(server, "second");
  const general = first.generalConversationId;
  const poll = (participantId, error = false, target = server) =>
    x.mcp(
      credential,
      "get_updates",
      {
        serverId: target.id,
        participantId,
        mode: "start",
        channelIds: [],
        directChats: "own",
        startAt: "now",
      },
      error,
    );
  const history = (error = false) =>
    x.mcp(
      credential,
      "read_messages",
      { serverId: server.id, mode: "history", conversationId: general, limit: 5 },
      error,
    );
  const httpRead = async () =>
    x.raw(`/v1/servers/${server.id}/conversations/${general}/messages`, {
      headers: { authorization: `Bearer ${await x.token("user_alice")}` },
    });
  const events = async () => (await (await x.control("read-events")).json()).events;
  await events();
  return {
    x,
    account,
    credential,
    server,
    general,
    register,
    first: first.item.id,
    second: second.item.id,
    poll,
    history,
    httpRead,
    events,
  };
};

test("default limits never touch polling at the documented interval, and every read is measured", async (t) => {
  const s = await setup(t);
  // An hour of polling every 30 seconds, delivered all at once, stays under the default limit.
  for (let check = 0; check < 120; check++) await s.poll(s.first);
  await s.history();
  assert.equal((await s.httpRead()).status, 200);
  await s.x.mcp(s.credential, "send_message", {
    serverId: s.server.id,
    participantId: s.first,
    requestKey: randomUUID(),
    target: { kind: "conversation", conversationId: s.general },
    body: "Writes are metered as messages, not as reads.",
  });
  const events = await s.events();
  assert.equal(events.length, 122);
  const [account, , serverId, kind, subject, operation, transport, outcome] = events[0];
  assert.deepEqual(
    [account, serverId, kind, subject, operation, transport, outcome],
    [s.account.id, s.server.id, "participant", s.first, "get_updates", "mcp", "allowed"],
  );
  assert.ok(events[0][1].length > 0);
  // Reads that name no participant are attributed to the caller's grant, never to an agent.
  assert.deepEqual(events[120].slice(3, 8), [
    "grant",
    events[120][4],
    "read_messages",
    "mcp",
    "allowed",
  ]);
  assert.notEqual(events[120][4], s.first);
  assert.deepEqual(events[121].slice(5, 8), ["readMessages", "http", "allowed"]);
});

test("one participant over its limit is refused with a retry delay; others keep reading", async (t) => {
  const s = await setup(t, { participantReadsPerMinute: 5 });
  for (let check = 0; check < 5; check++) await s.poll(s.first);
  const refused = await s.poll(s.first, true);
  assert.equal(refused.error.code, "rate_limited");
  assert.equal(refused.error.scope, "participant");
  assert.equal(refused.error.retryable, true);
  assert.equal(refused.error.action, "retry_after");
  assert.ok(refused.error.retryAfterSeconds >= 1 && refused.error.retryAfterSeconds <= 12);
  assert.match(refused.error.message, /Wait \d+ seconds?,/);
  await s.poll(s.second);
  // Writes are never refused by the read limit.
  await s.x.mcp(s.credential, "send_message", {
    serverId: s.server.id,
    participantId: s.first,
    requestKey: randomUUID(),
    target: { kind: "conversation", conversationId: s.general },
    body: "Still sending.",
  });
  // HTTP reads share the caller's grant bucket and answer 429 with Retry-After.
  for (let read = 0; read < 5; read++) assert.equal((await s.httpRead()).status, 200);
  const limited = await s.httpRead();
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  const body = await limited.json();
  assert.equal(body.error.code, "rate_limited");
  assert.equal(body.error.retryAfterSeconds, Number(limited.headers.get("retry-after")));
  const outcomes = (await s.events()).map((event) => event[7]);
  assert.equal(outcomes.filter((outcome) => outcome === "participant_limited").length, 2);
});

const pause = (millis) => new Promise((resolve) => setTimeout(resolve, millis));
/** Server objects the Worker looked up since the last call; no lookup means no request reached one. */
const lookups = async (s) => (await (await s.x.control("server-lookups")).json()).names;
/** "Wait 1 second" or "Wait 3 seconds", as refusals write it. */
const waitFor = (seconds) => `Wait ${seconds} second${seconds === 1 ? "" : "s"}`;
/** The refusal the server gave, as it reads with `seconds` left. */
const withSeconds = (error, seconds) => ({
  ...error,
  retryAfterSeconds: seconds,
  message: error.message.replace(waitFor(error.retryAfterSeconds), waitFor(seconds)),
});

test("an early retry is refused by the Worker with the time left, without reaching the server", async (t) => {
  // One read every 5 seconds once the burst is spent, so a refusal waits a few seconds.
  const s = await setup(t, { participantReadsPerMinute: 12 });
  for (let check = 0; check < 12; check++) await s.poll(s.first);
  const refused = await s.poll(s.first, true);
  const refusedAt = Date.now();
  const seconds = refused.error.retryAfterSeconds;
  assert.equal(refused.error.code, "rate_limited");
  assert.equal(refused.error.scope, "participant");
  assert.ok(seconds >= 2 && seconds <= 5, String(seconds));
  assert.deepEqual(
    (await s.events()).map((event) => event[7]),
    [...Array.from({ length: 12 }, () => "allowed"), "participant_limited"],
  );
  await lookups(s);
  // At once: the same answer, and no server object was looked up or measured the call.
  const early = await s.poll(s.first, true);
  assert.ok(early.error.retryAfterSeconds >= 1 && early.error.retryAfterSeconds <= seconds);
  assert.deepEqual(early.error, withSeconds(refused.error, early.error.retryAfterSeconds));
  assert.notEqual(early.meta.requestId, refused.meta.requestId);
  // A waiting read is refused at once too: no watch is opened and nothing is read.
  const waiting = await s.x.mcp(
    s.credential,
    "get_updates",
    {
      serverId: s.server.id,
      participantId: s.first,
      mode: "start",
      channelIds: [],
      directChats: "own",
      startAt: "now",
      waitSeconds: 10,
    },
    true,
  );
  assert.deepEqual(waiting.error, withSeconds(refused.error, waiting.error.retryAfterSeconds));
  assert.deepEqual(await lookups(s), []);
  assert.deepEqual(await s.events(), []);
  // A write is never answered from memory: the refused participant's send reaches the server.
  const sent = await s.x.mcp(s.credential, "send_message", {
    serverId: s.server.id,
    participantId: s.first,
    requestKey: randomUUID(),
    target: { kind: "conversation", conversationId: s.general },
    body: "Sends are never refused by the read limit.",
  });
  assert.equal(sent.data.item.body, "Sends are never refused by the read limit.");
  assert.deepEqual(await lookups(s), [s.server.id]);
  // A second later, a second less to wait.
  await pause(1000);
  const later = await s.poll(s.first, true);
  assert.ok(later.error.retryAfterSeconds < seconds, JSON.stringify(later.error));
  assert.deepEqual(later.error, withSeconds(refused.error, later.error.retryAfterSeconds));
  assert.deepEqual(await lookups(s), []);
  // The refusal is this participant's on this connection: other reads still reach the server.
  await s.poll(s.second);
  await s.history();
  assert.deepEqual(await lookups(s), [s.server.id, s.server.id]);
  // After the retry time, the server answers again.
  await pause(Math.max(0, refusedAt + seconds * 1000 + 250 - Date.now()));
  assert.ok(Array.isArray((await s.poll(s.first)).data.messages));
  assert.deepEqual(await lookups(s), [s.server.id]);
  // The server measured every read it saw, and only those.
  assert.deepEqual(
    (await s.events()).map((event) => [event[3] === "grant" ? "grant" : event[4], event[7]]),
    [
      [s.second, "allowed"],
      ["grant", "allowed"],
      [s.first, "allowed"],
    ],
  );
});

test("a refusal is replayed only to the caller it was given to", async (t) => {
  const s = await setup(t, { participantReadsPerMinute: 12 });
  await s.x.control("member", s.x.member(s.account.organizationId));
  await s.x.call("user_alice", "PUT", `/v1/servers/${s.server.id}/access/user_bob`);
  const bob = await s.x.mcpToken(s.account.organizationId, "user_bob");
  for (let check = 0; check < 12; check++) await s.poll(s.first);
  assert.equal((await s.poll(s.first, true)).error.code, "rate_limited");
  await lookups(s);
  await s.events();
  // Another person's connection naming the same participant reaches the server, which refuses it
  // from the participant's own bucket. Alice's remembered refusal never answers for Bob.
  const asBob = await s.x.mcp(
    bob,
    "get_updates",
    {
      serverId: s.server.id,
      participantId: s.first,
      mode: "start",
      channelIds: [],
      directChats: "own",
      startAt: "now",
    },
    true,
  );
  assert.equal(asBob.error.code, "rate_limited");
  assert.deepEqual(await lookups(s), [s.server.id]);
  assert.deepEqual(
    (await s.events()).map((event) => [event[4], event[7]]),
    [[s.first, "participant_limited"]],
  );
  // Alice's own retry is still answered from memory.
  assert.equal((await s.poll(s.first, true)).error.code, "rate_limited");
  assert.deepEqual(await lookups(s), []);
  // The same person signed in through another organization is the same caller: server access is
  // the boundary, not the organization. The remembered refusal answers without a request.
  const elsewhere = await s.x.account();
  const otherOrganization = await s.x.mcpToken(elsewhere.organizationId);
  const outside = await s.x.mcp(
    otherOrganization,
    "get_updates",
    {
      serverId: s.server.id,
      participantId: s.first,
      mode: "start",
      channelIds: [],
      directChats: "own",
      startAt: "now",
    },
    true,
  );
  assert.equal(outside.error.code, "rate_limited");
  assert.deepEqual(await lookups(s), []);
});

test("an early identical HTTP read gets the same 429 from the Worker, without reaching the server", async (t) => {
  const s = await setup(t, { participantReadsPerMinute: 12 });
  for (let read = 0; read < 12; read++) assert.equal((await s.httpRead()).status, 200);
  const limited = await s.httpRead();
  const limitedAt = Date.now();
  assert.equal(limited.status, 429);
  const body = await limited.json();
  assert.equal(body.error.code, "rate_limited");
  await lookups(s);
  await s.events();
  const early = await s.httpRead();
  assert.equal(early.status, 429);
  const replayed = await early.json();
  const seconds = replayed.error.retryAfterSeconds;
  assert.ok(seconds >= 1 && seconds <= body.error.retryAfterSeconds);
  assert.deepEqual(replayed.error, withSeconds(body.error, seconds));
  assert.equal(early.headers.get("retry-after"), String(seconds));
  for (const header of ["content-type", "cache-control", "link"])
    assert.equal(early.headers.get(header), limited.headers.get(header), header);
  assert.equal(early.headers.get("x-request-id"), replayed.meta.requestId);
  assert.notEqual(replayed.meta.requestId, body.meta.requestId);
  assert.deepEqual(replayed.meta.instructions, body.meta.instructions);
  assert.deepEqual(await lookups(s), []);
  assert.deepEqual(await s.events(), []);
  // A different request is not this refusal: it reaches the server, whose bucket refuses it.
  const other = await s.x.raw(`/v1/servers/${s.server.id}/participants`, {
    headers: { authorization: `Bearer ${await s.x.token("user_alice")}` },
  });
  assert.equal(other.status, 429);
  assert.deepEqual(await lookups(s), [s.server.id]);
  // A write to the refused read's own path reaches the server and is sent.
  const sent = await s.x.call(
    "user_alice",
    "POST",
    `/v1/servers/${s.server.id}/conversations/${s.general}/messages`,
    { participantId: s.first, requestKey: randomUUID(), body: "Still sending over HTTP." },
  );
  assert.equal(sent.item.body, "Still sending over HTTP.");
  assert.deepEqual(await lookups(s), [s.server.id]);
  // After the retry time, the server object answers the same read again.
  await pause(Math.max(0, limitedAt + body.error.retryAfterSeconds * 1000 + 250 - Date.now()));
  assert.equal((await s.httpRead()).status, 200);
  assert.deepEqual(await lookups(s), [s.server.id]);
});

test("an early identical waiting HTTP updates call gets the same 429 from the Worker", async (t) => {
  const s = await setup(t, { participantReadsPerMinute: 12 });
  const updates = async (input) =>
    s.x.raw(`/v1/servers/${s.server.id}/updates`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await s.x.token("user_alice")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
  const start = {
    participantId: s.first,
    mode: "start",
    channelIds: [],
    directChats: "own",
    startAt: "now",
  };
  for (let read = 0; read < 12; read++) assert.equal((await updates(start)).status, 200);
  const waiting = { ...start, waitSeconds: 10 };
  const limited = await updates(waiting);
  assert.equal(limited.status, 429);
  const body = await limited.json();
  assert.equal(body.error.code, "rate_limited");
  assert.equal(body.error.scope, "participant");
  await lookups(s);
  await s.events();
  // The same body again: answered at once from memory, without a watch or a read.
  const early = await updates(waiting);
  assert.equal(early.status, 429);
  const replayed = await early.json();
  assert.deepEqual(replayed.error, withSeconds(body.error, replayed.error.retryAfterSeconds));
  assert.equal(early.headers.get("retry-after"), String(replayed.error.retryAfterSeconds));
  assert.deepEqual(await lookups(s), []);
  assert.deepEqual(await s.events(), []);
  // Another body is another request: the server object refuses it from the participant's bucket.
  assert.equal((await updates(start)).status, 429);
  assert.deepEqual(await lookups(s), [s.server.id]);
  assert.deepEqual(
    (await s.events()).map((event) => [event[4], event[5], event[7]]),
    [[s.first, "getUpdates", "participant_limited"]],
  );
});

test("the organization backstop counts reads across all of its servers", async (t) => {
  const s = await setup(t, { organizationReadsPerMinute: 4 });
  const other = await s.x.server(s.account.id, { name: "Second" });
  const elsewhere = (await s.register(other, "elsewhere")).item.id;
  await s.poll(s.first);
  await s.poll(elsewhere, false, other);
  await s.poll(s.second);
  await s.poll(elsewhere, false, other);
  const refused = await s.poll(elsewhere, true, other);
  assert.equal(refused.error.code, "rate_limited");
  assert.equal(refused.error.scope, "organization");
  assert.equal(refused.error.retryAfterSeconds, 60);
  assert.equal((await s.poll(s.first, true)).error.scope, "organization");
  // The backstop's window is the binding's own, so the Worker never remembers its refusal: an
  // early retry asks the server object again.
  await lookups(s);
  assert.deepEqual((await s.poll(elsewhere, true, other)).error, refused.error);
  assert.deepEqual(await lookups(s), [other.id]);
});

test("limits can be turned off by configuration; reads are still measured", async (t) => {
  const s = await setup(t, {
    readLimits: "off",
    participantReadsPerMinute: 1,
    organizationReadsPerMinute: 1,
  });
  for (let check = 0; check < 5; check++) await s.poll(s.first);
  for (let read = 0; read < 3; read++) await s.history();
  const events = await s.events();
  assert.equal(events.length, 8);
  assert.ok(events.every((event) => event[7] === "allowed"));
});

test("a waiting get_updates is one read however often a wake makes it read again; callers cannot skip admission", async (t) => {
  const s = await setup(t);
  const pause = (millis) => new Promise((resolve) => setTimeout(resolve, millis));
  const direct = (body) =>
    s.x.mcp(s.credential, "send_message", {
      serverId: s.server.id,
      participantId: s.second,
      requestKey: randomUUID(),
      target: { kind: "direct", recipientId: s.first },
      body,
    });
  const started = await s.poll(s.first);
  // Over MCP: the wait reads, finds nothing, is woken by the direct message and reads again.
  const waiting = s.x.mcp(s.credential, "get_updates", {
    serverId: s.server.id,
    participantId: s.first,
    mode: "poll",
    checkpoint: started.data.checkpoint,
    waitSeconds: 10,
  });
  await pause(300);
  await direct("wake over MCP");
  const woken = await waiting;
  assert.deepEqual(
    woken.data.messages.map((message) => message.body),
    ["wake over MCP"],
  );
  // Over HTTP, held by the Worker the same way.
  const http = async (body, headers = {}) =>
    s.x.raw(`/v1/servers/${s.server.id}/updates`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await s.x.token("user_alice")}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const httpWaiting = http({
    participantId: s.first,
    mode: "poll",
    checkpoint: woken.data.checkpoint,
    waitSeconds: 10,
  });
  await pause(300);
  await direct("wake over HTTP");
  const httpWoken = await httpWaiting;
  assert.equal(httpWoken.status, 200);
  const page = await httpWoken.json();
  assert.deepEqual(
    page.data.messages.map((message) => message.body),
    ["wake over HTTP"],
  );
  // The Worker's re-read marker is removed from what a caller sends, so this read is admitted.
  const forged = await http(
    { participantId: s.first, mode: "poll", checkpoint: page.data.checkpoint },
    { "x-talkto-wait-reread": "1" },
  );
  assert.equal(forged.status, 200);
  const updates = (await s.events()).filter((event) =>
    ["get_updates", "getUpdates"].includes(event[5]),
  );
  assert.deepEqual(
    updates.map((event) => [event[5], event[6]]),
    [
      ["get_updates", "mcp"],
      ["get_updates", "mcp"],
      ["getUpdates", "http"],
      ["getUpdates", "http"],
    ],
  );
});
