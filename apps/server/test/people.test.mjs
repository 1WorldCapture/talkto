import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

/** One server with two agents registered over MCP, and helpers for a person's own endpoints. */
const setup = async (t, options = {}) => {
  const x = await start(t, options);
  const account = await x.account();
  const server = await x.server(account.id);
  const root = `/v1/servers/${server.id}`;
  const credential = await x.mcpToken(account.organizationId);
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
  // The whole envelope, so tests can read `included` beside `data`.
  const open = async (
    agentId,
    requestKey = randomUUID(),
    status = 200,
    user = "user_alice",
    headers = {},
  ) => {
    const response = await x.raw(`${root}/people/me/direct-chats`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await x.token(user)}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ agentId, requestKey }),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result.data === undefined ? result : { ...result.data, included: result.included };
  };
  const say = (conversationId, body, extra = {}, status = 200, user = "user_alice") =>
    x.call(
      user,
      "POST",
      `${root}/people/me/messages`,
      { conversationId, body, requestKey: randomUUID(), ...extra },
      status,
    );
  return {
    x,
    account,
    server,
    root,
    credential,
    ana: ana.item.id,
    general: ana.generalConversationId,
    ben,
    open,
    say,
  };
};
const person = (outcome) => outcome.included.participants.find((p) => p.kind === "person");

test("a person opens one chat per agent, named from their sign-in, and replays by request key", async (t) => {
  const s = await setup(t);
  const key = randomUUID();
  const first = await s.open(s.ana, key);
  assert.equal(first.created, true);
  assert.equal(first.item.kind, "direct");
  const me = person(first);
  assert.deepEqual(
    {
      name: me.name,
      agentType: me.agentType,
      kind: me.kind,
      workingDirectory: me.workingDirectory,
    },
    { name: "alice", agentType: "person", kind: "person", workingDirectory: null },
  );
  assert.deepEqual(first.item.participantIds.toSorted(), [me.id, s.ana].toSorted());
  assert.equal(first.item.createdByParticipantId, me.id);
  const agent = first.included.participants.find((p) => p.id === s.ana);
  assert.equal("kind" in agent, false, "agent records keep their exact shape");

  // The same key and agent replay exactly; a new key reuses the chat; another agent is a new chat.
  assert.deepEqual(await s.open(s.ana, key), first);
  const again = await s.open(s.ana);
  assert.equal(again.created, false);
  assert.equal(again.item.id, first.item.id);
  const other = await s.open(s.ben);
  assert.equal(other.created, true);
  assert.equal(person(other).id, me.id, "one person participant per user per server");
  assert.equal((await s.open(s.ben, key, 409)).error.code, "idempotency_conflict");

  // A person is never the agent; an unknown agent is not found.
  assert.equal((await s.open(me.id, randomUUID(), 403)).error.code, "forbidden");
  assert.equal((await s.open(randomUUID(), randomUUID(), 404)).error.code, "participant_not_found");

  // The name comes from the verified profile only: a caller's header is removed. Bob's is "bob".
  await s.x.control("member", s.x.member(s.account.organizationId, "user_bob"));
  await s.x.call("user_alice", "PUT", `${s.root}/access/user_bob`);
  const bob = await s.open(s.ana, randomUUID(), 200, "user_bob", {
    "x-talkto-person-name": "Mallory",
  });
  assert.equal(person(bob).name, "bob");
  assert.notEqual(person(bob).id, me.id);
  assert.notEqual(bob.item.id, first.item.id);

  // Agents see people in the directory; agent counts never include them.
  const listed = await s.x.call("user_alice", "GET", `${s.root}/participants`);
  assert.deepEqual(
    listed.items.filter((p) => p.kind === "person").map((p) => p.name),
    ["alice", "bob"],
  );
  assert.equal((await s.x.call("user_alice", "GET", s.root)).participantCount, 2);
});

test("a taken name gets a numeric suffix", async (t) => {
  const s = await setup(t);
  await s.x.mcp(s.credential, "register_participant", {
    serverId: s.server.id,
    name: "Alice",
    agentType: "codex",
    requestKey: randomUUID(),
  });
  assert.equal(person(await s.open(s.ana)).name, "alice-2");
});

test("a person sends only into their own chat with an agent, unmetered, and agents receive it as usual", async (t) => {
  const s = await setup(t);
  const opened = await s.open(s.ana);
  const me = person(opened);
  const chat = opened.item.id;
  const requestKey = randomUUID();
  const sent = await s.say(chat, "Can you look at the failing deploy?", {
    requestKey,
    priority: "urgent",
  });
  assert.equal(sent.created, true);
  assert.equal(sent.item.senderId, me.id);
  assert.equal(sent.item.priority, "urgent");
  const replay = await s.say(chat, "Can you look at the failing deploy?", {
    requestKey,
    priority: "urgent",
  });
  assert.deepEqual(replay.item, sent.item);
  assert.equal(replay.created, false);
  assert.equal(
    (await s.say(chat, "Different text", { requestKey }, 409)).error.code,
    "idempotency_conflict",
  );
  const normal = await s.say(chat, "No rush on this one.");
  assert.equal("priority" in normal.item, false);

  // Other people's chats and chats between agents are not the person's to send in.
  const agents = await s.x.mcp(s.credential, "send_message", {
    serverId: s.server.id,
    participantId: s.ben,
    requestKey: randomUUID(),
    target: { kind: "direct", recipientId: s.ana },
    body: "Agent to agent",
  });
  assert.equal(
    (await s.say(agents.data.item.conversationId, "Butting in", {}, 403)).error.code,
    "not_conversation_participant",
  );
  await s.x.control("member", s.x.member(s.account.organizationId, "user_bob"));
  await s.x.call("user_alice", "PUT", `${s.root}/access/user_bob`);
  assert.equal(
    (await s.say(chat, "Not my chat", {}, 403, "user_bob")).error.code,
    "not_conversation_participant",
  );

  // The agent reads it through get_updates, with the sender marked as a person.
  const updates = await s.x.mcp(s.credential, "get_updates", {
    serverId: s.server.id,
    participantId: s.ana,
    mode: "start",
    channelIds: [],
    directChats: "own",
    startAt: "beginning",
  });
  assert.deepEqual(
    updates.data.messages.map((m) => m.body),
    ["Can you look at the failing deploy?", "No rush on this one.", "Agent to agent"],
  );
  assert.deepEqual(
    updates.included.participants.find((p) => p.id === me.id),
    { id: me.id, name: "alice", agentType: "person", kind: "person" },
  );
  assert.equal("kind" in updates.included.participants.find((p) => p.id === s.ben), false);
  // And in its own direct chats, next to the chat another agent opened.
  const context = await s.x.mcp(s.credential, "get_context", {
    serverId: s.server.id,
    participant: { id: s.ana },
    directChats: "own",
  });
  const own = JSON.stringify(context);
  assert.ok(own.includes(chat) && own.includes(agents.data.item.conversationId));

  // Messages and the timeline count every message; agent counts leave the person out.
  const chart = await s.x.call("user_alice", "GET", `${s.root}/activity?range=hour`);
  assert.equal(chart.messageCount, 3);
  assert.equal(chart.participantCount, 1);
  assert.ok(chart.senders.every((sender) => sender.id !== me.id));
  const summary = await s.x.call("user_alice", "GET", `${s.root}/summary`);
  assert.ok(summary.participants.every((p) => p.kind !== "person"));
});

test("person sends are limited to 30 a minute per person per server, and replays still answer", async (t) => {
  const s = await setup(t);
  const chat = (await s.open(s.ana)).item.id;
  const first = { requestKey: randomUUID() };
  await s.say(chat, "Message 1", first);
  for (let n = 2; n <= 30; n++) await s.say(chat, `Message ${n}`);
  const response = await s.x.raw(`${s.root}/people/me/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await s.x.token("user_alice")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ conversationId: chat, body: "Message 31", requestKey: randomUUID() }),
  });
  const limited = await response.json();
  assert.equal(response.status, 429, JSON.stringify(limited));
  assert.equal(limited.error.code, "rate_limited");
  assert.equal(limited.error.scope, "participant");
  assert.ok(limited.error.retryAfterSeconds >= 1 && limited.error.retryAfterSeconds <= 60);
  assert.equal(response.headers.get("retry-after"), String(limited.error.retryAfterSeconds));
  assert.equal((await s.say(chat, "Message 1", first)).created, false);
  // Agents are metered as before and not limited by the person's sends.
  await s.x.mcp(s.credential, "send_message", {
    serverId: s.server.id,
    participantId: s.ana,
    requestKey: randomUUID(),
    target: { kind: "conversation", conversationId: chat },
    body: "On it.",
  });
});

test("no agent operation acts as a person, over MCP or HTTP", async (t) => {
  const s = await setup(t);
  const opened = await s.open(s.ana);
  const me = person(opened).id;
  const chat = opened.item.id;
  const refused = async (tool, args) => {
    const result = await s.x.mcp(s.credential, tool, { serverId: s.server.id, ...args }, true);
    assert.equal(result.error.code, "forbidden", `${tool}: ${JSON.stringify(result)}`);
  };
  await refused("send_message", {
    participantId: me,
    requestKey: randomUUID(),
    target: { kind: "conversation", conversationId: chat },
    body: "Pretending to be alice",
  });
  await refused("send_message", {
    participantId: me,
    requestKey: randomUUID(),
    target: { kind: "direct", recipientId: s.ben },
    body: "Pretending to be alice",
  });
  await refused("get_updates", {
    participantId: me,
    mode: "start",
    channelIds: [],
    directChats: "own",
    startAt: "beginning",
  });
  await refused("get_context", { participant: { id: me } });
  await refused("get_context", { participant: { name: "alice" } });
  await refused("create_channel", {
    participantId: me,
    requestKey: randomUUID(),
    name: "people-channel",
  });
  await refused("set_channel_archived", {
    participantId: me,
    conversationId: s.general,
    archived: false,
    expectedRevision: 0,
  });
  await refused("create_signal", { participantId: me, channelIds: [], directChats: "own" });
  for (const [path, payload] of [
    [
      `/conversations/${chat}/messages`,
      { participantId: me, requestKey: randomUUID(), body: "Pretending" },
    ],
    ["/direct-chats", { participantId: me, recipientId: s.ben }],
    ["/channels", { participantId: me, requestKey: randomUUID(), name: "people-channel" }],
  ]) {
    const result = await s.x.call("user_alice", "POST", s.root + path, payload, 403);
    assert.equal(result.error.code, "forbidden", path);
  }
  // An agent may still open a chat with a person and reply there.
  const reply = await s.x.mcp(s.credential, "send_message", {
    serverId: s.server.id,
    participantId: s.ben,
    requestKey: randomUUID(),
    target: { kind: "direct", recipientId: me },
    body: "Ben here, replying to you directly.",
  });
  assert.equal(reply.data.created, true);
  const answer = await s.x.mcp(s.credential, "send_message", {
    serverId: s.server.id,
    participantId: s.ana,
    requestKey: randomUUID(),
    target: { kind: "conversation", conversationId: chat },
    body: "Ana here.",
  });
  assert.equal(answer.data.item.conversationId, chat);
});

test("person sends never use the message allowance, even when it is spent", async (t) => {
  const s = await setup(t, { metering: true });
  const quota = async (action = "", data) => {
    const response = await s.x.control(`quota${action}?account=${s.account.id}`, data);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  await quota("/publish", {
    accountId: s.account.id,
    start: new Date(Date.now() - 3600000).toISOString(),
    end: new Date(Date.now() + 3600000).toISOString(),
    allowance: 1,
    overdraft: 0,
  });
  const chat = (await s.open(s.ana)).item.id;
  const agentSend = (body, error) =>
    s.x.mcp(
      s.credential,
      "send_message",
      {
        serverId: s.server.id,
        participantId: s.ana,
        requestKey: randomUUID(),
        target: { kind: "conversation", conversationId: chat },
        body,
      },
      error,
    );
  await agentSend("The one included message");
  assert.equal(
    (await agentSend("Over the allowance", true)).error.code,
    "message_allowance_exhausted",
  );
  assert.equal((await s.say(chat, "People are not metered")).created, true);
  assert.equal((await quota()).used, 1);
});

test("a person whose access is removed can no longer send", async (t) => {
  const s = await setup(t);
  await s.x.control("member", s.x.member(s.account.organizationId, "user_bob"));
  await s.x.call("user_alice", "PUT", `${s.root}/access/user_bob`);
  const chat = (await s.open(s.ana, randomUUID(), 200, "user_bob")).item.id;
  await s.say(chat, "Before", {}, 200, "user_bob");
  await s.x.call("user_alice", "DELETE", `${s.root}/access/user_bob`);
  assert.equal((await s.say(chat, "After", {}, 404, "user_bob")).error.code, "server_unavailable");
  assert.equal(
    (await s.open(s.ana, randomUUID(), 404, "user_bob")).error.code,
    "server_unavailable",
  );
});

test("a person reads their own participant without creating one", async (t) => {
  const s = await setup(t);
  const me = (user = "user_alice", status = 200) =>
    s.x.call(user, "GET", `${s.root}/people/me`, undefined, status);
  const listed = async () => (await s.x.call("user_alice", "GET", `${s.root}/participants`)).items;
  assert.deepEqual(await me(), { participant: null, postsInChannels: true });
  assert.deepEqual(
    await me(),
    { participant: null, postsInChannels: true },
    "asking twice still creates nothing",
  );
  assert.equal((await listed()).length, 2);

  const opened = person(await s.open(s.ana));
  assert.deepEqual(
    (await me()).participant,
    (await listed()).find((p) => p.id === opened.id),
  );
  assert.equal((await me()).participant.kind, "person");

  // Another person on the same server has their own answer, and losing access ends it.
  await s.x.control("member", s.x.member(s.account.organizationId, "user_bob"));
  await s.x.call("user_alice", "PUT", `${s.root}/access/user_bob`);
  assert.deepEqual(await me("user_bob"), { participant: null, postsInChannels: true });
  await s.x.call("user_alice", "DELETE", `${s.root}/access/user_bob`);
  assert.equal((await me("user_bob", 404)).error.code, "server_unavailable");
});

/** Sign in as a person on the server, creating their participant without any direct chat. */
const join = async (s, user = "user_alice", status = 200) =>
  s.x.call(user, "POST", `${s.root}/people/me`, undefined, status);

test("a person joins a server as themselves without a direct chat, once", async (t) => {
  const s = await setup(t);
  const first = await join(s);
  assert.equal(first.created, true);
  assert.deepEqual(
    { name: first.item.name, kind: first.item.kind, agentType: first.item.agentType },
    { name: "alice", kind: "person", agentType: "person" },
  );
  const again = await join(s);
  assert.equal(again.created, false);
  assert.deepEqual(again.item, first.item);
  assert.deepEqual(
    (await s.x.call("user_alice", "GET", `${s.root}/people/me`)).participant,
    first.item,
  );
  // A later direct chat reuses the same participant.
  assert.equal(person(await s.open(s.ana)).id, first.item.id);
  // The name comes from the verified profile; a caller's header is removed.
  await s.x.control("member", s.x.member(s.account.organizationId, "user_bob"));
  await s.x.call("user_alice", "PUT", `${s.root}/access/user_bob`);
  const response = await s.x.raw(`${s.root}/people/me`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await s.x.token("user_bob")}`,
      "x-talkto-person-name": "Mallory",
    },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.item.name, "bob");
  assert.equal((await s.x.call("user_alice", "GET", s.root)).participantCount, 2);
});

test("a person posts in a channel as themselves, and agents waiting on it get it", async (t) => {
  const s = await setup(t);
  // Before joining, the server asks the person to join first; nothing is created.
  assert.equal(
    (await s.say(s.general, "Too early", {}, 403)).error.code,
    "not_conversation_participant",
  );
  assert.equal((await s.x.call("user_alice", "GET", `${s.root}/people/me`)).participant, null);
  const me = (await join(s)).item;

  // Ana waits on General; the person's post ends the wait.
  const started = await s.x.mcp(s.credential, "get_updates", {
    serverId: s.server.id,
    participantId: s.ana,
    mode: "start",
    channelIds: [s.general],
    directChats: "none",
    startAt: "now",
  });
  const begun = Date.now();
  const waiting = s.x.mcp(s.credential, "get_updates", {
    serverId: s.server.id,
    participantId: s.ana,
    mode: "poll",
    checkpoint: started.data.checkpoint,
    waitSeconds: 20,
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const requestKey = randomUUID();
  const sent = await s.say(s.general, "Morning, team. Who has the deploy?", { requestKey });
  assert.equal(sent.created, true);
  assert.equal(sent.item.senderId, me.id);
  assert.equal(sent.item.conversationId, s.general);
  const woken = await waiting;
  assert.ok(Date.now() - begun < 10_000, "the post ends the wait, not its deadline");
  assert.deepEqual(
    woken.data.messages.map((m) => [m.senderId, m.body]),
    [[me.id, "Morning, team. Who has the deploy?"]],
  );
  assert.deepEqual(
    woken.included.participants.find((p) => p.id === me.id),
    { id: me.id, name: "alice", agentType: "person", kind: "person" },
  );

  // Replays answer unchanged; another body under the key conflicts.
  const replay = await s.say(s.general, "Morning, team. Who has the deploy?", { requestKey });
  assert.equal(replay.created, false);
  assert.deepEqual(replay.item, sent.item);
  assert.equal(
    (await s.say(s.general, "Changed", { requestKey }, 409)).error.code,
    "idempotency_conflict",
  );
  // Urgent stays a direct-chat option, as for agents.
  assert.equal(
    (await s.say(s.general, "Everyone stop", { priority: "urgent" }, 400)).error.code,
    "wrong_conversation_kind",
  );

  // A channel any agent created is open to the person too; agents reply as usual.
  const side = (
    await s.x.mcp(s.credential, "create_channel", {
      serverId: s.server.id,
      participantId: s.ben,
      name: "release",
      requestKey: randomUUID(),
    })
  ).data.item;
  assert.equal((await s.say(side.id, "Notes are ready.")).item.senderId, me.id);
  const reply = await s.x.mcp(s.credential, "send_message", {
    serverId: s.server.id,
    participantId: s.ben,
    requestKey: randomUUID(),
    target: { kind: "conversation", conversationId: side.id },
    body: "Thanks, alice.",
  });
  assert.equal(reply.data.created, true);
  const history = await s.x.call(
    "user_alice",
    "GET",
    `${s.root}/conversations/${side.id}/messages`,
  );
  assert.deepEqual(
    history.items.map((m) => m.body),
    ["Notes are ready.", "Thanks, alice."],
  );
});

test("a person cannot post in an archived channel, a chat between agents, or without access", async (t) => {
  const s = await setup(t);
  await join(s);
  const side = (
    await s.x.mcp(s.credential, "create_channel", {
      serverId: s.server.id,
      participantId: s.ben,
      name: "old-work",
      requestKey: randomUUID(),
    })
  ).data.item;
  await s.say(side.id, "Before archiving");
  await s.x.mcp(s.credential, "set_channel_archived", {
    serverId: s.server.id,
    participantId: s.ben,
    conversationId: side.id,
    archived: true,
    expectedRevision: side.revision,
  });
  const archived = await s.say(side.id, "After archiving", {}, 409);
  assert.equal(archived.error.code, "channel_archived");
  // Agents get the same refusal.
  const agent = await s.x.mcp(
    s.credential,
    "send_message",
    {
      serverId: s.server.id,
      participantId: s.ana,
      requestKey: randomUUID(),
      target: { kind: "conversation", conversationId: side.id },
      body: "After archiving",
    },
    true,
  );
  assert.equal(agent.error.code, archived.error.code);

  const agents = await s.x.mcp(s.credential, "send_message", {
    serverId: s.server.id,
    participantId: s.ben,
    requestKey: randomUUID(),
    target: { kind: "direct", recipientId: s.ana },
    body: "Agent to agent",
  });
  assert.equal(
    (await s.say(agents.data.item.conversationId, "Butting in", {}, 403)).error.code,
    "not_conversation_participant",
  );

  // A member without access to the server can neither join nor post.
  await s.x.control("member", s.x.member(s.account.organizationId, "user_bob"));
  assert.equal((await join(s, "user_bob", 404)).error.code, "server_unavailable");
  assert.equal(
    (await s.say(s.general, "Let me in", {}, 404, "user_bob")).error.code,
    "server_unavailable",
  );
  // Granted, then revoked: posting stops with the grant.
  await s.x.call("user_alice", "PUT", `${s.root}/access/user_bob`);
  await join(s, "user_bob");
  await s.say(s.general, "Hello", {}, 200, "user_bob");
  await s.x.call("user_alice", "DELETE", `${s.root}/access/user_bob`);
  assert.equal(
    (await s.say(s.general, "Still here?", {}, 404, "user_bob")).error.code,
    "server_unavailable",
  );
  // An unknown conversation is not found.
  assert.equal(
    (await s.say(randomUUID(), "Anyone?", {}, 404)).error.code,
    "conversation_not_found",
  );
});

test("MCP cannot post in a channel as a person, and an MCP token cannot use the person routes", async (t) => {
  const s = await setup(t);
  const me = (await join(s)).item.id;
  const result = await s.x.mcp(
    s.credential,
    "send_message",
    {
      serverId: s.server.id,
      participantId: me,
      requestKey: randomUUID(),
      target: { kind: "conversation", conversationId: s.general },
      body: "Pretending to be alice",
    },
    true,
  );
  assert.equal(result.error.code, "forbidden");
  for (const [path, payload] of [
    ["/people/me", undefined],
    ["/people/me/messages", { conversationId: s.general, requestKey: randomUUID(), body: "Hi" }],
  ]) {
    const response = await s.x.raw(s.root + path, {
      method: "POST",
      headers: { authorization: `Bearer ${s.credential}`, "content-type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    assert.equal(response.status, 401, path);
  }
  const history = await s.x.call(
    "user_alice",
    "GET",
    `${s.root}/conversations/${s.general}/messages`,
  );
  assert.ok(history.items.every((m) => m.senderId !== me));
});

test("channel posts share the person's limits with their direct messages, unmetered", async (t) => {
  const s = await setup(t, { metering: true });
  const quota = async (action = "", data) => {
    const response = await s.x.control(`quota${action}?account=${s.account.id}`, data);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  await quota("/publish", {
    accountId: s.account.id,
    start: new Date(Date.now() - 3600000).toISOString(),
    end: new Date(Date.now() + 3600000).toISOString(),
    allowance: 1,
    overdraft: 0,
  });
  const chat = (await s.open(s.ana)).item.id;
  for (let n = 1; n <= 15; n++) await s.say(chat, `Direct ${n}`);
  for (let n = 1; n <= 15; n++) await s.say(s.general, `Channel ${n}`);
  const limited = await s.say(s.general, "One too many", {}, 429);
  assert.equal(limited.error.code, "rate_limited");
  assert.equal(limited.error.scope, "participant");
  assert.equal((await quota()).used, 0, "people are not metered in channels either");
});
