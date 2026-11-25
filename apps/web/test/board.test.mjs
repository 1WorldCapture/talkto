import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createServer as createVite } from "vite";
import { start } from "../../server/test/platform-harness.mjs";
import { decode } from "./copy-rules.mjs";

/*
  The swarm server's Board (docs/swarm-server-spec.md, 9; board.tsx and board-model.ts): the
  summary's math, the three-row caps, the task list's tabs and filters, and Cancel. Rendering
  tests read a real swarm server through the dashboard's own routes.
*/

const modules = async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  return {
    vite,
    model: await vite.ssrLoadModule("/src/board-model.ts"),
    ui: {
      ...(await vite.ssrLoadModule("/src/session.tsx")),
      ...(await vite.ssrLoadModule("/src/dashboard.tsx")),
      ...(await vite.ssrLoadModule("/src/board.tsx")),
      ...(await vite.ssrLoadModule("/src/api.ts")),
    },
  };
};

const counts = (values = {}) => ({
  waiting: 0,
  ready: 0,
  claimed: 0,
  blocked: 0,
  completed: 0,
  failed: 0,
  canceled: 0,
  ...values,
});

test("the summary bar is proportional, in state order, and never loses a small state", async (t) => {
  const { model } = await modules(t);
  const large = counts({
    completed: 1284,
    failed: 52,
    claimed: 376,
    blocked: 1,
    ready: 1098,
    waiting: 1189,
  });
  const parts = model.barSegments(large);
  assert.deepEqual(
    parts.map((part) => part.key),
    ["done", "failed", "working", "needs", "ready", "waiting"],
  );
  const sum = parts.reduce((total, part) => total + part.share, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `shares add up to the whole bar (${sum})`);
  const needs = parts.find((part) => part.key === "needs");
  assert.equal(needs.count, 1);
  assert.ok(needs.share >= model.minShare, "one task of 4,000 still shows as a sliver");
  const done = parts.find((part) => part.key === "done");
  assert.ok(Math.abs(done.share - 1284 / 4000) < 0.002, "large parts stay close to proportional");
  // States without tasks are left out of the bar and the counts line.
  assert.deepEqual(
    model.barSegments(counts({ completed: 5, claimed: 2, ready: 2, waiting: 1 })).map((p) => p.key),
    ["done", "working", "ready", "waiting"],
  );
  assert.deepEqual(model.barSegments(counts()), []);
  assert.equal(model.totalOf(large), 4000);
  assert.equal(model.countWord("needs", 1), "needs you");
  assert.equal(model.countWord("needs", 3), "need you");
  assert.equal(model.countWord("ready", 3), "ready");
});

test("the agent line counts agents, stalled and idle, and never estimates time left", async (t) => {
  const { model } = await modules(t);
  assert.equal(
    model.agentSummary({ total: 400, working: 376, stalled: 14, idle: 24 }),
    "400 agents · 14 stalled · 24 idle",
  );
  assert.equal(
    model.agentSummary({ total: 20, working: 17, stalled: 2, idle: 3 }),
    "20 agents · 2 stalled · 3 idle",
  );
  assert.equal(
    model.agentSummary({ total: 2, working: 2, stalled: 0, idle: 0 }),
    "2 agents · both working",
  );
  assert.equal(
    model.agentSummary({ total: 5, working: 5, stalled: 0, idle: 0 }),
    "5 agents · all working",
  );
  assert.equal(
    model.agentSummary({ total: 3, working: 0, stalled: 0, idle: 3 }),
    "3 agents · all idle",
  );
  assert.equal(
    model.agentSummary({ total: 1, working: 1, stalled: 0, idle: 0 }),
    "1 agent · working",
  );
  assert.equal(model.agentSummary({ total: 0, working: 0, stalled: 0, idle: 0 }), "No agents yet");
});

test("Stalled and Failed cap at three rows and count the rest", async (t) => {
  const { model } = await modules(t);
  assert.equal(model.exceptionRows, 3);
  assert.equal(model.moreCount(14, 3), 11);
  assert.equal(model.moreCount(52, 3), 49);
  assert.equal(model.moreCount(2, 2), 0);
  const row = {
    attempts: 1,
    maxAttempts: 3,
    lastNoteAt: "2026-11-24T14:00:00.000Z",
    updatedAt: "",
  };
  assert.equal(model.attemptLabel(row), "attempt 2 of 3");
  assert.equal(model.attemptLabel({ attempts: 5, maxAttempts: 3 }), "attempt 3 of 3");
  const now = new Date("2026-11-24T14:18:30.000Z").getTime();
  // Silent past its lease: red "No update", rolled up to hours and days.
  assert.deepEqual(model.silenceLabel({ ...row, silent: true }, now), {
    text: "No update 18 min",
    silent: true,
  });
  assert.equal(
    model.silenceLabel({ ...row, silent: true, lastNoteAt: "2026-11-23T16:54:00.000Z" }, now).text,
    "No update 21 h",
  );
  assert.equal(
    model.silenceLabel({ ...row, silent: true, lastNoteAt: "2026-11-20T14:00:00.000Z" }, now).text,
    "No update 4 d",
  );
  // A retry within its lease reads as the attempt it is on, not yet as silence.
  assert.deepEqual(model.silenceLabel({ ...row, silent: false }, now), {
    text: "Attempt 2 of 3",
    silent: false,
  });
  assert.equal(model.silenceFor(59), "59 min");
  assert.equal(model.silenceFor(60), "1 h");
  assert.equal(model.silenceFor(1_440), "1 d");
});

test("small boards open on All without filters; past one page, Open with state, agent and label", async (t) => {
  const { model } = await modules(t);
  const small = counts({ completed: 5, claimed: 2, ready: 2, waiting: 1 });
  assert.deepEqual(
    model.tabsFor(small).map((tab) => [tab.key, tab.count]),
    [
      ["all", 10],
      ["open", 5],
      ["done", 5],
    ],
  );
  assert.equal(model.defaultTab(10), "all");
  assert.equal(model.showsFilters(10), false);
  assert.equal(model.showsFilters(50), false);
  // A small board with failures shows the Failed tab too.
  assert.deepEqual(
    model.tabsFor(counts({ completed: 1, failed: 1 })).map((tab) => tab.key),
    ["all", "open", "done", "failed"],
  );
  const medium = counts({
    completed: 86,
    failed: 4,
    claimed: 17,
    blocked: 3,
    ready: 41,
    waiting: 49,
  });
  assert.deepEqual(
    model.tabsFor(medium).map((tab) => [tab.key, tab.count]),
    [
      ["open", 110],
      ["done", 86],
      ["failed", 4],
    ],
  );
  assert.equal(model.defaultTab(200), "open");
  assert.equal(model.showsFilters(51), true);
  // A URL's tab is kept only where the board offers it.
  assert.equal(model.chosenTab("all", medium), "open");
  assert.equal(model.chosenTab("done", medium), "done");
  assert.equal(model.chosenTab(undefined, small), "all");
  // A state filter reads every view, so canceled tasks are found from any tab.
  assert.deepEqual(model.listInput({ tab: "open", state: "canceled" }), {
    view: "all",
    state: "canceled",
    agentId: undefined,
    label: undefined,
    q: undefined,
  });
  assert.equal(model.listInput({ tab: "done" }).view, "done");
  // Stalled (Stalled's "N more") is its own view, with no stored state.
  assert.deepEqual(model.listInput({ tab: "open", state: "stalled" }), {
    view: "stalled",
    state: undefined,
    agentId: undefined,
    label: undefined,
    q: undefined,
  });
  // Clicking a count opens the list it counts.
  assert.deepEqual(model.countFilter("working"), { tab: "open", state: "claimed" });
  assert.deepEqual(model.countFilter("failed"), { tab: "failed" });
  // Deep lists wait for the person instead of re-reading every page on each change.
  assert.equal(model.refreshesItself(2), true);
  assert.equal(model.refreshesItself(3), false);
});

test("rows read their state, agent and task number as the list shows them", async (t) => {
  const { model } = await modules(t);
  assert.deepEqual(model.rowState({ state: "claimed", stalled: true }), {
    label: "No update",
    swatch: "stalled",
    tone: "bad",
  });
  assert.equal(model.rowState({ state: "claimed", stalled: false }).label, "Working");
  // A retry within its lease is not yet "No update".
  assert.deepEqual(
    model.rowState({ state: "claimed", stalled: true, silent: false, attempts: 1, maxAttempts: 3 }),
    { label: "Attempt 2 of 3", swatch: "working", tone: "plain" },
  );
  assert.equal(
    model.rowState({ state: "claimed", stalled: true, silent: true, attempts: 1, maxAttempts: 3 })
      .label,
    "No update",
  );
  // Long names shorten in the middle, so names that differ only at the end still differ.
  assert.deepEqual(model.nameParts("worker"), ["worker", ""]);
  assert.deepEqual(model.nameParts("payments-migration-worker-agent-instance-01"), [
    "payments-migration-worker-agent-ins",
    "tance-01",
  ]);
  assert.equal(model.rowState({ state: "blocked", stalled: false }).tone, "you");
  assert.equal(model.rowState({ state: "completed", stalled: false }).label, "Done");
  // The Agent column: unfinished tasks keep holder, then assignee, then "Any worker".
  const agent = (row) => model.rowWorkers(row);
  assert.deepEqual(agent({ state: "ready" }), { agent: null, others: [] }, "Any worker");
  assert.deepEqual(agent({ state: "ready", assigneeId: "a", earlierHolderIds: ["w3"] }), {
    agent: "a",
    others: [],
  });
  assert.deepEqual(
    agent({ state: "claimed", holderId: "h", assigneeId: "a", earlierHolderIds: ["w3"] }),
    {
      agent: "h",
      others: [],
    },
  );
  // Finished: the agent that finished it, "+N" for those that held it before.
  assert.deepEqual(agent({ state: "completed", finishedById: "w1", earlierHolderIds: ["w3"] }), {
    agent: "w1",
    others: ["w3"],
  });
  assert.deepEqual(agent({ state: "canceled", finishedById: "lead" }), {
    agent: "lead",
    others: [],
  });
  // No agent finished it: its latest holder, or nobody if none ever held it.
  assert.deepEqual(agent({ state: "failed", earlierHolderIds: ["w2", "w1"] }), {
    agent: "w2",
    others: ["w1"],
  });
  assert.deepEqual(agent({ state: "canceled" }), { agent: null, others: [] });
  assert.equal(model.parseTaskNumber("T-14"), 14);
  assert.equal(model.parseTaskNumber("14"), 14);
  assert.equal(model.parseTaskNumber("T-0"), null);
  assert.equal(model.parseTaskNumber("x"), null);
  assert.equal(model.parseTaskNumber(undefined), null);
});

/** A person signed in on the website: their session cookie. */
const signIn = async (app) => {
  const flow = await app.browserLogin("user_alice");
  return (await flow.callback()).headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-talkto-session="))
    .split(";")[0];
};

/**
 * A swarm server with a lead and a worker: eight tasks, four failed by the worker, one claimed,
 * three ready. Read back through the dashboard's routes.
 */
const seeded = async (t) => {
  const app = await start(t, { board: true, manualAlarms: true });
  const account = await app.account();
  const server = await app.server(account.id, { name: "Swarm", board: true });
  const credential = await app.mcpToken(account.organizationId);
  const call = (name, args) =>
    app.mcp(credential, name, { serverId: server.id, requestKey: randomUUID(), ...args });
  const lead = (await call("register_participant", { name: "lead", agentType: "claude-code" })).data
    .item.id;
  const worker = (await call("register_participant", { name: "worker", agentType: "codex" })).data
    .item.id;
  const tasks = (
    await call("create_tasks", {
      participantId: lead,
      tasks: Array.from({ length: 8 }, (_, i) => ({
        title: `Task number ${i + 1}`,
        brief: `Do task ${i + 1}.`,
        labels: ["web"],
      })),
    })
  ).data.tasks;
  for (const task of tasks.slice(0, 4)) {
    const claimed = (await call("claim_task", { participantId: worker, taskId: task.id })).data;
    await call("update_task", {
      participantId: worker,
      taskId: task.id,
      leaseToken: claimed.lease.token,
      epoch: claimed.lease.epoch,
      action: "fail",
      summary: `Reason ${task.number}`,
    });
  }
  await call("claim_task", { participantId: worker, taskId: tasks[4].id });
  const cookie = await signIn(app);
  const read = async (path) =>
    (await app.raw(path, { headers: { cookie, origin: "https://talkto.test" } })).json();
  const root = `/v1/servers/${server.id}`;
  return {
    app,
    account,
    server,
    tasks,
    cookie,
    call,
    lead,
    worker,
    board: await read(`${root}/board`),
    list: await read(`${root}/board/tasks?view=all&limit=50`),
    labels: await read(`${root}/board/labels`),
    detail: await read(`${root}/board/tasks/5`),
    me: await read("/v1/me"),
    context: await app.call("user_alice", "GET", `/v1/accounts/${account.id}`),
    managed: await app.call("user_alice", "GET", `/v1/accounts/${account.id}/servers/${server.id}`),
  };
};

/** Render the dashboard at `path` (under the server) over a cache seeded by `seed(set, scope)`. */
const page = (t, ui, fixture, path, seed) =>
  render(
    t,
    ui,
    fixture,
    `/app/accounts/${fixture.account.id}/servers/${fixture.server.id}${path}`,
    seed,
  );

/** Render the dashboard at the /app `location` over a cache seeded by `seed(set, scope)`. */
const render = async (t, ui, fixture, location, seed) => {
  const services = ui.createServices("https://talkto.test");
  t.after(() => services.queries.clear());
  const user = fixture.me.data.user;
  const scope = ["human", user.id, fixture.account.id, fixture.server.id];
  services.queries.setQueryData(["session"], fixture.me);
  services.queries.setQueryData(["human", user.id, fixture.account.id, "account"], {
    data: fixture.context,
  });
  services.queries.setQueryData([...scope, "management"], { data: fixture.managed });
  seed((key, value) => services.queries.setQueryData(key, value), scope);
  const root = createRootRoute({ validateSearch: (input) => input });
  const route = createRoute({
    getParentRoute: () => root,
    path: "/app/$",
    component: () => createElement(ui.Dashboard),
  });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({
      initialEntries: [location],
    }),
  });
  await router.load();
  return decode(
    renderToStaticMarkup(
      createElement(
        ui.Services.Provider,
        { value: services },
        createElement(
          QueryClientProvider,
          { client: services.queries },
          createElement(
            ui.Human.Provider,
            { value: user },
            createElement(RouterProvider, { router }),
          ),
        ),
      ),
    ).replaceAll("<!-- -->", ""),
  );
};

/** The Board's top as the dashboard keeps it. */
const top = (reply, change = (data) => data) => ({
  ...change(reply.data),
  participants: reply.included.participants,
});
const pages = (reply) => ({ pages: [reply], pageParams: [""] });

test("the Board renders the summary, caps Failed at three and lists every task of a small board", async (t) => {
  const fixture = await seeded(t);
  const { ui } = await modules(t);
  assert.equal(fixture.me.data.connection.boards, true);
  assert.equal(fixture.managed.board, true);
  const html = await page(t, ui, fixture, "?tab=board", (set, scope) => {
    set([...scope, "board"], top(fixture.board));
    set([...scope, "board-tasks", { view: "all" }], pages(fixture.list));
  });
  assert.ok(html.includes(">Board</a>"), "the Board tab is in the server navigation");
  assert.ok(html.includes("0 of 8 tasks done"));
  assert.ok(html.includes("0 finished in the last hour"));
  assert.ok(!/left|remaining|ETA/i.test(html.match(/aria-label="Progress"[\s\S]*?<\/section>/)[0]));
  assert.ok(html.includes("<b>4</b> failed"));
  assert.ok(html.includes("<b>1</b> working"));
  assert.ok(html.includes("<b>3</b> ready"));
  assert.ok(html.includes("2 agents · 1 idle"));
  // Failed: the latest three, then "1 more"; nothing is stalled.
  assert.ok(html.includes("Reason 4"));
  assert.ok(html.includes("Reason 2"));
  assert.ok(!html.includes("Reason 1"), "the fourth failure waits behind 1 more");
  assert.ok(html.includes(">1 more</button>"));
  // Each shown failure offers Retry beside its link, never inside it.
  for (const n of [4, 3, 2]) assert.ok(html.includes(`aria-label="Retry T-${n}">Retry</button>`));
  assert.ok(!html.includes('aria-label="Retry T-1"'));
  assert.ok(!/<a [^>]*>(?:(?!<\/a>).)*<button/s.test(html), "no button inside a link");
  assert.ok(html.includes("Nothing stalled"));
  // The task list: All by default, no filters at eight tasks, every task listed.
  assert.ok(html.includes('aria-pressed="true">All<b>8</b>'));
  assert.ok(html.includes("Open<b>4</b>"));
  assert.ok(html.includes("Failed<b>4</b>"));
  assert.ok(html.includes('placeholder="Find tasks"'));
  assert.ok(!html.includes('aria-label="State"'), "no filters on a small board");
  for (let n = 1; n <= 8; n++) assert.ok(html.includes(`>T-${n}<`), `T-${n}`);
  assert.ok(html.includes("Any worker"), "unassigned ready tasks");
  assert.ok(html.includes(">worker</span>"), "the holder by name");
  // Pink is kept for what needs a person: nothing here needs one.
  assert.ok(!html.includes("k-needs"));
  assert.ok(!html.includes("Needs you"));
});

test("both lists empty collapse to one line; a board past one page opens on Open with filters", async (t) => {
  const fixture = await seeded(t);
  const { ui } = await modules(t);
  const calm = await page(t, ui, fixture, "?tab=board", (set, scope) => {
    set(
      [...scope, "board"],
      top(fixture.board, (data) => ({
        ...data,
        failed: { items: [], total: 0 },
        counts: { ...data.counts, failed: 0, completed: 4 },
      })),
    );
    set([...scope, "board-tasks", { view: "all" }], pages(fixture.list));
  });
  assert.ok(calm.includes("Nothing stalled or failed"));
  assert.ok(!calm.includes(">Stalled</h3>"));
  const large = await page(t, ui, fixture, "?tab=board", (set, scope) => {
    set(
      [...scope, "board"],
      top(fixture.board, (data) => ({
        ...data,
        total: 208,
        counts: { ...data.counts, ready: 203 },
      })),
    );
    set([...scope, "board-tasks", { view: "open" }], pages(fixture.list));
    set([...scope, "board-labels"], fixture.labels);
  });
  assert.ok(large.includes('aria-pressed="true">Open<b>204</b>'));
  assert.ok(!large.includes(">All<b>"), "no All tab past one page");
  for (const label of ["State", "Agent", "Label"])
    assert.ok(large.includes(`aria-label="${label}"`), label);
  assert.deepEqual(fixture.labels.data, { items: ["web"], more: false });
  assert.ok(large.includes('<option value="web">web</option>'), "the board's labels");
  // The agent filter is a search box the server answers, not a list of the first 100 agents.
  assert.match(large, /<input type="search" class="board-agent-filter" aria-label="Agent"/);
  // A state filter from the URL reads every view and is selected in its control.
  const filtered = await page(t, ui, fixture, "?tab=board&state=failed", (set, scope) => {
    set(
      [...scope, "board"],
      top(fixture.board, (data) => ({
        ...data,
        total: 208,
        counts: { ...data.counts, ready: 203 },
      })),
    );
    set([...scope, "board-tasks", { view: "all", state: "failed" }], pages(fixture.list));
  });
  assert.ok(filtered.includes('<option value="failed" selected="">Failed</option>'));
  assert.ok(!filtered.includes('aria-pressed="true"'), "a state filter takes over from the tabs");
});

test("a switched-off board stays readable with a banner and no Cancel", async (t) => {
  const fixture = await seeded(t);
  const { ui } = await modules(t);
  const html = await page(t, ui, fixture, "?tab=board", (set, scope) => {
    set(
      [...scope, "board"],
      top(fixture.board, (data) => ({ ...data, enabled: false })),
    );
    set([...scope, "board-tasks", { view: "all" }], pages(fixture.list));
  });
  assert.ok(html.includes("The board is off."));
  assert.ok(html.includes("Turn it on in Settings."));
  assert.ok(!html.includes(">Retry</button>"), "no Retry while the board is off");
  const task = await page(t, ui, fixture, "/board/T-5", (set, scope) => {
    set(
      [...scope, "board"],
      top(fixture.board, (data) => ({ ...data, enabled: false })),
    );
    set([...scope, "board-task", 5], fixture.detail);
  });
  assert.ok(task.includes("Task number 5"));
  assert.ok(!task.includes("Cancel task"));
});

test("the task page shows the thread and offers Cancel only while the task is unfinished", async (t) => {
  const fixture = await seeded(t);
  const { ui } = await modules(t);
  const html = await page(t, ui, fixture, "/board/T-5", (set, scope) => {
    set([...scope, "board"], top(fixture.board));
    set([...scope, "board-task", 5], fixture.detail);
  });
  assert.ok(html.includes(">T-5</span>Task number 5"));
  assert.ok(html.includes("Do task 5."), "the brief opens the thread");
  assert.ok(html.includes("· Brief") || html.includes(">Brief<"));
  assert.ok(html.includes(">Cancel task</button>"));
  assert.ok(!html.includes(">Retry</button>"), "Retry is for failed tasks only");
  assert.ok(html.includes("Claimed by worker"));
  assert.ok(html.includes("1 of 3"), "the running attempt");
  assert.ok(html.includes("<dt>Last update</dt>"), "the holder's last update is its own field");
  const failed = await read(fixture, 1);
  const done = await page(t, ui, fixture, "/board/T-1", (set, scope) => {
    set([...scope, "board"], top(fixture.board));
    set([...scope, "board-task", 1], failed);
  });
  assert.ok(done.includes("Reason 1"), "the failure's reason");
  assert.ok(!done.includes("Cancel task"));
  assert.ok(done.includes(">Retry</button>"), "a failed task offers Retry");
  assert.ok(done.includes("<h3>Attempts</h3><p>1 of 3</p>"), "the attempt that failed counts");
});

const read = async (fixture, number) =>
  (
    await fixture.app.raw(`/v1/servers/${fixture.server.id}/board/tasks/${number}`, {
      headers: { cookie: fixture.cookie, origin: "https://talkto.test" },
    })
  ).json();

test("Cancel sends the task's revision: a stale one is refused, the current one cancels", async (t) => {
  const fixture = await seeded(t);
  const { vite } = await modules(t);
  const { createApi, request, ApiError } = await vite.ssrLoadModule("/src/api.ts");
  // The browser client against the real Worker, as the website session.
  const proxy = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await fixture.app.raw(req.url, {
      method: req.method,
      headers: {
        cookie: fixture.cookie,
        origin: "https://talkto.test",
        "content-type": "application/json",
      },
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    proxy.closeAllConnections();
    proxy.close();
  });
  const api = createApi(`http://127.0.0.1:${proxy.address().port}`);
  const serverId = fixture.server.id;
  const detail = await request(
    api.server.getBoardTask({ params: { serverId, task: 5 }, query: {} }),
  );
  const task = detail.data.task;
  assert.equal(task.state, "claimed");
  const cancel = (expectedRevision, requestKey = randomUUID()) =>
    request(
      api.server.cancelTask({
        params: { serverId, taskId: task.id },
        payload: { expectedRevision, requestKey, reason: "Changed plans." },
      }),
    );
  await assert.rejects(
    cancel(task.revision + 1),
    (error) => error instanceof ApiError && error.code === "revision_conflict",
  );
  const canceled = await cancel(task.revision);
  assert.equal(canceled.data.task.state, "canceled");
  assert.equal(canceled.data.task.outcome.reason, "by_person");
  const after = await request(
    api.server.getBoardTask({ params: { serverId, task: 5 }, query: {} }),
  );
  assert.ok(after.data.thread.items.some((message) => message.body === "Changed plans."));
  // A finished task refuses another cancel.
  await assert.rejects(
    cancel(after.data.task.revision),
    (error) => error instanceof ApiError && error.code === "task_state_conflict",
  );
});

test("Retry's words: where the task goes, how many tasks come back, and what happened", async (t) => {
  const { model, ui } = await modules(t);
  const plan = model.retryPlan({
    needs: [{ state: "completed" }],
    neededBy: [
      { state: "canceled" },
      { state: "canceled" },
      { state: "canceled" },
      { state: "completed" },
    ],
  });
  assert.deepEqual(plan, { waits: false, back: 3 });
  assert.equal(
    model.retryQuestion(90, plan),
    "Retry T-90? It goes back to the queue, and 3 tasks waiting on it come back too.",
  );
  assert.equal(
    model.retryQuestion(90, { waits: false, back: 1 }),
    "Retry T-90? It goes back to the queue, and 1 task waiting on it comes back too.",
  );
  assert.equal(
    model.retryQuestion(90, { waits: false, back: 0 }),
    "Retry T-90? It goes back to the queue.",
  );
  // Attempts count expired leases, plus the claim running now or the one that ended the task.
  const used = (task) => model.attemptsUsed({ maxAttempts: 3, ...task });
  assert.equal(used({ attempts: 0, state: "ready" }), 0);
  assert.equal(used({ attempts: 0, state: "claimed", claim: {} }), 1);
  assert.equal(used({ attempts: 0, state: "failed" }), 1);
  assert.equal(used({ attempts: 3, state: "failed" }), 3);
  assert.equal(used({ attempts: 1, state: "canceled" }), 1);
  const waits = model.retryPlan({ needs: [{ state: "ready" }], neededBy: [] });
  assert.equal(model.retryQuestion(7, waits), "Retry T-7? It waits for the tasks it needs again.");
  assert.equal(
    model.retriedNotice({ task: { number: 90, state: "ready" }, reopened: [{}, {}, {}] }),
    "T-90 is back in the queue. 3 tasks waiting on it came back too.",
  );
  assert.equal(
    model.retriedNotice({ task: { number: 7, state: "waiting" } }),
    "T-7 is waiting for the tasks it needs.",
  );
  // The timeline names who retried or canceled, and says why when the system moved a task.
  const name = (id) => (id === "lead-id" ? "lead" : undefined);
  const agent = { kind: "agent", participantId: "lead-id" };
  assert.equal(
    ui.eventText({ kind: "reopened", reason: "by_owner", actor: agent }, name),
    "Retried by lead",
  );
  assert.equal(
    ui.eventText(
      { kind: "reopened", reason: "by_person", actor: { kind: "person", name: "Alice" } },
      name,
    ),
    "Retried by Alice",
  );
  assert.equal(
    ui.eventText({ kind: "canceled", reason: "by_owner", actor: agent }, name),
    "Canceled by lead",
  );
  assert.equal(
    ui.eventText({ kind: "reopened", reason: "need_reopened", actor: { kind: "system" } }, name),
    "Waiting again: a task it needs was retried",
  );
  assert.equal(
    ui.eventText({ kind: "canceled", reason: "need_failed", actor: { kind: "system" } }, name),
    "Canceled: a task it needs failed",
  );
});

/** Render one element with the dashboard's providers over a cache seeded by `seed(set, scope)`. */
const element = (t, ui, fixture, node, seed) => {
  const services = ui.createServices("https://talkto.test");
  t.after(() => services.queries.clear());
  const user = fixture.me.data.user;
  seed(
    (key, value) => services.queries.setQueryData(key, value),
    ["human", user.id, fixture.account.id, fixture.server.id],
  );
  return decode(
    renderToStaticMarkup(
      createElement(
        ui.Services.Provider,
        { value: services },
        createElement(
          QueryClientProvider,
          { client: services.queries },
          createElement(ui.Human.Provider, { value: user }, node),
        ),
      ),
    ).replaceAll("<!-- -->", ""),
  );
};

test("Retry asks first, sends the task's revision, and brings back the tasks its failure canceled", async (t) => {
  const fixture = await seeded(t);
  const { vite, ui, model } = await modules(t);
  const { createApi, request, ApiError } = await vite.ssrLoadModule("/src/api.ts");
  // T-9, and below it T-10 and T-11 (both need T-9) and T-12 (needs T-10). Failing T-9 cancels all three.
  const made = (
    await fixture.call("create_tasks", {
      participantId: fixture.lead,
      tasks: [
        { ref: "a", title: "Root", brief: "Root." },
        { ref: "b", title: "Below", brief: "Below.", needs: [{ ref: "a" }] },
        { title: "Beside", brief: "Beside.", needs: [{ ref: "a" }] },
        { title: "Deeper", brief: "Deeper.", needs: [{ ref: "b" }] },
      ],
    })
  ).data.tasks;
  const root = made[0];
  const claimed = (
    await fixture.call("claim_task", { participantId: fixture.worker, taskId: root.id })
  ).data;
  const failed = (
    await fixture.call("update_task", {
      participantId: fixture.worker,
      taskId: root.id,
      leaseToken: claimed.lease.token,
      epoch: claimed.lease.epoch,
      action: "fail",
      summary: "Flaky",
    })
  ).data;
  assert.equal(failed.canceled.length, 3);
  const detail = await read(fixture, root.number);
  assert.equal(detail.data.task.state, "failed");
  // The dialog reads the task and says what Retry will do before anything is sent.
  const dialog = element(
    t,
    ui,
    fixture,
    createElement(ui.RetryTaskDialog, {
      accountId: fixture.account.id,
      serverId: fixture.server.id,
      number: root.number,
      close: () => {},
      done: () => {},
    }),
    (set, scope) => set([...scope, "board-task", root.number], detail),
  );
  // The title asks; the text says what happens, once.
  assert.ok(dialog.includes(`>Retry T-${root.number}?</`));
  assert.ok(
    dialog.includes(
      "<p>It goes back to the queue, and 2 tasks waiting on it come back too. Its attempts start over.</p>",
    ),
  );
  assert.ok(dialog.includes(">Retry task</button>"));
  assert.ok(dialog.includes(">Not now</button>"));
  // The browser client against the real Worker, as the website session.
  const proxy = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await fixture.app.raw(req.url, {
      method: req.method,
      headers: {
        cookie: fixture.cookie,
        origin: "https://talkto.test",
        "content-type": "application/json",
      },
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    proxy.closeAllConnections();
    proxy.close();
  });
  const api = createApi(`http://127.0.0.1:${proxy.address().port}`);
  const serverId = fixture.server.id;
  const task = detail.data.task;
  const reopen = (expectedRevision, requestKey = randomUUID()) =>
    request(
      api.server.reopenTask({
        params: { serverId, taskId: task.id },
        payload: { expectedRevision, requestKey, note: "Try once more." },
      }),
    );
  await assert.rejects(
    reopen(task.revision + 1),
    (error) => error instanceof ApiError && error.code === "revision_conflict",
  );
  const result = await reopen(task.revision);
  assert.equal(result.data.task.state, "ready");
  assert.equal(result.data.task.attempts, 0);
  // Every task the failure canceled waits again, the one two levels down too.
  assert.deepEqual(
    result.data.reopened.map((item) => [item.number, item.state]).toSorted(),
    made.slice(1).map((item) => [item.number, "waiting"]),
  );
  assert.equal(
    model.retriedNotice(result.data),
    `T-${root.number} is back in the queue. 3 tasks waiting on it came back too.`,
  );
  // A task that is no longer failed refuses another Retry.
  await assert.rejects(
    reopen(result.data.task.revision),
    (error) => error instanceof ApiError && error.code === "task_state_conflict",
  );
  // The task page shows the note, the person's Retry, and no Retry button any more.
  const after = await read(fixture, root.number);
  const board = await (
    await fixture.app.raw(`/v1/servers/${serverId}/board`, {
      headers: { cookie: fixture.cookie, origin: "https://talkto.test" },
    })
  ).json();
  const html = await page(t, ui, fixture, `/board/T-${root.number}`, (set, scope) => {
    set([...scope, "board"], top(board));
    set([...scope, "board-task", root.number], after);
  });
  assert.ok(html.includes("Try once more."));
  assert.match(html, /Retried by [^<]+</);
  assert.ok(!html.includes(">Retry</button>"));
  assert.ok(html.includes(">Cancel task</button>"));
  const below = await read(fixture, made[1].number);
  const belowHtml = await page(t, ui, fixture, `/board/T-${made[1].number}`, (set, scope) => {
    set([...scope, "board"], top(board));
    set([...scope, "board-task", made[1].number], below);
  });
  assert.ok(belowHtml.includes("Canceled: a task it needs failed"));
  assert.ok(belowHtml.includes("Waiting again: a task it needs was retried"));
});

test("a finished row names the agent that finished it, and +N opens the agents that held it before", async (t) => {
  const fixture = await seeded(t);
  const { ui } = await modules(t);
  // T-9: the worker's lease runs out, then the lead claims it and completes it.
  const [task] = (
    await fixture.call("create_tasks", {
      participantId: fixture.lead,
      tasks: [{ title: "Handed over", brief: "Hand over." }],
    })
  ).data.tasks;
  await fixture.call("claim_task", { participantId: fixture.worker, taskId: task.id });
  const expired = await fixture.app.control(`board?server=${fixture.server.id}`, {
    action: "expire",
    number: task.number,
  });
  assert.equal(expired.status, 200);
  const claimed = (
    await fixture.call("claim_task", { participantId: fixture.lead, taskId: task.id })
  ).data;
  await fixture.call("update_task", {
    participantId: fixture.lead,
    taskId: task.id,
    leaseToken: claimed.lease.token,
    epoch: claimed.lease.epoch,
    action: "complete",
    summary: "Done",
  });
  const root = `/v1/servers/${fixture.server.id}`;
  const get = async (path) =>
    (
      await fixture.app.raw(path, {
        headers: { cookie: fixture.cookie, origin: "https://talkto.test" },
      })
    ).json();
  const list = await get(`${root}/board/tasks?view=all&limit=50`);
  const row = list.data.items.find((item) => item.number === task.number);
  assert.deepEqual([row.finishedById, row.earlierHolderIds], [fixture.lead, [fixture.worker]]);
  const html = await page(t, ui, fixture, "?tab=board", (set, scope) => {
    set([...scope, "board"], top(fixture.board));
    set([...scope, "board-tasks", { view: "all" }], pages(list));
  });
  const cells = html.split('<li class="board-tr').slice(1);
  const of = (number) => cells.find((cell) => cell.includes(`>T-${number}<`)) ?? "";
  // The lead finished it; "+1" is a button that shows the worker, closed until pressed.
  const handed = of(task.number);
  assert.match(handed, /<span class="board-who" title="lead">/);
  assert.match(
    handed,
    /<span class="board-name"><span class="board-name-head">lead<\/span><\/span>/,
  );
  assert.match(
    handed,
    /<button type="button" class="board-held" aria-expanded="false"[^>]*title="Also held by worker"[^>]*>\+1<span class="sr-only"> other agent held it<\/span><\/button>/,
  );
  assert.match(
    handed,
    /<ul id="[^"]+" class="board-held-list" aria-label="Also held by" hidden="">[\s\S]*worker[\s\S]*<\/ul>/,
  );
  // The title is the row's link, and the button is not inside it.
  assert.match(handed, /<a [^>]*class="board-t board-row-link"[^>]*>Handed over<\/a>/);
  // A task the worker failed names the worker, with no +N.
  assert.match(
    of(1),
    /<span class="board-name"><span class="board-name-head">worker<\/span><\/span>/,
  );
  assert.ok(!of(1).includes("board-held"));
  // An open task keeps today's rule.
  assert.ok(of(6).includes("Any worker"));
});

test("a finished task held by many agents shows five of them, then links to the task for the rest", async (t) => {
  const fixture = await seeded(t);
  const { ui } = await modules(t);
  const [finished] = fixture.list.data.items.filter((item) => item.state === "failed");
  const base = fixture.list.included.participants[0];
  const held = Array.from({ length: 7 }, (_, index) => ({
    ...base,
    id: `${base.id.slice(0, -2)}${String(index).padStart(2, "0")}`,
    name: `held-${index}`,
  }));
  const list = {
    ...fixture.list,
    data: {
      ...fixture.list.data,
      items: [{ ...finished, earlierHolderIds: held.map((item) => item.id) }],
    },
    included: {
      ...fixture.list.included,
      participants: [...fixture.list.included.participants, ...held],
    },
  };
  const html = await page(t, ui, fixture, "?tab=board", (set, scope) => {
    set([...scope, "board"], top(fixture.board));
    set([...scope, "board-tasks", { view: "all" }], pages(list));
  });
  const row = html
    .split('<li class="board-tr')
    .slice(1)
    .find((cell) => cell.includes(`>T-${finished.number}<`));
  const opened = row.slice(row.indexOf('class="board-held-list"'));
  assert.equal((opened.match(/class="board-who"/g) ?? []).length, 5);
  assert.match(opened, /<a [^>]*class="board-held-more"[^>]*>and 2 more<\/a>/);
  // Hovering "+7" names all seven.
  assert.match(row, /title="Also held by held-0, held-1, held-2, held-3, held-4, held-5, held-6"/);
});

// Task results (docs/swarm-task-results-scope.md, 6): the Result panel, thread chips and counts.

test("result counts, link text and host names read as the panel and the Board show them", async (t) => {
  const { model } = await modules(t);
  assert.equal(model.resultCount({}), "");
  assert.equal(model.resultCount({ resultFiles: 1 }), "1 file");
  assert.equal(model.resultCount({ resultFiles: 2, resultLinks: 3 }), "2 files · 3 links");
  assert.equal(model.resultCount({ resultLinks: 1 }), "1 link");
  assert.equal(model.eventResult({}), "");
  assert.equal(model.eventResult({ files: [{}, {}], links: [{}, {}, {}] }), "2 files, 3 links");
  assert.equal(model.linkHost("https://github.com/acme/app/pull/412"), "github.com");
  // A label never hides where a link goes: the host is read from the URL, not the label.
  const misleading = { kind: "url", url: "https://evil.example/x", label: "github.com" };
  assert.equal(model.linkText(misleading), "github.com");
  assert.equal(model.linkHost(misleading.url), "evil.example");
  assert.equal(model.linkText({ kind: "pr", url: "https://github.com/a/b/pull/9" }), "/a/b/pull/9");
  assert.equal(
    model.linkText({ kind: "url", url: "https://staging.example.com/" }),
    "staging.example.com",
  );
  assert.equal(model.linkText({ kind: "branch", name: "task-14" }), "task-14");
  assert.equal(model.linkText({ kind: "commit", sha: "1a2b3c4d".padEnd(40, "0") }), "1a2b3c4");
  assert.equal(model.shortHash("3f9a".padEnd(60, "0") + "c21e"), "3f9a…c21e");
  const links = [
    { kind: "url", url: "https://e.com/" },
    { kind: "commit", role: "head", sha: "9".repeat(40) },
    { kind: "branch", name: "task-14" },
    { kind: "commit", role: "base", sha: "1".repeat(40) },
    { kind: "commit", sha: "5".repeat(40) },
    { kind: "pr", url: "https://github.com/a/b/pull/1" },
  ];
  const code = model.resultCode(links);
  assert.equal(code.base.sha, "1".repeat(40));
  assert.equal(code.head.sha, "9".repeat(40));
  assert.deepEqual(
    code.code.map((link) => link.kind),
    ["branch", "commit"],
  );
  assert.deepEqual(
    code.other.map((link) => link.kind),
    ["url", "pr"],
  );
  assert.equal(
    model.fileFacts({ kind: "folder", fileCount: 14 }, "1.2 MB"),
    "folder · 1.2 MB · 14 files",
  );
  assert.equal(model.fileFacts({ kind: "file", fileCount: null }, "48 KB"), "48 KB");
  const now = new Date("2026-11-25T12:00:00Z");
  assert.match(
    model.fileExpiry({ state: "available", expiresAt: "2026-12-25T12:00:00Z" }, now),
    /^expires /,
  );
  assert.match(
    model.fileExpiry({ state: "expired", expiresAt: "2026-12-25T12:00:00Z" }, now),
    /^Expired /,
  );
  assert.match(
    model.fileExpiry({ state: "available", expiresAt: "2026-11-24T12:00:00Z" }, now),
    /^Expired /,
    "a page left open past the expiry says so",
  );
});

/**
 * A swarm server with transfers on: T-1 completed with three files (one folder) and four links
 * (base and head commits, a PR, a URL), T-2 failed with a log file, T-3 completed with links only.
 */
const resulted = async (t) => {
  const app = await start(t, { board: true, manualAlarms: true, transfers: true });
  const account = await app.account();
  const server = await app.server(account.id, { name: "Results", board: true });
  const credential = await app.mcpToken(account.organizationId);
  const call = (name, args) =>
    app.mcp(credential, name, { serverId: server.id, requestKey: randomUUID(), ...args });
  const lead = (await call("register_participant", { name: "lead", agentType: "claude-code" })).data
    .item.id;
  const worker = (await call("register_participant", { name: "worker-2", agentType: "codex" })).data
    .item.id;
  const tasks = (
    await call("create_tasks", {
      participantId: lead,
      tasks: ["Move session checks", "Fix the flaky test", "Open the PR"].map((title) => ({
        title,
        brief: `Do this: ${title}.`,
      })),
    })
  ).data.tasks;
  const file = async (name, bytes, folder) => {
    const prepared = (
      await call("prepare_transfer", {
        participantId: worker,
        name,
        bytes,
        sha256: "3f9a".padEnd(60, "0") + "c21e",
        ...(folder ? { kind: "folder", fileCount: 14, manifestBytes: 100 } : { kind: "file" }),
      })
    ).data.transferId;
    for (const [part, size] of [["payload", bytes], ...(folder ? [["manifest", 100]] : [])])
      await app.control(
        `transfer-object?key=${encodeURIComponent(`r30/${server.id}/${prepared}/${part}`)}&bytes=${size}`,
      );
    return prepared;
  };
  const finish = async (task, action, fields) => {
    const claimed = (await call("claim_task", { participantId: worker, taskId: task.id })).data;
    await call("update_task", {
      participantId: worker,
      taskId: task.id,
      leaseToken: claimed.lease.token,
      epoch: claimed.lease.epoch,
      action,
      ...fields,
    });
  };
  await finish(tasks[0], "complete", {
    summary: "Moved 12 session checks to auth.verify; tests pass",
    transferIds: [
      await file("t14.bundle", 48_000),
      await file("test-output", 1_258_291, true),
      await file("coverage.html", 9_000),
    ],
    links: [
      { kind: "commit", role: "base", sha: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d" },
      { kind: "commit", role: "head", sha: "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c" },
      { kind: "pr", url: "https://github.com/acme/app/pull/412", label: "#412" },
      { kind: "url", url: "https://staging.example.com/", label: "staging deploy" },
    ],
  });
  await finish(tasks[1], "fail", {
    summary: "The test fails on CI only",
    transferIds: [await file("ci.log", 2_000)],
  });
  await finish(tasks[2], "complete", {
    summary: "PR opened",
    links: [{ kind: "branch", name: "task-3-pr" }],
  });
  const cookie = await signIn(app);
  const read = async (path) =>
    (await app.raw(path, { headers: { cookie, origin: "https://talkto.test" } })).json();
  const root = `/v1/servers/${server.id}`;
  return {
    app,
    account,
    server,
    cookie,
    board: await read(`${root}/board`),
    list: await read(`${root}/board/tasks?view=all&limit=50`),
    labels: await read(`${root}/board/labels`),
    one: await read(`${root}/board/tasks/1`),
    two: await read(`${root}/board/tasks/2`),
    three: await read(`${root}/board/tasks/3`),
    me: await read("/v1/me"),
    context: await app.call("user_alice", "GET", `/v1/accounts/${account.id}`),
    managed: await app.call("user_alice", "GET", `/v1/accounts/${account.id}/servers/${server.id}`),
  };
};

test("the Result panel shows files with Download, base → head, links with their hosts, and chips", async (t) => {
  const fixture = await resulted(t);
  const { ui } = await modules(t);
  const render = (number, detail) =>
    page(t, ui, fixture, `/board/T-${number}`, (set, scope) => {
      set([...scope, "board"], top(fixture.board));
      set([...scope, "board-task", number], detail);
    });
  const html = await render(1, fixture.one);
  assert.match(html, /<h3 id="[^"]+">Result<\/h3>/);
  assert.ok(html.includes("by worker-2, "), "who finished it");
  assert.ok(html.includes("Moved 12 session checks to auth.verify; tests pass"));
  for (const name of ["t14.bundle", "test-output", "coverage.html"])
    assert.ok(html.includes(`aria-label="Download ${name}"`), name);
  assert.ok(html.includes("folder · 1.2 MB · 14 files"));
  assert.ok(html.includes("sha256 3f9a…c21e"));
  assert.ok(html.includes("expires "));
  // Base and head as short SHAs, each with a copy control for the full one.
  assert.ok(html.includes(">1a2b3c4</code>") && html.includes(">9f8e7d6</code>"));
  assert.ok(html.includes("→"));
  assert.ok(
    html.includes('aria-label="Copy the full base SHA 1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d"'),
  );
  // Links open in a new tab, send no referrer, and always show their host.
  assert.ok(html.includes('rel="noopener noreferrer nofollow"'));
  assert.ok(html.includes(">#412</a>") && html.includes("github.com"));
  assert.ok(html.includes(">staging deploy</a>") && html.includes("staging.example.com"));
  // The thread draws each offer as a transfer chip, and the old one-line outcome is gone.
  assert.equal(html.match(/class="ops-share"/g)?.length, 3);
  assert.ok(!html.includes("task-outcome"));
  assert.ok(html.includes("Completed by worker-2 · 3 files, 4 links"), "the timeline's note");
  // A failed task's panel is titled Reason, with its files.
  const failed = await render(2, fixture.two);
  assert.match(failed, />Reason<\/h3>/);
  assert.ok(failed.includes('aria-label="Download ci.log"'));
  assert.ok(failed.includes("The test fails on CI only"));
  // Links only: no Files part; a branch without a URL is copyable text, not a link.
  const links = await render(3, fixture.three);
  assert.ok(!links.includes("<h4>Files</h4>"));
  assert.ok(links.includes("<code>task-3-pr</code>"));
  assert.ok(links.includes('aria-label="Copy the branch name task-3-pr"'));
  // Expired: the row stays, muted, without Download; the hash stays.
  const expired = structuredClone(fixture.one);
  for (const file of expired.data.task.outcome.files) {
    file.state = "expired";
    file.expiresAt = "2026-01-01T00:00:00.000Z";
  }
  const old = await render(1, expired);
  assert.ok(!old.includes('aria-label="Download'));
  assert.equal(old.match(/data-state="expired"/g)?.length, 3);
  assert.ok(old.includes("Expired "));
  assert.ok(old.includes("sha256 3f9a…c21e"));
});

test("Board rows count a result's files and links after the title", async (t) => {
  const fixture = await resulted(t);
  const { ui } = await modules(t);
  const html = await page(t, ui, fixture, "?tab=board", (set, scope) => {
    set([...scope, "board"], top(fixture.board));
    set([...scope, "board-tasks", { view: "all" }], pages(fixture.list));
  });
  assert.ok(html.includes(" · 3 files · 4 links</span>"));
  assert.ok(html.includes(" · 1 link</span>"));
  // The Failed list counts too.
  assert.ok(
    html.includes(
      '<small class="has-result"><span class="board-row-note">T-2 · The test fails on CI only</span><span class="board-result-count"> · 1 file</span></small>',
    ),
    "the Failed list keeps the count apart from the reason, so the reason shortens first",
  );
});

test("a task's url opens for a member of the organization, not only for a guest", async (t) => {
  const fixture = await seeded(t);
  const { vite, ui } = await modules(t);
  const routes = await vite.ssrLoadModule("/src/app-routes.ts");
  const { memberServerQuery } = await vite.ssrLoadModule("/src/dashboard-queries.ts");
  const { account, server } = fixture;
  // Agents get the shared path: it serves guests, and members are sent on from it.
  const url = new URL(fixture.tasks[0].url);
  assert.equal(url.pathname, `/app/shared/${server.id}/board/T-1`);
  const route = routes.dashboardRoute(url.pathname);
  assert.deepEqual(route, { kind: "shared", serverId: server.id, task: "T-1" });
  // Alice created the server: she reaches it as a member, so the link sends her to its own page.
  const gateway = createServer(async (req, res) => {
    const response = await fixture.app.raw(req.url, {
      headers: { cookie: fixture.cookie, origin: "https://talkto.test" },
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    gateway.closeAllConnections();
    gateway.close();
  });
  const live = ui.createServices(`http://127.0.0.1:${gateway.address().port}`);
  t.after(() => live.queries.clear());
  const user = fixture.me.data.user;
  const found = await live.queries.fetchQuery(memberServerQuery(live.api, user.id, server.id));
  assert.equal(found?.accountId, account.id);
  const member = routes.memberServerPath(found, route.task);
  assert.equal(member, `accounts/${account.id}/servers/${server.id}/board/T-1`);
  assert.deepEqual(routes.dashboardRoute(`/app/${member}`), {
    kind: "account",
    accountId: account.id,
    view: "servers",
    serverId: server.id,
    task: "T-1",
  });
  assert.equal(
    routes.memberServerPath(found, undefined),
    routes.accountServerPath(account.id, server.id),
  );
  const elsewhere = await live.queries.fetchQuery(
    memberServerQuery(live.api, user.id, randomUUID()),
  );
  assert.equal(elsewhere, null, "a server the person is not a member of is not found");
  assert.equal(routes.memberServerPath(null, "T-1"), null);
  // The shared page redirects a member instead of saying the server isn't shared with them...
  const notShared = { data: { servers: [], invitations: [] } };
  const redirecting = await render(t, ui, fixture, url.pathname, (set) => {
    set(["human", user.id, "shared"], notShared);
    set(["human", user.id, "member-server", server.id], found);
  });
  assert.ok(!redirecting.includes("isn’t shared with you"));
  assert.ok(!redirecting.includes("Loading server…"));
  // ...and still says so to someone who reaches it neither way.
  const refused = await render(t, ui, fixture, url.pathname, (set) => {
    set(["human", user.id, "shared"], notShared);
    set(["human", user.id, "member-server", server.id], null);
  });
  assert.ok(refused.includes("This server isn’t shared with you, or your access was removed."));
});

test("Settings shows the claim cap beside the Board switch, and its creator may change it", async (t) => {
  const fixture = await seeded(t);
  const { ui } = await modules(t);
  // The seeded server has no cap; `claimCap` sets one on the Board's top.
  assert.equal(fixture.board.data.claimCap, undefined);
  const settings = (claimCap) =>
    page(t, ui, fixture, "?tab=settings", (set, scope) =>
      set(
        [...scope, "board"],
        claimCap === null
          ? top(fixture.board)
          : top(fixture.board, (data) => ({ ...data, claimCap })),
      ),
    );
  // A Free swarm server's starting cap of 4, editable by its creator.
  const capped = await settings(4);
  const field = capped.match(/<input[^>]*name="claimCap"[^>]*>/)?.[0];
  assert.ok(field, "the claim cap field is on Settings");
  assert.ok(field.includes('value="4"'));
  assert.ok(!field.includes("disabled"), "the creator may change it");
  assert.ok(capped.includes("tasks worked on at once"));
  assert.ok(capped.includes("Leave it empty for no cap."));
  // No cap: the field is empty.
  const open = await settings(null);
  assert.ok(open.match(/<input[^>]*name="claimCap"[^>]*>/)[0].includes('value=""'));
});
