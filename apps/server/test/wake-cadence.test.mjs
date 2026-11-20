import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";
import { packet, rpc } from "./mcp-wire.mjs";
import { load } from "./sources.mjs";

const M = await load("../../../packages/api/src/models.ts");
const W = await load("../../../packages/api/src/wake.ts");
const Policy = await load("../src/wakes/policy.ts");

const callback = "https://connectors.api.openai.com/mcp-events/callback_123";
const fire = "https://api.anthropic.com/v1/claude_code/routines/trig_01ABCDEFGHJKLMNOPQRSTUVW/fire";
const minute = 60_000;

/** Answers every wake host; `mode: "error"` answers 500; `before` runs before a notice is answered. */
const host = () => {
  const received = [];
  const state = { mode: "ok", before: undefined };
  const handler = async (request) => {
    const json = JSON.parse(await request.text());
    received.push(json);
    if (state.mode === "error") return new Response("no", { status: 500 });
    if (json.type === "verification") return Response.json({ challenge: json.challenge });
    if (state.before !== undefined) await state.before();
    return Response.json({ ok: true });
  };
  return { received, state, handler };
};

/** A person signed in on the TalkTo website. */
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
    const text = await response.text();
    return { status: response.status, json: JSON.parse(text) };
  };
};

/** One server, Ana (subscribed for ChatGPT wakes) and Ben, and cadence helpers. */
const setup = async (t, options = {}) => {
  const fake = host();
  const x = await start(t, {
    manualAlarms: true,
    wakeKey: true,
    wakeHandler: fake.handler,
    ...options,
  });
  const account = await x.account();
  const credential = await x.mcpToken(account.organizationId);
  const server = await x.server(account.id);
  const register = async (name) =>
    (
      await x.mcp(credential, "register_participant", {
        serverId: server.id,
        name,
        agentType: "codex",
        requestKey: randomUUID(),
      })
    ).data;
  const first = await register("Ana");
  const ana = first.item.id;
  const ben = (await register("Ben")).item.id;
  const general = first.generalConversationId;
  const scope = {
    serverId: server.id,
    participantId: ana,
    channelIds: [general],
    directChats: "own",
  };
  const send = (body, priority, target = { kind: "conversation", conversationId: general }) => {
    const input = {
      serverId: server.id,
      participantId: ben,
      requestKey: randomUUID(),
      target,
      body,
    };
    if (priority !== undefined) input.priority = priority;
    return x.mcp(credential, "send_message", input);
  };
  const direct = (body, priority) => send(body, priority, { kind: "direct", recipientId: ana });
  const subscribe = async () => {
    const answer = await packet(
      await x.raw(
        "/mcp",
        rpc(
          "events/subscribe",
          {
            name: "messages.waiting",
            arguments: scope,
            delivery: {
              mode: "webhook",
              url: callback,
              secret: `whsec_${randomBytes(32).toString("base64")}`,
            },
            ttlMs: 3_600_000,
          },
          credential,
          "2026-07-28",
        ),
      ),
    );
    assert.ok(answer.result, JSON.stringify(answer));
  };
  const control = async (action, participantId) => {
    const input = { action };
    if (participantId !== undefined) input.participantId = participantId;
    return (await x.control(`wakes?server=${server.id}`, input)).json();
  };
  const path = (participantId = ana) =>
    `/v1/servers/${server.id}/participants/${participantId}/wake-cadence`;
  const dashboard = await website(x);
  const choose = async (cadence, participantId = ana) => {
    const answer = await dashboard("PUT", path(participantId), { cadence });
    assert.equal(answer.status, 200, JSON.stringify(answer.json));
    return answer.json.data;
  };
  /** Wake once now, so the next wake's gap is measured from a known last attempt. */
  const wakeOnce = async () => {
    await send("First");
    const state = await control("deliver");
    assert.equal(state.targets[0].due_at, null);
    return state.targets[0].last_attempt_at;
  };
  return {
    x,
    fake,
    account,
    credential,
    server,
    general,
    ana,
    ben,
    scope,
    send,
    direct,
    subscribe,
    control,
    path,
    dashboard,
    choose,
    wakeOnce,
  };
};

test("the choices, their gaps and their words come from one shared list", () => {
  assert.deepEqual(W.Cadence.literals, [
    "right_away",
    "every_minute",
    "every_5_minutes",
    "every_15_minutes",
  ]);
  assert.equal(W.defaultCadence, "every_minute");
  assert.deepEqual(W.cadenceSeconds, {
    right_away: 0,
    every_minute: 60,
    every_5_minutes: 300,
    every_15_minutes: 900,
  });
  for (const cadence of W.Cadence.literals) {
    assert.match(W.cadenceLabels[cadence], /^[A-Z][a-z ]+[0-9a-z ]*$/);
    assert.ok(W.cadenceDescriptions[cadence].endsWith("."));
    assert.ok(
      Policy.cadenceMsSql.includes(`WHEN '${cadence}' THEN ${W.cadenceSeconds[cadence] * 1000}`),
    );
  }
  // No stored row reads as the default, at most once a minute.
  assert.match(Policy.cadenceMsSql, /, 60000\)$/);
  assert.equal(M.wakeCadenceSeconds, W.cadenceSeconds);
});

test("by default a wake keeps today's timing: 10 s debounce, then the host's minimum", async (t) => {
  const s = await setup(t);
  await s.subscribe();
  await s.send("Hello");
  const marked = await s.control("inspect");
  const [target] = marked.targets;
  assert.equal(marked.cadences.length, 0, "no row for the default");
  assert.ok(target.due_at >= marked.now + 9_000 && target.due_at <= marked.now + 10_000);
  const last = await s.wakeOnce();
  await s.send("Second");
  const next = await s.control("inspect");
  assert.equal(next.targets[0].due_at, last + minute, "one wake a minute at most, as before");
  // Choosing the default explicitly stores nothing and changes nothing.
  assert.deepEqual(await s.choose("every_minute"), {
    participantId: s.ana,
    cadence: "every_minute",
    intervalSeconds: 60,
  });
  const after = await s.control("inspect");
  assert.equal(after.cadences.length, 0);
  assert.equal(after.targets[0].due_at, last + minute);
});

test("each cadence sets the gap after a wake; the host's own minimum still applies", async (t) => {
  const s = await setup(t, { wakeTokens: true });
  await s.subscribe();
  // A Claude Code routine's own minimum is two minutes.
  const routine = await s.dashboard(
    "POST",
    `/v1/servers/${s.server.id}/participants/${s.ana}/wakes`,
    {
      kind: "claude_routine",
      url: fire,
      token: `sk-ant-oat01-${randomBytes(24).toString("base64url")}`,
      channelIds: [s.general],
      directChats: "own",
    },
  );
  assert.equal(routine.status, 200, JSON.stringify(routine.json));
  const gaps = async () => {
    await s.send("Next");
    const state = await s.control("inspect");
    return state.targets.map((target) => [target.kind, target.due_at - target.last_attempt_at]);
  };
  for (const [cadence, events, claude] of [
    ["right_away", minute, 2 * minute],
    ["every_minute", minute, 2 * minute],
    ["every_5_minutes", 5 * minute, 5 * minute],
    ["every_15_minutes", 15 * minute, 15 * minute],
  ]) {
    await s.choose(cadence);
    await s.wakeOnce();
    assert.deepEqual(
      (await gaps()).toSorted(),
      [
        ["claude_routine", claude],
        ["mcp_events", events],
      ],
      cadence,
    );
  }
  const stored = await s.control("inspect");
  assert.deepEqual(
    stored.cadences.map((row) => [row.participant_id, row.cadence]),
    [[s.ana, "every_15_minutes"]],
  );
  // Right away still groups messages that arrive together: the first one waits the debounce.
  await s.choose("right_away");
  const fresh = await setup(t);
  await fresh.subscribe();
  await fresh.choose("right_away");
  await fresh.send("Together");
  const grouped = await fresh.control("inspect");
  assert.ok(grouped.targets[0].due_at >= grouped.now + 9_000);
});

test("an urgent direct message skips the debounce and the cadence, but never a backoff or the budget", async (t) => {
  const s = await setup(t);
  await s.subscribe();
  await s.choose("every_15_minutes");
  // After a quiet period an urgent message is due at once, with no debounce.
  await s.direct("Stop the deploy", "urgent");
  const quiet = await s.control("inspect");
  assert.ok(quiet.targets[0].due_at <= quiet.now, "due now");
  // An alarm set in the past has already fired (a no-op with manual alarms) or is about to.
  assert.ok(quiet.alarm === null || quiet.alarm <= quiet.now);
  const delivered = await s.control("deliver");
  const last = delivered.targets[0].last_attempt_at;
  assert.equal(s.fake.received.at(-1).data.urgent, 1);

  // A normal message waits for the cadence; an urgent one moves that wake to the host's minimum.
  await s.send("Normal");
  assert.equal((await s.control("inspect")).targets[0].due_at, last + 15 * minute);
  await s.direct("Urgent again", "urgent");
  const advanced = await s.control("inspect");
  assert.equal(advanced.targets[0].due_at, last + minute);
  assert.ok(advanced.alarm <= last + minute);
  // A normal urgent-free direct message does not move it.
  await s.direct("Just a direct message");
  assert.equal((await s.control("inspect")).targets[0].due_at, last + minute);

  // During a retry backoff an urgent message changes nothing.
  s.fake.state.mode = "error";
  for (let attempt = 0; attempt < 3; attempt++) await s.control("deliver");
  const failing = await s.control("inspect");
  const retryAt = failing.targets[0].due_at;
  assert.equal(failing.targets[0].failures, 3);
  assert.ok(retryAt >= failing.targets[0].last_attempt_at + 2 * minute);
  await s.direct("Urgent while failing", "urgent");
  assert.equal((await s.control("inspect")).targets[0].due_at, retryAt);
  s.fake.state.mode = "ok";
  await s.control("deliver");

  // Nor does it pass the wake budget.
  await s.send("Budget");
  await s.control("exhaust", s.ana);
  const postponed = await s.control("deliver");
  assert.equal(postponed.targets[0].last_error, "budget");
  await s.direct("Urgent over budget", "urgent");
  assert.equal((await s.control("inspect")).targets[0].due_at, postponed.targets[0].due_at);
});

test("an urgent message that arrives during a send keeps only the host's minimum", async (t) => {
  const s = await setup(t);
  await s.subscribe();
  await s.choose("every_15_minutes");
  // The host answers only after another message has committed, so it is past the delivered
  // sequence and keeps the wake due.
  const during = async (body, priority) => {
    s.fake.state.before = () => s.direct(body, priority);
    await s.send("Before");
    const state = await s.control("deliver");
    s.fake.state.before = undefined;
    return state.targets[0].due_at - state.targets[0].last_attempt_at;
  };
  assert.equal(await during("Normal, mid-send"), 15 * minute);
  await s.control("deliver");
  assert.equal(await during("Urgent, mid-send", "urgent"), minute);
});

test("changing the cadence moves a held wake earlier, never later, and arms the alarm", async (t) => {
  const s = await setup(t);
  await s.subscribe();
  await s.choose("every_15_minutes");
  const last = await s.wakeOnce();
  await s.send("Held");
  assert.equal((await s.control("inspect")).targets[0].due_at, last + 15 * minute);
  await s.choose("every_5_minutes");
  const sooner = await s.control("inspect");
  assert.equal(sooner.targets[0].due_at, last + 5 * minute);
  assert.ok(sooner.alarm <= last + 5 * minute);
  await s.choose("right_away");
  assert.equal((await s.control("inspect")).targets[0].due_at, last + minute, "host minimum");
  await s.choose("every_15_minutes");
  assert.equal((await s.control("inspect")).targets[0].due_at, last + minute, "never later");
  // The wake after that uses the new cadence.
  await s.control("deliver");
  const next = (await s.control("inspect")).targets[0].last_attempt_at;
  await s.send("Later");
  assert.equal((await s.control("inspect")).targets[0].due_at, next + 15 * minute);
});

test("signal links, get_updates, get_context and list_wakes report the cadence; old fields stay", async (t) => {
  const s = await setup(t);
  const minted = await s.x.mcp(s.credential, "create_signal", s.scope);
  const check = async () => {
    const url = new URL(minted.data.url);
    const dot = url.pathname.lastIndexOf(".");
    const response = await s.x.raw(url.pathname.slice(0, dot), {
      headers: { authorization: `Bearer ${url.pathname.slice(dot + 1)}` },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const quiet = await check();
  assert.deepEqual(
    {
      pending: quiet.pending,
      urgent: quiet.urgent,
      more: quiet.more,
      cursor: quiet.cursor,
      wakeCadence: quiet.wakeCadence,
      wakeIntervalSeconds: quiet.wakeIntervalSeconds,
    },
    {
      pending: 0,
      urgent: 0,
      more: false,
      cursor: null,
      wakeCadence: "every_minute",
      wakeIntervalSeconds: 60,
    },
  );
  const updates = () =>
    s.x.mcp(s.credential, "get_updates", {
      serverId: s.server.id,
      participantId: s.ana,
      mode: "start",
      channelIds: [s.general],
      directChats: "own",
      startAt: "now",
    });
  const context = () =>
    s.x.mcp(s.credential, "get_context", {
      serverId: s.server.id,
      participant: { id: s.ana },
    });
  assert.deepEqual(
    [(await updates()).data.wakeCadence, (await updates()).data.wakeIntervalSeconds],
    ["every_minute", 60],
  );
  assert.equal("wakeCadence" in (await context()).data.self, false, "absent means the default");

  await s.choose("every_5_minutes");
  await s.send("One");
  const counted = await check();
  assert.deepEqual(
    [counted.pending, counted.wakeCadence, counted.wakeIntervalSeconds],
    [1, "every_5_minutes", 300],
  );
  const page = (await updates()).data;
  assert.deepEqual([page.wakeCadence, page.wakeIntervalSeconds], ["every_5_minutes", 300]);
  assert.equal((await context()).data.self.wakeCadence, "every_5_minutes");
  const listed = await s.x.mcp(s.credential, "list_wakes", {
    serverId: s.server.id,
    participantId: s.ana,
  });
  assert.equal(listed.data.cadence, "every_5_minutes");
  // Another agent's records show its own choice, or none.
  const roster = await s.x.call("user_alice", "GET", `/v1/servers/${s.server.id}/participants`);
  const byId = new Map(roster.items.map((item) => [item.id, item]));
  assert.equal(byId.get(s.ana).wakeCadence, "every_5_minutes");
  assert.equal("wakeCadence" in byId.get(s.ben), false);
  const overview = await s.dashboard(
    "GET",
    `/v1/servers/${s.server.id}/participants/${s.ana}/wakes`,
  );
  assert.equal(overview.json.data.cadence, "every_5_minutes");
});

test("people with server access change it over HTTP; agents and outsiders cannot", async (t) => {
  const s = await setup(t);
  // The website session and a person's own bearer token both work.
  assert.equal((await s.choose("every_5_minutes")).cadence, "every_5_minutes");
  const bearer = await s.x.call("user_alice", "PUT", s.path(), { cadence: "right_away" });
  assert.deepEqual(bearer, { participantId: s.ana, cadence: "right_away", intervalSeconds: 0 });
  const read = await s.x.call("user_alice", "GET", s.path());
  assert.equal(read.cadence, "right_away");
  // Choices are only the four; nothing else in the body.
  await s.x.call("user_alice", "PUT", s.path(), { cadence: "every_hour" }, 400);
  await s.x.call(
    "user_alice",
    "PUT",
    s.path(),
    { cadence: "right_away", participantId: s.ben },
    400,
  );
  // An unknown participant, and a person's own participant, are refused.
  await s.x.call("user_alice", "PUT", s.path(randomUUID()), { cadence: "right_away" }, 404);
  const root = `/v1/servers/${s.server.id}`;
  const opened = await s.x.call("user_alice", "POST", `${root}/people/me/direct-chats`, {
    agentId: s.ana,
    requestKey: randomUUID(),
  });
  const person = opened.item.participantIds.find((id) => id !== s.ana);
  const refused = await s.x.call(
    "user_alice",
    "PUT",
    s.path(person),
    { cadence: "right_away" },
    403,
  );
  assert.equal(refused.error.code, "forbidden");

  // An agent's MCP credential does not reach the HTTP API, and no MCP tool changes the cadence.
  const viaMcp = await s.x.raw(s.path(), {
    method: "PUT",
    headers: { authorization: `Bearer ${s.credential}`, "content-type": "application/json" },
    body: JSON.stringify({ cadence: "every_15_minutes" }),
  });
  assert.equal(viaMcp.status, 401);
  const tools = await packet(await s.x.raw("/mcp", rpc("tools/list", {}, s.credential)));
  const names = tools.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("get_updates"));
  assert.ok(!names.some((name) => /cadence/.test(name)), names.join(","));
  for (const tool of tools.result.tools)
    assert.ok(!JSON.stringify(tool.inputSchema).includes("every_15_minutes"), tool.name);

  // Someone without access to the server cannot read or change it.
  await s.x.control("member", s.x.member(s.account.organizationId));
  const outsider = await s.x.raw(s.path(), {
    method: "PUT",
    headers: {
      authorization: `Bearer ${await s.x.token("user_bob")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ cadence: "every_15_minutes" }),
  });
  assert.notEqual(outsider.status, 200);
  // A revoked grant ends it too.
  await s.x.call("user_alice", "PUT", `${root}/access/user_bob`);
  assert.equal(
    (await s.x.call("user_bob", "PUT", s.path(), { cadence: "every_15_minutes" })).cadence,
    "every_15_minutes",
  );
  await s.x.call("user_alice", "DELETE", `${root}/access/user_bob`);
  const revoked = await s.x.raw(s.path(), {
    method: "PUT",
    headers: {
      authorization: `Bearer ${await s.x.token("user_bob")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ cadence: "right_away" }),
  });
  assert.notEqual(revoked.status, 200);
  assert.equal((await s.x.call("user_alice", "GET", s.path())).cadence, "every_15_minutes");
});
