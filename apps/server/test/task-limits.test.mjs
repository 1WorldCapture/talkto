import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

/*
  Task operations per plan (docs/plan-limits.md, "Task operations"; docs/swarm-server-spec.md,
  8.2 and 8.3): the organization's month, kept by its quota object and leased in batches like
  reads, the slow lane after it, the owner-pilot exemption, the reopen bound and Free's default
  claim cap. Every test runs on the real Worker, D1, server object and quota object.
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
    return { status: response.status, json: JSON.parse(await response.text()) };
  };
};

/**
 * A swarm server with a lead and one worker, task budgets on. `budgets` replaces the plan's numbers
 * in the organization's quota object before the first task operation. `accountId` renames the
 * organization first, as an operator grant names an existing one.
 */
const setup = async (t, options = {}, budgets = null, accountId = null) => {
  const x = await start(t, { board: true, manualAlarms: true, taskBudgets: true, ...options });
  const created = await x.account();
  if (accountId !== null)
    await x.db.prepare("UPDATE accounts SET id=? WHERE id=?").bind(accountId, created.id).run();
  const account = { ...created, id: accountId ?? created.id };
  if (budgets !== null) await x.control(`quota/configure?account=${account.id}`, { budgets });
  const server = await x.server(account.id, { board: true });
  const root = `/v1/servers/${server.id}`;
  const credential = await x.mcpToken(account.organizationId);
  const call = (name, args, error = false) =>
    x.mcp(credential, name, { serverId: server.id, ...args }, error);
  const register = async (name) =>
    (await call("register_participant", { name, agentType: "codex", requestKey: randomUUID() }))
      .data.item.id;
  const lead = await register("Lead");
  const worker = await register("Wes");
  const claim = (selector = { next: {} }, error = false) =>
    call("claim_task", { participantId: worker, requestKey: randomUUID(), ...selector }, error);
  const create = (title, error = false) =>
    call(
      "create_tasks",
      {
        participantId: lead,
        requestKey: randomUUID(),
        tasks: [{ title, brief: `Do this: ${title}.` }],
      },
      error,
    );
  const update = (claimed, action, error = false) =>
    call(
      "update_task",
      {
        participantId: worker,
        requestKey: randomUUID(),
        taskId: claimed.task.id,
        leaseToken: claimed.lease.token,
        epoch: claimed.lease.epoch,
        ...action,
      },
      error,
    );
  const usage = async () => (await x.control(`quota/budgets?account=${account.id}`)).json();
  const taskCalls = async () =>
    (await usage()).calls.filter((entry) => entry.lane === "task").length;
  const context = async () => (await call("get_context", { participant: { id: lead } })).data.board;
  return {
    x,
    account,
    server,
    root,
    call,
    lead,
    worker,
    claim,
    create,
    update,
    usage,
    taskCalls,
    context,
  };
};

test("an empty-claim loop counts every claim in the month, leased in batches", async (t) => {
  const s = await setup(t);
  const claims = 40;
  for (let i = 0; i < claims; i++) assert.equal((await s.claim()).data.claimed, false);
  const { usage } = await s.usage();
  // A lease counts when granted: never below what was done, and above it by what the server has
  // not spent yet, under an eighth of what it did.
  assert.ok(usage.tasks.used >= claims, `${usage.tasks.used} < ${claims}`);
  assert.ok(usage.tasks.used <= claims + claims / 8, `${usage.tasks.used} far above ${claims}`);
  assert.equal(usage.tasks.beyond, 0);
  assert.equal(usage.tasks.limit, 10000, "Free's 10,000 a month");
  // Fewer quota calls than task operations: leases grow with what the server spends.
  const calls = await s.taskCalls();
  assert.ok(calls < claims, `${calls} lease calls for ${claims} claims`);
  // get_context shows the month on the board; reading it is not a task operation.
  const board = await s.context();
  assert.deepEqual(board.taskOperations, {
    used: usage.tasks.used,
    limit: 10000,
    resetsAt: usage.terms.periodEnd,
  });
  assert.equal((await s.usage()).usage.tasks.used, usage.tasks.used);
});

test("creating, renewing, finishing and reopening are task operations too", async (t) => {
  const s = await setup(t);
  await s.create("Count me");
  const claimed = (await s.claim()).data;
  await s.update(claimed, { action: "progress" });
  await s.update(claimed, { action: "fail", summary: "Broke" });
  await s.call("update_task", {
    participantId: s.lead,
    requestKey: randomUUID(),
    taskId: claimed.task.id,
    action: "reopen",
  });
  // Four whole operations and a renewal's fifth (21 parts), each leased as needed while the
  // server is fresh; usage shows whole operations.
  assert.equal((await s.usage()).usage.tasks.used, 4);
});

test("a lease renewal counts a fifth of a task operation", async (t) => {
  const s = await setup(t);
  await s.create("Keep me");
  const claimed = (await s.claim()).data;
  // Creating and claiming: two operations, 10 parts.
  assert.equal((await s.usage()).usage.tasks.used, 2);
  // Ten renewals are two operations, not ten.
  for (let i = 0; i < 10; i++) await s.update(claimed, { action: "progress" });
  const used = (await s.usage()).usage.tasks.used;
  assert.ok(used >= 4 && used <= 5, `${used} operations after 10 renewals`);
  // A renewal with a note posts a message, so it is a whole operation like any other update.
  const before = (await s.usage()).usage.tasks.used;
  await s.update(claimed, { action: "progress", note: "Halfway." });
  assert.ok((await s.usage()).usage.tasks.used >= before);
});

test("a bare renewal writes only the lease: the task's other columns, events and holders stay", async (t) => {
  const s = await setup(t, { taskBudgets: false });
  await s.create("Renew me");
  const claimed = (await s.claim()).data;
  const row = async () =>
    (
      await s.x.control(`board?server=${s.server.id}`, {
        action: "row",
        number: claimed.task.number,
      })
    ).json();
  const before = await row();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const renewed = await s.update(claimed, { action: "progress" });
  const after = await row();
  assert.ok(after.task.lease_expires_at > before.task.lease_expires_at, "the lease moved");
  assert.equal(renewed.data.lease.expiresAt, new Date(after.task.lease_expires_at).toISOString());
  const { lease_expires_at: _was, ...kept } = before.task;
  const { lease_expires_at: _now, ...still } = after.task;
  assert.deepEqual(still, kept, "nothing but the lease changed: revision and updated_at stay");
  assert.deepEqual([after.events, after.holders], [before.events, before.holders]);
  // The holder keeps working: the renewed claim still finishes.
  await s.update(claimed, { action: "complete", summary: "Done." });
});

test("Free's slow lane after the month is 1 task operation every 10 minutes", async (t) => {
  const s = await setup(t, {}, { taskMonthly: 1 });
  await s.claim();
  // The month's one operation is spent; the slow lane has one saved up, then 10 minutes a time.
  assert.equal((await s.claim()).data.claimed, false);
  const slowed = await s.claim({ next: {} }, true);
  assert.equal(slowed.error.code, "rate_limited");
  assert.ok(
    slowed.error.retryAfterSeconds > 500 && slowed.error.retryAfterSeconds <= 600,
    `${slowed.error.retryAfterSeconds}`,
  );
  assert.match(slowed.error.message, /slow lane: 1 every 10 minutes across the organization/);
  assert.match(slowed.error.message, /a lease renewal counts a fifth/);
});

test("past the month, task operations pass a slow lane; the refusal names the allowance, its reset and upgrading", async (t) => {
  const s = await setup(t, {}, { taskMonthly: 5, taskSlowPerMinute: 1 });
  for (let i = 0; i < 5; i++) await s.claim();
  // The month is spent; one slow-lane operation a minute still gets through.
  assert.equal((await s.claim()).data.claimed, false);
  const slowed = await s.claim({ next: {} }, true);
  assert.equal(slowed.error.code, "rate_limited");
  assert.equal(slowed.error.scope, "organization");
  assert.ok(
    slowed.error.retryAfterSeconds > 30 && slowed.error.retryAfterSeconds <= 60,
    `${slowed.error.retryAfterSeconds}`,
  );
  assert.match(slowed.error.message, /used the 5 task operations a month/);
  assert.match(slowed.error.message, /Free limits/);
  assert.match(slowed.error.message, /resets at \d{4}-\d\d-\d\dT/);
  assert.match(slowed.error.message, /1 a minute across the organization/);
  assert.match(slowed.error.message, /Upgrading to a larger plan raises the allowance/);
  const { usage } = await s.usage();
  assert.deepEqual([usage.tasks.used, usage.tasks.beyond], [5, 1]);
  // A refusal is remembered until its retry time: a refused loop costs no quota call.
  const before = await s.taskCalls();
  assert.equal((await s.create("Later", true)).error.code, "rate_limited");
  assert.equal(await s.taskCalls(), before);
  // Reads are not task operations, and messages still send.
  await s.call("read_tasks", { participantId: s.lead, mode: "list" });
  const board = await s.context();
  assert.deepEqual([board.taskOperations.used, board.taskOperations.limit], [5, 5]);
  // HTTP answers 429 with Retry-After from the same month.
  const response = await s.x.raw(`${s.root}/participants/${s.worker}/tasks/claim`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await s.x.token("user_alice")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ requestKey: randomUUID(), next: {} }),
  });
  assert.equal(response.status, 429, await response.clone().text());
  assert.ok(Number(response.headers.get("retry-after")) >= 1);
  assert.equal((await response.json()).error.scope, "organization");
});

test("owner-pilot organizations count no task operations and start with no claim cap", async (t) => {
  const id = randomUUID();
  const s = await setup(
    t,
    { taskLimits: true, freeClaimCap: true, unlimitedAccounts: [id] },
    { taskMonthly: 1, taskSlowPerMinute: 1 },
    id,
  );
  // Past the month's one operation and the agent's burst of 20, nothing is refused.
  for (let i = 0; i < 25; i++) assert.equal((await s.claim()).data.claimed, false);
  assert.equal(await s.taskCalls(), 0);
  const board = await s.context();
  assert.equal(board.taskOperations, undefined);
  assert.equal(board.claimCap, undefined);
});

test("budgets off: task operations are limited only per minute, as before", async (t) => {
  const s = await setup(t, { taskBudgets: false }, { taskMonthly: 1 });
  for (let i = 0; i < 5; i++) await s.claim();
  assert.equal(await s.taskCalls(), 0);
  assert.equal((await s.context()).taskOperations, undefined);
});

test("a task may be reopened 10 times; then it stays failed, for its owner agent and a person", async (t) => {
  const s = await setup(t, { taskBudgets: false });
  const task = (await s.create("Flaky")).data.tasks[0];
  const fail = async () => {
    const claimed = (await s.claim({ taskId: task.id })).data;
    await s.update(claimed, { action: "fail", summary: "Broke again" });
  };
  const reopen = (error = false) =>
    s.call(
      "update_task",
      { participantId: s.lead, requestKey: randomUUID(), taskId: task.id, action: "reopen" },
      error,
    );
  for (let round = 0; round < 10; round++) {
    await fail();
    assert.equal((await reopen()).data.task.state, "ready", `reopen ${round + 1}`);
  }
  await fail();
  const refused = await reopen(true);
  assert.deepEqual([refused.error.code, refused.error.state], ["task_state_conflict", "failed"]);
  assert.match(refused.error.message, /already reopened 10 times/);
  assert.match(refused.error.message, /Create a new task/);
  // A person's Reopen on the website is bound by the same count.
  const read = async () =>
    (await s.call("read_tasks", { participantId: s.lead, mode: "task", task: { id: task.id } }))
      .data;
  const dashboard = await website(s.x);
  const person = await dashboard("POST", `${s.root}/people/me/tasks/${task.id}/reopen`, {
    expectedRevision: (await read()).task.revision,
    requestKey: randomUUID(),
    note: "One more try.",
  });
  assert.equal(person.status, 409, JSON.stringify(person.json));
  assert.equal(person.json.error.code, "task_state_conflict");
  // The refused reopens added nothing: the task stays failed with exactly 10 reopens, and the
  // person's note was never posted.
  const after = await read();
  assert.equal(after.task.state, "failed");
  assert.equal(after.events.filter((event) => event.kind === "reopened").length, 10);
  assert.equal(after.thread.items.filter((message) => message.body === "One more try.").length, 0);
});

test("a new swarm server on Free starts with a claim cap of 4 its creator can change; a paid one starts with none", async (t) => {
  const x = await start(t, { board: true, freeClaimCap: true });
  const account = await x.account();
  const credential = await x.mcpToken(account.organizationId);
  const board = async (server) => {
    await x.mcp(credential, "register_participant", {
      serverId: server.id,
      name: "Lead",
      agentType: "codex",
      requestKey: randomUUID(),
    });
    return (await x.mcp(credential, "get_context", { serverId: server.id })).data.board;
  };
  const free = await x.server(account.id, { board: true });
  assert.equal((await board(free)).claimCap, 4);
  // Settings: the creator raises it, or removes it.
  const dashboard = await website(x);
  const raised = await dashboard("PUT", `/v1/servers/${free.id}/board`, {
    enabled: true,
    claimCap: 8,
  });
  assert.equal(raised.status, 200, JSON.stringify(raised.json));
  assert.equal(raised.json.data.claimCap, 8);
  const removed = await dashboard("PUT", `/v1/servers/${free.id}/board`, {
    enabled: true,
    claimCap: null,
  });
  assert.equal(removed.json.data.claimCap, undefined);
  // A paid organization's new swarm server starts with no cap.
  await x.db.batch([
    x.db
      .prepare(
        "INSERT INTO workspace_billing(account_id,provider_scope) VALUES(?,'test') ON CONFLICT DO NOTHING",
      )
      .bind(account.id),
    x.db
      .prepare(
        "INSERT INTO billing_periods(account_id,subscription_id,invoice_id,line_id,plan,plan_version,start,end,allowance) VALUES(?,?,?,?,'shop','test',?,?,40000)",
      )
      .bind(
        account.id,
        `sub_${account.id}`,
        `in_${account.id}`,
        `line_${account.id}`,
        new Date(Date.now() - 60000).toISOString(),
        new Date(Date.now() + 86400000).toISOString(),
      ),
  ]);
  const paid = await x.server(account.id, { board: true });
  assert.equal((await board(paid)).claimCap, undefined);
});
