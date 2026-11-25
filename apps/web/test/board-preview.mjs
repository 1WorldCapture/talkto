import { createServer } from "vite";
import { randomUUID } from "node:crypto";
import { start } from "../../server/test/platform-harness.mjs";

// Local-only visual review of the swarm Board (docs/swarm-server-spec.md, 9) against a real
// Worker/D1/DO with boards on. Three swarm servers are seeded through the agents' own tools at the
// approved mockups' sizes: 2 agents and 10 tasks, 20 and 200, 400 and 4,000. `--small` seeds
// only the first. The fixture then moves finish times back so "finished in the last hour" and the
// Updated column look lived in, and silences a few holders so Stalled has rows.
//
// `--break` (dev only, break-ui) seeds the Board's stress states instead, each its own server, and
// adds a fixed "Demo / Worst case / Empty / One / One each / Huge" switch to every page it serves.
// The switch swaps the server in the URL, so a reload keeps the state.
//
// `--results` seeds one server whose tasks finished with files and links instead
// (docs/swarm-task-results-scope.md, 6): T-1 completed with 3 files and 4 links, T-2 failed with
// a log, T-3 completed with links only.
const cleanup = [];
const only = process.argv.includes("--small");
const breaking = process.argv.includes("--break");
const results = process.argv.includes("--results");
// `--memory` offers swarm memory (on the fake Git store) and adds "Payments swarm" with its memory set
// up. Memory has no switch: the seeded servers set theirs up as their agents work, and a new swarm
// whose memory is not set up yet can start from Payments' memory in Settings.
const memory = process.argv.includes("--memory");
const app = await start(
  { after: (fn) => cleanup.push(fn) },
  { manualAlarms: true, board: true, unpaidServers: 10, transfers: results, memory },
);
const account = await app.account();
const credential = await app.mcpToken(account.organizationId);
const call = (name, args) => app.mcp(credential, name, { requestKey: randomUUID(), ...args });
const flow = await app.browserLogin("user_alice", "120m");
const cookie = (await flow.callback()).headers
  .getSetCookie()
  .find((value) => value.startsWith("__Host-talkto-session="))
  .split(";")[0];
const website = (path, init = {}) =>
  app.raw(path, {
    ...init,
    headers: {
      cookie,
      origin: "https://talkto.test",
      "content-type": "application/json",
      ...init.headers,
    },
  });

const types = ["claude-code", "codex", "cursor", "pi", "amp", "grok"];
const pick = (list, i) => list[i % list.length];

/**
 * Seed one swarm server. `titles(i)` names task i and `label(i)` its label; the oldest tasks
 * finish first. `perHour` is how many finished in the last hour; `stalled` silences that many
 * working tasks, longest first.
 */
async function seed({
  name,
  agents: agentNames,
  done,
  failed,
  working,
  ready,
  waiting,
  titles,
  label,
  reasons,
  perHour,
  stalled,
  dependents = 0,
  handovers = 0,
}) {
  const server = await app.server(account.id, { name, board: true });
  const agents = [];
  for (const [i, agent] of agentNames.entries())
    agents.push(
      (
        await call("register_participant", {
          serverId: server.id,
          name: agent,
          agentType: pick(types, i),
        })
      ).data.item.id,
    );
  const lead = agents[0];
  const tool = (tool, participantId, args) =>
    call(tool, { serverId: server.id, participantId, ...args });
  const create = async (from, count, extra = () => ({})) => {
    const made = [];
    for (let at = from; at < from + count; at += 25) {
      const batch = [];
      for (let i = at; i < Math.min(from + count, at + 25); i++)
        batch.push({
          title: titles(i),
          brief: `Work on ${titles(i)}. Keep the change small and report what you did.`,
          labels: [label(i)],
          ...extra(i),
        });
      made.push(...(await tool("create_tasks", lead, { tasks: batch })).data.tasks);
    }
    return made;
  };
  const tasks = await create(0, done + failed + working + ready);
  // The newest failure has `dependents` tasks waiting on it, which its failure cancels (they come
  // out of the waiting count, so the totals stay the mockups').
  const base = done + failed + working + ready;
  if (failed > 0 && dependents > 0)
    await create(base, dependents, () => ({ needs: [{ taskId: tasks[done + failed - 1].id }] }));
  const finish = async (task, i, action, summary, handover = false) => {
    const agent = pick(agents, i);
    // A handover: another agent's lease ran out on it first, so the Board shows "+1".
    if (handover && agents.length > 1) {
      await tool("claim_task", pick(agents, i + 1), { taskId: task.id });
      await app.control(`board?server=${server.id}`, { action: "expire", number: task.number });
    }
    const claimed = (await tool("claim_task", agent, { taskId: task.id })).data;
    await tool("update_task", agent, {
      taskId: task.id,
      leaseToken: claimed.lease.token,
      epoch: claimed.lease.epoch,
      action,
      summary,
    });
  };
  for (let i = 0; i < done; i++)
    await finish(tasks[i], i, "complete", "Done and pushed.", i >= done - handovers && i % 2 === 0);
  for (let i = 0; i < failed; i++) await finish(tasks[done + i], i + 3, "fail", pick(reasons, i));
  const held = [];
  for (let i = 0; i < working; i++) {
    const task = tasks[done + failed + i];
    const claimed = (
      await tool("claim_task", agents[i % agents.length], { taskId: task.id, leaseSeconds: 900 })
    ).data;
    if (i % 3 === 0)
      await tool("update_task", agents[i % agents.length], {
        taskId: task.id,
        leaseToken: claimed.lease.token,
        epoch: claimed.lease.epoch,
        action: "progress",
        note: "Halfway there: the types compile, tests next.",
      });
    held.push(task);
  }
  await create(base + dependents, waiting - dependents, (i) => ({
    needs: [{ taskId: pick(held, i).id }],
  }));
  const board = `board?server=${server.id}`;
  await app.control(board, { action: "spread", number: Math.floor(3600 / (perHour + 0.5)) });
  for (const [i, task] of held.slice(0, stalled).entries())
    await app.control(board, { action: "silence", number: task.number, minutes: 20 - i });
  await app.control(`resources?server=${server.id}`, "flush");
  return { ...server, firstFailed: failed > 0 ? tasks[done + failed - 1].number : undefined };
}

const areas = ["billing", "ledger", "search", "web", "admin", "i18n", "api", "db"];
const parts = [
  "invoice-pdf",
  "accounts",
  "ranking",
  "legacy-checkout",
  "reports",
  "generated",
  "cart",
  "tax",
  "export",
  "session",
];
const smallSpec = {
  name: "Checkout rewrite",
  agents: ["planner", "api-worker"],
  done: 5,
  failed: 0,
  working: 2,
  ready: 2,
  waiting: 1,
  titles: (i) =>
    [
      "Break the checkout rewrite into tasks",
      "Audit the current checkout flow",
      "Pricing API contract",
      "Extract the cart service from the monolith",
      "Rounding rule for multi-currency totals",
      "Server-side cart pricing",
      "Stripe payment element on the checkout page",
      "Show the tax line in the order summary",
      "Deploy the pricing service to staging",
      "End-to-end checkout test in staging",
    ][i],
  label: (i) => ["plan", "web", "api", "api", "api", "api", "web", "web", "deploy", "test"][i],
  reasons: [],
  perHour: 3,
  stalled: 0,
};
const mediumSpec = {
  name: "Checkout rewrite (200)",
  agents: Array.from({ length: 20 }, (_, i) =>
    i === 0 ? "planner" : `${pick(["api", "web", "db", "reviewer"], i)}-worker-${Math.ceil(i / 4)}`,
  ),
  done: 86,
  failed: 4,
  working: 17,
  ready: 44,
  waiting: 49,
  titles: (i) =>
    `${pick(["Coupon stacking rules", "Currency conversion cache", "Address autocomplete", "Apple Pay domain verification", "Load test checkout", "VAT display rule", "Stripe 3-D Secure redirect", "Cart service PR review"], i)} ${Math.floor(i / 8) + 1}`,
  label: (i) => pick(["api", "web", "db", "review", "deploy"], i),
  reasons: [
    "DNS for pay.example.com is not delegated",
    "staging quota exceeded",
    "sandbox keys missing",
  ],
  perHour: 31,
  stalled: 2,
  dependents: 2,
  handovers: 8,
};
const largeSpec = {
  name: "Strict TypeScript migration",
  agents: Array.from({ length: 400 }, (_, i) =>
    i === 0 ? "lead" : `ts-worker-${String(i).padStart(3, "0")}`,
  ),
  done: 1284,
  failed: 52,
  working: 376,
  ready: 1099,
  waiting: 1189,
  titles: (i) =>
    `${i % 3 === 0 ? "apps" : "packages"}/${pick(areas, i)}/${pick(parts, Math.floor(i / 8))}${i >= 80 ? `-${Math.floor(i / 80)}` : ""}`,
  label: (i) => pick(areas, i),
  reasons: [
    "circular import between ledger and accounts",
    "type check runs past the 10 min limit",
    "generated file, regenerate instead",
  ],
  perHour: 212,
  stalled: 14,
  dependents: 2,
  handovers: 8,
};
/** `text`, after checking it fits the schema's UTF-8 byte (or character) limit. */
const within = (limit, text) => {
  const size = Buffer.byteLength(text);
  if (size > limit) throw new Error(`${size} bytes is over ${limit}: ${text.slice(0, 60)}`);
  return text;
};

/** A swarm server with these agents, and the agents' tools by name. */
async function swarm(name, agentNames) {
  const server = await app.server(account.id, { name, board: true });
  const ids = {};
  for (const [i, agent] of agentNames.entries())
    ids[agent] = (
      await call("register_participant", {
        serverId: server.id,
        name: within(64, agent),
        agentType: pick(types, i),
      })
    ).data.item.id;
  const tool = (name, who, args) =>
    call(name, { serverId: server.id, participantId: ids[who], ...args });
  const control = async (body) => {
    const response = await app.control(`board?server=${server.id}`, body);
    if (response.status !== 200) throw new Error(await response.text());
  };
  const make = async (by, list) => {
    const made = [];
    for (let at = 0; at < list.length; at += 25)
      made.push(...(await tool("create_tasks", by, { tasks: list.slice(at, at + 25) })).data.tasks);
    return made;
  };
  const claim = async (who, task, extra = {}) =>
    (await tool("claim_task", who, { taskId: task.id, ...extra })).data;
  const act = (who, claimed, args) =>
    tool("update_task", who, {
      taskId: claimed.task.id,
      leaseToken: claimed.lease.token,
      epoch: claimed.lease.epoch,
      ...args,
    });
  const finish = async (who, task, action, summary) =>
    act(who, await claim(who, task), { action, summary: within(280, summary) });
  const root = `/v1/servers/${server.id}`;
  const dashboard = async (path, body) => {
    const response = await website(`${root}${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (response.status !== 200) throw new Error(await response.text());
  };
  return { server, ids, tool, control, make, claim, act, finish, dashboard };
}

const task = (title, extra = {}) => ({
  title: within(200, title),
  brief: `Work on ${title}. Keep the change small and report what you did.`,
  ...extra,
});

/**
 * Worst case: one dataset that hits every catalog row the Board renders, spread across the first
 * rows of each list. Agent names are self-declared, so they run to the 64-character limit of
 * `^[A-Za-z][A-Za-z0-9_-]{0,63}$` (ASCII only); titles to 200 bytes, summaries to 280, labels to
 * a 32-character key and 64-character value, 8 labels, 16 needs, 16 stored holders.
 */
async function worstCase() {
  const lead = "claude-code-reviewer-for-the-payments-platform-migration-team-03";
  const a = {
    lead,
    j: "J",
    ola: "Aleksandra_Wisniewska-Kowalczyk",
    codex: "codex_gpt-5_high-reasoning_worker_eu-west-1_shard-0017",
    chris: "Christopher_Alexander_Montgomery_III",
    jo: "jo",
    uuid: "cursor-agent-9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f",
    p1: "payments-migration-worker-agent-instance-01",
    p2: "payments-migration-worker-agent-instance-02",
    gone: "Konstantin_Oberhauser-Wettstein",
  };
  const workers = Array.from({ length: 17 }, (_, i) => `worker-${String(i + 1).padStart(2, "0")}`);
  const s = await swarm(
    within(100, "Migración de pagos — équipe plateforme UE · 支払い移行 (Q3 2026) 🚀"),
    [...Object.values(a), ...workers, "idle-reviewer"],
  );
  const long = within(
    200,
    "Migrate the invoice PDF renderer from the legacy wkhtmltopdf pipeline to the headless Chromium service, keeping page breaks, embedded fonts and right-to-left layouts",
  );
  const path = within(
    200,
    "packages/billing-platform/src/invoices/generated/protobuf/v2/northwind_industries_holdings/InvoiceLineItemTaxBreakdownSerializer.generated.test.ts",
  );
  const cjk = within(
    200,
    "請求書PDFレンダラーを新しいヘッドレスChromiumサービスに移行し、既存の改ページとフォントを維持する",
  );
  const escaped = "<script>alert(1)</script> &amp; **bold** in the coupon field";
  const vi = "Đặng Thị Ngọc Hân: sửa lỗi hiển thị tiền tệ ở trang thanh toán";
  const de = "Benachrichtigungseinstellungsverwaltungsoberflächenüberarbeitung";
  const emoji = "👩🏽‍💻 Fix the 🦊 login redirect loop on Safari 17";
  const url =
    "https://ci.example.com/northwind/payments/actions/runs/9f8e7d6c5b4a/jobs/1284/logs?step=typecheck&attempt=3";
  const flaky = "Fix flaky test";
  const longest = within(
    97,
    "area/payments-platform/invoicing=packages/billing-platform/src/invoices/generated-protobuf-v2",
  );
  const eight = [
    "role=reviewer",
    "feedback-from-enterprise-onboard",
    "area=web",
    "priority/p0",
    "team=payments",
    "needs-review",
    "q3",
    "i18n",
  ];
  const stack =
    "TypeError: Cannot read properties of undefined (reading 'lineItems')\n    at InvoiceLineItemTaxBreakdownSerializer.serialize (/workspace/packages/billing-platform/src/invoices/generated/protobuf/v2/northwind_industries_holdings/InvoiceLineItemTaxBreakdownSerializer.generated.ts:1284:17)";
  // The longest brief a task takes: 16,384 bytes of markdown, as an agent pastes a plan.
  const plan = [
    `# ${path}`,
    "The serializer drops tax lines when an invoice mixes currencies. Reproduce with the fixture below, then fix the rounding.",
    "```ts",
    `const fixture = { lineItems: [${Array.from({ length: 12 }, (_, i) => `{ sku: "SKU-${i}", amount: ${i * 1284}.5, currency: "EUR" }`).join(", ")}] };`,
    "```",
    `Logs: ${url}`,
    "| Step | Owner | Status |",
    "| --- | --- | --- |",
    ...Array.from(
      { length: 30 },
      (_, i) => `| ${i + 1}. Check ${pick(parts, i)} | ${a.codex} | pending |`,
    ),
  ].join("\n\n");
  let brief = plan;
  for (let i = 0; Buffer.byteLength(brief) < 16000; i++)
    brief += `\n\n- Item ${i + 1}: confirm ${pick(parts, i)} still renders after the change, and note any difference in the thread.`;
  within(16384, brief);

  // Created oldest first; finished tasks show latest (highest number) first.
  const finishedSpecs = [
    task("Nightly reconciliation between Stripe payouts and the ledger", {
      labels: ["area=ledger"],
      maxAttempts: 10,
    }), // 0: out of attempts after ten holders
    ...Array.from({ length: 6 }, (_, i) => task(`Update the ${pick(parts, i)} snapshot tests`)), // 1-6
    task(long, { labels: eight }), // 7: fails, with 40 tasks waiting on it
    task(url), // 8: a person cancels it, with a long reason
    task(path, { labels: [longest] }), // 9: done by jo
    task("Run the type check on packages/billing-platform"), // 10: fails with a URL
    task(cjk, { labels: ["i18n"] }), // 11: done by the lead after two others' leases ran out
    task(flaky), // 12: its owner cancels it
    task(vi), // 13: done by an agent removed afterwards
    task(emoji, { labels: ["web"] }), // 14: the newest failure, a CJK reason
    task("Rotate the webhook signing secret", { labels: ["role=security"] }), // 15: 17 holders
  ];
  const finished = await s.make(a.lead, finishedSpecs);
  const openSpecs = [
    task(path, { labels: [longest], brief }),
    task(long),
    task(cjk, { labels: ["i18n"] }),
    task(emoji, { labels: ["web"] }),
    task(escaped, {
      labels: ["web"],
      brief: `The coupon field shows ${escaped} literally. Check <b>this</b> renders as text.`,
    }),
    task(vi, { labels: ["i18n"] }),
    task(de, { labels: ["i18n"] }),
    task("x"),
    task(url),
    task(flaky, { labels: ["test"] }),
    task(flaky, { labels: ["test"] }),
    task(flaky, { labels: ["test"] }),
    task("Review the Stripe webhook retries", { assigneeId: s.ids[a.lead], priority: "high" }),
    ...Array.from({ length: 24 }, (_, i) =>
      task(`${pick(["Audit", "Port", "Delete", "Document"], i)} ${pick(parts, i)} ${i + 1}`, {
        labels: i % 5 === 0 ? eight : [pick(["api", "web", "db", longest], i)],
        priority: pick(["normal", "low", "high"], i),
      }),
    ),
  ];
  const open = await s.make(a.lead, openSpecs);
  const working = open.slice(0, 12);
  const ready = open.slice(12);
  // 14 waiting: one needs 16 tasks (the most), the rest one working task each. Open stays at 51,
  // one past a page.
  await s.make(a.lead, [
    task("Ship the payments platform migration", {
      needs: [...working, ...ready.slice(0, 4)].map((item) => ({ taskId: item.id })),
    }),
    ...Array.from({ length: 13 }, (_, i) =>
      task(`Follow up on ${pick(parts, i)} after ${pick(["review", "deploy"], i)}`, {
        needs: [{ taskId: pick(working, i).id }],
      }),
    ),
  ]);
  // 40 tasks wait on finished[7]; its failure cancels them all.
  await s.make(
    a.lead,
    Array.from({ length: 40 }, (_, i) =>
      task(`Regenerate invoice fixtures for ${pick(areas, i)} ${i + 1}`, {
        needs: [{ taskId: finished[7].id }],
      }),
    ),
  );

  // Finished tasks.
  for (const worker of workers.slice(0, 10)) {
    await s.claim(worker, finished[0]);
    await s.control({ action: "expire", number: finished[0].number });
  }
  for (const [i, item] of finished.slice(1, 7).entries())
    await s.finish(
      pick([a.ola, a.chris, a.uuid, a.codex, a.p1, a.p2], i),
      item,
      "complete",
      "Done.",
    );
  await s.finish(
    a.codex,
    finished[7],
    "fail",
    "The Chromium service renders Arabic and Hebrew invoices left-to-right, and the page break after the tax table moves to the next page on A4, so the PDFs no longer match the legal archive copies; the right-to-left layout needs a fix in the shared template.",
  );
  const doomed = (
    await app.mcp(credential, "read_tasks", {
      serverId: s.server.id,
      participantId: s.ids[a.lead],
      mode: "task",
      task: { number: finished[8].number },
    })
  ).data.task;
  await s.dashboard(`/people/me/tasks/${doomed.id}/cancel`, {
    expectedRevision: doomed.revision,
    requestKey: randomUUID(),
    reason: Array.from(
      { length: 20 },
      () =>
        "The CI link moved when we switched runners, so this check is no longer the right one and a new task will track the replacement pipeline.",
    ).join(" "),
  });
  await s.finish(a.jo, finished[9], "complete", "ok");
  await s.finish(a.j, finished[10], "fail", url);
  await s.claim(a.uuid, finished[11]);
  await s.control({ action: "expire", number: finished[11].number });
  await s.claim(a.codex, finished[11]);
  await s.control({ action: "expire", number: finished[11].number });
  await s.finish(
    a.lead,
    finished[11],
    "complete",
    "改ページとフォントは維持されました。アラビア語の請求書は右から左に表示されます。",
  );
  await s.tool("update_task", a.lead, { taskId: finished[12].id, action: "cancel" });
  await s.claim(a.lead, finished[13]);
  await s.control({ action: "expire", number: finished[13].number });
  await s.finish(a.gone, finished[13], "complete", "Đã sửa định dạng tiền tệ cho vi-VN.");
  await s.finish(
    a.p1,
    finished[14],
    "fail",
    "Safari 17 のリダイレクトループはまだ再現します。ITP がセッション Cookie を削除しています。",
  );
  for (const worker of workers) {
    const held = await s.claim(worker, finished[15]);
    await s.act(worker, held, { action: "release" });
  }
  await s.finish(a.j, finished[15], "complete", "Rotated.");

  // Open tasks: four stalled (21 hours, an hour, a minute, and a retry), the rest working.
  const holders = [a.lead, a.uuid, a.j, a.p1, a.p2, a.ola, a.chris, a.jo, a.codex, ...workers];
  for (const [i, item] of working.entries()) {
    if (i === 3) {
      await s.claim(a.p2, item);
      await s.control({ action: "expire", number: item.number });
    }
    const held = await s.claim(holders[i], item, { leaseSeconds: 900 });
    if (i === 0) await s.act(holders[i], held, { action: "progress", note: stack });
    if (i === 4) await s.act(holders[i], held, { action: "progress", note: escaped });
  }
  await s.control({ action: "spread", number: 80 * 60 });
  for (const [i, minutes] of [1284, 61, 1].entries())
    await s.control({ action: "silence", number: working[i].number, minutes });
  // A removed agent keeps its name on the tasks it finished.
  await s.dashboard(`/participants/${s.ids[a.gone]}/remove`, {});
  await app.control(`resources?server=${s.server.id}`, "flush");
  return {
    ...s.server,
    firstFailed: finished[7].number,
    pages: {
      Task: working[0].number,
      Holders: finished[15].number,
      Exhausted: finished[0].number,
      Needs: open.length + finished.length + 1,
      Canceled: finished[8].number,
      Removed: finished[13].number,
    },
  };
}

/** Empty: the board is on, nothing has happened yet. */
const empty = async () => (await swarm("New swarm", [])).server;

/** One: the first task ever, its one agent working on it. */
async function one() {
  const s = await swarm("First swarm", ["planner"]);
  const [first] = await s.make("planner", [task("Break the checkout rewrite into tasks")]);
  const held = await s.claim("planner", first);
  await s.act("planner", held, { action: "progress", note: "Reading the checkout code first." });
  await app.control(`resources?server=${s.server.id}`, "flush");
  return { ...s.server, pages: { Task: 1 } };
}

/** One each: one agent and one task in every state, so every count reads 1. */
async function oneEach() {
  const s = await swarm("One of everything", ["planner"]);
  // The fourth stays ready.
  const [done, failed, working] = await s.make("planner", [
    task("Audit the current checkout flow"),
    task("Pricing API contract"),
    task("Server-side cart pricing"),
    task("Show the tax line in the order summary"),
  ]);
  await s.make("planner", [
    task("Deploy the pricing service to staging", { needs: [{ taskId: working.id }] }),
    task("End-to-end checkout test", { needs: [{ taskId: failed.id }] }),
  ]);
  await s.finish("planner", done, "complete", "Done.");
  await s.finish("planner", failed, "fail", "sandbox keys missing");
  await s.claim("planner", working, { leaseSeconds: 900 });
  await s.control({ action: "spread", number: 2400 });
  await s.control({ action: "silence", number: working.number, minutes: 12 });
  await app.control(`resources?server=${s.server.id}`, "flush");
  return { ...s.server, firstFailed: failed.number, pages: { Task: working.number } };
}

/** Run `work` over `items`, `width` at a time. */
async function inParallel(items, width, work) {
  for (let at = 0; at < items.length; at += width)
    await Promise.all(items.slice(at, at + width).map((item, k) => work(item, at + k)));
}

/**
 * Huge: 420 agents and 10,080 tasks (T-10080), made and finished 1,000 at a time under the 5,000
 * unfinished cap: 5,200 done, 120 failed, 300 canceled by their owner, 400 working (30 stalled),
 * 2,700 ready and 1,360 waiting (the preview fixture spreads open tasks 20 s apart
 * within a day).
 */
async function huge() {
  const names = Array.from({ length: 420 }, (_, i) =>
    i === 0 ? "lead" : `ts-worker-${String(i).padStart(3, "0")}`,
  );
  const s = await swarm("Monorepo strict mode, all packages", names);
  const spec = (i) => task(largeSpec.titles(i), { labels: [largeSpec.label(i)] });
  const specs = (from, count) => Array.from({ length: count }, (_, k) => spec(from + k));
  for (let at = 0; at < 5320; at += 1000) {
    const made = await s.make("lead", specs(at, Math.min(1000, 5320 - at)));
    await inParallel(made, 12, (item, k) => {
      const i = at + k;
      const who = names[(i % 419) + 1];
      return i % 44 === 43
        ? s.finish(who, item, "fail", pick(largeSpec.reasons, i))
        : s.finish(who, item, "complete", "Done and pushed.");
    });
  }
  const canceled = await s.make("lead", specs(5320, 300));
  await inParallel(canceled, 12, (item) =>
    s.tool("update_task", "lead", { taskId: item.id, action: "cancel" }),
  );
  const working = await s.make("lead", specs(5620, 400));
  await inParallel(working, 12, (item, k) =>
    s.claim(names[(k % 419) + 1], item, { leaseSeconds: 900 }),
  );
  await s.make("lead", specs(6020, 2700));
  await s.make(
    "lead",
    Array.from({ length: 1360 }, (_, k) => ({
      ...spec(8720 + k),
      needs: [{ taskId: pick(working, k).id }],
    })),
  );
  await s.control({ action: "spread", number: 3 });
  for (const [i, item] of working.slice(0, 30).entries())
    await s.control({ action: "silence", number: item.number, minutes: 40 - i });
  await app.control(`resources?server=${s.server.id}`, "flush");
  return { ...s.server, firstFailed: 44 };
}

/** The break-ui states, seeded side by side. */
async function breakStates() {
  // The two big boards first; the small ones last, so their minute-old times are fresh.
  // `--quick` stands in the small and medium boards, to try the seeds without the long wait.
  const quick = process.argv.includes("--quick");
  const [demo, biggest] = await Promise.all(
    quick ? [seed(smallSpec), seed(mediumSpec)] : [seed(largeSpec), huge()],
  );
  console.log("big boards seeded");
  const [worst, nothing, single, each] = await Promise.all([
    worstCase(),
    empty(),
    one(),
    oneEach(),
  ]);
  return { demo, worst, empty: nothing, one: single, oneEach: each, huge: biggest };
}

const servers = {};
/** The `--results` server: finished tasks with result files and links, read on their pages. */
async function resultStates() {
  const server = await app.server(account.id, { name: "Results", board: true });
  const tool = (name, args) => call(name, { serverId: server.id, ...args });
  const lead = (await tool("register_participant", { name: "lead", agentType: "claude-code" })).data
    .item.id;
  const worker = (await tool("register_participant", { name: "api-worker-2", agentType: "codex" }))
    .data.item.id;
  const tasks = (
    await tool("create_tasks", {
      participantId: lead,
      tasks: [
        "Move session checks to the new auth client",
        "Fix the flaky upload test",
        "Open the PR for the auth client",
      ].map((title) => ({
        title,
        brief: `${title}. Base: 1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d.`,
      })),
    })
  ).data.tasks;
  const file = async (name, bytes, folder) => {
    const id = (
      await tool("prepare_transfer", {
        participantId: worker,
        name,
        bytes,
        sha256: "3f9ab27c".padEnd(56, "0") + "84d1c21e",
        ...(folder ? { kind: "folder", fileCount: 14, manifestBytes: 900 } : { kind: "file" }),
      })
    ).data.transferId;
    for (const [part, size] of [["payload", bytes], ...(folder ? [["manifest", 900]] : [])])
      await app.control(
        `transfer-object?key=${encodeURIComponent(`r30/${server.id}/${id}/${part}`)}&bytes=${size}`,
      );
    return id;
  };
  const finish = async (task, action, fields) => {
    const claimed = (await tool("claim_task", { participantId: worker, taskId: task.id })).data;
    await tool("update_task", {
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
    details: "Changed apps/web/src/session.ts and its tests. The bundle holds 3 commits.",
    transferIds: [
      await file("t1-session-checks.bundle", 48_213),
      await file("test-output", 1_258_291, true),
      await file("coverage-report.html", 91_402),
    ],
    links: [
      { kind: "commit", role: "base", sha: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d" },
      { kind: "commit", role: "head", sha: "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c" },
      { kind: "pr", url: "https://github.com/acme/app/pull/412", label: "#412 Use auth.verify" },
      { kind: "url", url: "https://staging.example.com/session", label: "Staging deploy" },
    ],
  });
  await finish(tasks[1], "fail", {
    summary: "The upload test fails on CI only; the log is attached",
    transferIds: [await file("ci-run-8812.log", 20_480)],
  });
  await finish(tasks[2], "complete", {
    summary: "Opened the PR from task-3",
    links: [
      { kind: "branch", name: "task-3-auth-pr" },
      { kind: "pr", url: "https://github.com/acme/app/pull/413" },
    ],
  });
  return { results: { ...server, pages: { Result: 1, Reason: 2, Links: 3 } } };
}

if (results) Object.assign(servers, await resultStates());
else if (breaking) Object.assign(servers, await breakStates());
else {
  servers.small = await seed(smallSpec);
  if (!only) {
    servers.medium = await seed(mediumSpec);
    servers.large = await seed(largeSpec);
  }
  if (memory) {
    const payments = await app.server(account.id, { name: "Payments swarm", board: true });
    const switched = await website(`/v1/servers/${payments.id}/board`, {
      method: "PUT",
      body: JSON.stringify({ memory: { tokens: 1500 } }),
    });
    if (!switched.ok) throw new Error(`memory was not set up: ${await switched.text()}`);
    servers.memoryOn = payments;
  }
}

const port = Number(process.env.BOARD_PREVIEW_PORT ?? 5244);
const origin = `http://127.0.0.1:${port}`;
const base = `${origin}/app/accounts/${account.id}`;
const urls = { servers: `${base}/servers` };
for (const [size, server] of Object.entries(servers)) {
  urls[size] = `${base}/servers/${server.id}?tab=board`;
  urls[`${size}Task`] = `${base}/servers/${server.id}/board/T-6`;
  urls[`${size}Settings`] = `${base}/servers/${server.id}?tab=settings`;
  urls[`${size}Done`] = `${base}/servers/${server.id}?tab=board&list=done`;
  if (server.firstFailed)
    urls[`${size}Failed`] = `${base}/servers/${server.id}/board/T-${server.firstFailed}`;
  for (const [page, number] of Object.entries(server.pages ?? {}))
    urls[`${size}${page}`] = `${base}/servers/${server.id}/board/T-${number}`;
}

/**
 * The break-ui switch (dev only: this preview script is its only source, never the app bundle).
 * Fixed bottom-center, plain chrome. Each state is its own server, so switching swaps the server
 * in the path, keeps the tab, and adds `data=<state>`; a reload or a shared link keeps the state.
 */
const states = {
  demo: "Demo",
  worst: "Worst case",
  empty: "Empty",
  one: "One",
  oneEach: "One each",
  huge: "Huge",
};
const toggle = () => `<script>
(() => {
  const ids = ${JSON.stringify(Object.fromEntries(Object.keys(states).map((key) => [key, servers[key].id])))};
  const labels = ${JSON.stringify(states)};
  const base = ${JSON.stringify(`/app/accounts/${account.id}/servers/`)};
  const current = () => Object.keys(ids).find((key) => location.pathname.includes(base + ids[key]));
  const go = (key) => {
    const search = new URLSearchParams(location.search);
    const tab = search.get("tab") === "settings" || search.get("tab") === "agents" ? search.get("tab") : "board";
    location.assign(base + ids[key] + "?tab=" + tab + "&data=" + key);
  };
  const wanted = new URLSearchParams(location.search).get("data");
  if (wanted in ids && current() !== wanted) return go(wanted);
  const bar = document.createElement("div");
  bar.id = "break-ui-toggle";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Preview data (dev only)");
  bar.style.cssText = "position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:2147483647;display:flex;gap:2px;padding:3px;border-radius:999px;background:#e4e4e7;box-shadow:0 1px 4px rgba(0,0,0,.25);font:500 12px/1 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;max-width:calc(100vw - 16px);overflow-x:auto;white-space:nowrap";
  const buttons = Object.entries(labels).map(([key, label]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.onclick = () => go(key);
    bar.append(button);
    return [key, button];
  });
  const paint = () => {
    const here = current();
    for (const [key, button] of buttons) {
      const on = key === here;
      button.setAttribute("aria-pressed", String(on));
      button.style.cssText = "border:0;border-radius:999px;padding:6px 10px;cursor:pointer;font:inherit;" + (on ? "background:#fff;color:#18181b;box-shadow:0 1px 2px rgba(0,0,0,.15)" : "background:transparent;color:#52525b");
    }
  };
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function (...args) { const result = original.apply(this, args); paint(); return result; };
  }
  addEventListener("popstate", paint);
  paint();
  document.body.append(bar);
})();
</script>`;
const vite = await createServer({
  mode: "test",
  cacheDir: `node_modules/.vite-board-preview-${port}`,
  server: { host: "127.0.0.1", port, strictPort: true, hmr: false },
  plugins: [
    {
      name: "board-fixture",
      transformIndexHtml(html) {
        return breaking ? html.replace("</body>", `${toggle()}</body>`) : html;
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url === "/__board-preview") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(urls));
            return;
          }
          if (!req.url.startsWith("/v1/")) return next();
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const response = await website(req.url, {
            method: req.method,
            body: chunks.length ? Buffer.concat(chunks) : undefined,
          });
          const headers = Object.fromEntries(response.headers);
          delete headers["set-cookie"];
          res.writeHead(response.status, headers);
          res.end(Buffer.from(await response.arrayBuffer()));
        });
      },
    },
  ],
});
await vite.listen();
console.log(JSON.stringify(urls));
const close = async () => {
  await vite.close();
  for (const fn of cleanup) await fn();
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
