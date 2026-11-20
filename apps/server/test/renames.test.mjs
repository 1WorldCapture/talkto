import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

/** One server with Ana and Ben registered over Alice's MCP connection, and rename helpers. */
const setup = async (t, options = {}) => {
  const x = await start(t, options);
  const account = await x.account();
  const server = await x.server(account.id);
  const root = `/v1/servers/${server.id}`;
  const credential = await x.mcpToken(account.organizationId);
  const anaKey = randomUUID();
  const register = async (name, requestKey = randomUUID(), token = credential) =>
    (
      await x.mcp(token, "register_participant", {
        serverId: server.id,
        name,
        agentType: "codex",
        requestKey,
      })
    ).data;
  const first = await register("Ana", anaKey);
  const ana = first.item.id;
  const ben = (await register("Ben")).item.id;
  const general = first.generalConversationId;
  /** An agent renames a registration over MCP; `error` expects a refusal. */
  const rename = async (participantId, name, requestKey = randomUUID(), error = false, token) =>
    x.mcp(
      token ?? credential,
      "rename_participant",
      { serverId: server.id, participantId, name, requestKey },
      error,
    );
  const updates = (input) => x.mcp(credential, "get_updates", { serverId: server.id, ...input });
  const renames = async (query = "") =>
    (await x.call("user_alice", "GET", `${root}/renames${query}`)).items;
  const send = (body, participantId = ben) =>
    x.mcp(credential, "send_message", {
      serverId: server.id,
      participantId,
      requestKey: randomUUID(),
      target: { kind: "conversation", conversationId: general },
      body,
    });
  const bob = async () => {
    await x.control("member", x.member(account.organizationId, "user_bob"));
    await x.call("user_alice", "PUT", `${root}/access/user_bob`);
    return x.mcpToken(account.organizationId, "user_bob");
  };
  return {
    x,
    account,
    server,
    root,
    credential,
    register,
    anaKey,
    ana,
    ben,
    general,
    rename,
    updates,
    renames,
    send,
    bob,
  };
};

test("an agent renames itself: same participant, current name everywhere, history unchanged", async (t) => {
  const s = await setup(t);
  await s.send("Hello from Ana before the rename", s.ana);
  const result = await s.rename(s.ana, "ana-macbook");
  assert.equal(result.data.changed, true);
  assert.equal(result.data.participant.id, s.ana);
  assert.equal(result.data.participant.name, "ana-macbook");
  assert.equal(result.data.participant.messageCount, 1, "activity stays with the participant");
  const notice = result.data.rename;
  assert.deepEqual(
    {
      participantId: notice.participantId,
      previousName: notice.previousName,
      name: notice.name,
      renamedBy: notice.renamedBy,
    },
    { participantId: s.ana, previousName: "Ana", name: "ana-macbook", renamedBy: { kind: "self" } },
  );
  assert.ok(Number.isSafeInteger(notice.sequence) && notice.sequence > 0);
  assert.match(notice.renamedAt, /^\d{4}-\d{2}-\d{2}T/);

  // The new name recovers the identity; the old one is free and no longer resolves.
  const context = await s.x.mcp(s.credential, "get_context", {
    serverId: s.server.id,
    participant: { name: "ana-macbook" },
  });
  assert.equal(context.data.self.id, s.ana);
  const listed = await s.x.call("user_alice", "GET", `${s.root}/participants?name=Ana`);
  assert.deepEqual(listed.items, []);

  // Message bodies are unchanged; author labels show the current name.
  const history = await s.x.call(
    "user_alice",
    "GET",
    `${s.root}/conversations/${s.general}/messages`,
  );
  assert.deepEqual(
    history.items.map((m) => m.body),
    ["Hello from Ana before the rename"],
  );
  const raw = await s.x.raw(`${s.root}/conversations/${s.general}/messages`, {
    headers: { authorization: `Bearer ${await s.x.token("user_alice")}` },
  });
  const envelope = await raw.json();
  assert.equal(envelope.included.participants.find((p) => p.id === s.ana).name, "ana-macbook");

  // The HTTP route is the same operation for an agent using the HTTP API.
  const viaHttp = await s.x.call("user_alice", "POST", `${s.root}/participants/${s.ana}/rename`, {
    name: "ana-studio",
    requestKey: randomUUID(),
  });
  assert.equal(viaHttp.changed, true);
  assert.equal(viaHttp.rename.previousName, "ana-macbook");
  assert.deepEqual(
    (await s.renames(`?participantId=${s.ana}`)).map((r) => [r.previousName, r.name]),
    [
      ["ana-macbook", "ana-studio"],
      ["Ana", "ana-macbook"],
    ],
  );
});

test("a peer watching only its direct chats receives the rename once through get_updates", async (t) => {
  const s = await setup(t);
  // Ben saved a checkpoint before the rename, from a watch with no channels at all.
  const started = await s.updates({
    participantId: s.ben,
    mode: "start",
    channelIds: [],
    directChats: "own",
    startAt: "now",
  });
  assert.deepEqual(started.data.messages, []);
  assert.equal("renames" in started.data, false, "pages without renames keep their shape");
  const checkpoint = started.data.checkpoint;

  // A wait in progress returns as soon as the rename commits.
  const waiting = s.updates({
    participantId: s.ben,
    mode: "poll",
    checkpoint,
    waitSeconds: 20,
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const began = Date.now();
  await s.rename(s.ana, "ana-macbook");
  const woken = await waiting;
  assert.ok(Date.now() - began < 10_000, "the rename ended the wait");
  assert.deepEqual(
    woken.data.renames.map((r) => [r.participantId, r.previousName, r.name, r.renamedBy.kind]),
    [[s.ana, "Ana", "ana-macbook", "self"]],
  );

  // Polling the saved checkpoint again returns it again; the new checkpoint never repeats it.
  const polled = await s.updates({ participantId: s.ben, mode: "poll", checkpoint });
  assert.deepEqual(polled.data.renames, woken.data.renames);
  assert.deepEqual(polled.data.messages, []);
  const after = await s.updates({
    participantId: s.ben,
    mode: "poll",
    checkpoint: polled.data.checkpoint,
  });
  assert.equal("renames" in after.data, false);

  // Renames and messages share one order: a later direct message arrives after the notice.
  const sent = await s.x.mcp(s.credential, "send_message", {
    serverId: s.server.id,
    participantId: s.ana,
    requestKey: randomUUID(),
    target: { kind: "direct", recipientId: s.ben },
    body: "Same agent, new name",
  });
  assert.ok(sent.data.item.sequence > polled.data.renames[0].sequence);
  const next = await s.updates({
    participantId: s.ben,
    mode: "poll",
    checkpoint: after.data.checkpoint,
  });
  assert.deepEqual(
    next.data.messages.map((m) => m.body),
    ["Same agent, new name"],
  );
  assert.equal("renames" in next.data, false);
  assert.equal(next.included.participants.find((p) => p.id === s.ana).name, "ana-macbook");

  // Ana is told of her own rename too, and a small limit pages renames with the same checkpoint.
  await s.rename(s.ana, "ana-studio");
  const own = await s.updates({
    participantId: s.ana,
    mode: "start",
    channelIds: [],
    directChats: "own",
    startAt: "beginning",
    limit: 1,
  });
  assert.deepEqual(
    own.data.renames.map((r) => r.name),
    ["ana-macbook"],
  );
  assert.notEqual(own.data.nextCursor, null);
  const rest = await s.updates({
    participantId: s.ana,
    mode: "continue",
    cursor: own.data.nextCursor,
    limit: 1,
  });
  assert.deepEqual(
    rest.data.renames.map((r) => r.name),
    ["ana-studio"],
  );
});

test("a taken name, the same name and a case-only change", async (t) => {
  const s = await setup(t);
  // Another participant's name, in any case, is refused and changes nothing.
  const taken = await s.rename(s.ana, "BEN", randomUUID(), true);
  assert.equal(taken.error.code, "name_taken");
  assert.deepEqual(await s.renames(), []);
  assert.equal(
    (await s.x.call("user_alice", "GET", `${s.root}/participants/${s.ana}`)).name,
    "Ana",
  );

  // The exact current name is a no-op with no notice.
  const same = await s.rename(s.ana, "Ana");
  assert.deepEqual(
    { changed: same.data.changed, rename: same.data.rename, name: same.data.participant.name },
    { changed: false, rename: null, name: "Ana" },
  );
  assert.deepEqual(await s.renames(), []);

  // A case-only change is a change and is announced.
  const cased = await s.rename(s.ana, "ANA");
  assert.equal(cased.data.changed, true);
  assert.equal(cased.data.participant.name, "ANA");
  assert.deepEqual(
    (await s.renames()).map((r) => [r.previousName, r.name]),
    [["Ana", "ANA"]],
  );
  // Invalid names follow registration's rules.
  const invalid = await s.rename(s.ana, "has space", randomUUID(), true);
  assert.equal(invalid.error.code, "invalid_input");
});

test("retries are idempotent and never restore an older name; the original registration still recovers", async (t) => {
  const s = await setup(t);
  const key = randomUUID();
  const first = await s.rename(s.ana, "ana-macbook", key);
  const later = await s.rename(s.ana, "ana-studio");
  assert.equal(later.data.changed, true);

  // Retrying the first request returns its recorded change, without undoing the later one.
  const retry = await s.rename(s.ana, "ana-macbook", key);
  assert.equal(retry.data.changed, false);
  assert.deepEqual(retry.data.rename, first.data.rename);
  assert.equal(retry.data.participant.name, "ana-studio");
  assert.equal((await s.renames()).length, 2, "no duplicate notice");
  // The same key with different input is a conflict.
  const conflict = await s.rename(s.ana, "ana-laptop", key, true);
  assert.equal(conflict.error.code, "idempotency_conflict");

  // Retrying the original registration recovers the same participant under its current name.
  const recovered = await s.register("Ana", s.anaKey);
  assert.equal(recovered.created, false);
  assert.equal(recovered.item.id, s.ana);
  assert.equal(recovered.item.name, "ana-studio");
  // Changed registration input is still a conflict, and the old name is free for someone else.
  const changed = await s.x.mcp(
    s.credential,
    "register_participant",
    { serverId: s.server.id, name: "Ana", agentType: "claude-code", requestKey: s.anaKey },
    true,
  );
  assert.equal(changed.error.code, "idempotency_conflict");
  const newcomer = await s.register("Ana");
  assert.equal(newcomer.created, true);
  assert.notEqual(newcomer.item.id, s.ana);
  assert.equal((await s.register("Ana", s.anaKey)).item.id, s.ana);
});

test("agents cannot rename another person's agents or a person", async (t) => {
  const s = await setup(t);
  const bobToken = await s.bob();
  const bobAgent = (await s.register("Bobs-agent", randomUUID(), bobToken)).item.id;

  // Alice's connection cannot rename Bob's agent, nor Bob's connection Alice's.
  const refused = await s.rename(bobAgent, "taken-over", randomUUID(), true);
  assert.equal(refused.error.code, "forbidden");
  const reverse = await s.rename(s.ana, "taken-over", randomUUID(), true, bobToken);
  assert.equal(reverse.error.code, "forbidden");
  // The HTTP route has the same rule.
  await s.x.call(
    "user_bob",
    "POST",
    `${s.root}/participants/${s.ana}/rename`,
    { name: "taken-over", requestKey: randomUUID() },
    403,
  );

  // A person's participant is never renamed through an agent operation.
  const chat = await s.x.call("user_alice", "POST", `${s.root}/people/me/direct-chats`, {
    agentId: s.ana,
    requestKey: randomUUID(),
  });
  const me = (await s.x.call("user_alice", "GET", `${s.root}/people/me`)).participant;
  assert.ok(chat.item.participantIds.includes(me.id));
  const person = await s.rename(me.id, "not-a-person", randomUUID(), true);
  assert.equal(person.error.code, "forbidden");
  const unknown = await s.rename(randomUUID(), "nobody", randomUUID(), true);
  assert.equal(unknown.error.code, "participant_not_found");

  // Within one person's connection, any of their agents can rename another: TalkTo cannot tell
  // them apart, and the notice records it as the agent's own change.
  const sibling = await s.rename(s.ben, "ben-macbook");
  assert.equal(sibling.data.rename.renamedBy.kind, "self");
  assert.deepEqual(
    (await s.renames()).map((r) => r.name),
    ["ben-macbook"],
  );
});

test("a person renames an agent on the dashboard, recorded as renamed by them", async (t) => {
  const s = await setup(t);
  const result = await s.x.call("user_alice", "POST", `${s.root}/people/me/renames`, {
    agentId: s.ana,
    name: "ana-macbook",
    requestKey: randomUUID(),
  });
  assert.equal(result.changed, true);
  const me = (await s.x.call("user_alice", "GET", `${s.root}/people/me`)).participant;
  assert.deepEqual(result.rename.renamedBy, {
    kind: "person",
    participantId: me.id,
    name: "alice",
  });

  // Anyone with access to the server may, like other dashboard agent management.
  await s.bob();
  const byBob = await s.x.call("user_bob", "POST", `${s.root}/people/me/renames`, {
    agentId: s.ana,
    name: "ana-studio",
    requestKey: randomUUID(),
  });
  assert.equal(byBob.rename.renamedBy.name, "bob");

  // Agents learn about it through get_updates like any rename.
  const page = await s.updates({
    participantId: s.ben,
    mode: "start",
    channelIds: [s.general],
    directChats: "none",
    startAt: "beginning",
  });
  assert.deepEqual(
    page.data.renames.map((r) => [r.name, r.renamedBy.kind, r.renamedBy.name]),
    [
      ["ana-macbook", "person", "alice"],
      ["ana-studio", "person", "bob"],
    ],
  );

  // A person participant cannot be renamed, and the person's key namespace replays.
  await s.x.call(
    "user_alice",
    "POST",
    `${s.root}/people/me/renames`,
    { agentId: me.id, name: "someone-else", requestKey: randomUUID() },
    403,
  );
  const taken = await s.x.call(
    "user_alice",
    "POST",
    `${s.root}/people/me/renames`,
    { agentId: s.ana, name: "ben", requestKey: randomUUID() },
    409,
  );
  assert.equal(taken.error.code, "name_taken");
});

test("renames are never metered and leave message counts alone", async (t) => {
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
  await s.send("The one included message");
  const over = await s.x.mcp(
    s.credential,
    "send_message",
    {
      serverId: s.server.id,
      participantId: s.ben,
      requestKey: randomUUID(),
      target: { kind: "conversation", conversationId: s.general },
      body: "Over the allowance",
    },
    true,
  );
  assert.equal(over.error.code, "message_allowance_exhausted");
  // With the allowance spent, renames still work and spend nothing.
  await s.rename(s.ana, "ana-macbook");
  await s.x.call("user_alice", "POST", `${s.root}/people/me/renames`, {
    agentId: s.ben,
    name: "ben-macbook",
    requestKey: randomUUID(),
  });
  assert.equal((await quota()).used, 1);
  const summary = await s.x.call("user_alice", "GET", s.root);
  assert.equal(summary.messageCount, 1);
  const chart = await s.x.call("user_alice", "GET", `${s.root}/activity?range=hour`);
  assert.equal(chart.messageCount, 1);
});

test("renames keep the stored schema version, so the previous Worker can still open the server", async (t) => {
  const s = await setup(t);
  // A checkpoint written before the feature existed still reads renames and messages after it.
  const before = await s.updates({
    participantId: s.ben,
    mode: "start",
    channelIds: [s.general],
    directChats: "own",
    startAt: "now",
  });
  await s.rename(s.ana, "ana-macbook");
  await s.send("After the rename", s.ana);
  const page = await s.updates({
    participantId: s.ben,
    mode: "poll",
    checkpoint: before.data.checkpoint,
  });
  assert.deepEqual(
    page.data.renames.map((r) => r.name),
    ["ana-macbook"],
  );
  assert.deepEqual(
    page.data.messages.map((m) => m.body),
    ["After the rename"],
  );
  // The deployed Worker accepts only its own latest version (11); the rename table is additive.
  const state = await (await s.x.control(`updates?server=${s.server.id}`, "inspect")).json();
  assert.equal(state.version, 11);
});
