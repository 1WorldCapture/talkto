import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

/*
  The task board (docs/swarm-server-spec.md). Every test runs on the real Worker, D1 and server
  object. Leases are made to run out through `/__control/board` instead of waiting minutes;
  everything else goes through the agents' tools and the dashboard's routes. Numbers in test names
  refer to section 11 of the spec.
*/

/** A person signed in on the TalkTo website: session cookie and the website's Origin. */
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

/**
 * A swarm server with a lead and workers registered over Alice's MCP connection. `swarm: false`
 * creates a plain server instead.
 */
const setup = async (t, options = {}, { swarm = true, workers = ["Wes", "Wyn"] } = {}) => {
  const x = await start(t, { board: true, manualAlarms: true, ...options });
  const account = await x.account();
  const server = await x.server(account.id, swarm ? { board: true } : {});
  const root = `/v1/servers/${server.id}`;
  const credential = await x.mcpToken(account.organizationId);
  const call = (name, args, error = false) =>
    x.mcp(credential, name, { serverId: server.id, ...args }, error);
  const register = async (name) =>
    (await call("register_participant", { name, agentType: "codex", requestKey: randomUUID() }))
      .data;
  const first = await register("Lead");
  const lead = first.item.id;
  const ids = {};
  for (const name of workers) ids[name] = (await register(name)).item.id;
  const create = (tasks, { by = lead, requestKey = randomUUID(), error = false } = {}) =>
    call("create_tasks", { participantId: by, requestKey, tasks }, error);
  const claim = (participantId, selector = { next: {} }, options = {}) =>
    call(
      "claim_task",
      { participantId, requestKey: options.requestKey ?? randomUUID(), ...selector },
      options.error ?? false,
    );
  const update = (participantId, claimed, action, options = {}) =>
    call(
      "update_task",
      {
        participantId,
        requestKey: options.requestKey ?? randomUUID(),
        taskId: claimed.task.id,
        leaseToken: claimed.lease.token,
        epoch: claimed.lease.epoch,
        ...action,
      },
      options.error ?? false,
    );
  const read = (participantId, input, error = false) =>
    call("read_tasks", { participantId, ...input }, error);
  const task = async (number) => (await read(lead, { mode: "task", task: { number } })).data;
  const updates = (participantId, input) => call("get_updates", { participantId, ...input });
  const control = async (action, number, participantId) => {
    const body = { action };
    if (number !== undefined) body.number = number;
    if (participantId !== undefined) body.participantId = participantId;
    const response = await x.control(`board?server=${server.id}`, body);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const context = async (participantId = lead) =>
    (await call("get_context", { participant: { id: participantId } })).data;
  return {
    x,
    account,
    server,
    root,
    credential,
    call,
    register,
    lead,
    general: first.generalConversationId,
    ids,
    create,
    claim,
    update,
    read,
    task,
    updates,
    control,
    context,
  };
};
const brief = (title, extra = {}) => ({ title, brief: `Do this: ${title}.`, ...extra });

test("off by default: no task tools are listed and the routes answer board_off", async (t) => {
  const x = await start(t);
  const account = await x.account();
  const server = await x.server(account.id, { board: true });
  assert.equal(server.board, undefined, "a deployment without boards creates a plain server");
  const credential = await x.mcpToken(account.organizationId);
  const listed = await x.raw(
    "/mcp",
    (await import("./mcp-wire.mjs")).rpc("tools/list", {}, credential),
  );
  const names = (await listed.json()).result.tools.map((tool) => tool.name);
  for (const tool of ["create_tasks", "claim_task", "update_task", "read_tasks"])
    assert.ok(!names.includes(tool), tool);
  const lead = (
    await x.mcp(credential, "register_participant", {
      serverId: server.id,
      name: "Lead",
      agentType: "codex",
      requestKey: randomUUID(),
    })
  ).data.item.id;
  const refused = await x.call(
    "user_alice",
    "GET",
    `/v1/servers/${server.id}/tasks?participantId=${lead}`,
    undefined,
    409,
  );
  assert.equal(refused.error.code, "board_off");
  const context = await x.mcp(credential, "get_context", { serverId: server.id });
  assert.equal(context.data.board, undefined);
});

test("1: board tables are added once, keep schema version 11, and an older server upgrades", async (t) => {
  const s = await setup(t);
  const first = await s.control("inspect");
  assert.equal(first.version, 11);
  assert.deepEqual(first.tables, [
    "board_settings",
    "task_batches",
    "task_event_recipients",
    "task_events",
    "task_finishers",
    "task_holders",
    "task_interests",
    "task_labels",
    "task_message_recipients",
    "task_messages",
    "task_needs",
    "task_requests",
    "task_result_files",
    "task_results",
    "tasks",
  ]);
  // A restart runs board.sql again: nothing changes.
  await s.x.control(`resources?server=${s.server.id}`, "restart");
  assert.deepEqual(await s.context().then((c) => c.board.enabled), true);
  const again = await s.control("inspect");
  assert.deepEqual([again.version, again.tables], [first.version, first.tables]);
  // A server from before the board has none of these tables: it opens and gains them, boardless.
  await s.control("drop");
  await s.x.control(`resources?server=${s.server.id}`, "restart");
  const upgraded = await s.context();
  assert.equal(upgraded.board, undefined);
  assert.deepEqual((await s.control("inspect")).tables, first.tables);
  const off = await s.create([brief("Too early")], { error: true });
  assert.equal(off.error.code, "board_off");
});

test("2: messages, renames and task events share one strictly increasing sequence", async (t) => {
  const s = await setup(t);
  const reader = s.ids.Wyn;
  const started = await s.updates(reader, {
    channelIds: [s.general],
    directChats: "own",
    mode: "start",
    startAt: "beginning",
    tasks: "all",
  });
  // On a fresh swarm server the first events come before any message the lead sends.
  const created = await s.create([brief("First"), brief("Second")]);
  const sent = await s.call("send_message", {
    participantId: s.lead,
    requestKey: randomUUID(),
    target: { kind: "conversation", conversationId: s.general },
    body: "After the events",
  });
  await s.call("rename_participant", {
    participantId: s.ids.Wes,
    name: "Wesley",
    requestKey: randomUUID(),
  });
  await s.create([brief("Third")]);
  const board = (await s.context()).board.channelId;
  const page = await s.updates(reader, {
    channelIds: [s.general, board],
    directChats: "own",
    mode: "start",
    startAt: "beginning",
    tasks: "all",
  });
  const items = [
    ...page.data.messages.map((m) => ({ kind: "message", sequence: m.sequence, id: m.id })),
    ...(page.data.renames ?? []).map((r) => ({ kind: "rename", sequence: r.sequence })),
    ...(page.data.tasks ?? []).map((e) => ({ kind: e.kind, sequence: e.sequence })),
  ].toSorted((a, b) => a.sequence - b.sequence);
  const sequences = items.map((item) => item.sequence);
  assert.equal(new Set(sequences).size, sequences.length, "no two items share a number");
  assert.ok(items.some((item) => item.kind === "rename"));
  assert.ok(items.filter((item) => item.kind === "created").length === 3);
  const lastEvent = Math.max(
    ...page.data.tasks.filter((e) => e.number <= 2).map((e) => e.sequence),
  );
  const message = page.data.messages.find((m) => m.id === sent.data.item.id);
  assert.ok(message.sequence > lastEvent, "a message sent after an event is numbered after it");
  // Brief messages carry their thread; ordinary messages do not.
  const briefMessage = page.data.messages.find(
    (m) => m.id === created.data.tasks[0].briefMessageId,
  );
  assert.deepEqual(briefMessage.task, { id: created.data.tasks[0].id, number: 1, kind: "brief" });
  assert.equal(message.task, undefined);
  assert.ok(started.data.checkpoint);
});

test("3: the transition trigger refuses every move the state machine does not allow", async (t) => {
  const s = await setup(t);
  await s.create([brief("Probe")]);
  const states = ["waiting", "ready", "claimed", "blocked", "completed", "failed", "canceled"];
  const allowed = new Set([
    "waiting->ready",
    "waiting->canceled",
    "ready->claimed",
    "ready->canceled",
    "claimed->ready",
    "claimed->blocked",
    "claimed->completed",
    "claimed->failed",
    "claimed->canceled",
    "blocked->ready",
    "blocked->canceled",
    // Reopening a failed task (a task canceled by a person stays canceled).
    "failed->ready",
    "failed->waiting",
  ]);
  const expected = states
    .flatMap((from) => states.map((to) => `${from}->${to}`))
    .filter((move) => !allowed.has(move) && move.split("->")[0] !== move.split("->")[1]);
  const { refused } = await s.control("transitions", 1);
  assert.deepEqual(refused.toSorted(), expected.toSorted());
  assert.equal(refused.length, 29);
  // Every probe rolled back.
  assert.equal((await s.task(1)).task.state, "ready");
});

test("4: history size counts tasks and events; pruning removes finished tasks and keeps open briefs", async (t) => {
  const s = await setup(t);
  const empty = await s.control("inspect");
  const created = await s.create([brief("Kept"), brief("Done")]);
  const grown = await s.control("inspect");
  // Two task rows (512 bytes each plus titles), two events and two briefs at least.
  assert.ok(grown.bytes - empty.bytes >= 2 * 512 + 2 * 128, `${empty.bytes} -> ${grown.bytes}`);
  const claimed = await s.claim(s.ids.Wes, { taskId: created.data.tasks[1].id });
  await s.update(s.ids.Wes, claimed.data, { action: "progress", note: "Halfway." });
  await s.update(s.ids.Wes, claimed.data, {
    action: "complete",
    summary: "Done",
    details: "Everything is done.",
  });
  const pruned = await s.control("prune");
  assert.equal(pruned.tasks, 1);
  const after = await s.control("inspect");
  assert.equal(after.rows.tasks, 1);
  assert.ok(after.bytes < grown.bytes + 4096);
  // The open task's brief stays readable; the finished task is gone with its rows.
  const kept = await s.task(1);
  assert.equal(kept.thread.items[0].id, created.data.tasks[0].briefMessageId);
  const gone = await s.read(s.lead, { mode: "task", task: { number: 2 } }, true);
  assert.equal(gone.error.code, "task_not_found");
  // A second pass has nothing left to remove and fails on no foreign key.
  assert.equal((await s.control("prune")).tasks, 0);
});

test("4: pruning a finished swarm keeps the updates head, so a saved checkpoint still polls", async (t) => {
  const s = await setup(t);
  const reader = s.ids.Wyn;
  const created = await s.create([brief("Only")]);
  const claimed = await s.claim(s.ids.Wes, { taskId: created.data.tasks[0].id });
  await s.update(s.ids.Wes, claimed.data, { action: "complete", summary: "Done" });
  let page = await s.updates(reader, {
    channelIds: [s.general],
    directChats: "own",
    mode: "start",
    startAt: "beginning",
    tasks: "all",
  });
  const events = [...(page.data.tasks ?? [])];
  while (page.data.nextCursor !== null) {
    page = await s.updates(reader, { mode: "continue", cursor: page.data.nextCursor });
    events.push(...(page.data.tasks ?? []));
  }
  // The checkpoint ends after the last event, which comes after every message.
  const last = events.at(-1);
  assert.equal(last.kind, "batch_finished");
  const checkpoint = page.data.checkpoint;
  // Cutoff = now, as storage-cap shedding prunes: every event of the finished task goes.
  assert.equal((await s.control("prune")).tasks, 1);
  const inspected = await s.control("inspect");
  assert.equal(inspected.rows.events, 0);
  assert.ok(inspected.retention.seq >= last.sequence, JSON.stringify(inspected.retention));
  const quiet = await s.updates(reader, { mode: "poll", checkpoint });
  assert.deepEqual([quiet.data.messages.length, quiet.data.tasks], [0, undefined]);
  // The next message is numbered after the pruned events and reaches the same checkpoint.
  await s.call("send_message", {
    participantId: s.lead,
    requestKey: randomUUID(),
    target: { kind: "conversation", conversationId: s.general },
    body: "After the prune",
  });
  const next = await s.updates(reader, { mode: "poll", checkpoint });
  assert.deepEqual(
    next.data.messages.map((message) => message.body),
    ["After the prune"],
  );
  assert.ok(next.data.messages[0].sequence > last.sequence);
});

test("5: each move allows its actor and refuses the others with the stated error", async (t) => {
  const s = await setup(t);
  const created = await s.create([
    brief("Base", { ref: "base" }),
    brief("Later", { needs: [{ ref: "base" }] }),
  ]);
  const [base, later] = created.data.tasks;
  assert.deepEqual([base.state, later.state], ["ready", "waiting"]);
  const waiting = await s.claim(s.ids.Wes, { taskId: later.id }, { error: true });
  assert.deepEqual(
    [waiting.error.code, waiting.error.reason],
    ["task_not_claimable", "waiting_on_needs"],
  );
  const claimed = await s.claim(s.ids.Wes, { number: 1 });
  assert.equal(claimed.data.task.state, "claimed");
  const held = await s.claim(s.ids.Wyn, { taskId: base.id }, { error: true });
  assert.equal(held.error.reason, "held_by_other");
  assert.equal(held.error.holderId, s.ids.Wes);
  assert.ok(held.error.expiresAt);
  // Only the holder writes: another agent with a copied lease gets claim_lost.
  const intruder = await s.update(s.ids.Wyn, claimed.data, { action: "progress" }, { error: true });
  assert.equal(intruder.error.code, "claim_lost");
  const released = await s.update(s.ids.Wes, claimed.data, { action: "release", note: "Later." });
  assert.equal(released.data.task.state, "ready");
  const again = await s.claim(s.ids.Wyn, { taskId: base.id });
  assert.equal(again.data.lease.epoch, 2);
  const failed = await s.update(s.ids.Wyn, again.data, { action: "fail", summary: "Broken" });
  assert.equal(failed.data.task.state, "failed");
  assert.deepEqual(
    failed.data.canceled.map((item) => [item.number, item.state]),
    [[2, "canceled"]],
  );
  const finished = await s.claim(s.ids.Wes, { taskId: base.id }, { error: true });
  assert.deepEqual([finished.error.code, finished.error.state], ["task_state_conflict", "failed"]);
  const twice = await s.update(
    s.ids.Wyn,
    again.data,
    { action: "complete", summary: "Late" },
    {
      error: true,
    },
  );
  assert.deepEqual([twice.error.code, twice.error.state], ["claim_lost", "failed"]);
});

test("6: twenty concurrent claims for next on five ready tasks have five winners", async (t) => {
  const workers = Array.from({ length: 20 }, (_, i) => `Worker${i}`);
  const s = await setup(t, {}, { workers });
  await s.create(Array.from({ length: 5 }, (_, i) => brief(`Task ${i}`)));
  const results = await Promise.all(workers.map((name) => s.claim(s.ids[name])));
  const winners = results.filter((result) => result.data.claimed);
  assert.equal(winners.length, 5);
  assert.equal(results.filter((result) => !result.data.claimed).length, 15);
  assert.equal(new Set(winners.map((result) => result.data.task.id)).size, 5);
  const listed = await s.read(s.lead, { mode: "list", states: ["claimed"] });
  assert.equal(listed.data.items.length, 5);
  assert.equal(new Set(listed.data.items.map((item) => item.claim.holderId)).size, 5);
});

test("7: a write with an old lease after expiry, re-claim, release or cancel changes nothing", async (t) => {
  const s = await setup(t);
  const created = await s.create([brief("Fenced"), brief("Released"), brief("Canceled")]);
  const first = await s.claim(s.ids.Wes, { number: 1 });
  await s.control("expire", 1);
  const second = await s.claim(s.ids.Wyn, { number: 1 });
  assert.equal(second.data.lease.epoch, 2);
  const before = await s.task(1);
  const stale = await s.update(
    s.ids.Wes,
    first.data,
    { action: "complete", summary: "Mine", details: "A result nobody asked for." },
    { error: true },
  );
  assert.equal(stale.error.code, "claim_lost");
  assert.equal(stale.error.holderId, s.ids.Wyn);
  assert.equal(stale.error.epoch, 2);
  const after = await s.task(1);
  assert.deepEqual(
    [after.thread.items.length, after.events.length, after.task.revision],
    [before.thread.items.length, before.events.length, before.task.revision],
  );
  // A token from a released claim.
  const released = await s.claim(s.ids.Wes, { number: 2 });
  await s.update(s.ids.Wes, released.data, { action: "release" });
  const late = await s.update(s.ids.Wes, released.data, { action: "progress" }, { error: true });
  assert.deepEqual([late.error.code, late.error.state], ["claim_lost", "ready"]);
  // A token from a task a person canceled.
  const canceled = await s.claim(s.ids.Wes, { number: 3 });
  const dashboard = await website(s.x);
  const answer = await dashboard(
    "POST",
    `${s.root}/people/me/tasks/${created.data.tasks[2].id}/cancel`,
    {
      expectedRevision: canceled.data.task.revision,
      requestKey: randomUUID(),
      reason: "Not needed.",
    },
  );
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  const gone = await s.update(s.ids.Wes, canceled.data, { action: "progress" }, { error: true });
  assert.deepEqual([gone.error.code, gone.error.state], ["claim_lost", "canceled"]);
});

test("8: a write after the lease ends gets claim_lost before the alarm runs", async (t) => {
  const s = await setup(t);
  await s.create([brief("Lapsing")]);
  const claimed = await s.claim(s.ids.Wes);
  await s.control("lapse");
  const late = await s.update(s.ids.Wes, claimed.data, { action: "progress" }, { error: true });
  assert.equal(late.error.code, "claim_lost");
  const task = await s.task(1);
  assert.deepEqual([task.task.state, task.task.attempts], ["ready", 1]);
  assert.deepEqual(
    task.events.slice(-2).map((event) => [event.kind, event.actor.kind]),
    [
      ["expired", "system"],
      ["ready", "system"],
    ],
  );
});

test("9: the alarm returns an expired task to ready and stays set for the next lease", async (t) => {
  const s = await setup(t);
  await s.create([brief("Alarmed")]);
  const claimed = await s.claim(s.ids.Wes, { next: {} });
  const leaseEnd = Date.parse(claimed.data.lease.expiresAt);
  assert.equal(claimed.data.lease.leaseSeconds, 300);
  // Other work runs the server's end-of-request bookkeeping; the lease keeps the alarm set.
  await s.call("send_message", {
    participantId: s.lead,
    requestKey: randomUUID(),
    target: { kind: "conversation", conversationId: s.general },
    body: "Status?",
  });
  const armed = await s.control("inspect");
  assert.ok(armed.alarm !== null && armed.alarm <= leaseEnd, JSON.stringify(armed));
  const expired = await s.control("expire");
  assert.deepEqual(
    expired.leases.map((lease) => [lease.state, lease.attempts]),
    [["ready", 1]],
  );
  const short = await s.claim(s.ids.Wyn, { next: {}, leaseSeconds: 60 });
  assert.equal(short.data.lease.leaseSeconds, 60);
  const rearmed = await s.control("inspect");
  assert.ok(rearmed.alarm !== null && rearmed.alarm <= Date.parse(short.data.lease.expiresAt));
});

test("10: three expiries fail the task with attempts_exhausted and tell the owner", async (t) => {
  const s = await setup(t);
  const owner = await s.updates(s.lead, {
    channelIds: [s.general],
    directChats: "own",
    mode: "start",
    startAt: "now",
  });
  await s.create([brief("Doomed")]);
  for (let attempt = 0; attempt < 3; attempt++) {
    await s.claim(s.ids.Wes);
    await s.control("expire");
  }
  const task = (await s.task(1)).task;
  assert.equal(task.state, "failed");
  assert.equal(task.attempts, 3);
  assert.equal(task.outcome.reason, "attempts_exhausted");
  const page = await s.updates(s.lead, { mode: "poll", checkpoint: owner.data.checkpoint });
  const failed = page.data.tasks.find((event) => event.kind === "failed");
  assert.equal(failed.reason, "attempts_exhausted");
  assert.equal(failed.actor.kind, "system");
  assert.ok(page.data.tasks.some((event) => event.kind === "batch_finished"));
});

test("11: claiming a task you hold recovers its lease; replaying a lost claim gets claim_lost", async (t) => {
  const s = await setup(t);
  await s.create([brief("Recovered")]);
  const key = randomUUID();
  const claimed = await s.claim(s.ids.Wes, { next: {} }, { requestKey: key });
  assert.equal(claimed.data.recovered, false);
  const replay = await s.claim(s.ids.Wes, { next: {} }, { requestKey: key });
  assert.deepEqual(
    [replay.data.lease.token, replay.data.lease.epoch],
    [claimed.data.lease.token, claimed.data.lease.epoch],
  );
  const recovered = await s.claim(s.ids.Wes, { taskId: claimed.data.task.id });
  assert.equal(recovered.data.recovered, true);
  assert.deepEqual(
    [recovered.data.lease.token, recovered.data.lease.epoch],
    [claimed.data.lease.token, claimed.data.lease.epoch],
  );
  assert.ok(Date.parse(recovered.data.lease.expiresAt) >= Date.parse(claimed.data.lease.expiresAt));
  // get_context lists what you hold, so a fresh context can claim it again.
  const context = await s.context(s.ids.Wes);
  assert.deepEqual(
    context.board.yours.map((item) => [item.number, item.holderId]),
    [[1, s.ids.Wes]],
  );
  await s.control("expire");
  const lost = await s.claim(s.ids.Wes, { next: {} }, { requestKey: key, error: true });
  assert.equal(lost.error.code, "claim_lost");
});

test("11: a lapsed lease is not held, even when more ran out than one transaction expires", async (t) => {
  const s = await setup(t);
  for (let call = 0; call < 17; call++)
    await s.create(
      Array.from({ length: 25 }, (_, i) => brief(`Task ${call}-${i}`, { maxAttempts: 10 })),
    );
  // Wes holds the newest task; Wyn holds the other 424, and every lease runs out at once.
  const mine = await s.claim(s.ids.Wes, { number: 425 });
  await s.control("seize", undefined, s.ids.Wyn);
  await s.control("lapse");
  // Lazy expiry reaches the oldest 400 (200 in its own transaction, 200 in the claim's);
  // claiming the task again does not revive its lapsed lease.
  const again = await s.claim(s.ids.Wes, { taskId: mine.data.task.id });
  assert.deepEqual(
    [again.data.recovered, again.data.lease.epoch, again.data.task.attempts],
    [false, 2, 1],
  );
  assert.notEqual(again.data.lease.token, mine.data.lease.token);
  // Lapsed leases do not count toward the holding cap.
  await s.control("seize", undefined, s.ids.Wyn);
  const held = (await s.control("inspect")).leases.filter(
    (lease) => lease.state === "claimed" && lease.expiresAt < Date.now() && lease.number !== 425,
  );
  assert.ok(held.length > 400 + 8, `${held.length} lapsed`);
  const next = await s.claim(s.ids.Wyn);
  assert.equal(next.data.claimed, true);
  // Nor does a lapsed lease make its task held by another agent.
  await s.control("seize", undefined, s.ids.Wyn);
  const lapsed = (await s.control("inspect")).leases
    .filter((lease) => lease.state === "claimed" && lease.expiresAt < Date.now())
    .toSorted((a, b) => a.expiresAt - b.expiresAt || a.number - b.number);
  assert.ok(lapsed.length > 400, `${lapsed.length} lapsed`);
  const taken = await s.claim(s.ids.Wes, { number: lapsed.at(-1).number });
  assert.deepEqual([taken.data.claimed, taken.data.recovered], [true, false]);
});

test("11: replayed renewals renew, and an empty claim's key claims once work is ready", async (t) => {
  const s = await setup(t);
  const key = randomUUID();
  const empty = await s.claim(s.ids.Wes, { next: {} }, { requestKey: key });
  assert.deepEqual([empty.data.claimed, empty.data.why], [false, "none_ready"]);
  await s.create([brief("Later")]);
  const claimed = await s.claim(s.ids.Wes, { next: {} }, { requestKey: key });
  assert.equal(claimed.data.claimed, true, "the same key claims the new task");
  // One heartbeat key, used again and again, keeps renewing.
  const heartbeat = randomUUID();
  const first = await s.update(
    s.ids.Wes,
    claimed.data,
    { action: "progress" },
    { requestKey: heartbeat },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await s.update(
    s.ids.Wes,
    claimed.data,
    { action: "progress" },
    { requestKey: heartbeat },
  );
  assert.equal(second.data.changed, true);
  assert.ok(Date.parse(second.data.lease.expiresAt) > Date.parse(first.data.lease.expiresAt));
  // A replayed note is not posted twice, but it renews the lease too.
  const noteKey = randomUUID();
  const noted = await s.update(
    s.ids.Wes,
    claimed.data,
    { action: "progress", note: "Halfway." },
    { requestKey: noteKey },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const replayed = await s.update(
    s.ids.Wes,
    claimed.data,
    { action: "progress", note: "Halfway." },
    { requestKey: noteKey },
  );
  assert.equal(replayed.data.changed, false);
  assert.ok(Date.parse(replayed.data.lease.expiresAt) > Date.parse(noted.data.lease.expiresAt));
  const notes = (await s.task(1)).thread.items.filter((item) => item.body === "Halfway.");
  assert.equal(notes.length, 1);
  // A wrong token with the right epoch says so, not "epoch 1 now, not 1".
  const wrong = await s.update(
    s.ids.Wes,
    { ...claimed.data, lease: { ...claimed.data.lease, token: "x".repeat(22) } },
    { action: "progress" },
    { error: true },
  );
  assert.equal(wrong.error.code, "claim_lost");
  assert.match(wrong.error.message, /token .* does not match your claim \(epoch 1\)/);
});

test("12: needs refuse cycles and unusable tasks, ready dependents and cascade failures", async (t) => {
  const s = await setup(t);
  const cycle = await s.create(
    [
      brief("A", { ref: "a", needs: [{ ref: "b" }] }),
      brief("B", { ref: "b", needs: [{ ref: "a" }] }),
      brief("C", { ref: "c", needs: [{ ref: "a" }] }),
    ],
    { error: true },
  );
  assert.equal(cycle.error.code, "task_cycle");
  assert.deepEqual(cycle.error.refs, ["a", "b"]);
  const self = await s.create([brief("Self", { ref: "s", needs: [{ ref: "s" }] })], {
    error: true,
  });
  assert.deepEqual([self.error.code, self.error.refs], ["task_cycle", ["s"]]);
  const unknown = await s.create([brief("Orphan", { needs: [{ taskId: randomUUID() }] })], {
    error: true,
  });
  assert.equal(unknown.error.code, "need_unavailable");
  // Completion readies every dependent at once.
  const tree = await s.create([
    brief("Root", { ref: "root" }),
    brief("Left", { needs: [{ ref: "root" }] }),
    brief("Right", { needs: [{ ref: "root" }] }),
  ]);
  const root = await s.claim(s.ids.Wes, { taskId: tree.data.tasks[0].id });
  const done = await s.update(s.ids.Wes, root.data, { action: "complete", summary: "Rooted" });
  assert.deepEqual(
    done.data.unlocked.map((item) => [item.number, item.state]),
    [
      [2, "ready"],
      [3, "ready"],
    ],
  );
  // Failure cancels three levels below it.
  const chain = await s.create([
    brief("One", { ref: "one" }),
    brief("Two", { ref: "two", needs: [{ ref: "one" }] }),
    brief("Three", { ref: "three", needs: [{ ref: "two" }] }),
    brief("Four", { needs: [{ ref: "three" }] }),
  ]);
  const one = await s.claim(s.ids.Wes, { taskId: chain.data.tasks[0].id });
  const failed = await s.update(s.ids.Wes, one.data, { action: "fail", summary: "No" });
  assert.deepEqual(
    failed.data.canceled.map((item) => [item.number, item.state]),
    [
      [5, "canceled"],
      [6, "canceled"],
      [7, "canceled"],
    ],
  );
  assert.equal((await s.task(7)).task.outcome.reason, "need_failed");
  const onFailed = await s.create(
    [brief("Too late", { needs: [{ taskId: chain.data.tasks[0].id }] })],
    {
      error: true,
    },
  );
  assert.deepEqual([onFailed.error.code, onFailed.error.state], ["need_unavailable", "failed"]);
});

test("12: a cascade over 500 tasks finishes over alarm passes", async (t) => {
  const s = await setup(t);
  const root = (await s.create([brief("Root")])).data.tasks[0];
  for (let call = 0; call < 21; call++)
    await s.create(
      Array.from({ length: 25 }, (_, i) =>
        brief(`Leaf ${call}-${i}`, { needs: [{ taskId: root.id }] }),
      ),
    );
  const claimed = await s.claim(s.ids.Wes, { taskId: root.id });
  const failed = await s.update(s.ids.Wes, claimed.data, { action: "fail", summary: "Gone" });
  assert.equal(failed.data.canceled.length, 100, "the reply lists at most 100");
  const first = await s.read(s.lead, { mode: "list", states: ["waiting"] });
  assert.equal(first.data.counts.canceled, 500);
  assert.equal(first.data.counts.waiting, 25, "the rest waits for the alarm");
  await s.control("alarm");
  const counts = (await s.read(s.lead, { mode: "list" })).data.counts;
  assert.deepEqual([counts.canceled, counts.waiting, counts.failed], [525, 0, 1]);
});

test("12: one transaction readies at most 500 dependents; the alarm readies the rest", async (t) => {
  const s = await setup(t);
  const root = (await s.create([brief("Root")])).data.tasks[0];
  for (let call = 0; call < 21; call++)
    await s.create(
      Array.from({ length: 25 }, (_, i) =>
        brief(`Leaf ${call}-${i}`, { needs: [{ taskId: root.id }] }),
      ),
    );
  const claimed = await s.claim(s.ids.Wes, { taskId: root.id });
  const done = await s.update(s.ids.Wes, claimed.data, { action: "complete", summary: "Done" });
  assert.equal(done.data.unlocked.length, 100, "the reply lists at most 100");
  const first = (await s.read(s.lead, { mode: "list" })).data.counts;
  assert.deepEqual([first.ready, first.waiting], [500, 25], "the rest waits for the alarm");
  await s.control("alarm");
  const counts = (await s.read(s.lead, { mode: "list" })).data.counts;
  assert.deepEqual([counts.ready, counts.waiting, counts.completed], [525, 0, 1]);
});

test("12: pruning keeps a failed need while its cascade is unfinished", async (t) => {
  const s = await setup(t);
  const [root, other] = (await s.create([brief("Root"), brief("Other")])).data.tasks;
  for (let call = 0; call < 21; call++)
    await s.create(
      Array.from({ length: 25 }, (_, i) =>
        brief(`Leaf ${call}-${i}`, { needs: [{ taskId: root.id }] }),
      ),
    );
  // The last task needs the root and another open task; the alarm owes its cancel.
  const late = (
    await s.create([brief("Late", { needs: [{ taskId: root.id }, { taskId: other.id }] })])
  ).data.tasks[0];
  const claimed = await s.claim(s.ids.Wes, { taskId: root.id });
  await s.update(s.ids.Wes, claimed.data, { action: "fail", summary: "Gone" });
  assert.equal((await s.task(late.number)).task.state, "waiting");
  // Cutoff = now, as storage-cap shedding prunes: canceled leaves go, the failed root stays.
  const pruned = await s.control("prune");
  assert.ok(pruned.tasks > 0);
  assert.equal((await s.task(root.number)).task.state, "failed");
  // The other need completing must not make the late task ready: its root still failed.
  const second = await s.claim(s.ids.Wyn, { taskId: other.id });
  const done = await s.update(s.ids.Wyn, second.data, { action: "complete", summary: "Done" });
  assert.deepEqual(done.data.unlocked, []);
  await s.control("alarm");
  const finished = await s.task(late.number);
  assert.deepEqual(
    [finished.task.state, finished.task.outcome.reason],
    ["canceled", "need_failed"],
  );
  // With no unfinished dependent left, the root goes with the next passes.
  for (let pass = 0; pass < 8; pass++) await s.control("prune");
  const gone = await s.read(s.lead, { mode: "task", task: { number: root.number } }, true);
  assert.equal(gone.error.code, "task_not_found");
});

test("13: labels match all of them, invalid labels are refused, and next claims in order", async (t) => {
  const s = await setup(t);
  await s.create([
    brief("Go review", { labels: ["role=reviewer", "lang=go"] }),
    brief("Any review", { labels: ["role=reviewer"] }),
  ]);
  const go = await s.claim(s.ids.Wes, { next: { labels: ["role=reviewer", "lang=go"] } });
  assert.equal(go.data.task.number, 1);
  const none = await s.claim(s.ids.Wyn, { next: { labels: ["role=reviewer", "lang=go"] } });
  assert.deepEqual([none.data.claimed, none.data.why], [false, "none_ready"]);
  assert.deepEqual(none.data.waitingFor.labels, ["role=reviewer", "lang=go"]);
  assert.equal(none.data.message, undefined, "only the claim cap needs a message");
  // Labels only filter claims for next: a claim by ID or number takes a labeled task as it is.
  const byNumber = await s.claim(s.ids.Wyn, { number: 2 });
  assert.deepEqual([byNumber.data.task.number, byNumber.data.task.labels], [2, ["role=reviewer"]]);
  await s.update(s.ids.Wyn, byNumber.data, { action: "release" });
  const invalid = await s.create([brief("Bad", { labels: ["Not A Label"] })], { error: true });
  assert.equal(invalid.error.code, "invalid_input");
  // Assigned to you first, then priority, then the oldest ready.
  await s.create([
    brief("Normal"),
    brief("High", { priority: "high" }),
    brief("Low", { priority: "low" }),
    brief("Mine", { assigneeId: s.ids.Wyn }),
  ]);
  const order = [];
  for (let i = 0; i < 5; i++) {
    const next = await s.claim(s.ids.Wyn);
    order.push(next.data.task.title);
  }
  assert.deepEqual(order, ["Mine", "High", "Any review", "Normal", "Low"]);
});

test("13: a claim for next with waitSeconds waits for work and claims it", async (t) => {
  const s = await setup(t);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // Nothing comes: the claim answers empty at its deadline.
  const began = Date.now();
  const empty = await s.claim(s.ids.Wes, { next: { waitSeconds: 1 } });
  assert.deepEqual([empty.data.claimed, empty.data.why], [false, "none_ready"]);
  assert.ok(Date.now() - began >= 900, `${Date.now() - began} ms`);
  // Work for its labels arrives while it waits: it claims it, once.
  const started = Date.now();
  const waiting = s.claim(s.ids.Wes, { next: { labels: ["role=reviewer"], waitSeconds: 15 } });
  await sleep(1500);
  await s.create([brief("Not for reviewers")]);
  await sleep(300);
  const review = (await s.create([brief("Review", { labels: ["role=reviewer"] })])).data.tasks[0];
  const claimed = await waiting;
  assert.equal(claimed.data.claimed, true);
  assert.equal(claimed.data.task.id, review.id);
  const waited = Date.now() - started;
  assert.ok(waited >= 1400 && waited < 15_000, `${waited} ms`);
  // Over HTTP the same: the participant is in the path.
  const path = `${s.root}/participants/${s.ids.Wyn}/tasks/claim`;
  const http = s.x.call("user_alice", "POST", path, {
    requestKey: randomUUID(),
    next: { labels: ["area=web"], waitSeconds: 15 },
  });
  await sleep(1000);
  const later = (await s.create([brief("Later", { labels: ["area=web"] })])).data.tasks[0];
  const answer = await http;
  assert.deepEqual([answer.claimed, answer.task.id], [true, later.id]);
  // The bound is the one get_updates has.
  const refused = await s.claim(s.ids.Wes, { next: { waitSeconds: 21 } }, { error: true });
  assert.equal(refused.error.code, "invalid_input");
});

test("14: only the assignee claims assigned work; removal clears the assignee and releases claims", async (t) => {
  const s = await setup(t);
  const created = await s.create([brief("For Wes", { assigneeId: s.ids.Wes }), brief("Anyone")]);
  assert.equal(created.data.tasks[0].assigneeId, s.ids.Wes);
  const other = await s.claim(s.ids.Wyn, { number: 1 }, { error: true });
  assert.equal(other.error.reason, "assigned_to_other");
  const next = await s.claim(s.ids.Wyn);
  assert.equal(next.data.task.number, 2, "next skips work assigned to someone else");
  const removedTarget = (await s.register("Rae")).item.id;
  await s.create([brief("For Rae", { assigneeId: removedTarget })]);
  const held = await s.claim(removedTarget, { next: { assignedOnly: true } });
  assert.equal(held.data.task.number, 3);
  await s.create([brief("Also for Rae", { assigneeId: removedTarget })]);
  const dashboard = await website(s.x);
  const removed = await dashboard("POST", `${s.root}/participants/${removedTarget}/remove`);
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  const released = await s.task(3);
  assert.equal(released.task.state, "ready");
  assert.equal(released.task.assigneeId, undefined);
  assert.equal(released.events.at(-1).reason, "participant_removed");
  assert.equal((await s.task(4)).task.assigneeId, undefined);
  const refused = await s.create([brief("For nobody", { assigneeId: removedTarget })], {
    error: true,
  });
  assert.equal(refused.error.code, "participant_removed");
});

test("14: removing an agent that holds its own assigned task offers the task to a waiting agent", async (t) => {
  const s = await setup(t);
  const rae = (await s.register("Rae")).item.id;
  await s.create([brief("For Rae", { assigneeId: rae })]);
  const held = await s.claim(rae, { next: { assignedOnly: true } });
  assert.equal(held.data.task.number, 1);
  const from = await s.updates(s.ids.Wyn, {
    channelIds: [s.general],
    directChats: "own",
    mode: "start",
    startAt: "now",
  });
  // Wyn found no work and waits for some.
  assert.equal((await s.claim(s.ids.Wyn)).data.claimed, false);
  const dashboard = await website(s.x);
  const removed = await dashboard("POST", `${s.root}/participants/${rae}/remove`);
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  const heard = await s.updates(s.ids.Wyn, { mode: "poll", checkpoint: from.data.checkpoint });
  assert.deepEqual(
    (heard.data.tasks ?? []).map((event) => [event.number, event.kind, event.state]),
    [[1, "released", "ready"]],
  );
  const claimed = await s.claim(s.ids.Wyn);
  assert.equal(claimed.data.task.number, 1);
});

test("15: limits on tasks per call, unfinished tasks, holds and the claim cap", async (t) => {
  const s = await setup(t);
  const many = await s.create(
    Array.from({ length: 26 }, (_, i) => brief(`Task ${i}`)),
    { error: true },
  );
  assert.equal(many.error.code, "invalid_input");
  await s.create(Array.from({ length: 9 }, (_, i) => brief(`Hold ${i}`)));
  for (let i = 0; i < 8; i++) await s.claim(s.ids.Wes);
  const ninth = await s.claim(s.ids.Wes, { next: {} }, { error: true });
  assert.deepEqual(
    [ninth.error.code, ninth.error.reason],
    ["task_not_claimable", "holding_too_many"],
  );
  // The claim cap: at most this many tasks claimed at once on the server.
  const dashboard = await website(s.x);
  const capped = await dashboard("PUT", `${s.root}/board`, { enabled: true, claimCap: 8 });
  assert.equal(capped.status, 200, JSON.stringify(capped.json));
  assert.equal(capped.json.data.claimCap, 8);
  const cap = await s.claim(s.ids.Wyn);
  assert.deepEqual([cap.data.claimed, cap.data.why], [false, "claim_cap"]);
  assert.equal(
    cap.data.message,
    "This server's claim cap is reached: at most 8 tasks may be claimed at once. Wait for a ready event in get_updates or for a claimed task to finish, then claim again; a claim with next.waitSeconds claims as soon as one finishes. Do not claim in a loop.",
  );
  assert.equal((await s.context()).board.claimCap, 8);
  // 5,000 unfinished tasks at most: fill up to 4,999 from seeded briefs, then one call too many.
  const seeded = [];
  for (let i = 0; i < 4990; i++)
    seeded.push({
      participantId: s.lead,
      conversationId: s.general,
      at: new Date(Date.now() + 1000 + i).toISOString(),
      body: `seed ${i}`,
    });
  for (let i = 0; i < seeded.length; i += 1000) {
    const response = await s.x.control("activity-seed", {
      serverId: s.server.id,
      messages: seeded.slice(i, i + 1000),
    });
    assert.equal(response.status, 200, await response.text());
  }
  await s.control("fill", 4990);
  const full = (await s.read(s.lead, { mode: "list", limit: 1 })).data.counts;
  assert.equal(full.ready + full.claimed + full.waiting, 4999);
  const over = await s.create([brief("One"), brief("Two")], { error: true });
  assert.deepEqual([over.error.code, over.error.limit], ["task_limit_reached", 5000]);
  assert.equal((await s.create([brief("Last")])).data.tasks.length, 1);
});

test("15: at the claim cap, a waiting claim claims as soon as a claim ends", async (t) => {
  const s = await setup(t);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const dashboard = await website(s.x);
  const capped = await dashboard("PUT", `${s.root}/board`, { enabled: true, claimCap: 1 });
  assert.equal(capped.status, 200, JSON.stringify(capped.json));
  await s.create([brief("First"), brief("Second"), brief("Web", { labels: ["area=web"] })]);
  const first = (await s.claim(s.ids.Wes)).data;
  assert.equal(first.task.number, 1);
  const from = await s.updates(s.ids.Wyn, {
    channelIds: [s.general],
    directChats: "own",
    mode: "start",
    startAt: "now",
  });
  /** Claim for next with a wait while the cap is full; `end` ends a claim; time it. */
  const waitThrough = async (participantId, next, end) => {
    const waiting = s.claim(participantId, { next: { ...next, waitSeconds: 15 } });
    await sleep(1000);
    const ended = Date.now();
    await end();
    const answer = await waiting;
    const waited = Date.now() - ended;
    assert.equal(answer.data.claimed, true, JSON.stringify(answer.data));
    assert.ok(waited < 10_000, `${waited} ms`);
    return answer.data;
  };
  // A completed task frees the slot: Wyn's waiting claim takes the next task.
  const second = await waitThrough(s.ids.Wyn, {}, () =>
    s.update(s.ids.Wes, first, { action: "complete", summary: "Done." }),
  );
  assert.equal(second.task.number, 2);
  // The claim's end reaches Wyn in get_updates too, as a ready task would.
  const heard = await s.updates(s.ids.Wyn, { mode: "poll", checkpoint: from.data.checkpoint });
  assert.deepEqual(
    (heard.data.tasks ?? []).map((event) => [event.number, event.kind]),
    [[1, "completed"]],
  );
  // A release frees it for an agent waiting for other work: Wes waits for web work only.
  const web = await waitThrough(s.ids.Wes, { labels: ["area=web"] }, () =>
    s.update(s.ids.Wyn, second, { action: "release" }),
  );
  assert.equal(web.task.number, 3);
  // A lease that runs out frees it as well.
  const again = await waitThrough(s.ids.Wyn, {}, () => s.control("expire", 3));
  assert.ok([2, 3].includes(again.task.number), JSON.stringify(again.task));
  // A full cap still holds the claim to its deadline.
  const began = Date.now();
  const full = await s.claim(s.ids.Wes, { next: { waitSeconds: 1 } });
  assert.deepEqual([full.data.claimed, full.data.why], [false, "claim_cap"]);
  assert.ok(Date.now() - began >= 900, `${Date.now() - began} ms`);
});

test("15: each agent may make 120 task operations a minute, with a burst of 20", async (t) => {
  const s = await setup(t, { taskLimits: true });
  assert.equal(
    (await s.x.control(`limiter-clock?server=${s.server.id}`, { hold: true })).status,
    200,
  );
  for (let i = 0; i < 20; i++) await s.claim(s.ids.Wes);
  const limited = await s.claim(s.ids.Wes, { next: {} }, { error: true });
  assert.deepEqual([limited.error.code, limited.error.scope], ["rate_limited", "participant"]);
  assert.match(limited.error.message, /120 times a minute/);
  // Another agent has its own; reads are not task operations.
  assert.equal((await s.claim(s.ids.Wyn)).data.claimed, false);
  await s.read(s.ids.Wes, { mode: "list" });
  await s.x.control(`limiter-clock?server=${s.server.id}`, { advanceMillis: 1000 });
  assert.equal((await s.claim(s.ids.Wes)).data.claimed, false);
});

test("16: replays return the same result and changed input is refused", async (t) => {
  const s = await setup(t);
  const key = randomUUID();
  const tasks = [brief("Once")];
  const created = await s.create(tasks, { requestKey: key });
  const replay = await s.create(tasks, { requestKey: key });
  assert.equal(replay.data.batchId, created.data.batchId);
  assert.equal(replay.data.created, false);
  assert.deepEqual(
    replay.data.tasks.map((task) => task.id),
    created.data.tasks.map((task) => task.id),
  );
  const changed = await s.create([brief("Twice")], { requestKey: key, error: true });
  assert.equal(changed.error.code, "idempotency_conflict");
  const claimKey = randomUUID();
  const claimed = await s.claim(s.ids.Wes, { next: {} }, { requestKey: claimKey });
  const reclaimed = await s.claim(s.ids.Wes, { next: {} }, { requestKey: claimKey });
  assert.equal(reclaimed.data.lease.token, claimed.data.lease.token);
  const otherClaim = await s.claim(s.ids.Wes, { number: 1 }, { requestKey: claimKey, error: true });
  assert.equal(otherClaim.error.code, "idempotency_conflict");
  const updateKey = randomUUID();
  const note = { action: "progress", note: "Working on it." };
  const noted = await s.update(s.ids.Wes, claimed.data, note, { requestKey: updateKey });
  assert.equal(noted.data.changed, true);
  const renoted = await s.update(s.ids.Wes, claimed.data, note, { requestKey: updateKey });
  assert.equal(renoted.data.changed, false);
  const thread = (await s.task(1)).thread.items;
  assert.equal(thread.filter((m) => m.body === "Working on it.").length, 1, "one note, not two");
  const different = await s.update(
    s.ids.Wes,
    claimed.data,
    { action: "progress", note: "Something else." },
    { requestKey: updateKey, error: true },
  );
  assert.equal(different.error.code, "idempotency_conflict");
});

test("17: get_updates delivers task events by selection, keeps old checkpoints, and pages them", async (t) => {
  const plain = await setup(t, {}, { swarm: false, workers: [] });
  const quiet = await plain.updates(plain.lead, {
    channelIds: [plain.general],
    directChats: "own",
    mode: "start",
    startAt: "beginning",
    tasks: "all",
  });
  assert.equal(quiet.data.tasks, undefined, "no tasks key on a server without a board");
  assert.equal((await plain.context()).board, undefined);

  const s = await setup(t);
  const start = (participantId, tasks) => {
    const input = { channelIds: [s.general], directChats: "own", mode: "start", startAt: "now" };
    if (tasks !== undefined) input.tasks = tasks;
    return s.updates(participantId, input);
  };
  const mine = await start(s.ids.Wes, "mine");
  const all = await start(s.ids.Wyn, "all");
  const none = await start(s.lead, "none");
  // A checkpoint from before task selections existed reads as mine.
  const legacy = await start(s.ids.Wes);
  await s.create([brief("For Wes", { assigneeId: s.ids.Wes }), brief("Open")]);
  const poll = (participantId, from) =>
    s.updates(participantId, { mode: "poll", checkpoint: from.data.checkpoint });
  const wes = await poll(s.ids.Wes, mine);
  assert.deepEqual(
    wes.data.tasks.map((event) => [event.number, event.kind]),
    [
      [1, "created"],
      [1, "ready"],
    ],
  );
  assert.deepEqual(
    (await poll(s.ids.Wes, legacy)).data.tasks.map((event) => event.id),
    wes.data.tasks.map((event) => event.id),
  );
  const wyn = await poll(s.ids.Wyn, all);
  assert.deepEqual(
    wyn.data.tasks.map((event) => [event.number, event.kind]),
    [
      [1, "created"],
      [1, "ready"],
      [2, "created"],
      [2, "ready"],
    ],
  );
  assert.equal((await poll(s.lead, none)).data.tasks, undefined);
  // Included names every actor.
  assert.ok(wyn.included.participants.some((participant) => participant.id === s.lead));
  assert.equal(wyn.data.tasks[0].actor.participantId, s.lead);
  // Pages of 2 trim messages, renames and events in one order, and miss nothing.
  const board = (await s.context()).board.channelId;
  const from = await s.updates(s.ids.Wyn, {
    channelIds: [s.general, board],
    directChats: "own",
    mode: "start",
    startAt: "now",
    tasks: "all",
    limit: 2,
  });
  await s.create([brief("Third"), brief("Fourth")]);
  await s.call("rename_participant", {
    participantId: s.ids.Wes,
    name: "Wesley",
    requestKey: randomUUID(),
  });
  await s.call("send_message", {
    participantId: s.lead,
    requestKey: randomUUID(),
    target: { kind: "conversation", conversationId: s.general },
    body: "Two more tasks are up.",
  });
  const seen = [];
  let page = await s.updates(s.ids.Wyn, {
    mode: "poll",
    checkpoint: from.data.checkpoint,
    limit: 2,
  });
  for (let i = 0; i < 20; i++) {
    const items = [
      ...page.data.messages.map((m) => m.sequence),
      ...(page.data.renames ?? []).map((r) => r.sequence),
      ...(page.data.tasks ?? []).map((e) => e.sequence),
    ];
    // Each kind trims at the limit; the checkpoint covers all three.
    for (const kind of [page.data.messages, page.data.renames ?? [], page.data.tasks ?? []])
      assert.ok(kind.length <= 2, JSON.stringify(page.data));
    seen.push(...items.toSorted((a, b) => a - b));
    if (page.data.nextCursor === null) break;
    page = await s.updates(s.ids.Wyn, { mode: "continue", cursor: page.data.nextCursor, limit: 2 });
  }
  // Two briefs, four events, one rename and one message.
  assert.equal(seen.length, 8, JSON.stringify(seen));
  assert.deepEqual(
    seen,
    seen.toSorted((a, b) => a - b),
  );
  assert.equal(new Set(seen).size, seen.length);
});

test("19: signal links count waking task events", async (t) => {
  const s = await setup(t, { signalKey: true });
  const link = (
    await s.call("create_signal", {
      participantId: s.ids.Wes,
      channelIds: [s.general],
      directChats: "own",
    })
  ).data.url;
  const check = async (since) => {
    const target = new URL(link);
    if (since !== undefined) target.searchParams.set("since", since);
    const dot = target.pathname.lastIndexOf(".");
    const response = await s.x.raw(target.pathname.slice(0, dot) + target.search, {
      headers: { authorization: `Bearer ${target.pathname.slice(dot + 1)}` },
    });
    return response.json();
  };
  const quiet = await check();
  assert.equal(quiet.pending, 0);
  await s.create([brief("Unassigned")]);
  // The first task also opens the board channel, announced in General: a notice that wakes.
  const opened = await check();
  await s.create([brief("Unassigned too")]);
  assert.equal((await check(opened.cursor)).waking, 0, "a task for anyone wakes no one in phase 1");
  await s.create([brief("For Wes", { assigneeId: s.ids.Wes })]);
  const busy = await check(opened.cursor);
  assert.equal(busy.waking, 1, JSON.stringify(busy));
  assert.ok(busy.pending >= busy.waking);
  const after = await check(busy.cursor);
  assert.equal(after.pending, 0, JSON.stringify(after));
  // A person canceling the task Wes holds wakes Wes too.
  const claimed = await s.claim(s.ids.Wes, { next: { assignedOnly: true } });
  const quietAgain = await check();
  const dashboard = await website(s.x);
  await dashboard("POST", `${s.root}/people/me/tasks/${claimed.data.task.id}/cancel`, {
    expectedRevision: claimed.data.task.revision,
    requestKey: randomUUID(),
  });
  assert.equal((await check(quietAgain.cursor)).waking, 1);
});

test("the Board shows counts, stalled and failed rows, and pages its task list", async (t) => {
  const s = await setup(t);
  await s.create([
    brief("Retried"),
    brief("Broken"),
    brief("Waiting", { priority: "high" }),
    brief("Fresh", { priority: "low" }),
  ]);
  await s.claim(s.ids.Wes, { number: 1 });
  await s.control("expire", 1);
  await s.claim(s.ids.Wes, { number: 1 });
  const broken = await s.claim(s.ids.Wyn, { number: 2 });
  await s.update(s.ids.Wyn, broken.data, { action: "fail", summary: "It broke" });
  const dashboard = await website(s.x);
  const top = (await dashboard("GET", `${s.root}/board`)).json.data;
  assert.equal(top.changed, true);
  assert.equal(top.total, 4);
  assert.deepEqual(
    [top.counts.claimed, top.counts.ready, top.counts.failed, top.counts.stalled],
    [1, 2, 1, 1],
  );
  assert.deepEqual(
    top.stalled.items.map((row) => [row.number, row.stalled, row.attempts]),
    [[1, true, 1]],
  );
  assert.deepEqual(
    top.failed.items.map((row) => [row.number, row.summary]),
    [[2, "It broke"]],
  );
  assert.deepEqual([top.agents.working, top.needs.length], [1, 0]);
  // The open list: stalled first, then ready by priority; one row a page.
  const seen = [];
  let path = `${s.root}/board/tasks?view=open&limit=1`;
  for (let i = 0; i < 5; i++) {
    const page = (await dashboard("GET", path)).json.data;
    seen.push(...page.items.map((row) => row.number));
    if (page.nextCursor === null) break;
    path = `${s.root}/board/tasks?view=open&limit=1&cursor=${page.nextCursor}`;
  }
  assert.deepEqual(seen, [1, 3, 4]);
  const failed = (await dashboard("GET", `${s.root}/board/tasks?view=failed`)).json.data;
  assert.deepEqual(
    failed.items.map((row) => row.number),
    [2],
  );
});

test("20: every task write acts only as the caller's own agent", async (t) => {
  const s = await setup(t, { agentOwnership: "enforce" });
  await s.x.control("member", s.x.member(s.account.organizationId, "user_bob"));
  await s.x.call("user_alice", "PUT", `${s.root}/access/user_bob`);
  const bob = await s.x.mcpToken(s.account.organizationId, "user_bob");
  const asBob = (name, args) => s.x.mcp(bob, name, { serverId: s.server.id, ...args }, true);
  const created = await s.create([brief("Alice's")]);
  const claimed = await s.claim(s.ids.Wes);
  const refusals = [
    await asBob("create_tasks", {
      participantId: s.lead,
      requestKey: randomUUID(),
      tasks: [brief("Bob's")],
    }),
    await asBob("claim_task", { participantId: s.ids.Wyn, requestKey: randomUUID(), next: {} }),
    await asBob("update_task", {
      participantId: s.ids.Wes,
      requestKey: randomUUID(),
      taskId: created.data.tasks[0].id,
      leaseToken: claimed.data.lease.token,
      epoch: claimed.data.lease.epoch,
      action: "progress",
    }),
  ];
  assert.deepEqual(
    refusals.map((reply) => reply.error.code),
    ["forbidden", "forbidden", "forbidden"],
  );
  // Reads follow the read-everything rule: Bob's own agent reads Alice's tasks.
  const dana = (
    await s.x.mcp(bob, "register_participant", {
      serverId: s.server.id,
      name: "Dana",
      agentType: "codex",
      requestKey: randomUUID(),
    })
  ).data.item.id;
  const listed = await s.x.mcp(bob, "read_tasks", {
    serverId: s.server.id,
    participantId: dana,
    mode: "list",
  });
  assert.equal(listed.data.items.length, 1);
});

test("5: the owner agent cancels its own waiting or ready task, and nothing else", async (t) => {
  const s = await setup(t);
  const [first, below, held] = (
    await s.create([
      brief("Withdrawn", { ref: "a" }),
      brief("Below", { needs: [{ ref: "a" }] }),
      brief("Held"),
    ])
  ).data.tasks;
  const owner = (participantId, task, action, options = {}) =>
    s.call(
      "update_task",
      {
        participantId,
        requestKey: options.requestKey ?? randomUUID(),
        taskId: task.id,
        ...action,
      },
      options.error ?? false,
    );
  const other = await owner(s.ids.Wes, first, { action: "cancel" }, { error: true });
  assert.equal(other.error.code, "forbidden");
  const stale = await owner(
    s.lead,
    first,
    { action: "cancel", expectedRevision: first.revision + 1 },
    { error: true },
  );
  assert.equal(stale.error.code, "revision_conflict");
  const key = randomUUID();
  const canceled = await owner(
    s.lead,
    first,
    { action: "cancel", reason: "Wrong task." },
    { requestKey: key },
  );
  assert.deepEqual(
    [canceled.data.task.state, canceled.data.task.outcome.reason, canceled.data.changed],
    ["canceled", "by_owner", true],
  );
  assert.equal(canceled.data.message.body, "Wrong task.");
  assert.deepEqual(
    canceled.data.canceled.map((item) => item.number),
    [below.number],
  );
  const replay = await owner(
    s.lead,
    first,
    { action: "cancel", reason: "Wrong task." },
    { requestKey: key },
  );
  assert.equal(replay.data.changed, false);
  const again = await owner(s.lead, first, { action: "cancel" }, { error: true });
  assert.deepEqual([again.error.code, again.error.state], ["task_state_conflict", "canceled"]);
  // A claimed task is a worker's: its owner waits or asks a person.
  await s.claim(s.ids.Wes, { taskId: held.id });
  const working = await owner(s.lead, held, { action: "cancel" }, { error: true });
  assert.deepEqual([working.error.code, working.error.state], ["task_state_conflict", "claimed"]);
  const events = (await s.task(first.number)).events;
  assert.deepEqual(
    [events.at(-1).kind, events.at(-1).reason, events.at(-1).actor.participantId],
    ["canceled", "by_owner", s.lead],
  );
});

test("5: the owner agent or a person reopens a failed task; its canceled dependents wait again", async (t) => {
  const s = await setup(t);
  const [root, other, first, second, both] = (
    await s.create([
      brief("Root", { ref: "r" }),
      brief("Other", { ref: "x" }),
      brief("First", { ref: "d1", needs: [{ ref: "r" }] }),
      brief("Second", { needs: [{ ref: "d1" }] }),
      brief("Both", { needs: [{ ref: "r" }, { ref: "x" }] }),
    ])
  ).data.tasks;
  // The other need fails first: Both is canceled for it, before the root fails.
  const x = await s.claim(s.ids.Wyn, { taskId: other.id });
  await s.update(s.ids.Wyn, x.data, { action: "fail", summary: "Broke" });
  // The root's lease runs out once, then its next holder fails it.
  await s.claim(s.ids.Wes, { taskId: root.id });
  await s.control("expire", root.number);
  const retry = await s.claim(s.ids.Wes, { taskId: root.id });
  const failed = await s.update(s.ids.Wes, retry.data, { action: "fail", summary: "Flaky" });
  assert.deepEqual(failed.data.canceled.map((item) => item.number).toSorted(), [
    first.number,
    second.number,
  ]);
  const reopen = (participantId, task, options = {}) =>
    s.call(
      "update_task",
      {
        participantId,
        requestKey: randomUUID(),
        taskId: task.id,
        action: "reopen",
        ...options.extra,
      },
      options.error ?? false,
    );
  assert.equal((await reopen(s.ids.Wes, root, { error: true })).error.code, "forbidden");
  const notFailed = await reopen(s.lead, first, { error: true });
  assert.deepEqual(
    [notFailed.error.code, notFailed.error.state],
    ["task_state_conflict", "canceled"],
  );
  const reopened = await reopen(s.lead, root, { extra: { note: "Try once more." } });
  assert.deepEqual(
    [
      reopened.data.task.state,
      reopened.data.task.attempts,
      reopened.data.task.outcome,
      reopened.data.changed,
    ],
    ["ready", 0, undefined, true],
  );
  assert.equal(reopened.data.message.body, "Try once more.");
  // First and Second wait again; Both stays canceled: its other need still failed.
  assert.deepEqual(reopened.data.reopened.map((item) => [item.number, item.state]).toSorted(), [
    [first.number, "waiting"],
    [second.number, "waiting"],
  ]);
  assert.equal((await s.task(both.number)).task.state, "canceled");
  const events = (await s.task(second.number)).events.map((event) => [event.kind, event.reason]);
  assert.deepEqual(events.at(-1), ["reopened", "need_reopened"]);
  // A person reopens the other need on the dashboard; now Both waits too.
  const dashboard = await website(s.x);
  const path = `${s.root}/people/me/tasks/${other.id}/reopen`;
  const current = (await s.task(other.number)).task;
  const stale = await dashboard("POST", path, {
    expectedRevision: current.revision + 1,
    requestKey: randomUUID(),
  });
  assert.deepEqual([stale.status, stale.json.error.code], [409, "revision_conflict"]);
  const body = { expectedRevision: current.revision, requestKey: randomUUID(), note: "Retry." };
  const person = await dashboard("POST", path, body);
  assert.equal(person.status, 200, JSON.stringify(person.json));
  assert.equal(person.json.data.task.state, "ready");
  assert.deepEqual(
    person.json.data.reopened.map((item) => item.number),
    [both.number],
  );
  const replay = await dashboard("POST", path, body);
  assert.equal(replay.json.data.changed, false);
  const bearer = await s.x.call("user_alice", "POST", path, body, 403);
  assert.equal(bearer.error.code, "forbidden");
  // The work runs again: completing the root readies First.
  const claimed = await s.claim(s.ids.Wes, { taskId: root.id });
  const done = await s.update(s.ids.Wes, claimed.data, { action: "complete", summary: "Done" });
  assert.deepEqual(
    done.data.unlocked.map((item) => item.number),
    [first.number],
  );
});

test("21: person routes refuse bearer tokens; a website session acts as the person", async (t) => {
  const s = await setup(t);
  const created = await s.create([brief("Cancel me"), brief("Below", { needs: [] })]);
  const task = created.data.tasks[0];
  const path = `${s.root}/people/me/tasks/${task.id}/cancel`;
  const body = {
    expectedRevision: task.revision,
    requestKey: randomUUID(),
    reason: "Changed plans.",
  };
  const bearer = await s.x.call("user_alice", "POST", path, body, 403);
  assert.equal(bearer.error.code, "forbidden");
  const board = await s.x.call("user_alice", "GET", `${s.root}/board`, undefined, 403);
  assert.equal(board.error.code, "forbidden");
  const dashboard = await website(s.x);
  const stale = await dashboard("POST", path, { ...body, expectedRevision: task.revision + 1 });
  assert.deepEqual([stale.status, stale.json.error.code], [409, "revision_conflict"]);
  const canceled = await dashboard("POST", path, body);
  assert.equal(canceled.status, 200, JSON.stringify(canceled.json));
  assert.equal(canceled.json.data.task.state, "canceled");
  assert.equal(canceled.json.data.task.outcome.reason, "by_person");
  const replay = await dashboard("POST", path, body);
  assert.equal(replay.json.data.changed, false);
  const detail = await s.task(1);
  const event = detail.events.at(-1);
  assert.deepEqual([event.kind, event.actor.kind], ["canceled", "person"]);
  assert.ok(event.actor.name);
  assert.ok(detail.thread.items.some((m) => m.body === "Changed plans."));
  // The dashboard's Board reads from the same session.
  const top = await dashboard("GET", `${s.root}/board`);
  assert.equal(top.status, 200, JSON.stringify(top.json));
  assert.equal(top.json.data.counts.canceled, 1);
  assert.equal(top.json.data.total, 2);
  const unchanged = await dashboard("GET", `${s.root}/board?after=${top.json.data.after}`);
  assert.deepEqual(unchanged.json.data, { changed: false, after: top.json.data.after });
  const list = await dashboard("GET", `${s.root}/board/tasks?view=all&q=T-2`);
  assert.equal(list.status, 200, JSON.stringify(list.json));
  assert.deepEqual(
    list.json.data.items.map((row) => row.number),
    [2],
  );
});

test("22: any agent reads tasks; only claim_task returns a lease token", async (t) => {
  const s = await setup(t);
  const outsider = (await s.register("Olive")).item.id;
  const replies = [];
  const created = await s.create([brief("Secret lease")]);
  replies.push(created);
  const claimed = await s.claim(s.ids.Wes);
  const token = claimed.data.lease.token;
  // The holder's own update_task reply returns its renewed lease (spec 4.3); nothing else does.
  const renewed = await s.update(s.ids.Wes, claimed.data, { action: "progress", note: "On it." });
  assert.equal(renewed.data.lease.token, token);
  replies.push(await s.read(outsider, { mode: "list" }));
  replies.push(await s.read(outsider, { mode: "task", task: { id: claimed.data.task.id } }));
  replies.push(await s.context(s.ids.Wes));
  replies.push(
    await s.updates(outsider, {
      channelIds: [s.general],
      directChats: "own",
      mode: "start",
      startAt: "beginning",
      tasks: "all",
    }),
  );
  replies.push(await s.x.call("user_alice", "GET", `${s.root}/tasks/1?participantId=${outsider}`));
  const dashboard = await website(s.x);
  const rows = await dashboard("GET", `${s.root}/board/tasks?view=all`);
  assert.equal(rows.status, 200, JSON.stringify(rows.json));
  replies.push(rows.json);
  for (const reply of replies) assert.doesNotMatch(JSON.stringify(reply), new RegExp(token));
  assert.equal(replies[1].data.items[0].claim.holderId, s.ids.Wes);
});

test("23: only the server's creator switches the board; off releases claims and refuses tools", async (t) => {
  const s = await setup(t);
  await s.x.control("member", s.x.member(s.account.organizationId, "user_bob"));
  await s.x.call("user_alice", "PUT", `${s.root}/access/user_bob`);
  await s.create([brief("Held"), brief("Open")]);
  await s.claim(s.ids.Wes, { number: 1 });
  const bob = await website(s.x, "user_bob");
  const refused = await bob("PUT", `${s.root}/board`, { enabled: false });
  assert.deepEqual([refused.status, refused.json.error.code], [403, "forbidden"]);
  const alice = await website(s.x);
  const off = await alice("PUT", `${s.root}/board`, { enabled: false });
  assert.equal(off.status, 200, JSON.stringify(off.json));
  assert.deepEqual([off.json.data.enabled, off.json.data.released], [false, 1]);
  const tool = await s.claim(s.ids.Wyn, { next: {} }, { error: true });
  assert.equal(tool.error.code, "board_off");
  assert.equal((await s.context()).board.enabled, false);
  const listed = await s.x.call("user_alice", "GET", `/v1/accounts/${s.account.id}/servers`);
  assert.equal(listed.items.find((item) => item.id === s.server.id).board, undefined);
  const on = await alice("PUT", `${s.root}/board`, { enabled: true });
  assert.equal(on.json.data.enabled, true);
  const back = await s.read(s.lead, { mode: "list" });
  assert.deepEqual(back.data.items.map((item) => [item.number, item.state]).toSorted(), [
    [1, "ready"],
    [2, "ready"],
  ]);
  assert.equal((await s.claim(s.ids.Wyn)).data.claimed, true);
  const relisted = await s.x.call("user_alice", "GET", `/v1/accounts/${s.account.id}/servers`);
  assert.equal(relisted.items.find((item) => item.id === s.server.id).board, true);
  // A plain server's creator can switch a board on later.
  const plain = await s.x.server(s.account.id, { name: "Plain" });
  const later = await alice("PUT", `/v1/servers/${plain.id}/board`, { enabled: true });
  assert.equal(later.status, 200, JSON.stringify(later.json));
  assert.ok(later.json.data.channelId);
  // The creator's own token switches it too; another member's token is still refused.
  const token = await s.x.call("user_alice", "PUT", `/v1/servers/${plain.id}/board`, {
    enabled: false,
  });
  assert.equal(token.enabled, false);
  const bobToken = await s.x.call("user_bob", "PUT", `${s.root}/board`, { enabled: false }, 403);
  assert.equal(bobToken.error.code, "forbidden");
});

test("25: the OpenAPI document includes the task and board routes", async (t) => {
  const x = await start(t, { board: true });
  const spec = await (await x.raw("/openapi.json")).json();
  for (const path of [
    "/v1/servers/{serverId}/participants/{participantId}/tasks",
    "/v1/servers/{serverId}/participants/{participantId}/tasks/claim",
    "/v1/servers/{serverId}/participants/{participantId}/tasks/{taskId}/updates",
    "/v1/servers/{serverId}/tasks",
    "/v1/servers/{serverId}/tasks/{task}",
    "/v1/servers/{serverId}/board",
    "/v1/servers/{serverId}/board/tasks",
    "/v1/servers/{serverId}/board/tasks/{task}",
    "/v1/servers/{serverId}/people/me/tasks/{taskId}/cancel",
    "/v1/servers/{serverId}/people/me/tasks/{taskId}/reopen",
  ])
    assert.ok(spec.paths[path], path);
  assert.ok(spec.paths["/v1/servers/{serverId}/board"].put);
});

test("the Board's task page reads one task as the person, by number or ID, on the website only", async (t) => {
  const s = await setup(t);
  const created = await s.create([brief("Page")]);
  const id = created.data.tasks[0].id;
  const bearer = await s.x.call("user_alice", "GET", `${s.root}/board/tasks/1`, undefined, 403);
  assert.equal(bearer.error.code, "forbidden");
  const dashboard = await website(s.x);
  const byNumber = await dashboard("GET", `${s.root}/board/tasks/1`);
  assert.equal(byNumber.status, 200, JSON.stringify(byNumber.json));
  assert.equal(byNumber.json.data.task.id, id);
  assert.equal(byNumber.json.data.thread.items[0].body, "Do this: Page.");
  assert.deepEqual(
    byNumber.json.data.events.map((event) => event.kind),
    ["created", "ready"],
  );
  const byId = await dashboard("GET", `${s.root}/board/tasks/${id}`);
  assert.equal(byId.json.data.task.number, 1);
  const missing = await dashboard("GET", `${s.root}/board/tasks/9`);
  assert.deepEqual([missing.status, missing.json.error.code], [404, "task_not_found"]);
});

test("the Board's rows come with the agents they name, for their names and marks", async (t) => {
  const s = await setup(t);
  await s.create([brief("Held"), brief("Open")]);
  await s.claim(s.ids.Wes, { number: 1 });
  const dashboard = await website(s.x);
  const list = (await dashboard("GET", `${s.root}/board/tasks?view=all`)).json;
  assert.deepEqual(list.included.participants.map((item) => item.name).sort(), ["Lead", "Wes"]);
  const top = (await dashboard("GET", `${s.root}/board`)).json;
  assert.deepEqual(top.included.participants, []);
});

test("the dashboard learns whether this deployment offers boards", async (t) => {
  const me = async (x) => (await (await website(x))("GET", "/v1/me")).json.data.connection;
  assert.equal((await me(await start(t, { board: true }))).boards, true);
  assert.equal((await me(await start(t))).boards, undefined);
});

test("finished rows name the agent that finished them and the agents that held them before", async (t) => {
  const s = await setup(t);
  await s.create([
    brief("Expired then done"),
    brief("Failed, reopened, done"),
    brief("Owner cancels"),
    brief("Person cancels"),
    brief("Below the failure", { needs: [{ ref: "x" }] }),
    brief("Runs out", { maxAttempts: 1 }),
    brief("Fails", { ref: "x" }),
  ]);
  const dashboard = await website(s.x);
  const rows = async (query = "view=all") => {
    const list = (await dashboard("GET", `${s.root}/board/tasks?${query}&limit=50`)).json;
    return {
      byNumber: new Map(list.data.items.map((row) => [row.number, row])),
      names: new Map(list.included.participants.map((item) => [item.id, item])),
    };
  };
  const pick = (row) => [row.state, row.holderId, row.finishedById, row.earlierHolderIds];
  // T-1: Wes's lease runs out, Wyn claims it and completes it: Wyn, then Wes before.
  await s.claim(s.ids.Wes, { number: 1 });
  await s.control("expire", 1);
  const second = await s.claim(s.ids.Wyn, { number: 1 });
  let row = (await rows()).byNumber.get(1);
  assert.deepEqual(pick(row), ["claimed", s.ids.Wyn, undefined, [s.ids.Wes]]);
  await s.update(s.ids.Wyn, second.data, { action: "complete", summary: "Done" });
  const done = await rows();
  assert.deepEqual(pick(done.byNumber.get(1)), ["completed", undefined, s.ids.Wyn, [s.ids.Wes]]);
  assert.equal(done.names.get(s.ids.Wes).name, "Wes", "earlier holders come with their names");
  // T-2: Wes fails it; the owner reopens it; its holders stay; Wyn finishes it and wins.
  const failing = await s.claim(s.ids.Wes, { number: 2 });
  await s.update(s.ids.Wes, failing.data, { action: "fail", summary: "Broke" });
  assert.deepEqual(pick((await rows()).byNumber.get(2)), [
    "failed",
    undefined,
    s.ids.Wes,
    undefined,
  ]);
  const task2 = (await s.task(2)).task;
  await s.call("update_task", {
    participantId: s.lead,
    requestKey: randomUUID(),
    taskId: task2.id,
    action: "reopen",
  });
  assert.deepEqual(pick((await rows()).byNumber.get(2)), [
    "ready",
    undefined,
    undefined,
    [s.ids.Wes],
  ]);
  const again = await s.claim(s.ids.Wyn, { number: 2 });
  await s.update(s.ids.Wyn, again.data, { action: "complete", summary: "Fixed" });
  assert.deepEqual(pick((await rows()).byNumber.get(2)), [
    "completed",
    undefined,
    s.ids.Wyn,
    [s.ids.Wes],
  ]);
  // T-3: the owner agent cancels it before anyone claims it: the owner finished it.
  const task3 = (await s.task(3)).task;
  await s.call("update_task", {
    participantId: s.lead,
    requestKey: randomUUID(),
    taskId: task3.id,
    action: "cancel",
  });
  assert.deepEqual(pick((await rows()).byNumber.get(3)), [
    "canceled",
    undefined,
    s.lead,
    undefined,
  ]);
  // T-4: a person cancels it: no agent finished it.
  const task4 = (await s.task(4)).task;
  const canceled = await dashboard("POST", `${s.root}/people/me/tasks/${task4.id}/cancel`, {
    expectedRevision: task4.revision,
    requestKey: randomUUID(),
  });
  assert.equal(canceled.status, 200, JSON.stringify(canceled.json));
  assert.deepEqual(pick((await rows()).byNumber.get(4)), [
    "canceled",
    undefined,
    undefined,
    undefined,
  ]);
  // T-7 fails, which cancels T-5 below it: T-7 names Wyn, T-5 no agent.
  const fails = await s.claim(s.ids.Wyn, { number: 7 });
  await s.update(s.ids.Wyn, fails.data, { action: "fail", summary: "No" });
  const cascade = (await rows()).byNumber;
  assert.deepEqual(pick(cascade.get(5)), ["canceled", undefined, undefined, undefined]);
  assert.deepEqual(pick(cascade.get(7)), ["failed", undefined, s.ids.Wyn, undefined]);
  // T-6 runs out of attempts: nobody finished it; Wes held it.
  await s.claim(s.ids.Wes, { number: 6 });
  await s.control("expire", 6);
  assert.deepEqual(pick((await rows()).byNumber.get(6)), [
    "failed",
    undefined,
    undefined,
    [s.ids.Wes],
  ]);
  // The agent filter finds the tasks an agent held or finished, not only the ones it holds now.
  const wes = await rows(`view=all&agentId=${s.ids.Wes}`);
  assert.deepEqual(
    [...wes.byNumber.keys()].sort((a, b) => a - b),
    [1, 2, 6],
  );
  const wyn = await rows(`view=done&agentId=${s.ids.Wyn}`);
  assert.deepEqual(
    [...wyn.byNumber.keys()].sort((a, b) => a - b),
    [1, 2],
  );
  // The task page's events name every holder.
  const events = (await dashboard("GET", `${s.root}/board/tasks/1`)).json.data.events;
  assert.deepEqual(
    events.filter((event) => event.kind === "claimed").map((event) => event.actor.participantId),
    [s.ids.Wes, s.ids.Wyn],
  );
});

test("holders survive a removed agent, and a server that ran board.sql earlier gains their tables", async (t) => {
  const s = await setup(t);
  await s.create([brief("Removed holder"), brief("Held across the upgrade")]);
  await s.claim(s.ids.Wes, { number: 1 });
  const dashboard = await website(s.x);
  // Removing Wes releases its claim (B6); its record stays, and its name still resolves.
  const removed = await dashboard("POST", `${s.root}/participants/${s.ids.Wes}/remove`);
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  const next = await s.claim(s.ids.Wyn, { number: 1 });
  await s.update(s.ids.Wyn, next.data, { action: "complete", summary: "Done" });
  const list = (await dashboard("GET", `${s.root}/board/tasks?view=done`)).json;
  const row = list.data.items.find((item) => item.number === 1);
  assert.deepEqual([row.finishedById, row.earlierHolderIds], [s.ids.Wyn, [s.ids.Wes]]);
  const wes = list.included.participants.find((item) => item.id === s.ids.Wes);
  assert.equal(wes.name, "Wes");
  assert.ok(wes.removedAt, "a removed earlier holder is marked removed");
  // A server object that ran board.sql before task-holders.sql (staging) has no holder tables. On
  // its next start it creates them, keeps schema version 11, and records the claims held now.
  const held = await s.claim(s.ids.Wyn, { number: 2 });
  await s.control("drop-holders");
  await s.x.control(`resources?server=${s.server.id}`, "restart");
  const inspected = await s.control("inspect");
  assert.equal(inspected.version, 11);
  assert.ok(
    inspected.tables.includes("task_holders") && inspected.tables.includes("task_finishers"),
  );
  await s.update(s.ids.Wyn, held.data, { action: "complete", summary: "Done" });
  const after = (await dashboard("GET", `${s.root}/board/tasks?view=done`)).json.data.items;
  assert.deepEqual(
    after.map((item) => [item.number, item.finishedById, item.earlierHolderIds]),
    [
      [2, s.ids.Wyn, undefined],
      [1, undefined, undefined],
    ],
    "the claim held across the upgrade names Wyn; the first task's records went with the tables",
  );
  // A replayed start changes nothing.
  await s.x.control(`resources?server=${s.server.id}`, "restart");
  assert.equal((await s.control("inspect")).version, 11);
});

test("the Board lists every label A–Z, including the longest a label may be", async (t) => {
  const s = await setup(t);
  // A 32-character key, "=", and a 63-character value: 96, the longest task_labels stores.
  const longest = `${"k".repeat(32)}=${"v".repeat(63)}`;
  // One longer is refused as invalid input, not stored and failed.
  const refused = await s.create([brief("Too long", { labels: [`${longest}v`] })], {
    error: true,
  });
  assert.equal(refused.error.code, "invalid_input", JSON.stringify(refused));
  await s.create([
    brief("One", { labels: ["role=reviewer", "area=web"] }),
    brief("Two", { labels: ["area=web", longest] }),
    brief("Three"),
  ]);
  const dashboard = await website(s.x);
  const listed = await dashboard("GET", `${s.root}/board/labels`);
  assert.equal(listed.status, 200, JSON.stringify(listed.json));
  assert.deepEqual(listed.json.data, {
    items: ["area=web", longest, "role=reviewer"],
    more: false,
  });
  // A label filter finds the longest label's task.
  const filtered = await dashboard(
    "GET",
    `${s.root}/board/tasks?view=all&label=${encodeURIComponent(longest)}`,
  );
  assert.deepEqual(
    filtered.json.data.items.map((row) => row.title),
    ["Two"],
  );
});

test("a retried claim is stalled but not silent until its lease passes", async (t) => {
  const s = await setup(t);
  await s.create([brief("Retried")]);
  await s.claim(s.ids.Wes, { number: 1 });
  await s.control("expire", 1);
  await s.claim(s.ids.Wyn, { number: 1 });
  const dashboard = await website(s.x);
  const row = async () =>
    (await dashboard("GET", `${s.root}/board/tasks?view=all`)).json.data.items[0];
  const retried = await row();
  assert.equal(retried.stalled, true, "a retry is stalled");
  assert.equal(retried.silent, false, "but its holder is within its lease");
  // The task was made a day earlier, so twenty minutes of silence fits after its creation.
  await s.control("spread");
  const response = await s.x.control(`board?server=${s.server.id}`, {
    action: "silence",
    number: 1,
    minutes: 20,
  });
  assert.equal(response.status, 200);
  const quiet = await row();
  assert.equal(quiet.stalled, true);
  assert.equal(quiet.silent, true, "twenty minutes without a note is past the lease");
});

test("a person's full API key cancels and reopens tasks and reads the Board as HTTP reads", async (t) => {
  const s = await setup(t, { readBudgets: true });
  await s.create([brief("Cancel me"), brief("Broken")]);
  const broken = await s.claim(s.ids.Wyn, { number: 2 });
  await s.update(s.ids.Wyn, broken.data, { action: "fail", summary: "It broke" });
  const dashboard = await website(s.x);
  const keyFor = async (access) => {
    const made = await dashboard("POST", "/v1/me/api-keys", { name: access, access });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const secret = made.json.data.secret;
    return async (method, path, value) => {
      const response = await s.x.raw(path, {
        method,
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: value === undefined ? undefined : JSON.stringify(value),
      });
      return { status: response.status, json: await response.json() };
    };
  };
  const full = await keyFor("full");
  const read = await keyFor("read");
  const first = await s.task(1);
  const second = await s.task(2);
  const cancel = `${s.root}/people/me/tasks/${first.task.id}/cancel`;
  const reopen = `${s.root}/people/me/tasks/${second.task.id}/reopen`;
  const cancelBody = { expectedRevision: first.task.revision, requestKey: randomUUID() };
  const reopenBody = { expectedRevision: second.task.revision, requestKey: randomUUID() };
  assert.equal((await read("POST", cancel, cancelBody)).status, 403);
  assert.equal((await read("POST", reopen, reopenBody)).status, 403);
  const canceled = await full("POST", cancel, cancelBody);
  assert.equal(canceled.status, 200, JSON.stringify(canceled.json));
  const reopened = await full("POST", reopen, reopenBody);
  assert.equal(reopened.status, 200, JSON.stringify(reopened.json));

  // Board reads by key count as HTTP reads of the person's connection: they run out.
  await s.x.control(`quota/configure?account=${s.account.id}`, {
    budgets: { perMinute: 60, burst: 2 },
  });
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await read("GET", `${s.root}/board`)).status);
  assert.ok(statuses.includes(429), JSON.stringify(statuses));
});
