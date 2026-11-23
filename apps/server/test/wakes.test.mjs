import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";
import { packet, rpc } from "./mcp-wire.mjs";
import { load } from "./sources.mjs";

const W = await load("../../../packages/api/src/wake.ts");
const { adapters } = await load("../src/wakes/kinds.ts");
const McpEvents = await load("../src/wakes/mcp-events.ts");

const callback = "https://connectors.api.openai.com/mcp-events/callback_123";
const fire = "https://api.anthropic.com/v1/claude_code/routines/trig_01ABCDEFGHJKLMNOPQRSTUVW/fire";

/**
 * A stand-in for every wake host: it records what TalkTo sent and answers as told. `mode` steers
 * the next answers: "ok", "wrong-challenge", "redirect", "error" (500), "unauthorized" (401),
 * or "hang" (no answer before TalkTo's 5-second timeout).
 */
const host = () => {
  const received = [];
  const state = { mode: "ok" };
  const handler = async (request) => {
    const body = await request.text();
    const entry = {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body,
      json: JSON.parse(body),
    };
    received.push(entry);
    // Answer only after TalkTo's 5-second request timeout has given up.
    if (state.mode === "hang") await new Promise((resolve) => setTimeout(resolve, 7_000));
    if (state.mode === "redirect")
      return new Response(null, { status: 302, headers: { location: "https://example.com/" } });
    if (state.mode === "error") return new Response("upstream says no", { status: 500 });
    if (state.mode === "unauthorized") return new Response("bad token", { status: 401 });
    if (entry.json.type === "verification")
      return Response.json({
        challenge: state.mode === "wrong-challenge" ? "not-it" : entry.json.challenge,
      });
    return Response.json({ ok: true, echoed: "anything the host says is ignored" });
  };
  return { received, state, handler };
};

/** One organization, one server, three agents, a stand-in host, and wake helpers. */
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
  const ana = await register("Ana");
  const ben = (await register("Ben")).item.id;
  const general = ana.generalConversationId;
  const side = (
    await x.mcp(credential, "create_channel", {
      serverId: server.id,
      participantId: ben,
      name: "side",
      requestKey: randomUUID(),
    })
  ).data.item.id;
  const send = (from, conversationId, body) =>
    x.mcp(credential, "send_message", {
      serverId: server.id,
      participantId: from,
      requestKey: randomUUID(),
      target: { kind: "conversation", conversationId },
      body,
    });
  const protocol = async (method, params, version = "2026-07-28", token = credential) =>
    packet(await x.raw("/mcp", rpc(method, params, token, version)));
  const secretBytes = randomBytes(32);
  const secret = `whsec_${secretBytes.toString("base64")}`;
  const scope = {
    serverId: server.id,
    participantId: ana.item.id,
    channelIds: [general],
    directChats: "own",
  };
  const subscribe = (overrides = {}, version) =>
    protocol(
      "events/subscribe",
      {
        name: "messages.waiting",
        arguments: scope,
        delivery: { mode: "webhook", url: callback, secret },
        ttlMs: 3_600_000,
        ...overrides,
      },
      version,
    );
  const control = async (action, participantId) => {
    const input = { action };
    if (participantId !== undefined) input.participantId = participantId;
    return (await x.control(`wakes?server=${server.id}`, input)).json();
  };
  const wakesPath = (participantId = ana.item.id) =>
    `/v1/servers/${server.id}/participants/${participantId}/wakes`;
  const dashboard = await website(x);
  const signedBy = (entry, key) => {
    const id = entry.headers["webhook-id"];
    const timestamp = entry.headers["webhook-timestamp"];
    return (
      entry.headers["webhook-signature"] ===
      `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${entry.body}`).digest("base64")}`
    );
  };
  return {
    x,
    fake,
    account,
    credential,
    server,
    general,
    side,
    ana: ana.item.id,
    ben,
    send,
    protocol,
    secret,
    secretBytes,
    scope,
    subscribe,
    control,
    signedBy,
    wakesPath,
    dashboard,
  };
};

/** A person signed in on the TalkTo website: session cookie and the website's Origin. */
const website = async (x, user = "user_alice") => {
  const flow = await x.browserLogin(user);
  const cookie = (await flow.callback()).headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-talkto-session="))
    .split(";")[0];
  return async (method, path, value, headers = {}) => {
    const response = await x.raw(path, {
      method,
      headers: {
        cookie,
        origin: "https://talkto.test",
        "content-type": "application/json",
        ...headers,
      },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    const text = await response.text();
    return { status: response.status, text, json: JSON.parse(text) };
  };
};

test("a pasted URL names its kind by the same addresses the server sends to", () => {
  for (const kind of W.TokenKind.literals)
    assert.equal(adapters[kind].policy.path, W.addresses[kind].path, `${kind} shares its address`);
  const cases = [
    ["https://api.anthropic.com/v1/claude_code/routines/trig_01ABCDEF/fire", "claude_routine"],
    ["  https://api.anthropic.com/v1/claude_code/routines/trig_01ABCDEF/fire\n", "claude_routine"],
    ["https://api2.cursor.sh/automations/webhook/routine-1", "grok_bot"],
    ["https://api.town.com/workflow-webhooks/whk_abc123", "town"],
    ["https://api.anthropic.com/v1/messages", null],
    ["https://api.anthropic.com.evil.example/v1/claude_code/routines/trig_1/fire", null],
    ["http://api.anthropic.com/v1/claude_code/routines/trig_1/fire", null],
    ["https://api.anthropic.com/v1/claude_code/routines/trig_1/fire?x=1", null],
    ["https://api.anthropic.com:8443/v1/claude_code/routines/trig_1/fire", null],
    ["https://user@api.town.com/workflow-webhooks/whk_abc123", null],
    ["https://api.town.com/workflow-webhooks/whk_abc123#x", null],
    ["https://connectors.api.openai.com/callback", null],
    ["not a url", null],
    ["", null],
  ];
  for (const [url, kind] of cases) assert.equal(W.kindOf(url), kind, url);
});

test("an events log line keeps outcome codes and the callback host, never secrets, paths or text", () => {
  const secret = `whsec_${randomBytes(32).toString("base64")}`;
  const text = "Secret plan alpha for General";
  const params = {
    name: "messages.waiting",
    arguments: { serverId: randomUUID(), participantId: randomUUID(), channelIds: [], [text]: 1 },
    delivery: { mode: "webhook", url: `${callback}?token=tok_abcdef`, secret },
    cursor: "cur_private",
    ttlMs: 3_600_000,
    subscriptionId: "x",
  };
  const request = McpEvents.requestSummary(McpEvents.observe(params), Object.keys(params));
  assert.deepEqual(request, {
    name: "messages.waiting",
    argumentKeys: ["?", "channelIds", "participantId", "serverId"],
    unknownParams: ["subscriptionId"],
    deliveryMode: "webhook",
    callbackHost: "connectors.api.openai.com",
    callbackAllowed: true,
    secret: "valid",
    cursor: "present",
    ttlMs: 3_600_000,
  });
  const refusal = {
    code: -32015,
    message: `could not verify ${text} with ${secret}`,
    data: { reason: "http_4xx" },
    diagnostic: { failure: "CallbackFailed", detail: "rejected", status: 400 },
  };
  const refused = McpEvents.logEntry("events/subscribe", request, { _tag: "Refused", refusal }, 12);
  assert.equal(refused.outcome, "refused");
  assert.equal(refused.code, -32015);
  assert.equal(refused.reason, "http_4xx");
  assert.equal(refused.failure, "CallbackFailed");
  assert.equal(refused.detail, "rejected");
  assert.equal(refused.status, 400);
  const failed = McpEvents.logEntry(
    "events/unsubscribe",
    request,
    { _tag: "Failed", cause: new Error(`RPC failed for ${secret}: ${text}`) },
    3,
  );
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.error.failure, "Error");
  // A body that is not an object, or fields of the wrong type, still summarize.
  const odd = { delivery: "nope", ttlMs: "soon", name: 7 };
  assert.deepEqual(McpEvents.requestSummary(McpEvents.observe(odd), Object.keys(odd)), {
    name: null,
    argumentKeys: null,
    unknownParams: [],
    deliveryMode: null,
    callbackHost: null,
    callbackAllowed: false,
    secret: "absent",
    cursor: "absent",
    ttlMs: null,
  });
  for (const entry of [refused, failed]) {
    const serialized = JSON.stringify(entry);
    for (const forbidden of [
      secret.slice(6, 30),
      text,
      "tok_abcdef",
      "callback_123",
      "cur_private",
    ])
      assert.ok(!serialized.includes(forbidden), forbidden);
  }
});

test("ChatGPT subscribes through MCP events, proves its callback, and gets one signed content-free event", async (t) => {
  const s = await setup(t);
  // Both eras advertise events: ChatGPT reads the top-level key, SEP-3415 the extension.
  const legacy = await s.protocol(
    "initialize",
    {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "ChatGPT", version: "1" },
    },
    "2025-11-25",
  );
  assert.deepEqual(legacy.result.capabilities.events, {});
  const discovered = await s.protocol("server/discover", {});
  assert.deepEqual(discovered.result.capabilities.events, {});
  assert.deepEqual(discovered.result.capabilities.extensions["io.modelcontextprotocol/events"], {});
  const listed = await s.protocol("events/list", {});
  assert.equal(listed.result.events.length, 1);
  const [event] = listed.result.events;
  assert.equal(event.name, "messages.waiting");
  assert.deepEqual(event.delivery, ["webhook"]);
  assert.match(event.description, /never message text/);
  assert.ok(event.inputSchema && event.payloadSchema);

  const subscribed = await s.subscribe();
  assert.ok(subscribed.result, JSON.stringify(subscribed));
  const subscription = subscribed.result;
  assert.match(subscription.id, /^sub_[0-9a-f]{32}$/);
  assert.equal(subscription.cursor, null);
  assert.equal(subscription.truncated, false);
  const refresh = Date.parse(subscription.refreshBefore) - Date.now();
  assert.ok(refresh > 3_500_000 && refresh <= 3_600_000, String(refresh));
  // The challenge went out first, signed with the subscriber's own secret.
  assert.equal(s.fake.received.length, 1);
  const [challenge] = s.fake.received;
  assert.equal(challenge.url, callback);
  assert.equal(challenge.json.type, "verification");
  assert.match(challenge.headers["webhook-id"], /^msg_verification_/);
  // OpenAI requires X-MCP-Subscription-Id on verification too: the ID this subscribe returns.
  assert.equal(challenge.headers["x-mcp-subscription-id"], subscription.id);
  assert.ok(s.signedBy(challenge, s.secretBytes));
  // Subscribing again is an idempotent refresh with the same ID.
  const again = await s.subscribe({}, "2025-11-25");
  assert.equal(again.result.id, subscription.id);
  assert.equal(again.result.deliveryStatus.active, true);

  // Three incoming messages; Ana's own send and an unselected channel do not count.
  await s.send(s.ben, s.general, "Secret plan alpha for General");
  await s.send(s.ben, s.general, "Second secret");
  await s.send(s.ben, s.general, "Third secret");
  await s.send(s.ana, s.general, "Ana's own words");
  await s.send(s.ben, s.side, "Unselected side channel text");
  const pending = await s.control("inspect");
  assert.equal(pending.targets.length, 1);
  assert.ok(pending.targets[0].due_at >= pending.now, "a send marks the wake due");
  assert.ok(pending.alarm !== null && pending.alarm <= pending.targets[0].due_at);
  assert.ok(!JSON.stringify(pending.targets).includes(s.secret.slice(6, 30)));

  const before = s.fake.received.length;
  const delivered = await s.control("deliver");
  const sent = s.fake.received.slice(before);
  assert.equal(sent.length, 1, "many messages share one wake");
  const [notice] = sent;
  assert.equal(notice.url, callback);
  assert.ok(s.signedBy(notice, s.secretBytes));
  assert.equal(notice.headers["webhook-id"], notice.json.eventId);
  assert.equal(notice.headers["x-mcp-subscription-id"], subscription.id);
  assert.equal(notice.headers["content-type"], "application/json");
  assert.ok(Math.abs(Number(notice.headers["webhook-timestamp"]) * 1000 - Date.now()) < 60_000);
  assert.equal(notice.json.name, "messages.waiting");
  assert.equal(notice.json.cursor, null);
  const { checkpoint, ...counts } = notice.json.data;
  assert.deepEqual(counts, {
    serverId: s.server.id,
    participantId: s.ana,
    pending: 3,
    urgent: 0,
    more: false,
  });
  // A run that keeps no state reads exactly the announced messages from the wake's checkpoint.
  const woken = await s.x.mcp(s.credential, "get_updates", {
    serverId: s.server.id,
    participantId: s.ana,
    mode: "poll",
    checkpoint,
  });
  assert.deepEqual(
    woken.data.messages.map((message) => message.body),
    ["Secret plan alpha for General", "Second secret", "Third secret"],
  );
  assert.doesNotMatch(notice.body, /Secret plan|Second secret|Third secret|side channel|Ana's own/);
  assert.deepEqual(Object.keys(notice.json).toSorted(), [
    "cursor",
    "data",
    "eventId",
    "name",
    "timestamp",
  ]);
  assert.equal(delivered.targets[0].due_at, null);
  assert.equal(delivered.targets[0].failures, 0);
  assert.equal(delivered.sends[0].sent, 1);

  // Nothing new: no wake. A later message waits at least the host's minimum interval.
  await s.control("deliver");
  assert.equal(s.fake.received.length, before + 1);
  await s.send(s.ben, s.general, "Fourth");
  const spaced = await s.control("inspect");
  assert.ok(
    spaced.targets[0].due_at >= spaced.targets[0].last_attempt_at + 60_000,
    "one event a minute at most",
  );

  // The participant can see its wake, without the secret.
  const status = await s.x.mcp(s.credential, "list_wakes", {
    serverId: s.server.id,
    participantId: s.ana,
  });
  assert.equal(status.data.items.length, 1);
  const [wake] = status.data.items;
  assert.equal(wake.wakeId, subscription.id);
  assert.equal(wake.kind, "mcp_events");
  assert.equal(wake.host, "connectors.api.openai.com");
  assert.equal(wake.credentialHint, `…${s.secret.slice(-4)}`);
  assert.equal(wake.state, "active");
  assert.ok(wake.lastSentAt !== null);
  assert.ok(!JSON.stringify(status).includes(s.secret.slice(6, 30)));

  // Unsubscribe is idempotent and ends delivery.
  const gone = await s.protocol("events/unsubscribe", {
    name: "messages.waiting",
    arguments: s.scope,
    delivery: { mode: "webhook", url: callback },
  });
  assert.deepEqual(
    Object.keys(gone.result).filter((key) => key !== "_meta" && key !== "resultType"),
    [],
  );
  const twice = await s.protocol("events/unsubscribe", {
    name: "messages.waiting",
    arguments: s.scope,
    delivery: { url: callback },
  });
  assert.ok(twice.result, JSON.stringify(twice));
  assert.equal((await s.control("inspect")).targets.length, 0);
});

test("subscriptions refuse other hosts, bad secrets, failed challenges and other participants' scopes", async (t) => {
  const s = await setup(t);
  const code = async (overrides, expected) => {
    const answer = await s.subscribe(overrides);
    assert.ok(answer.error, JSON.stringify(answer));
    assert.equal(answer.error.code, expected, JSON.stringify(answer));
    return answer.error;
  };
  const delivery = (fields) => ({
    delivery: { mode: "webhook", url: callback, secret: s.secret, ...fields },
  });
  await code(delivery({ url: "http://connectors.api.openai.com/cb" }), -32602);
  await code(delivery({ url: "https://evil.example/cb" }), -32602);
  await code(delivery({ url: "https://connectors.api.openai.com.evil.example/cb" }), -32602);
  await code(delivery({ url: "https://user:pass@connectors.api.openai.com/cb" }), -32602);
  await code(delivery({ url: "https://connectors.api.openai.com:8443/cb" }), -32602);
  await code(delivery({ secret: "whsec_short" }), -32602);
  await code(delivery({ secret: "not-a-webhook-secret" }), -32602);
  await code(delivery({ mode: "poll" }), -32026);
  await code({ name: "comment.created" }, -32023);
  await code({ arguments: { ...s.scope, participantId: randomUUID() } }, -32602);
  await code({ arguments: { ...s.scope, channelIds: [randomUUID()] } }, -32602);
  await code({ arguments: { ...s.scope, serverId: randomUUID() } }, -32024);
  // A params mismatch names the failing paths, so the subscriber can correct its arguments.
  const { channelIds: _channels, ...withoutChannels } = s.scope;
  const missing = await code({ arguments: { ...withoutChannels, channel: "general" } }, -32602);
  assert.match(missing.message, /arguments\.channelIds/);
  assert.match(missing.message, /arguments\.channel\b/);
  assert.ok(!missing.message.includes(s.secret));
  await code({ delivery: { mode: "webhook", url: callback } }, -32602);
  // None of those reached the callback.
  assert.equal(s.fake.received.length, 0);

  s.fake.state.mode = "wrong-challenge";
  const wrong = await code({}, -32015);
  assert.equal(wrong.data.reason, "challenge_failed");
  s.fake.state.mode = "redirect";
  await code({}, -32015);
  // The redirect was not followed: the stand-in saw exactly one request per attempt.
  assert.equal(s.fake.received.length, 2);
  assert.equal((await s.control("inspect")).targets.length, 0);
});

test("a failing callback is retried with backoff, then turned off with a reason the agent can read", async (t) => {
  const s = await setup(t);
  const id = (await s.subscribe()).result.id;
  await s.send(s.ben, s.general, "Hello");
  s.fake.state.mode = "error";
  for (let attempt = 1; attempt <= 4; attempt++) {
    const state = await s.control("deliver");
    const [target] = state.targets;
    assert.equal(target.failures, attempt);
    assert.equal(target.last_error, "server_error");
    assert.ok(target.due_at >= target.last_attempt_at + 60_000, "a retry waits");
    assert.equal(target.disabled_at, null);
  }
  const off = await s.control("deliver");
  assert.ok(off.targets[0].disabled_at !== null);
  assert.equal(off.targets[0].disabled_reason, "repeated:server_error");
  const status = await s.x.mcp(s.credential, "list_wakes", {
    serverId: s.server.id,
    participantId: s.ana,
  });
  assert.equal(status.data.items[0].state, "disabled");
  assert.match(status.data.items[0].disabledReason, /several times.*error on its side/i);
  assert.doesNotMatch(JSON.stringify(status), /upstream says no/);
  // A disabled target sends nothing more; a refresh turns it back on.
  const before = s.fake.received.length;
  await s.send(s.ben, s.general, "Again");
  await s.control("deliver");
  assert.equal(s.fake.received.length, before);
  s.fake.state.mode = "ok";
  const refreshed = await s.subscribe();
  assert.equal(refreshed.result.id, id);
  assert.equal(refreshed.result.deliveryStatus.lastError, "http_5xx");
  await s.send(s.ben, s.general, "After refresh");
  await s.control("deliver");
  assert.equal(s.fake.received.at(-1).json.name, "messages.waiting");

  // A refused token turns the target off at once.
  s.fake.state.mode = "unauthorized";
  await s.send(s.ben, s.general, "Once more");
  const refused = await s.control("deliver");
  assert.equal(refused.targets[0].disabled_reason, "unauthorized");
});

test("the wake budget and the server grant both bound delivery", async (t) => {
  const s = await setup(t);
  await s.subscribe();
  await s.send(s.ben, s.general, "Budget");
  const before = s.fake.received.length;
  const exhausted = await s.control("exhaust", s.ana);
  assert.equal(exhausted.sends[0].sent, 60);
  const postponed = await s.control("deliver");
  assert.equal(s.fake.received.length, before);
  assert.equal(postponed.targets[0].last_error, "budget");
  assert.ok(postponed.targets[0].due_at > postponed.now);

  // Bob's subscription ends when the owner revokes Bob's access to the server.
  await s.x.control("member", s.x.member(s.account.organizationId));
  const root = `/v1/servers/${s.server.id}`;
  await s.x.call("user_alice", "PUT", `${root}/access/user_bob`);
  const bob = await s.x.mcpToken(s.account.organizationId, "user_bob");
  const dana = (
    await s.x.mcp(bob, "register_participant", {
      serverId: s.server.id,
      name: "Dana",
      agentType: "chatgpt",
      requestKey: randomUUID(),
    })
  ).data.item.id;
  const own = await s.protocol(
    "events/subscribe",
    {
      name: "messages.waiting",
      arguments: { ...s.scope, participantId: dana },
      delivery: { mode: "webhook", url: callback, secret: s.secret },
    },
    "2026-07-28",
    bob,
  );
  assert.ok(own.result, JSON.stringify(own));
  await s.x.call("user_alice", "DELETE", `${root}/access/user_bob`);
  await s.send(s.ben, s.general, "After revocation");
  const sent = s.fake.received.length;
  const after = await s.control("deliver");
  assert.ok(
    s.fake.received.slice(sent).every((entry) => entry.json.data?.participantId !== dana),
    "no wake for a revoked grant",
  );
  assert.ok(after.targets.every((target) => target.participant_id !== dana));
});

test("without the token switch, the dashboard says routine wakes are not enabled", async (t) => {
  const s = await setup(t);
  const tools = (await s.protocol("tools/list", {})).result.tools.map((tool) => tool.name);
  assert.ok(tools.includes("list_wakes") && tools.includes("revoke_wake"));
  assert.ok(!tools.includes("create_wake"));
  const context = await s.x.mcp(s.credential, "get_context", { serverId: s.server.id });
  assert.deepEqual(context.data.capabilities, ["wakes"]);
  const listed = await s.dashboard("GET", s.wakesPath());
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual(listed.json.data, { items: [], cadence: "every_minute", tokensEnabled: false });
  const token = `sk-ant-oat01-${randomBytes(24).toString("base64url")}`;
  const refused = await s.dashboard("POST", s.wakesPath(), {
    kind: "claude_routine",
    url: fire,
    token,
    channelIds: [],
    directChats: "own",
  });
  assert.equal(refused.status, 400, refused.text);
  assert.equal(refused.json.error.code, "invalid_input");
  assert.match(refused.json.error.message, /not enabled/);
  assert.ok(!refused.text.includes(token.slice(13, 40)));
  assert.equal((await s.control("inspect")).targets.length, 0);
});

test("without a wake key, no wake is offered and events are unknown", async (t) => {
  const s = await setup(t, { wakeKey: false });
  const tools = (await s.protocol("tools/list", {})).result.tools.map((tool) => tool.name);
  assert.ok(!tools.some((name) => name.includes("wake")));
  const discovered = await s.protocol("server/discover", {});
  assert.equal(discovered.result.capabilities.events, undefined);
  const answer = await s.subscribe();
  assert.equal(answer.error.code, -32601);
});

test("a Claude routine token added on the dashboard is stored encrypted, never shown, and fires a content-free text", async (t) => {
  const s = await setup(t, { wakeTokens: true });
  const token = `sk-ant-oat01-${randomBytes(24).toString("base64url")}`;
  const create = (extra = {}) =>
    s.dashboard("POST", s.wakesPath(), {
      kind: "claude_routine",
      url: fire,
      token,
      channelIds: [s.general],
      directChats: "own",
      ...extra,
    });
  const created = await create();
  assert.equal(created.status, 200, created.text);
  assert.ok(!created.text.includes(token.slice(13, 40)));
  assert.equal(created.json.data.credentialHint, `…${token.slice(-4)}`);
  assert.equal(created.json.data.host, "api.anthropic.com");
  assert.equal(created.json.data.kind, "claude_routine");
  assert.equal(created.json.data.minIntervalSeconds, 120);
  assert.ok(Number.isFinite(Date.parse(created.json.data.addedAt)), "the dashboard can say when");
  assert.equal(created.json.data.procedure, undefined);
  const stored = (await s.control("inspect")).targets[0];
  assert.match(stored.sealed, /^v1\./);
  assert.ok(!JSON.stringify(stored).includes(token.slice(13, 40)));
  assert.equal(stored.hint, token.slice(-4));

  // Exact host and path only; an API key is not a routine token. Refusals never echo the token.
  for (const url of [
    "https://api.anthropic.com/v1/messages",
    "https://api.anthropic.com.evil.example/v1/claude_code/routines/trig_1/fire",
    "http://api.anthropic.com/v1/claude_code/routines/trig_1/fire",
    `${fire}?x=1`,
  ]) {
    const refused = await create({ url });
    assert.equal(refused.status, 400, refused.text);
    assert.equal(refused.json.error.code, "invalid_input");
    assert.ok(!refused.text.includes(token.slice(13, 40)));
  }
  const wrongHost = await create({
    url: "https://evil.example/v1/claude_code/routines/trig_1/fire",
  });
  assert.match(wrongHost.json.error.message, /only sends to api\.anthropic\.com/);
  const apiKey = await create({ token: "sk-ant-api03-abcdefghijkl" });
  assert.match(apiKey.json.error.message, /sk-ant-oat01-/);
  assert.doesNotMatch(apiKey.text, /abcdefghijkl/);

  await s.send(s.ben, s.general, "Deploy password is hunter2");
  await s.send(s.ben, s.general, "And more");
  const before = s.fake.received.length;
  await s.control("deliver");
  const [request] = s.fake.received.slice(before);
  assert.equal(request.url, fire);
  assert.equal(request.method, "POST");
  assert.equal(request.headers.authorization, `Bearer ${token}`);
  assert.equal(request.headers["anthropic-version"], "2023-06-01");
  assert.equal(request.headers["anthropic-beta"], "experimental-cc-routine-2026-04-01");
  assert.deepEqual(Object.keys(request.json), ["text"]);
  assert.match(request.json.text, /2 new messages are waiting/);
  assert.match(request.json.text, new RegExp(`participantId ${s.ana}`));
  assert.match(request.json.text, /get_updates/);
  assert.doesNotMatch(request.json.text, /password is|And more/);

  // The dashboard lists it with its last delivery and never the token.
  const listed = await s.dashboard("GET", s.wakesPath());
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.json.data.tokensEnabled, true);
  assert.equal(listed.json.data.items.length, 1);
  assert.ok(listed.json.data.items[0].lastSentAt !== null);
  assert.ok(!listed.text.includes(token.slice(13, 40)));

  // Adding again replaces the one routine wake for this agent; the agent sees it too.
  const rotated = await create({ token: `sk-ant-oat01-${randomBytes(24).toString("base64url")}` });
  assert.notEqual(rotated.json.data.wakeId, created.json.data.wakeId);
  const agentView = await s.x.mcp(s.credential, "list_wakes", {
    serverId: s.server.id,
    participantId: s.ana,
  });
  assert.equal(agentView.data.items.length, 1);
  assert.equal(agentView.data.items[0].wakeId, rotated.json.data.wakeId);

  // Revoke from the dashboard ends it; a second revoke removes nothing.
  const revoke = `${s.wakesPath()}/${rotated.json.data.wakeId}`;
  const revoked = await s.dashboard("DELETE", revoke);
  assert.equal(revoked.status, 200, revoked.text);
  assert.equal(revoked.json.data.revoked, 1);
  assert.equal((await s.dashboard("DELETE", revoke)).json.data.revoked, 0);
  assert.equal((await s.control("inspect")).targets.length, 0);

  // The agent's own revoke_wake still works.
  await create();
  const agentRevoked = await s.x.mcp(s.credential, "revoke_wake", {
    serverId: s.server.id,
    participantId: s.ana,
  });
  assert.equal(agentRevoked.data.revoked, 1);
});

test("a direct chat a person opens wakes the agent and reaches it the same way as one an agent opens", async (t) => {
  const s = await setup(t, { wakeTokens: true });
  const token = `sk-ant-oat01-${randomBytes(24).toString("base64url")}`;
  const added = await s.dashboard("POST", s.wakesPath(), {
    kind: "claude_routine",
    url: fire,
    token,
    channelIds: [],
    directChats: "own",
  });
  assert.equal(added.status, 200, added.text);
  const updates = (input) =>
    s.x.mcp(s.credential, "get_updates", { serverId: s.server.id, participantId: s.ana, ...input });
  const started = await updates({
    mode: "start",
    channelIds: [],
    directChats: "own",
    startAt: "now",
  });

  // From the website, the person opens a chat with Ana and sends; nothing names a participant.
  const opened = await s.dashboard("POST", `/v1/servers/${s.server.id}/people/me/direct-chats`, {
    agentId: s.ana,
    requestKey: randomUUID(),
  });
  assert.equal(opened.status, 200, opened.text);
  const sent = await s.dashboard("POST", `/v1/servers/${s.server.id}/people/me/messages`, {
    conversationId: opened.json.data.item.id,
    requestKey: randomUUID(),
    body: "Please pick up the release notes.",
  });
  assert.equal(sent.status, 200, sent.text);
  const before = s.fake.received.length;
  await s.control("deliver");
  const [wake] = s.fake.received.slice(before);
  assert.match(wake.json.text, /1 new message is waiting/);
  assert.match(wake.json.text, new RegExp(`participantId ${s.ana}`));

  // Another agent opens a chat with Ana too. Both arrive in one feed, alike but for the sender.
  const fromBen = await s.x.mcp(s.credential, "send_message", {
    serverId: s.server.id,
    participantId: s.ben,
    requestKey: randomUUID(),
    target: { kind: "direct", recipientId: s.ana },
    body: "Release notes are in the side channel.",
  });
  const page = await updates({ mode: "poll", checkpoint: started.data.checkpoint });
  assert.deepEqual(
    page.data.messages.map((m) => m.id),
    [sent.json.data.item.id, fromBen.data.item.id],
  );
  const chats = page.included.conversations.map(({ kind, participantIds }) => ({
    kind,
    withAna: participantIds.includes(s.ana),
  }));
  assert.deepEqual(chats, [
    { kind: "direct", withAna: true },
    { kind: "direct", withAna: true },
  ]);
  const senders = page.included.participants.filter((p) => p.id !== s.ana);
  assert.deepEqual(senders.map((p) => p.kind ?? "agent").toSorted(), ["agent", "person"]);
  // Both are in Ana's own direct chats.
  const own = await s.x.mcp(s.credential, "get_context", {
    serverId: s.server.id,
    participant: { id: s.ana },
    directChats: "own",
  });
  const text = JSON.stringify(own);
  for (const id of [opened.json.data.item.id, fromBen.data.item.conversationId])
    assert.ok(text.includes(id), id);
});

test("a person's channel post wakes the agents that watch the channel", async (t) => {
  const s = await setup(t, { wakeTokens: true });
  const token = `sk-ant-oat01-${randomBytes(24).toString("base64url")}`;
  const added = await s.dashboard("POST", s.wakesPath(), {
    kind: "claude_routine",
    url: fire,
    token,
    channelIds: [s.general],
    directChats: "none",
  });
  assert.equal(added.status, 200, added.text);
  // From the website, the person joins as themselves and posts in General.
  const joined = await s.dashboard("POST", `/v1/servers/${s.server.id}/people/me`);
  assert.equal(joined.status, 200, joined.text);
  const sent = await s.dashboard("POST", `/v1/servers/${s.server.id}/people/me/messages`, {
    conversationId: s.general,
    requestKey: randomUUID(),
    body: "Who is on the release today?",
  });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.json.data.item.senderId, joined.json.data.item.id);
  const before = s.fake.received.length;
  await s.control("deliver");
  const [wake] = s.fake.received.slice(before);
  assert.match(wake.json.text, /1 new message is waiting/);
  assert.match(wake.json.text, new RegExp(`participantId ${s.ana}`));
});

test("auto-start runs for direct messages, @mentions and the person's chosen channels, never other channel posts", async (t) => {
  const s = await setup(t, { wakeTokens: true });
  const token = `sk-ant-oat01-${randomBytes(24).toString("base64url")}`;
  // The person ticks direct chats and no channel: the dashboard's default.
  const added = await s.dashboard("POST", s.wakesPath(), {
    kind: "claude_routine",
    url: fire,
    token,
    channelIds: [],
    directChats: "own",
  });
  assert.equal(added.status, 200, added.text);
  const deliver = async () => {
    const before = s.fake.received.length;
    await s.control("deliver");
    return s.fake.received.slice(before);
  };
  // Plain posts in channels the person did not choose start nothing, General's included: they
  // never make the wake due.
  await s.send(s.ben, s.general, "Status update for everyone");
  await s.send(s.ben, s.side, "Side chatter");
  assert.equal((await s.control("inspect")).targets[0].due_at, null);
  assert.deepEqual(await deliver(), []);

  // An @mention in one of those channels starts a run.
  await s.send(s.ben, s.side, "@Ana can you look at the migration?");
  const [mentioned] = await deliver();
  assert.match(mentioned.json.text, /1 new message is waiting/);

  // So does a direct message; the test's deliver skips the host's minimum gap.
  await s.x.mcp(s.credential, "send_message", {
    serverId: s.server.id,
    participantId: s.ben,
    requestKey: randomUUID(),
    target: { kind: "direct", recipientId: s.ana },
    body: "Ping",
  });
  const due = (await s.control("inspect")).targets[0];
  assert.ok(due.due_at !== null, "the direct message makes the wake due");
  const [direct] = await deliver();
  assert.match(direct.json.text, /1 new message is waiting/);
});

test("no agent tool accepts a third-party token, and only a website session can add one", async (t) => {
  const s = await setup(t, { wakeTokens: true });
  const token = `sk-ant-oat01-${randomBytes(24).toString("base64url")}`;
  const input = { kind: "claude_routine", url: fire, token, channelIds: [], directChats: "own" };
  const tools = (await s.protocol("tools/list", {})).result.tools.map((tool) => tool.name);
  assert.ok(tools.includes("list_wakes") && tools.includes("revoke_wake"));
  assert.ok(!tools.includes("create_wake"));
  const viaTool = await s.protocol("tools/call", {
    name: "create_wake",
    arguments: { serverId: s.server.id, participantId: s.ana, ...input },
  });
  assert.ok(viaTool.error || viaTool.result?.isError, JSON.stringify(viaTool));
  assert.ok(!JSON.stringify(viaTool).includes(token.slice(13, 40)));
  const context = await s.x.mcp(s.credential, "get_context", { serverId: s.server.id });
  assert.deepEqual(context.data.capabilities, ["wakes", "wake_tokens"]);

  // A bearer token (an agent, a script or the API client) cannot store one, even the owner's.
  const bearer = await s.x.raw(s.wakesPath(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${await s.x.token()}`,
      "content-type": "application/json",
      "x-talkto-authenticated-by": "website-session",
    },
    body: JSON.stringify(input),
  });
  const bearerText = await bearer.text();
  assert.equal(bearer.status, 403, bearerText);
  assert.equal(JSON.parse(bearerText).error.code, "forbidden");
  assert.match(JSON.parse(bearerText).error.message, /TalkTo dashboard/);
  assert.ok(!bearerText.includes(token.slice(13, 40)));
  // Bearer callers may still read and revoke.
  assert.equal(
    (await s.x.call("user_alice", "GET", s.wakesPath())).tokensEnabled,
    true,
    "bearer list works",
  );

  // Signed out: authentication is required.
  for (const [method, path] of [
    ["GET", s.wakesPath()],
    ["POST", s.wakesPath()],
    ["DELETE", `${s.wakesPath()}/${randomUUID()}`],
  ]) {
    const response = await s.x.raw(path, {
      method,
      headers: { "content-type": "application/json", origin: "https://talkto.test" },
      body: method === "POST" ? JSON.stringify(input) : undefined,
    });
    assert.equal(response.status, 401, `${method} ${path}`);
  }

  // A cookie without the website's Origin is refused before anything runs.
  const crossSite = await s.dashboard("POST", s.wakesPath(), input, {
    origin: "https://evil.test",
  });
  assert.equal(crossSite.status, 403, crossSite.text);

  // Someone outside this server's organization sees no server, whatever they send.
  const carol = await website(s.x, "user_carol");
  for (const [method, path, body] of [
    ["GET", s.wakesPath(), undefined],
    ["POST", s.wakesPath(), input],
    ["DELETE", `${s.wakesPath()}/${randomUUID()}`, undefined],
  ]) {
    const answer = await carol(method, path, body);
    assert.equal(answer.status, 404, `${method} ${answer.text}`);
    assert.equal(answer.json.error.code, "server_unavailable");
    assert.ok(!answer.text.includes(token.slice(13, 40)));
  }
  // An unknown participant on a server you can read is named as such.
  const nobody = await s.dashboard("POST", s.wakesPath(randomUUID()), input);
  assert.equal(nobody.status, 404, nobody.text);
  assert.equal(nobody.json.error.code, "participant_not_found");
  assert.equal((await s.control("inspect")).targets.length, 0);

  // The token goes in the body only; the contract has no other place for it.
  const extra = await s.dashboard("POST", s.wakesPath(), { ...input, serverId: s.server.id });
  assert.equal(extra.status, 400, extra.text);
  assert.ok(!extra.text.includes(token.slice(13, 40)));
});

test("Grok Bot and Town wakes use their own documented request shapes", async (t) => {
  const s = await setup(t, { wakeTokens: true });
  const register = async (kind, url, token) => {
    const answer = await s.dashboard("POST", s.wakesPath(), {
      kind,
      url,
      token,
      channelIds: [],
      directChats: "own",
    });
    assert.equal(answer.status, 200, answer.text);
    return answer.json.data;
  };
  const grokKey = `crsr_${randomBytes(20).toString("hex")}`;
  const townSecret = `whsec_${randomBytes(20).toString("hex")}`;
  await register("grok_bot", "https://api2.cursor.sh/automations/webhook/routine-1", grokKey);
  await register("town", "https://api.town.com/workflow-webhooks/whk_abc123", townSecret);
  const badTown = await s.dashboard("POST", s.wakesPath(), {
    kind: "town",
    url: "https://api.town.com/workflow-webhooks/whk_abc123",
    token: "Bearer-not-a-secret",
    channelIds: [],
    directChats: "own",
  });
  assert.equal(badTown.status, 400, badTown.text);
  assert.match(badTown.json.error.message, /whsec_/);
  const badGrok = await s.dashboard("POST", s.wakesPath(), {
    kind: "grok_bot",
    url: "https://api.x.ai/automations/webhook/routine-1",
    token: grokKey,
    channelIds: [],
    directChats: "own",
  });
  assert.equal(badGrok.status, 400, badGrok.text);
  assert.match(badGrok.json.error.message, /only sends to api2\.cursor\.sh/);
  assert.ok(!badGrok.text.includes(grokKey));

  // A direct message wakes both; a channel the selection leaves out does not.
  await s.x.mcp(s.credential, "send_message", {
    serverId: s.server.id,
    participantId: s.ben,
    requestKey: randomUUID(),
    target: { kind: "direct", recipientId: s.ana },
    body: "Private words",
  });
  await s.send(s.ben, s.general, "Not selected");
  const before = s.fake.received.length;
  await s.control("deliver");
  const sent = s.fake.received.slice(before);
  assert.equal(sent.length, 2);
  const grok = sent.find((entry) => entry.url.startsWith("https://api2.cursor.sh/"));
  const town = sent.find((entry) => entry.url.startsWith("https://api.town.com/"));
  assert.equal(grok.headers.authorization, `Bearer ${grokKey}`);
  assert.equal(grok.json.pending, 1);
  assert.equal(grok.json.participantId, s.ana);
  assert.equal(town.headers.authorization, `Bearer ${townSecret}`);
  assert.match(town.headers["x-town-idempotency-key"], /^evt_/);
  assert.equal(town.json.data.pending, 1);
  for (const entry of sent) assert.doesNotMatch(entry.body, /Private words|Not selected/);
});

test("the server object's own alarm delivers after the debounce, sharing it with projection", async (t) => {
  const s = await setup(t, { manualAlarms: false });
  await s.subscribe();
  const before = s.fake.received.length;
  await s.send(s.ben, s.general, "Wake me");
  const deadline = Date.now() + 30_000;
  while (s.fake.received.length === before && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 250));
  const [notice] = s.fake.received.slice(before);
  assert.ok(notice, "the alarm delivered the wake");
  assert.equal(notice.json.data.pending, 1);
  const state = await s.control("inspect");
  assert.equal(state.targets[0].due_at, null);
  assert.ok(state.targets[0].last_sent_at - state.targets[0].created_at >= 0);
});

/** Add a pasted wake on the dashboard for `participantId` (Ana by default) and return it. */
const paste = async (s, kind, url, token, participantId = s.ana) => {
  const answer = await s.dashboard("POST", s.wakesPath(participantId), {
    kind,
    url,
    token,
    channelIds: [s.general],
    directChats: "own",
  });
  assert.equal(answer.status, 200, answer.text);
  return answer.json.data;
};
const testPath = (s, wake, participantId = s.ana) =>
  `${s.wakesPath(participantId)}/${wake.wakeId}/test`;

test("Send a test is the person's read and admin call, never the agent's", async (t) => {
  const s = await setup(t, { wakeTokens: true, readBudgets: true, adminBudgets: true });
  await s.x.control(`quota/configure?account=${s.account.id}`, {
    budgets: { perMinute: 60, burst: 2 },
  });
  assert.equal(
    (await s.x.control(`limiter-clock?server=${s.server.id}`, { hold: true })).status,
    200,
  );
  const token = `sk-ant-oat01-${randomBytes(24).toString("base64url")}`;
  const wake = await paste(s, "claude_routine", fire, token);
  const poll = (error = false) =>
    s.x.mcp(
      s.credential,
      "get_updates",
      {
        serverId: s.server.id,
        participantId: s.ana,
        mode: "start",
        channelIds: [],
        directChats: "own",
        startAt: "now",
      },
      error,
    );
  // The agents' bucket is empty and Ana has spent her thirty admin calls this minute.
  for (let read = 0; read < 2; read++) await poll();
  assert.equal((await poll(true)).error.code, "rate_limited");
  for (let call = 0; call < 30; call++)
    await s.x.mcp(s.credential, "create_channel", {
      serverId: s.server.id,
      participantId: s.ana,
      requestKey: randomUUID(),
      name: `room-${call}`,
    });
  await s.x.control("read-events");
  const tested = await s.dashboard("POST", testPath(s, wake));
  assert.equal(tested.status, 200, tested.text);
  assert.equal(tested.json.data.lastTest.accepted, true);
  // Read as one of the person's website reads, keyed to their grant, not to Ana.
  const events = (await (await s.x.control("read-events")).json()).events;
  assert.deepEqual(
    events.map((event) => [event[3], event[5], event[6], event[7]]),
    [["grant", "wake_test", "dashboard", "allowed"]],
  );
});

test("Send a test starts the routine once through the real request, and changes no delivery state", async (t) => {
  const s = await setup(t, { wakeTokens: true });
  const token = `sk-ant-oat01-${randomBytes(24).toString("base64url")}`;
  const wake = await paste(s, "claude_routine", fire, token);
  assert.equal(wake.lastTest, null);
  const before = (await s.control("inspect")).targets[0];
  const sent = s.fake.received.length;

  const tested = await s.dashboard("POST", testPath(s, wake));
  assert.equal(tested.status, 200, tested.text);
  assert.equal(tested.json.data.lastTest.accepted, true);
  assert.equal(
    tested.json.data.lastTest.message,
    "Test sent: Claude Code accepted it (started a run).",
  );
  assert.ok(!tested.text.includes(token.slice(13, 40)));
  // The same URL and headers as a real wake; Claude Code's documented body is `{ text }` only.
  assert.equal(s.fake.received.length, sent + 1);
  const request = s.fake.received.at(-1);
  assert.equal(request.url, fire);
  assert.equal(request.headers.authorization, `Bearer ${token}`);
  assert.equal(request.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(Object.keys(request.json), ["text"]);
  assert.match(request.json.text, /^TalkTo test wake for participant /);
  assert.match(request.json.text, /Nothing new is waiting/);
  assert.match(request.json.text, /If it returns nothing new, end the run\.$/);

  // A run that polls with the test's checkpoint finds nothing new and ends.
  const checkpoint = request.json.text.match(/checkpoint (\S+)\. If/)[1];
  const polled = await s.x.mcp(s.credential, "get_updates", {
    serverId: s.server.id,
    participantId: s.ana,
    mode: "poll",
    checkpoint,
  });
  assert.deepEqual(polled.data.messages, [], JSON.stringify(polled));

  // Only the test's own row changed: checkpoint, due time, attempts and errors stay put.
  const after = await s.control("inspect");
  const target = after.targets[0];
  for (const column of [
    "delivered_through",
    "due_at",
    "last_attempt_at",
    "last_sent_at",
    "failures",
    "last_error",
    "attempt_id",
    "disabled_at",
  ])
    assert.equal(target[column], before[column], column);
  // It counts in the agent's wake budget like any outbound call.
  const hour = Math.floor(after.now / 3_600_000);
  assert.equal(after.sends.find((row) => row.hour === hour)?.sent, 1);

  // One test a minute at most, or the host's longer minimum: 2 minutes for Claude Code.
  const again = await s.dashboard("POST", testPath(s, wake));
  assert.equal(again.status, 429, again.text);
  assert.equal(again.json.error.code, "rate_limited");
  assert.match(again.json.error.message, /^A test was just sent\. You can send another in /);
  assert.ok(again.json.error.retryAfterSeconds > 60 && again.json.error.retryAfterSeconds <= 120);
  assert.equal(s.fake.received.length, sent + 1, "a refused test sends nothing");

  // A real wake right after waits for the host's minimum after the test, not for the cadence.
  await s.send(s.ben, s.general, "After the test");
  const held = await s.control("deliver");
  assert.equal(s.fake.received.length, sent + 1, "the host's minimum covers the test too");
  const lastTestAt = Date.parse(tested.json.data.lastTest.at);
  assert.equal(held.targets[0].due_at, lastTestAt + 120_000);
  assert.equal(held.targets[0].last_error, null, "waiting for the host is not a problem");
  assert.equal(held.targets[0].delivered_through, before.delivered_through);

  // The agent sees the result too, but cannot send a test: no tool, and no bearer token.
  const listed = await s.x.mcp(s.credential, "list_wakes", {
    serverId: s.server.id,
    participantId: s.ana,
  });
  assert.equal(listed.data.items[0].lastTest.accepted, true);
  const tools = (await s.protocol("tools/list", {})).result.tools.map((tool) => tool.name);
  assert.ok(!tools.some((name) => name.includes("test")), tools.join(", "));
  const bearer = await s.x.call("user_alice", "POST", testPath(s, wake), undefined, 403);
  assert.equal(bearer.error.code, "forbidden");
  assert.match(bearer.error.message, /from the TalkTo dashboard/);
});

test("a test reports a refused key and a host that never answers in plain words, and leaves the wake on", async (t) => {
  const s = await setup(t, { wakeTokens: true });
  const grokKey = `crsr_${randomBytes(20).toString("hex")}`;
  const grok = await paste(
    s,
    "grok_bot",
    "https://api2.cursor.sh/automations/webhook/routine-1",
    grokKey,
  );
  s.fake.state.mode = "unauthorized";
  const refused = await s.dashboard("POST", testPath(s, grok));
  assert.equal(refused.status, 200, refused.text);
  assert.equal(refused.json.data.lastTest.accepted, false);
  assert.equal(
    refused.json.data.lastTest.message,
    "Test failed: The key was refused. Copy a new key from Grok Bot and paste it again.",
  );
  assert.doesNotMatch(refused.text, /bad token/, "nothing from the host's answer");
  // Grok Bot's body takes extra fields: the same shape as a wake, marked as a test.
  const body = s.fake.received.at(-1).json;
  assert.equal(body.source, "talkto");
  assert.equal(body.test, true);
  assert.equal(body.pending, 0);
  assert.equal(body.participantId, s.ana);
  assert.match(body.text, /TalkTo test wake/);
  assert.equal(refused.json.data.state, "active", "a test never turns the wake off");
  assert.equal(refused.json.data.lastError, null);
  const target = (await s.control("inspect")).targets.find((row) => row.kind === "grok_bot");
  assert.equal(target.failures, 0);
  assert.equal(target.disabled_at, null);

  // No answer within TalkTo's timeout.
  const townSecret = `whsec_${randomBytes(20).toString("hex")}`;
  const town = await paste(
    s,
    "town",
    "https://api.town.com/workflow-webhooks/whk_abc123",
    townSecret,
  );
  s.fake.state.mode = "hang";
  const timedOut = await s.dashboard("POST", testPath(s, town));
  assert.equal(timedOut.status, 200, timedOut.text);
  assert.equal(timedOut.json.data.lastTest.accepted, false);
  assert.equal(
    timedOut.json.data.lastTest.message,
    "Test failed: Couldn't reach Town in time. It may still have started a run. Try again in a few minutes.",
  );
  assert.equal(s.fake.received.at(-1).json.data.test, true);
  assert.match(s.fake.received.at(-1).headers["x-town-idempotency-key"], /^evt_/);

  // A host error, on another agent's wake: tests are limited per wake, not per server.
  const benKey = `crsr_${randomBytes(20).toString("hex")}`;
  const bens = await paste(
    s,
    "grok_bot",
    "https://api2.cursor.sh/automations/webhook/routine-2",
    benKey,
    s.ben,
  );
  s.fake.state.mode = "error";
  const failing = await s.dashboard("POST", testPath(s, bens, s.ben));
  assert.equal(failing.status, 200, failing.text);
  assert.equal(
    failing.json.data.lastTest.message,
    "Test failed: Grok Bot had an error on its side. Try again in a few minutes.",
  );
});

test("tests wait for the host's minimum after a real wake and for the wake budget; real problems read plainly", async (t) => {
  const s = await setup(t, { wakeTokens: true });
  const token = `sk-ant-oat01-${randomBytes(24).toString("base64url")}`;
  const wake = await paste(s, "claude_routine", fire, token);
  s.fake.state.mode = "error";
  await s.send(s.ben, s.general, "Hello");
  await s.control("deliver");
  // A real delivery problem names the service, on the dashboard and for the agent.
  const listed = await s.dashboard("GET", s.wakesPath());
  assert.equal(listed.json.data.items[0].lastError, "Claude Code had an error on its side.");
  const sent = s.fake.received.length;
  const soon = await s.dashboard("POST", testPath(s, wake));
  assert.equal(soon.status, 429, soon.text);
  assert.match(
    soon.json.error.message,
    /^TalkTo started Claude Code moments ago\. You can send a test in /,
  );
  assert.equal(s.fake.received.length, sent);

  // The budget covers tests too.
  const other = await setup(t, { wakeTokens: true });
  const fresh = await paste(other, "claude_routine", fire, token);
  await other.control("exhaust", other.ana);
  const spent = await other.dashboard("POST", testPath(other, fresh));
  assert.equal(spent.status, 429, spent.text);
  assert.match(spent.json.error.message, /reached their limit/);

  // A wake that belongs to another agent cannot be tested under this one.
  const elsewhere = await other.dashboard("POST", testPath(other, fresh, other.ben));
  assert.equal(elsewhere.status, 400, elsewhere.text);
  assert.match(elsewhere.json.error.message, /no longer exists/);
});
