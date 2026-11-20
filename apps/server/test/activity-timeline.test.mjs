import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

test("sender disclosure lists every contributor with window counts, stable pages and current server access", async (t) => {
  const app = await start(t);
  const account = await app.account();
  const server = await app.server(account.id);
  const root = `/v1/servers/${server.id}`;
  const call = (path, status) => app.call("user_alice", "GET", root + path, undefined, status);
  const agents = [];
  for (let i = 0; i < 56; i++) {
    agents.push(
      (
        await app.call("user_alice", "POST", root + "/participants", {
          name: `sender-${i}`,
          agentType: i % 2 ? "claude-code" : "codex-desktop",
          requestKey: randomUUID(),
        })
      ).item,
    );
  }
  const general = (await call("/channels")).items[0];
  const end = Date.now() - 1000;
  const startTime = end - 3_600_000;
  const window = { start: new Date(startTime).toISOString(), end: new Date(end).toISOString() };
  const seed = async (messages) => {
    const response = await app.control("activity-seed", { serverId: server.id, messages });
    assert.equal(response.status, 200, await response.text());
  };
  const message = (agent, at) => ({
    participantId: agent.id,
    conversationId: general.id,
    at: new Date(at).toISOString(),
    body: "Sender disclosure fixture",
  });
  // Fifty-four active senders, one outside the window, one idle. Include both interval edges.
  await seed([
    message(agents[54], startTime),
    ...agents
      .slice(0, 54)
      .flatMap((agent, i) => Array.from({ length: i < 3 ? 3 : 1 }, () => message(agent, end))),
  ]);
  const chart = await call(`/activity?${new URLSearchParams({ range: "hour", at: window.end })}`);
  const first = await call(`/activity/senders?${new URLSearchParams(window)}`);
  assert.equal(chart.participantCount, 54);
  assert.equal(first.items.length, 50);
  assert.ok(first.nextCursor);
  assert.deepEqual(first.items.slice(0, 6), chart.senders);
  // Same-timestamp arrivals must not move a remaining sender between pages.
  const remaining = agents
    .slice(0, 54)
    .find((agent) => !first.items.some((s) => s.id === agent.id));
  await seed(Array.from({ length: 10 }, () => message(remaining, end)));
  const nextQuery = new URLSearchParams({ cursor: first.nextCursor });
  const second = await call(`/activity/senders?${nextQuery}`);
  assert.equal(second.items.length, 4);
  assert.equal(second.nextCursor, null);
  const all = [...first.items, ...second.items];
  const expected = agents.slice(0, 54).map((agent, i) => ({
    id: agent.id,
    name: agent.name,
    agentType: agent.agentType,
    messageCount: i < 3 ? 3 : 1,
  }));
  expected.sort((a, b) => b.messageCount - a.messageCount || a.id.localeCompare(b.id));
  assert.deepEqual(all, expected);
  assert.equal(
    all.reduce((sum, sender) => sum + sender.messageCount, 0),
    chart.messageCount,
  );
  assert.equal(new Set(all.map((sender) => sender.id)).size, 54);
  await seed([message(agents[54], end + 1)]);
  const refreshed = await call(`/activity/senders?${new URLSearchParams(window)}`);
  assert.equal(refreshed.items[0].id, remaining.id);
  assert.equal(refreshed.items[0].messageCount, 11);
  assert.equal(
    (await call(`/activity?${new URLSearchParams({ range: "hour", at: window.end })}`))
      .participantCount,
    54,
    "messages after the window stay excluded",
  );
  assert.ok(!JSON.stringify(first).includes("Sender disclosure fixture"));
  const empty = await call(
    `/activity/senders?${new URLSearchParams({ start: window.start, end: new Date(startTime + 1).toISOString() })}`,
  );
  assert.deepEqual(empty, { items: [], nextCursor: null });
  for (const query of [
    {},
    { start: window.start },
    { ...window, end: window.start },
    { ...window, start: window.end },
    { ...window, start: new Date(end - 604_800_001).toISOString() },
    { ...window, cursor: first.nextCursor },
    { cursor: "malformed" },
  ]) {
    await call(`/activity/senders?${new URLSearchParams(query)}`, 400);
  }
  const other = await app.server(account.id);
  await app.call(
    "user_alice",
    "GET",
    `/v1/servers/${other.id}/activity/senders?${nextQuery}`,
    undefined,
    400,
  );
  assert.equal((await app.raw(root + `/activity/senders?${nextQuery}`)).status, 401);
  await app.call("user_bob", "GET", root + `/activity/senders?${nextQuery}`, undefined, 404);
  await app.call("user_alice", "DELETE", root + "/access/user_alice");
  await call(`/activity/senders?${nextQuery}`, 404);
});

test("server timeline counts complete dated history, bounded windows and top senders behind current grants", async (t) => {
  const app = await start(t);
  const account = await app.account();
  const server = await app.server(account.id);
  const root = `/v1/servers/${server.id}`;
  const call = (method, path, value, status) =>
    app.call("user_alice", method, root + path, value, status);
  const empty = await call("GET", "/activity");
  assert.equal(empty.messageCount, 0);
  assert.equal(empty.participantCount, 0);
  assert.equal(empty.firstMessageAt, null);
  assert.equal(empty.buckets.length, 96);
  assert.ok(empty.buckets.every((b) => b.messageCount === 0));
  const agents = [];
  for (let i = 0; i < 8; i++)
    agents.push(
      (
        await call("POST", "/participants", {
          name: `timeline-${i}`,
          agentType: i % 2 ? "claude-code" : "codex",
          requestKey: randomUUID(),
        })
      ).item,
    );
  const general = (await call("GET", "/channels")).items[0];
  const direct = (
    await call("POST", "/direct-chats", { participantId: agents[0].id, recipientId: agents[1].id })
  ).item;
  const at = Date.now();
  const dated = [
    ...Array.from({ length: 3 }, () => at - 8 * 86_400_000),
    ...Array.from({ length: 7 }, () => at - 25 * 3_600_000),
    ...Array.from({ length: 12 }, () => at - 2 * 3_600_000),
    ...Array.from({ length: 63 }, (_, i) => at - 30 * 60_000 + i * 1000),
  ];
  const messages = dated.map((ms, i) => ({
    participantId: agents[i % agents.length].id,
    conversationId: i % 8 < 2 ? direct.id : general.id,
    at: new Date(ms).toISOString(),
    body: `Dated message ${i}`,
  }));
  const seeded = await app.control("activity-seed", { serverId: server.id, messages });
  assert.equal(seeded.status, 200, await seeded.text());
  for (const [range, expected, buckets] of [
    ["hour", 63, 60],
    ["day", 75, 96],
    ["week", 82, 168],
  ]) {
    const chart = await call("GET", `/activity?range=${range}`);
    assert.equal(chart.messageCount, expected);
    assert.equal(chart.participantCount, 8);
    assert.equal(chart.buckets.length, buckets);
    assert.equal(
      chart.buckets.reduce((sum, b) => sum + b.messageCount, 0),
      expected,
    );
    assert.equal(chart.senders.length, 6);
    assert.ok(
      chart.senders.every((s, i) => !i || s.messageCount <= chart.senders[i - 1].messageCount),
    );
    for (const bucket of chart.buckets) {
      const within = messages.filter((m) => m.at > bucket.start && m.at <= bucket.end);
      assert.equal(bucket.messageCount, within.length);
      assert.equal(bucket.participantCount, new Set(within.map((m) => m.participantId)).size);
    }
    assert.equal(chart.firstMessageAt, messages.find((m) => m.at > chart.windowStart).at);
    assert.equal(chart.lastMessageAt, messages.at(-1).at);
    assert.ok(!JSON.stringify(chart).includes("Dated message"));
  }
  const page = await call("GET", "/messages?limit=10&query=Dated");
  assert.equal(page.items.length, 10);
  assert.equal(
    (await call("GET", "/activity")).messageCount,
    75,
    "pagination and search do not truncate chart totals",
  );
  const payload = {
    participantId: agents[0].id,
    body: "Dated new arrival",
    requestKey: randomUUID(),
  };
  const arrival = (await call("POST", `/conversations/${general.id}/messages`, payload)).item;
  const retry = (await call("POST", `/conversations/${general.id}/messages`, payload)).item;
  assert.equal(arrival.id, retry.id);
  const accumulated = [...page.items];
  let next = page.nextCursor;
  for (const limit of [25, 50, 10]) {
    if (!next) break;
    const older = await call("GET", `/messages?${new URLSearchParams({ cursor: next, limit })}`);
    accumulated.push(...older.items);
    next = older.nextCursor;
  }
  assert.equal(next, null);
  assert.equal(accumulated.length, messages.length);
  assert.equal(new Set(accumulated.map((m) => m.id)).size, messages.length);
  assert.ok(accumulated.every((m) => m.id !== arrival.id));
  const live = await call(
    "GET",
    `/messages?${new URLSearchParams({ cursor: page.liveCursor, limit: 10 })}`,
  );
  assert.deepEqual(
    live.items.map((m) => m.id),
    [arrival.id],
  );
  assert.equal((await call("GET", "/activity")).messageCount, 76);
  await call("GET", "/activity?range=year", undefined, 400);
  assert.equal((await app.raw(root + "/activity")).status, 401);
  await app.call("user_bob", "GET", root + "/activity", undefined, 404);
  const other = await app.server(account.id);
  assert.equal(
    (await app.call("user_alice", "GET", `/v1/servers/${other.id}/activity`)).messageCount,
    0,
  );
  await call("DELETE", "/access/user_alice");
  await call("GET", "/activity", undefined, 404);
});

test("timeline selections match bar boundaries and retain time, search and conversation scope through cursors", async (t) => {
  const app = await start(t);
  const account = await app.account();
  const server = await app.server(account.id);
  const root = `/v1/servers/${server.id}`;
  const call = (method, path, value, status) =>
    app.call("user_alice", method, root + path, value, status);
  const agent = (
    await call("POST", "/participants", {
      name: "range-reader",
      agentType: "codex",
      requestKey: randomUUID(),
    })
  ).item;
  const general = (await call("GET", "/channels")).items[0];
  // A direct chat, not a new channel: a channel's announcement in General would be newer than the
  // dated history seeded below, and messages can only be appended in time order.
  const peer = (
    await call("POST", "/participants", {
      name: "range-peer",
      agentType: "codex",
      requestKey: randomUUID(),
    })
  ).item;
  const channel = (
    await call("POST", "/direct-chats", { participantId: agent.id, recipientId: peer.id })
  ).item;
  const at = Date.now() - 10_000;
  const stamp = (ms) => new Date(ms).toISOString();
  const startTime = at - 45 * 60_000;
  const endTime = at - 15 * 60_000;
  const timestamps = [
    startTime,
    startTime + 1,
    ...Array.from({ length: 120 }, (_, i) => startTime + 1000 + i * 1000),
    endTime,
    endTime + 1,
    at,
  ];
  const messages = timestamps.map((ms, i) => ({
    participantId: agent.id,
    conversationId: i % 3 ? general.id : channel.id,
    at: stamp(ms),
    body: `${i % 2 ? "Focus" : "Other"} message ${i}`,
  }));
  const seeded = await app.control("activity-seed", { serverId: server.id, messages });
  assert.equal(seeded.status, 200, await seeded.text());
  const timelineQuery = new URLSearchParams({ range: "day", at: stamp(at) });
  const chart = await call("GET", `/activity?${timelineQuery}`);
  assert.equal(chart.windowEnd, stamp(at));
  assert.equal(chart.buckets.length, 96);
  const selection = { start: stamp(startTime), end: stamp(endTime) };
  const expected = messages.filter((m) => m.at > selection.start && m.at <= selection.end);
  const buckets = chart.buckets.filter((b) => b.start >= selection.start && b.end <= selection.end);
  assert.equal(buckets.length, 2);
  assert.equal(
    buckets.reduce((sum, b) => sum + b.messageCount, 0),
    expected.length,
  );
  for (const extra of [{}, { query: "Focus" }, { query: "Focus", conversationId: channel.id }]) {
    const page = await call(
      "GET",
      `/messages?${new URLSearchParams({ ...selection, ...extra, limit: 10 })}`,
    );
    const arrival = (
      await call("POST", `/conversations/${general.id}/messages`, {
        participantId: agent.id,
        body: "Focus later arrival",
        requestKey: randomUUID(),
      })
    ).item;
    const found = [...page.items];
    let cursor = page.nextCursor;
    while (cursor) {
      const next = await call("GET", `/messages?${new URLSearchParams({ cursor, limit: 25 })}`);
      found.push(...next.items);
      cursor = next.nextCursor;
    }
    const wanted = expected
      .filter(
        (m) =>
          (!extra.query || m.body.startsWith(extra.query)) &&
          (!extra.conversationId || m.conversationId === extra.conversationId),
      )
      .reverse();
    assert.deepEqual(
      found.map((m) => [m.body, m.createdAt]),
      wanted.map((m) => [m.body, m.at]),
    );
    assert.equal(new Set(found.map((m) => m.id)).size, wanted.length);
    assert.ok(found.every((m) => m.id !== arrival.id));
    const newer = await call(
      "GET",
      `/messages?${new URLSearchParams({ cursor: page.liveCursor })}`,
    );
    assert.deepEqual(newer.items, [], "forward delivery retains the closed time window");
    if (page.nextCursor) {
      await call(
        "GET",
        `/messages?${new URLSearchParams({ cursor: page.nextCursor, ...selection })}`,
        undefined,
        400,
      );
      const other = await app.server(account.id);
      await app.call(
        "user_alice",
        "GET",
        `/v1/servers/${other.id}/messages?${new URLSearchParams({ cursor: page.nextCursor })}`,
        undefined,
        400,
      );
    }
    const invalid = JSON.parse(Buffer.from(page.liveCursor, "base64url").toString());
    invalid.beforeTime = invalid.afterTime;
    await call(
      "GET",
      `/messages?${new URLSearchParams({ cursor: Buffer.from(JSON.stringify(invalid)).toString("base64url") })}`,
      undefined,
      400,
    );
  }
  assert.deepEqual(
    await call("GET", `/activity?${timelineQuery}`),
    chart,
    "an anchored graph is unchanged by arrivals after its end",
  );
  const empty = await call(
    "GET",
    `/messages?${new URLSearchParams({ start: stamp(at - 86_400_000), end: stamp(startTime - 1) })}`,
  );
  assert.deepEqual(empty.items, []);
  assert.equal(empty.nextCursor, null);
  for (const invalid of [
    { start: selection.start },
    { end: selection.end },
    { start: selection.end, end: selection.start },
    { start: selection.start, end: selection.start },
    { start: "not-a-date", end: selection.end },
  ]) {
    await call("GET", `/messages?${new URLSearchParams(invalid)}`, undefined, 400);
  }
  await call("GET", "/activity?at=not-a-date", undefined, 400);
  await app.call(
    "user_bob",
    "GET",
    root + `/messages?${new URLSearchParams(selection)}`,
    undefined,
    404,
  );
  await call("DELETE", "/access/user_alice");
  await call("GET", `/messages?${new URLSearchParams(selection)}`, undefined, 404);
  await call("GET", `/activity?${timelineQuery}`, undefined, 404);
});
