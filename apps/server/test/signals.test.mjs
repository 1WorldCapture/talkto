import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

/** One organization, one server, three agents on one connection, and helpers for signal links. */
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
        agentType: "codex",
        requestKey: randomUUID(),
      })
    ).data;
  const ana = await register("Ana");
  const ben = (await register("Ben")).item.id;
  const cal = (await register("Cal")).item.id;
  const general = ana.generalConversationId;
  const side = (
    await x.mcp(credential, "create_channel", {
      serverId: server.id,
      participantId: ben,
      name: "side",
      requestKey: randomUUID(),
    })
  ).data.item.id;
  const send = (from, target, body, priority) => {
    const input = {
      serverId: server.id,
      participantId: from,
      requestKey: randomUUID(),
      target,
      body,
    };
    if (priority !== undefined) input.priority = priority;
    return x.mcp(credential, "send_message", input);
  };
  const toChannel = (id) => ({ kind: "conversation", conversationId: id });
  const toAgent = (id) => ({ kind: "direct", recipientId: id });
  const mint = (participantId, extra = {}, error = false) =>
    x.mcp(
      credential,
      "create_signal",
      { serverId: server.id, participantId, channelIds: [general], directChats: "own", ...extra },
      error,
    );
  /**
   * A hook's view of the link: status, raw text and parsed body. Current hooks send the secret in
   * the Authorization header; `legacy` sends the link itself, as hooks installed earlier do.
   */
  const check = async (url, since, legacy = false) => {
    const target = new URL(url);
    if (since !== undefined && since !== null) target.searchParams.set("since", since);
    const dot = target.pathname.lastIndexOf(".");
    const response = legacy
      ? await x.raw(target.pathname + target.search)
      : await x.raw(target.pathname.slice(0, dot) + target.search, {
          headers: { authorization: `Bearer ${target.pathname.slice(dot + 1)}` },
        });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: JSON.parse(text) };
  };
  return {
    x,
    account,
    credential,
    server,
    general,
    side,
    ana: ana.item.id,
    ben,
    cal,
    send,
    toChannel,
    toAgent,
    mint,
    check,
  };
};

test("a signal link counts only the participant's incoming messages and reveals no content", async (t) => {
  const s = await setup(t);
  const minted = await s.mint(s.ana);
  const link = minted.data;
  assert.match(
    link.url,
    /^https:\/\/talkto\.test\/v1\/signals\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.[\w-]{43}$/,
  );
  assert.ok(link.url.includes(s.server.id));
  assert.doesNotMatch(JSON.stringify(minted), new RegExp(s.credential.slice(-24)));
  assert.deepEqual(link.selection, { channelIds: [s.general], directChats: "own" });
  assert.ok(link.minIntervalSeconds >= 5);
  assert.match(link.procedure, /never message text/i);

  const quiet = await s.check(link.url);
  assert.equal(quiet.status, 200, quiet.text);
  // Hooks installed before the header form send the link itself; it answers the same.
  const legacy = await s.check(link.url, null, true);
  assert.equal(legacy.status, 200, legacy.text);
  assert.deepEqual(legacy.body, quiet.body);
  assert.deepEqual(Object.keys(quiet.body).toSorted(), [
    "cursor",
    "expiresAt",
    "more",
    "pending",
    "urgent",
    "wakeCadence",
    "wakeIntervalSeconds",
    "waking",
  ]);
  assert.deepEqual(
    { pending: quiet.body.pending, urgent: quiet.body.urgent, cursor: quiet.body.cursor },
    { pending: 0, urgent: 0, cursor: null },
  );
  assert.equal(quiet.body.expiresAt, link.expiresAt);
  assert.equal(quiet.headers.get("cache-control"), "no-store");

  // Counted: General (selected) and Ana's own direct chats. Not counted: her own sends,
  // an unselected channel, and a direct chat between two other participants.
  await s.send(s.ben, s.toChannel(s.general), "Secret plan alpha for General");
  await s.send(s.ana, s.toChannel(s.general), "Ana's own words");
  await s.send(s.ben, s.toChannel(s.side), "Unselected side channel text");
  await s.send(s.ben, s.toAgent(s.cal), "Between Ben and Cal only");
  const direct = await s.send(s.cal, s.toAgent(s.ana), "Urgent: stop the deploy", "urgent");
  const busy = await s.check(link.url);
  assert.equal(busy.status, 200, busy.text);
  assert.equal(busy.body.pending, 2);
  assert.equal(busy.body.urgent, 1);
  assert.equal(busy.body.waking, 1, "the direct message wakes; the General post is held");
  assert.equal(busy.body.more, false);
  assert.equal(busy.body.cursor, direct.data.item.id);
  // No text, senders, names or conversation identities leak into the answer.
  for (const forbidden of [
    "Secret plan",
    "stop the deploy",
    "Ben",
    "Cal",
    "Ana",
    s.ben,
    s.cal,
    s.ana,
    s.general,
    s.side,
    "sequence",
    "body",
    "senderId",
  ])
    assert.ok(!busy.text.includes(forbidden), forbidden);

  // since=<cursor> counts only newer messages.
  assert.equal((await s.check(link.url, busy.body.cursor)).body.pending, 0);
  assert.equal((await s.check(link.url, busy.body.cursor)).body.cursor, busy.body.cursor);
  await s.send(s.ben, s.toChannel(s.general), "One more");
  const newer = await s.check(link.url, busy.body.cursor);
  assert.deepEqual([newer.body.pending, newer.body.urgent], [1, 0]);
  // An unknown since is ignored rather than trusted; a malformed one is refused.
  assert.equal((await s.check(link.url, randomUUID())).body.pending, 3);
  assert.equal((await s.check(link.url, "not-a-cursor")).status, 404);

  // The same messages get_updates would return from the link's start.
  const updates = await s.x.mcp(s.credential, "get_updates", {
    serverId: s.server.id,
    participantId: s.ana,
    mode: "start",
    channelIds: [s.general],
    directChats: "own",
    startAt: "beginning",
  });
  // From the beginning, General also holds TalkTo's announcement of Ben's side channel.
  assert.equal(updates.data.messages.length, 4);
  assert.equal(updates.data.messages[0].notice?.channelId, s.side);
});

test("only direct messages, @mentions and TalkTo notices count as waking; other channel posts are held", async (t) => {
  const s = await setup(t);
  const link = (await s.mint(s.ana)).data.url;
  const counts = async (since) => {
    const { status, text, body } = await s.check(link, since);
    assert.equal(status, 200, text);
    return { pending: body.pending, urgent: body.urgent, waking: body.waking, cursor: body.cursor };
  };
  // A plain post in a watched channel is counted, but it does not wake.
  const plain = await s.send(s.ben, s.toChannel(s.general), "Status update for everyone");
  assert.deepEqual(await counts(), {
    pending: 1,
    urgent: 0,
    waking: 0,
    cursor: plain.data.item.id,
  });
  // Neither does a post in a channel the link does not watch, nor a chat between others.
  await s.send(s.ben, s.toChannel(s.side), "Side chatter");
  await s.send(s.ben, s.toAgent(s.cal), "Between Ben and Cal");
  assert.deepEqual((await counts()).waking, 0);

  // A direct message wakes.
  const direct = await s.send(s.cal, s.toAgent(s.ana), "Can you review my change?");
  assert.deepEqual(await counts(plain.data.item.id), {
    pending: 1,
    urgent: 0,
    waking: 1,
    cursor: direct.data.item.id,
  });
  // An @mention wakes, even from a channel the link does not watch.
  const mention = await s.send(s.ben, s.toChannel(s.side), "@Ana please look at this");
  assert.deepEqual(await counts(direct.data.item.id), {
    pending: 1,
    urgent: 0,
    waking: 1,
    cursor: mention.data.item.id,
  });
  // TalkTo's notice of a new channel, in watched General, wakes.
  await s.x.mcp(s.credential, "create_channel", {
    serverId: s.server.id,
    participantId: s.ben,
    name: "launch",
    requestKey: randomUUID(),
  });
  const notice = await counts(mention.data.item.id);
  assert.deepEqual([notice.pending, notice.waking], [1, 1]);
  // From the link's start: four incoming, three of them waking, the plain post held.
  assert.deepEqual(await counts(), { pending: 4, urgent: 0, waking: 3, cursor: notice.cursor });

  // A link that does not take direct chats wakes for neither direct messages nor mentions,
  // and a link without General hears no notices.
  const channelsOnly = (await s.mint(s.ben, { channelIds: [s.general], directChats: "none" })).data
    .url;
  const dmsOnly = (await s.mint(s.cal, { channelIds: [], directChats: "own" })).data.url;
  await s.send(s.ana, s.toAgent(s.ben), "Direct to Ben");
  await s.send(s.ana, s.toChannel(s.general), "@Ben @Cal in General");
  await s.x.mcp(s.credential, "create_channel", {
    serverId: s.server.id,
    participantId: s.ana,
    name: "later",
    requestKey: randomUUID(),
  });
  const ben = (await s.check(channelsOnly)).body;
  assert.deepEqual([ben.pending, ben.waking], [2, 1], "only the notice wakes Ben's channel link");
  const cal = (await s.check(dmsOnly)).body;
  assert.deepEqual([cal.pending, cal.waking], [1, 1], "the mention wakes Cal");
});

test("another participant's link says nothing about others, and links only answer for their own server", async (t) => {
  const s = await setup(t);
  const ana = (await s.mint(s.ana)).data.url;
  const ben = (await s.mint(s.ben, { channelIds: [], directChats: "own" })).data.url;
  await s.send(s.cal, s.toAgent(s.ana), "For Ana only", "urgent");
  await s.send(s.cal, s.toChannel(s.general), "General chatter");
  assert.deepEqual([(await s.check(ana)).body.pending, (await s.check(ana)).body.urgent], [2, 1]);
  // Ben selected only his own direct chats: Ana's urgent chat and General are invisible to him.
  const quiet = await s.check(ben);
  assert.deepEqual([quiet.body.pending, quiet.body.urgent, quiet.body.cursor], [0, 0, null]);

  const [, , , serverId, token] = new URL(ana).pathname.split("/");
  const [id, secret] = token.split(".");
  const flipped = `${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`;
  const bearer = (value) => ({ headers: { authorization: `Bearer ${value}` } });
  for (const [path, init] of [
    [`/v1/signals/${serverId}/${id}.${flipped}`],
    [`/v1/signals/${serverId}/${randomUUID()}.${secret}`],
    [`/v1/signals/${randomUUID()}/${id}.${secret}`],
    [`/v1/signals/${serverId}/${id}`],
    [`/v1/signals/${serverId}`],
    // The header form: a wrong secret, another link or server, a malformed or missing header.
    [`/v1/signals/${serverId}/${id}`, bearer(flipped)],
    [`/v1/signals/${serverId}/${randomUUID()}`, bearer(secret)],
    [`/v1/signals/${randomUUID()}/${id}`, bearer(secret)],
    [`/v1/signals/${serverId}/${id}`, { headers: { authorization: secret } }],
    [`/v1/signals/${serverId}/${id}`, { headers: { authorization: `Basic ${secret}` } }],
    [`/v1/signals/${serverId}`, bearer(secret)],
    // A secret in both the path and the header is refused, even when both are right.
    [`/v1/signals/${serverId}/${id}.${secret}`, bearer(secret)],
  ]) {
    const response = await s.x.raw(path, init);
    assert.equal(response.status, 404, path);
    const body = await response.json();
    assert.equal(body.error.code, "not_found");
    assert.equal(response.headers.get("www-authenticate"), null);
  }
  assert.equal((await s.x.raw(new URL(ana).pathname, { method: "POST" })).status, 405);
  // The link is no credential anywhere else.
  const mcp = await s.x.raw("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(mcp.status, 401);
  const http = await s.x.raw(`/v1/servers/${serverId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(http.status, 401);
});

test("rotation, revoke_signal, expiry, a new history lineage and grant revocation each end a link", async (t) => {
  const s = await setup(t);
  const first = (await s.mint(s.ana)).data;
  const second = (await s.mint(s.ana, { ttlSeconds: 600 })).data;
  assert.notEqual(first.signalId, second.signalId);
  assert.equal((await s.check(first.url)).status, 404);
  assert.equal((await s.check(second.url)).status, 200);
  const lifetime = Date.parse(second.expiresAt) - Date.now();
  assert.ok(lifetime > 500_000 && lifetime <= 600_000, String(lifetime));

  const revoked = await s.x.mcp(s.credential, "revoke_signal", {
    serverId: s.server.id,
    participantId: s.ana,
  });
  assert.equal(revoked.data.revoked, 1);
  assert.equal((await s.check(second.url)).status, 404);
  const again = await s.x.mcp(s.credential, "revoke_signal", {
    serverId: s.server.id,
    participantId: s.ana,
    signalId: second.signalId,
  });
  assert.equal(again.data.revoked, 0);

  const expiring = (await s.mint(s.ana)).data;
  await s.x.control(`signals?server=${s.server.id}`, "expire");
  const expired = await s.check(expiring.url);
  assert.equal(expired.status, 404);
  assert.match(expired.body.error.message, /create_signal/);

  const restored = (await s.mint(s.ana)).data;
  await s.x.control(`signals?server=${s.server.id}`, "new-generation");
  assert.equal((await s.check(restored.url)).status, 404);

  // Bob's link ends when the owner revokes Bob's access to the server.
  await s.x.control("member", s.x.member(s.account.organizationId));
  const root = `/v1/servers/${s.server.id}`;
  await s.x.call("user_alice", "PUT", `${root}/access/user_bob`);
  const bob = await s.x.mcpToken(s.account.organizationId, "user_bob");
  const dana = (
    await s.x.mcp(bob, "register_participant", {
      serverId: s.server.id,
      name: "Dana",
      agentType: "codex",
      requestKey: randomUUID(),
    })
  ).data.item.id;
  const link = (
    await s.x.mcp(bob, "create_signal", {
      serverId: s.server.id,
      participantId: dana,
      channelIds: [s.general],
      directChats: "own",
    })
  ).data.url;
  assert.equal((await s.check(link)).status, 200);
  await s.x.call("user_alice", "DELETE", `${root}/access/user_bob`);
  assert.equal((await s.check(link)).status, 404);
});

test("create_signal validates its selection like get_updates", async (t) => {
  const s = await setup(t);
  const unknown = await s.mint(randomUUID(), {}, true);
  assert.equal(unknown.error.code, "participant_not_found");
  const missing = await s.mint(s.ana, { channelIds: [randomUUID()] }, true);
  assert.equal(missing.error.code, "conversation_not_found");
  const empty = await s.mint(s.ana, { channelIds: [], directChats: "none" }, true);
  assert.equal(empty.error.code, "invalid_input");
  const short = await s.mint(s.ana, { ttlSeconds: 60 }, true);
  assert.equal(short.error.code, "invalid_input");
});

test("signal checks are measured and limited as the participant's own reads", async (t) => {
  const s = await setup(t, { participantReadsPerMinute: 4 });
  const link = (await s.mint(s.ana)).data.url;
  await s.x.control("read-events");
  for (let check = 0; check < 4; check++) assert.equal((await s.check(link)).status, 200);
  const limited = await s.check(link);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, "rate_limited");
  assert.equal(limited.body.error.scope, "participant");
  assert.equal(Number(limited.headers.get("retry-after")), limited.body.error.retryAfterSeconds);
  // The same bucket as the participant's get_updates calls.
  const poll = await s.x.mcp(
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
    true,
  );
  assert.equal(poll.error.code, "rate_limited");
  const events = (await (await s.x.control("read-events")).json()).events;
  const signals = events.filter((event) => event[5] === "signal");
  assert.equal(signals.length, 5);
  assert.deepEqual(signals[0].slice(2, 8), [
    s.server.id,
    "participant",
    s.ana,
    "signal",
    "signal",
    "allowed",
  ]);
  assert.equal(signals[4][7], "participant_limited");
});

/** The tag a deployment with this key puts in a link's secret: see `Signals.secrets`. */
const expectedTag = (key, serverId, signalId, secret) => {
  const bytes = Buffer.from(secret, "base64url");
  const nonce = bytes.subarray(0, 16).toString("base64url");
  return createHmac("sha256", Buffer.from(key, "base64url"))
    .update(`talkto-signal-v1:${serverId}:${signalId}:${nonce}`)
    .digest()
    .subarray(0, 16)
    .equals(bytes.subarray(16));
};
const parts = (url) => {
  const [, , , serverId, token] = new URL(url).pathname.split("/");
  const [id, secret] = token.split(".");
  return { serverId, id, secret };
};
const lookups = async (x) => (await (await x.control("server-lookups")).json()).names;

test("a check for an unknown server never reaches a server object, with or without a signal key", async (t) => {
  for (const signalKey of [false, true]) {
    const s = await setup(t, { signalKey });
    const link = (await s.mint(s.ana)).data.url;
    const { serverId, id, secret } = parts(link);
    await lookups(s.x);
    const strangers = [randomUUID(), randomUUID()];
    for (const [path, init] of [
      [`/v1/signals/${strangers[0]}/${id}.${secret}`],
      [
        `/v1/signals/${strangers[1]}/${randomUUID()}`,
        { headers: { authorization: `Bearer ${secret}` } },
      ],
    ]) {
      const response = await s.x.raw(path, init);
      assert.equal(response.status, 404, path);
      const body = await response.json();
      assert.equal(body.error.code, "not_found");
      assert.match(body.error.message, /create_signal/);
    }
    assert.deepEqual(await lookups(s.x), [], "no server object was looked up for unknown servers");
    // The real link still answers, in both forms.
    assert.equal((await s.check(link)).status, 200);
    assert.equal((await s.check(link, null, true)).status, 200);
    assert.deepEqual(await lookups(s.x), [serverId, serverId]);
    if (!signalKey) {
      // A server whose deletion was requested is unknown too.
      const other = await s.x.server(s.account.id, { name: "Other" });
      await s.x.db
        .prepare("UPDATE servers SET deletion_requested_at=? WHERE id=?")
        .bind(new Date().toISOString(), other.id)
        .run();
      await lookups(s.x);
      assert.equal((await s.x.raw(`/v1/signals/${other.id}/${id}.${secret}`)).status, 404);
      assert.deepEqual(await lookups(s.x), []);
    }
  }
});

test("with a signal key, links prove themselves in the Worker and older links keep working", async (t) => {
  const s = await setup(t, { signalKey: true });
  const minted = (await s.mint(s.ana)).data;
  const { serverId, id, secret } = parts(minted.url);
  assert.match(secret, /^[\w-]{43}$/, "the link format is unchanged");
  assert.ok(expectedTag(s.x.signalKey, serverId, id, secret), "the secret carries the key's tag");
  assert.ok(!expectedTag(s.x.signalKey, randomUUID(), id, secret), "the tag names its server");

  // A tagged link needs no D1 read: it answers while D1 is down.
  await s.send(s.cal, s.toAgent(s.ana), "Hello Ana");
  await s.x.control("database-down?value=true");
  const down = await s.check(minted.url);
  assert.equal(down.status, 200, down.text);
  assert.equal(down.body.pending, 1);
  // A forged secret for the real server cannot be told from an older link without D1, so the
  // server object decides, as before.
  const forged = `${secret.slice(0, 20)}${secret.slice(20).split("").reverse().join("")}`;
  assert.equal(
    (
      await s.x.raw(`/v1/signals/${serverId}/${id}`, {
        headers: { authorization: `Bearer ${forged}` },
      })
    ).status,
    404,
  );
  await s.x.control("database-down?value=false");

  // A link minted before the key (fully random secret) still answers, through the existence check.
  const legacy = await (await s.x.control(`signals?server=${serverId}`, "legacy")).json();
  assert.ok(!expectedTag(s.x.signalKey, serverId, id, legacy.secret));
  const old = `https://talkto.test/v1/signals/${serverId}/${id}.${legacy.secret}`;
  assert.equal((await s.check(old)).status, 200);
  assert.equal((await s.check(old, null, true)).status, 200);
  assert.equal((await s.check(minted.url)).status, 404, "the replaced secret no longer answers");
});

test("failed signal checks are limited per network and answer 429 until the period ends", async (t) => {
  const s = await setup(t, { signalKey: true, signalFailuresPerMinute: 3 });
  const link = (await s.mint(s.ana)).data.url;
  const { serverId, id, secret } = parts(link);
  const from = (address, path, init = {}) =>
    s.x.raw(path, { ...init, headers: { ...init.headers, "cf-connecting-ip": address } });
  const attacker = "203.0.113.7";
  const guesses = [
    `/v1/signals/${randomUUID()}/${randomUUID()}.${secret}`,
    `/v1/signals/${serverId}/${randomUUID()}.${secret}`,
    `/v1/signals/${serverId}`,
  ];
  for (const path of guesses) {
    const response = await from(attacker, path);
    assert.equal(response.status, 404, path);
    assert.equal((await response.json()).error.code, "not_found");
  }
  const limited = await from(attacker, guesses[0]);
  assert.equal(limited.status, 429);
  const body = await limited.json();
  assert.equal(body.error.code, "rate_limited");
  assert.equal(body.error.scope, "network");
  assert.equal(body.error.retryAfterSeconds, 60);
  assert.equal(limited.headers.get("retry-after"), "60");
  // The network is refused before anything else, valid links included; other networks are not.
  await lookups(s.x);
  const header = { headers: { authorization: `Bearer ${secret}` } };
  assert.equal((await from(attacker, `/v1/signals/${serverId}/${id}`, header)).status, 429);
  assert.deepEqual(await lookups(s.x), []);
  assert.equal((await from("198.51.100.4", `/v1/signals/${serverId}/${id}`, header)).status, 200);
  // An IPv6 network is one /64, whatever its last 64 bits.
  for (const suffix of ["1", "2", "3"])
    assert.equal((await from(`2001:db8:1:2::${suffix}`, guesses[0])).status, 404);
  assert.equal((await from("2001:db8:1:2:ffff::9", guesses[0])).status, 429);
  // A successful check is never counted.
  for (let check = 0; check < 5; check++)
    assert.equal((await from("192.0.2.1", `/v1/signals/${serverId}/${id}`, header)).status, 200);
});
