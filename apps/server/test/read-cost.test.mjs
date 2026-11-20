import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

/*
  What one read costs the server object (docs/read-cost-plan-2026-11-17.md, stream A): the rows
  its SQL reads and the requests it serves. The fixture measures both on request.
*/

/** One organization, one server and two agents over MCP, and the object's measurements. */
const setup = async (t, options = {}) => {
  const x = await start(t, options);
  const account = await x.account();
  const credential = await x.mcpToken(account.organizationId);
  const server = await x.server(account.id);
  const register = async (name) =>
    (
      await x.mcp(credential, "register_participant", {
        serverId: server.id,
        name,
        agentType: "claude-code",
        requestKey: randomUUID(),
      })
    ).data;
  const reader = await register("reader");
  const sender = await register("sender");
  const measure = async (work) => {
    await x.control(`cost?server=${server.id}`, "start");
    const result = await work();
    const cost = await (await x.control(`cost?server=${server.id}`, "take")).json();
    return { result, cost };
  };
  const updates = (input) =>
    x.mcp(credential, "get_updates", {
      serverId: server.id,
      participantId: reader.item.id,
      ...input,
    });
  const send = (body) =>
    x.mcp(credential, "send_message", {
      serverId: server.id,
      participantId: sender.item.id,
      requestKey: randomUUID(),
      target: { kind: "direct", recipientId: reader.item.id },
      body,
    });
  /** The same read over HTTP: the status and the page. `padding` goes before the JSON. */
  const http = async (input, padding = "") => {
    const response = await x.raw(`/v1/servers/${server.id}/updates`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await x.token("user_alice")}`,
        "content-type": "application/json",
      },
      body: padding + JSON.stringify({ participantId: reader.item.id, ...input }),
    });
    return { status: response.status, body: await response.json() };
  };
  const firstRead = (action) => x.control(`first-read?server=${server.id}`, action);
  return {
    x,
    account,
    credential,
    server,
    reader: reader.item.id,
    sender: sender.item.id,
    measure,
    updates,
    send,
    http,
    firstRead,
  };
};
const pause = (millis) => new Promise((resolve) => setTimeout(resolve, millis));
const timed = async (work) => {
  const begun = Date.now();
  const result = await work;
  return { result, millis: Date.now() - begun };
};
const bodies = (page) => page.data.messages.map((message) => message.body);

test("a warm get_updates never scans the schema table", async (t) => {
  const s = await setup(t);
  const started = await s.updates({
    mode: "start",
    channelIds: [],
    directChats: "own",
    startAt: "now",
  });
  const { cost } = await s.measure(() =>
    s.updates({ mode: "poll", checkpoint: started.data.checkpoint }),
  );
  t.diagnostic(`rows read by one get_updates: ${cost.rowsRead}`);
  t.diagnostic(JSON.stringify(cost.statements));
  assert.deepEqual(
    cost.statements.filter((statement) => /sqlite_master/.test(statement.query)),
    [],
  );
});

test("a deleted server refuses every read, before and after its object restarts", async (t) => {
  const s = await setup(t, { manualAlarms: true });
  const started = await s.updates({
    mode: "start",
    channelIds: [],
    directChats: "own",
    startAt: "now",
  });
  const checkpoint = started.data.checkpoint;
  const deleted = await s.x.call(
    "user_alice",
    "POST",
    `/v1/accounts/${s.account.id}/servers/${s.server.id}/delete`,
    { confirmation: s.server.name },
  );
  assert.equal(deleted.status, "deleted");
  const refused = async () => {
    for (const waitSeconds of [0, 2]) {
      const reply = await s.x.mcp(
        s.credential,
        "get_updates",
        { serverId: s.server.id, participantId: s.reader, mode: "poll", checkpoint, waitSeconds },
        true,
      );
      assert.equal(reply.error.code, "server_unavailable");
    }
    const http = await s.x.raw(`/v1/servers/${s.server.id}/updates`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await s.x.token("user_alice")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ participantId: s.reader, mode: "poll", checkpoint, waitSeconds: 2 }),
    });
    assert.equal(http.status, 404);
    assert.equal((await http.json()).error.code, "server_unavailable");
  };
  await refused();
  await s.x.control(`meter/configure?server=${s.server.id}`, { restart: true });
  await refused();
});

test("a waiting get_updates check is one server object request, over MCP and HTTP", async (t) => {
  const s = await setup(t);
  const requests = ({ cost }) => cost.requests.fetch + cost.requests.invokeAgent;
  let checkpoint = (
    await s.updates({ mode: "start", channelIds: [], directChats: "own", startAt: "now" })
  ).data.checkpoint;
  // Nothing arrives: one request registers the watch, reads, and holds the empty page.
  const quiet = await s.measure(() => s.updates({ mode: "poll", checkpoint, waitSeconds: 1 }));
  assert.deepEqual(quiet.result.data.messages, []);
  assert.equal(requests(quiet), 1, JSON.stringify(quiet.cost.requests));
  t.diagnostic(`rows read by a waiting check that times out: ${quiet.cost.rowsRead}`);
  // A message already waits: the same request answers with it.
  await s.send("already here");
  const ready = await s.measure(() => s.updates({ mode: "poll", checkpoint, waitSeconds: 10 }));
  assert.deepEqual(bodies(ready.result), ["already here"]);
  assert.equal(requests(ready), 1, JSON.stringify(ready.cost.requests));
  checkpoint = ready.result.data.checkpoint;
  // A send wakes the wait: the send and one re-read are the only other requests.
  const woken = await s.measure(async () => {
    const waiting = s.updates({ mode: "poll", checkpoint, waitSeconds: 10 });
    await pause(300);
    await s.send("wake up");
    return waiting;
  });
  assert.deepEqual(bodies(woken.result), ["wake up"]);
  assert.equal(requests(woken), 3, JSON.stringify(woken.cost.requests));
  checkpoint = woken.result.data.checkpoint;
  // Over HTTP, held by the Worker the same way.
  const httpQuiet = await s.measure(() => s.http({ mode: "poll", checkpoint, waitSeconds: 1 }));
  assert.equal(httpQuiet.result.status, 200);
  assert.deepEqual(httpQuiet.result.body.data.messages, []);
  assert.equal(requests(httpQuiet), 1, JSON.stringify(httpQuiet.cost.requests));
  await s.send("already here over HTTP");
  const httpReady = await s.measure(() => s.http({ mode: "poll", checkpoint, waitSeconds: 10 }));
  assert.deepEqual(bodies(httpReady.result.body), ["already here over HTTP"]);
  assert.equal(requests(httpReady), 1, JSON.stringify(httpReady.cost.requests));
  // A body padded past what one header carries goes as before: the watch, then a separate read.
  checkpoint = httpReady.result.body.data.checkpoint;
  const padded = await s.measure(async () => {
    const waiting = s.http({ mode: "poll", checkpoint, waitSeconds: 10 }, " ".repeat(20000));
    await pause(300);
    await s.send("padded wait");
    return waiting;
  });
  assert.deepEqual(bodies(padded.result.body), ["padded wait"]);
  assert.equal(requests(padded), 4, JSON.stringify(padded.cost.requests));
});

test("a send that commits after a held call's first read, before its watch opens, still wakes it", async (t) => {
  const s = await setup(t);
  let checkpoint = (
    await s.updates({ mode: "start", channelIds: [], directChats: "own", startAt: "now" })
  ).data.checkpoint;
  const raced = async (wait, body) => {
    await s.firstRead("pause");
    const waiting = timed(wait({ mode: "poll", checkpoint, waitSeconds: 10 }));
    // The first read found nothing; the watch is registered but its socket is not open yet.
    await s.firstRead("reached");
    await s.send(body);
    await s.firstRead("release");
    const { result, millis } = await waiting;
    assert.ok(millis < 5000, `answered at the deadline (${millis} ms), not on the send`);
    return result;
  };
  const viaMcp = await raced(s.updates, "between read and watch");
  assert.deepEqual(bodies(viaMcp), ["between read and watch"]);
  checkpoint = viaMcp.data.checkpoint;
  const viaHttp = await raced(s.http, "between read and watch over HTTP");
  assert.equal(viaHttp.status, 200);
  assert.deepEqual(bodies(viaHttp.body), ["between read and watch over HTTP"]);
});

test("a held call still waits on an object from before first reads", async (t) => {
  const s = await setup(t);
  const requests = ({ cost }) => cost.requests.fetch + cost.requests.invokeAgent;
  const checkpoint = (
    await s.updates({ mode: "start", channelIds: [], directChats: "own", startAt: "now" })
  ).data.checkpoint;
  await s.firstRead("legacy");
  // The object only opens the watch, so the Worker reads separately, as it did before.
  const quiet = await s.measure(() => s.updates({ mode: "poll", checkpoint, waitSeconds: 1 }));
  assert.deepEqual(quiet.result.data.messages, []);
  assert.equal(requests(quiet), 2, JSON.stringify(quiet.cost.requests));
  const waiting = timed(s.updates({ mode: "poll", checkpoint, waitSeconds: 10 }));
  await pause(300);
  await s.send("still woken");
  const { result, millis } = await waiting;
  assert.deepEqual(bodies(result), ["still woken"]);
  assert.ok(millis < 5000, `${millis}`);
  const httpQuiet = await s.measure(() =>
    s.http({ mode: "poll", checkpoint: result.data.checkpoint, waitSeconds: 1 }),
  );
  assert.equal(httpQuiet.result.status, 200);
  assert.deepEqual(httpQuiet.result.body.data.messages, []);
  assert.equal(requests(httpQuiet), 2, JSON.stringify(httpQuiet.cost.requests));
});

test("the MCP boundary refuses a reply that breaks its contract, however it reached the Worker", async (t) => {
  const s = await setup(t);
  const general = (await s.x.mcp(s.credential, "get_context", { serverId: s.server.id })).data
    .general.conversation.id;
  const before = (
    await s.updates({ mode: "start", channelIds: [], directChats: "own", startAt: "now" })
  ).data.checkpoint;
  await s.send("waiting already");
  const after = (await s.updates({ mode: "poll", checkpoint: before })).data.checkpoint;
  // From here every reply the object builds carries a request ID that is not a UUID.
  await s.firstRead("malformed");
  const call = (tool, input) =>
    s.x.mcp(s.credential, tool, { serverId: s.server.id, ...input }, true);
  const refused = (step, reply) => {
    assert.equal(reply.error.code, "internal_error", step);
    assert.match(reply.error.message, /could not be prepared/, step);
  };
  const updates = (input) => call("get_updates", { participantId: s.reader, ...input });
  // One private RPC, for get_updates and for any other tool.
  refused("plain read", await updates({ mode: "poll", checkpoint: before }));
  refused(
    "another tool",
    await call("read_messages", { mode: "history", conversationId: general, limit: 5 }),
  );
  // A held call: answered by its first read, held to its deadline, or read again after a wake.
  refused("answered at once", await updates({ mode: "poll", checkpoint: before, waitSeconds: 10 }));
  refused("held", await updates({ mode: "poll", checkpoint: after, waitSeconds: 1 }));
  const waiting = timed(updates({ mode: "poll", checkpoint: after, waitSeconds: 10 }));
  await pause(300);
  // The send commits; only its own reply breaks the contract.
  refused(
    "send",
    await call("send_message", {
      participantId: s.sender,
      requestKey: randomUUID(),
      target: { kind: "direct", recipientId: s.reader },
      body: "wake the held call",
    }),
  );
  const woken = await waiting;
  refused("read again", woken.result);
  assert.ok(woken.millis < 5000, `${woken.millis}`);
});
