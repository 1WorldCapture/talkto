import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

/*
  Task results (docs/swarm-task-results-scope.md): files and links on update_task complete and
  fail. Every test runs on the real Worker, D1, R2 binding and server object; an upload is stood in
  for by writing the object through `/__control/transfer-object`, as transfers.test.mjs does.
  Numbers in test names refer to section 9 of the scope.
*/

const sha = "b".repeat(64);
const base = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const head = "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c";

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
 * A swarm server with a lead and two workers on Alice's MCP connection, transfers on unless
 * `transfers: false` (TalkTo Local has no transfer store).
 */
const setup = async (t, options = {}) => {
  const x = await start(t, { board: true, manualAlarms: true, transfers: true, ...options });
  const account = await x.account();
  // One paid period; publishing it again with a larger allowance raises it in place.
  const period = {
    start: new Date(Date.now() - 3600000).toISOString(),
    end: new Date(Date.now() + 3600000).toISOString(),
  };
  const publish = async (allowance) =>
    assert.equal(
      (
        await x.control(`quota/publish?account=${account.id}`, {
          accountId: account.id,
          ...period,
          allowance,
          overdraft: 0,
        })
      ).status,
      200,
    );
  if (options.metering) await publish(options.allowance ?? 200);
  const server = await x.server(account.id, { board: true });
  const root = `/v1/servers/${server.id}`;
  const credential = await x.mcpToken(account.organizationId);
  const on =
    (serverId) =>
    (name, args, error = false) =>
      x.mcp(credential, name, { serverId, ...args }, error);
  const call = on(server.id);
  const register = async (name, at = call) =>
    (await at("register_participant", { name, agentType: "codex", requestKey: randomUUID() })).data;
  const first = await register("Lead");
  const lead = first.item.id;
  const wes = (await register("Wes")).item.id;
  const wyn = (await register("Wyn")).item.id;
  const create = async (titles) =>
    (
      await call("create_tasks", {
        participantId: lead,
        requestKey: randomUUID(),
        tasks: titles.map((title) => ({ title, brief: `Do this: ${title}.` })),
      })
    ).data.tasks;
  const claim = async (participantId, number) =>
    (await call("claim_task", { participantId, requestKey: randomUUID(), number })).data;
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
  const prepare = async (participantId, args = {}, at = call) =>
    (
      await at("prepare_transfer", {
        participantId,
        requestKey: randomUUID(),
        name: "t1.bundle",
        kind: "file",
        bytes: 16,
        sha256: sha,
        ...args,
      })
    ).data;
  const upload = async (transferId, bytes = 16, serverId = server.id, part = "payload") => {
    const key = `r30/${serverId}/${transferId}/${part}`;
    const response = await x.control(
      `transfer-object?key=${encodeURIComponent(key)}&bytes=${bytes}`,
    );
    assert.equal(response.status, 200);
  };
  const objects = async () => (await (await x.control("transfer-objects")).json()).keys;
  const control = async (action, number) => {
    const body = { action };
    if (number !== undefined) body.number = number;
    const response = await x.control(`board?server=${server.id}`, body);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const task = async (number) =>
    (await call("read_tasks", { participantId: lead, mode: "task", task: { number } })).data;
  const meter = async () => (await x.control(`meter?server=${server.id}`)).json();
  return {
    x,
    account,
    server,
    root,
    credential,
    call,
    on,
    register,
    lead,
    general: first.generalConversationId,
    wes,
    wyn,
    create,
    claim,
    update,
    prepare,
    upload,
    objects,
    control,
    task,
    meter,
    publish,
  };
};

test("4, 10: a result offers its uploaded files in the thread and carries its links everywhere", async (t) => {
  const s = await setup(t);
  await s.create(["Move session checks"]);
  const claimed = await s.claim(s.wes, 1);
  const bundle = await s.prepare(s.wes, { name: "t1.bundle", bytes: 48 });
  const folder = await s.prepare(s.wes, {
    name: "test-output",
    kind: "folder",
    bytes: 1200,
    fileCount: 14,
    manifestBytes: 300,
  });
  await s.upload(bundle.transferId, 48);
  await s.upload(folder.transferId, 1200);
  await s.upload(folder.transferId, 300, s.server.id, "manifest");
  const links = [
    { kind: "commit", role: "base", sha: base },
    { kind: "commit", role: "head", sha: head },
    { kind: "branch", name: "task-1-session-checks", url: "https://github.com/acme/app/tree/x" },
    { kind: "pr", url: "https://GitHub.com/acme/app/pull/412", label: "#412" },
    { kind: "url", url: "https://staging.example.com/", label: "staging deploy" },
  ];
  const done = await s.update(s.wes, claimed, {
    action: "complete",
    summary: "Moved 12 session checks; tests pass",
    details: "All 12 checks now live in auth.verify.",
    transferIds: [bundle.transferId, folder.transferId],
    links,
  });
  assert.equal(done.data.changed, true);
  const outcome = done.data.task.outcome;
  assert.deepEqual(
    outcome.files.map((file) => [file.id, file.name, file.kind, file.bytes, file.fileCount]),
    [
      [bundle.transferId, "t1.bundle", "file", 48, null],
      [folder.transferId, "test-output", "folder", 1200, 14],
    ],
  );
  assert.ok(outcome.files.every((file) => file.state === "available" && file.sha256 === sha));
  // URLs come back as their parsed href; the rest as given, in order.
  assert.deepEqual(outcome.links, [
    links[0],
    links[1],
    links[2],
    { kind: "pr", url: "https://github.com/acme/app/pull/412", label: "#412" },
    links[4],
  ]);
  // The details message is the reply's message; the offers follow it in the thread.
  assert.equal(done.data.message.task.kind, "result");
  const detail = await s.task(1);
  const offers = detail.thread.items.filter((item) => item.transfer !== undefined);
  assert.deepEqual(
    offers.map((item) => [item.transfer.id, item.task.kind, item.senderId, item.body]),
    [
      [bundle.transferId, "result", s.wes, "Result file for T-1: t1.bundle"],
      [folder.transferId, "result", s.wes, "Result folder for T-1: test-output (14 files)"],
    ],
  );
  assert.deepEqual(
    outcome.files.map((file) => file.messageId),
    offers.map((item) => item.id),
  );
  const details = detail.thread.items.find((item) => item.id === done.data.message.id);
  assert.ok(details.sequence < offers[0].sequence, "the details come first");
  // The completed event carries the same files and links, after the messages it names.
  const completed = detail.events.find((event) => event.kind === "completed");
  assert.deepEqual(completed.files, outcome.files);
  assert.deepEqual(completed.links, outcome.links);
  assert.equal(completed.summary, "Moved 12 session checks; tests pass");
  assert.ok(completed.sequence > offers[1].sequence);
  // A lead that follows every task sees the files on the event and the offers on the same page.
  const page = (
    await s.call("get_updates", {
      participantId: s.lead,
      mode: "start",
      startAt: "beginning",
      channelIds: [s.general],
      directChats: "own",
      tasks: "all",
    })
  ).data;
  const event = page.tasks.find((item) => item.kind === "completed");
  assert.deepEqual(event.files, outcome.files);
  assert.deepEqual(event.links, outcome.links);
  const delivered = page.messages.filter((item) => item.transfer !== undefined);
  assert.deepEqual(
    delivered.map((item) => item.transfer.id),
    [bundle.transferId, folder.transferId],
    "the owner receives the offers like the details",
  );
  // The lead fetches the bundle, and the worker sees the receipt.
  const fetched = await s.call("fetch_transfer", {
    participantId: s.lead,
    transferId: bundle.transferId,
  });
  assert.equal(fetched.data.transfer.id, bundle.transferId);
  assert.match(fetched.data.procedure, new RegExp(`talkto-${bundle.transferId}`));
  const status = await s.call("read_transfer", { transferId: bundle.transferId });
  assert.deepEqual(
    status.data.fetches.map((item) => item.participantId),
    [s.lead],
  );
  // read_tasks lists the same task, and the Board counts the result.
  const list = await s.call("read_tasks", { participantId: s.lead, mode: "list" });
  assert.deepEqual(list.data.items[0].outcome, outcome);
  const dashboard = await website(s.x);
  const rows = (await dashboard("GET", `${s.root}/board/tasks?view=done`)).json.data.items;
  assert.deepEqual([rows[0].resultFiles, rows[0].resultLinks], [2, 5]);
  const page2 = (await dashboard("GET", `${s.root}/board/tasks/1`)).json.data;
  assert.deepEqual(page2.task.outcome, outcome);
  // The Files tab lists both offers, sent in the board channel.
  const files = (await dashboard("GET", `${s.root}/files/transfers`)).json.data.items;
  const boardChannel = (await s.call("get_context", {})).data.board.channelId;
  for (const id of [bundle.transferId, folder.transferId]) {
    const listed = files.find((item) => item.id === id);
    assert.equal(listed.state, "available");
    assert.equal(listed.conversationId, boardChannel);
  }
  const download = await dashboard(
    "POST",
    `${s.root}/files/transfers/${bundle.transferId}/download`,
  );
  assert.equal(download.status, 200);
  // A task without results keeps today's shape.
  await s.create(["Plain"]);
  const plain = await s.claim(s.wyn, 2);
  const ended = await s.update(s.wyn, plain, { action: "complete", summary: "Done" });
  assert.deepEqual(Object.keys(ended.data.task.outcome).toSorted(), [
    "at",
    "kind",
    "reason",
    "summary",
  ]);
  const plainRows = (await dashboard("GET", `${s.root}/board/tasks?view=done`)).json.data.items;
  const plainRow = plainRows.find((row) => row.number === 2);
  assert.equal(plainRow.resultFiles, undefined);
  assert.equal(plainRow.resultLinks, undefined);
});

test("5: a file already offered in a direct chat is attached as it is, with no new message", async (t) => {
  const s = await setup(t);
  await s.create(["Report"]);
  const claimed = await s.claim(s.wes, 1);
  const sent = await s.prepare(s.wes, { name: "report.pdf" });
  await s.upload(sent.transferId);
  const offered = await s.call("complete_transfer", {
    participantId: s.wes,
    requestKey: randomUUID(),
    target: { kind: "direct", recipientId: s.lead },
    transferId: sent.transferId,
    body: "The report.",
  });
  const done = await s.update(s.wes, claimed, {
    action: "complete",
    summary: "Report attached",
    transferIds: [sent.transferId],
  });
  assert.equal(done.data.task.outcome.files[0].messageId, offered.data.item.id);
  assert.equal(done.data.message, undefined, "no details, so no thread message");
  const detail = await s.task(1);
  assert.equal(
    detail.thread.items.filter((item) => item.transfer !== undefined).length,
    0,
    "nothing new in the thread",
  );
});

test("6: refusals leave the task claimed and write nothing", async (t) => {
  const s = await setup(t);
  await s.create(["Refusals"]);
  const claimed = await s.claim(s.wes, 1);
  const refused = async (transferIds, code) => {
    const result = await s.update(
      s.wes,
      claimed,
      { action: "complete", summary: "Done", transferIds },
      { error: true },
    );
    assert.equal(result.error.code, code, JSON.stringify(result.error));
    return result;
  };
  // Another agent's transfer, even one of the same person.
  const theirs = await s.prepare(s.wyn);
  await s.upload(theirs.transferId);
  await refused([theirs.transferId], "transfer_not_found");
  // A transfer from another server of the same organization.
  const other = await s.x.server(s.account.id, { board: true });
  const elsewhere = s.on(other.id);
  const otherWes = (await s.register("Wes", elsewhere)).item.id;
  const foreign = await s.prepare(otherWes, {}, elsewhere);
  await s.upload(foreign.transferId, 16, other.id);
  await refused([foreign.transferId], "transfer_not_found");
  // An ID nobody prepared.
  await refused([randomUUID()], "transfer_not_found");
  // Never uploaded, then uploaded at the wrong size: that object is removed.
  const mine = await s.prepare(s.wes);
  const missing = await refused([mine.transferId], "transfer_not_uploaded");
  assert.match(missing.error.message, /has not arrived/);
  await s.upload(mine.transferId, 15);
  const wrong = await refused([mine.transferId], "transfer_not_uploaded");
  assert.match(wrong.error.message, /removed/);
  assert.ok(!(await s.objects()).includes(`r30/${s.server.id}/${mine.transferId}/payload`));
  // One good file does not carry a bad one: the whole call is refused.
  const good = await s.prepare(s.wes);
  await s.upload(good.transferId);
  await refused([good.transferId, mine.transferId], "transfer_not_uploaded");
  const still = await s.task(1);
  assert.equal(still.task.state, "claimed");
  assert.equal(still.thread.items.length, 1, "only the brief");
  assert.equal((await s.control("results")).results.length, 0);
  // Expired.
  await s.x.control(`transfers-expired?server=${s.server.id}`);
  await refused([good.transferId], "transfer_expired");
  // The same claim still completes.
  const done = await s.update(s.wes, claimed, { action: "complete", summary: "Done" });
  assert.equal(done.data.task.state, "completed");
});

test("6: a pending reservation is not the worker's to attach", async (t) => {
  const s = await setup(t, { storageUnpaidBytes: 1000 });
  await s.create(["Pending"]);
  const claimed = await s.claim(s.wes, 1);
  await s.x.control(`quota/configure?account=${s.account.id}`, { down: true });
  const failed = await s.call(
    "prepare_transfer",
    {
      participantId: s.wes,
      requestKey: randomUUID(),
      name: "x.bin",
      kind: "file",
      bytes: 16,
      sha256: sha,
    },
    true,
  );
  assert.equal(failed.error.code, "files_unavailable");
  const [pending] = (await s.control("results")).transfers;
  const result = await s.update(
    s.wes,
    claimed,
    { action: "complete", summary: "Done", transferIds: [pending.id] },
    { error: true },
  );
  assert.equal(result.error.code, "transfer_not_found");
});

test("6: claim_lost comes first: nothing is attached or offered", async (t) => {
  const s = await setup(t);
  await s.create(["Lost"]);
  const claimed = await s.claim(s.wes, 1);
  const file = await s.prepare(s.wes);
  await s.upload(file.transferId);
  await s.control("expire", 1);
  const lost = await s.update(
    s.wes,
    claimed,
    {
      action: "complete",
      summary: "Done",
      transferIds: [file.transferId],
      links: [{ kind: "url", url: "https://example.com/" }],
    },
    { error: true },
  );
  assert.equal(lost.error.code, "claim_lost");
  const { transfers, results } = await s.control("results");
  assert.equal(transfers.find((item) => item.id === file.transferId).messageId, null);
  assert.equal(results.length, 0);
  // The Files tab shows it as an upload not finished.
  const dashboard = await website(s.x);
  const listed = (await dashboard("GET", `${s.root}/files/transfers`)).json.data.items;
  assert.equal(listed.find((item) => item.id === file.transferId).state, "incomplete");
});

test("6: TalkTo Local answers files_unavailable, and links still work", async (t) => {
  const s = await setup(t, { transfers: false });
  await s.create(["Local"]);
  const claimed = await s.claim(s.wes, 1);
  const refused = await s.update(
    s.wes,
    claimed,
    { action: "complete", summary: "Done", transferIds: [randomUUID()] },
    { error: true },
  );
  assert.equal(refused.error.code, "files_unavailable");
  assert.match(refused.error.message, /links still work/);
  const done = await s.update(s.wes, claimed, {
    action: "complete",
    summary: "Done",
    links: [{ kind: "commit", role: "head", sha: head }],
  });
  assert.deepEqual(done.data.task.outcome.links, [{ kind: "commit", role: "head", sha: head }]);
  assert.equal(done.data.task.outcome.files, undefined);
});

test("7: retries with the same requestKey", async (t) => {
  const s = await setup(t);
  await s.create(["Retry"]);
  const claimed = await s.claim(s.wes, 1);
  const file = await s.prepare(s.wes);
  const requestKey = randomUUID();
  const action = {
    action: "complete",
    summary: "Done",
    details: "Bundle attached.",
    transferIds: [file.transferId],
    links: [{ kind: "commit", role: "head", sha: head }],
  };
  // Not uploaded yet: nothing recorded, so the same key succeeds once the upload is there.
  const early = await s.update(s.wes, claimed, action, { requestKey, error: true });
  assert.equal(early.error.code, "transfer_not_uploaded");
  await s.upload(file.transferId);
  const done = await s.update(s.wes, claimed, action, { requestKey });
  assert.equal(done.data.changed, true);
  // After success: the stored task, changed false, and no second offer.
  const again = await s.update(s.wes, claimed, action, { requestKey });
  assert.equal(again.data.changed, false);
  assert.deepEqual(again.data.task.outcome, done.data.task.outcome);
  const thread = (await s.task(1)).thread.items;
  assert.equal(thread.filter((item) => item.transfer !== undefined).length, 1);
  assert.equal(thread.length, 3, "brief, details, one offer");
  // The same key with another list is refused.
  for (const changed of [
    { ...action, transferIds: [randomUUID()] },
    { ...action, links: [{ kind: "commit", role: "base", sha: base }] },
    { ...action, links: undefined },
  ]) {
    const conflict = await s.update(s.wes, claimed, changed, { requestKey, error: true });
    assert.equal(conflict.error.code, "idempotency_conflict");
  }
});

test("8: two results racing for one transfer give one offer", async (t) => {
  const s = await setup(t);
  await s.create(["One", "Two"]);
  const one = await s.claim(s.wes, 1);
  const two = await s.claim(s.wes, 2);
  const file = await s.prepare(s.wes);
  await s.upload(file.transferId);
  const [a, b] = await Promise.all([
    s.update(s.wes, one, { action: "complete", summary: "One", transferIds: [file.transferId] }),
    s.update(s.wes, two, { action: "complete", summary: "Two", transferIds: [file.transferId] }),
  ]);
  assert.equal(a.data.task.outcome.files[0].messageId, b.data.task.outcome.files[0].messageId);
  const offers = [...(await s.task(1)).thread.items, ...(await s.task(2)).thread.items].filter(
    (item) => item.transfer !== undefined,
  );
  assert.equal(offers.length, 1);
});

test("9: each attempt's event keeps its own summary, files and links after a reopen", async (t) => {
  const s = await setup(t);
  await s.create(["Flaky"]);
  const first = await s.claim(s.wes, 1);
  const logs = await s.prepare(s.wes, { name: "logs.txt" });
  await s.upload(logs.transferId);
  const failed = await s.update(s.wes, first, {
    action: "fail",
    summary: "Tests fail on CI",
    transferIds: [logs.transferId],
    links: [{ kind: "url", url: "https://ci.example.com/run/1", label: "CI run" }],
  });
  assert.equal(failed.data.task.outcome.files[0].name, "logs.txt");
  const offer = (await s.task(1)).thread.items.find((item) => item.transfer !== undefined);
  assert.equal(offer.task.kind, "failure");
  assert.equal(offer.body, "Failure file for T-1: logs.txt");
  await s.call("update_task", {
    participantId: s.lead,
    requestKey: randomUUID(),
    taskId: first.task.id,
    action: "reopen",
  });
  const reopened = await s.task(1);
  assert.equal(reopened.task.outcome, undefined, "a reopen clears the outcome and its files");
  const second = await s.claim(s.wyn, 1);
  await s.update(s.wyn, second, {
    action: "complete",
    summary: "Fixed the flaky test",
    links: [{ kind: "pr", url: "https://github.com/acme/app/pull/9" }],
  });
  const detail = await s.task(1);
  const failedEvent = detail.events.find((event) => event.kind === "failed");
  const completedEvent = detail.events.find((event) => event.kind === "completed");
  assert.equal(failedEvent.summary, "Tests fail on CI");
  assert.deepEqual(
    failedEvent.files.map((file) => file.id),
    [logs.transferId],
  );
  assert.equal(failedEvent.links[0].label, "CI run");
  assert.equal(completedEvent.summary, "Fixed the flaky test");
  assert.equal(completedEvent.files, undefined);
  assert.equal(completedEvent.links[0].url, "https://github.com/acme/app/pull/9");
  assert.equal(detail.task.outcome.summary, "Fixed the flaky test");
  assert.equal(detail.task.outcome.files, undefined, "only the latest attempt's result");
  assert.equal(detail.task.outcome.links.length, 1);
  // The earlier attempt's file is still in the thread and still fetchable.
  assert.ok(detail.thread.items.some((item) => item.transfer?.id === logs.transferId));
});

test("3: a result file reads as expired after its 30 days, and its copy stays", async (t) => {
  const s = await setup(t);
  await s.create(["Old"]);
  const claimed = await s.claim(s.wes, 1);
  const file = await s.prepare(s.wes);
  await s.upload(file.transferId);
  await s.update(s.wes, claimed, {
    action: "complete",
    summary: "Done",
    transferIds: [file.transferId],
  });
  await s.x.control(`transfers-expired?server=${s.server.id}`);
  const [expired] = (await s.task(1)).task.outcome.files;
  assert.deepEqual([expired.id, expired.state, expired.sha256], [file.transferId, "expired", sha]);
  const fetched = await s.call(
    "fetch_transfer",
    { participantId: s.lead, transferId: file.transferId },
    true,
  );
  assert.equal(fetched.error.code, "transfer_expired");
  // History pruning then removes the offer and its transfer row; the task keeps its copy. (A
  // later brief makes the offer no longer the board channel's newest message, which stays.)
  await s.create(["Later"]);
  const pruned = await s.control("prune-messages");
  assert.ok(pruned.messages >= 1);
  const { transfers } = await s.control("results");
  assert.equal(transfers.length, 0, "file_transfers lost the row");
  const kept = (await s.task(1)).task.outcome.files;
  assert.deepEqual(kept, [expired]);
  const gone = await s.call(
    "fetch_transfer",
    { participantId: s.lead, transferId: file.transferId },
    true,
  );
  assert.equal(gone.error.code, "transfer_not_found");
});

test("11: the details message and each offer spend 1 + N units; links spend nothing", async (t) => {
  const s = await setup(t, { metering: true });
  await s.create(["Metered"]);
  const claimed = await s.claim(s.wes, 1);
  const files = [];
  for (const name of ["a.txt", "b.txt"]) {
    const file = await s.prepare(s.wes, { name });
    await s.upload(file.transferId);
    files.push(file.transferId);
  }
  const before = (await s.meter()).usage.length;
  const done = await s.update(s.wes, claimed, {
    action: "complete",
    summary: "Done",
    details: "Two files.",
    transferIds: files,
    links: Array.from({ length: 10 }, (_, i) => ({ kind: "url", url: `https://e.com/${i}` })),
  });
  const usage = (await s.meter()).usage.slice(before);
  const offers = done.data.task.outcome.files.map((file) => file.messageId);
  assert.deepEqual(
    usage.map((row) => [row.message_id, row.units, row.kind]).toSorted(),
    [
      [done.data.message.id, 1, "message"],
      [offers[0], 1, "share"],
      [offers[1], 1, "share"],
    ].toSorted(),
  );
});

test("11: with a share surcharge of 3, 8 files and details are refused before any write", async (t) => {
  const s = await setup(t, { metering: true, shareUnits: 3 });
  await s.create(["Heavy"]);
  const claimed = await s.claim(s.wes, 1);
  const ids = [];
  for (let i = 0; i < 8; i++) {
    const file = await s.prepare(s.wes, { name: `f${i}.txt` });
    await s.upload(file.transferId);
    ids.push(file.transferId);
  }
  const before = (await s.meter()).usage.length;
  const refused = await s.update(
    s.wes,
    claimed,
    { action: "complete", summary: "Done", details: "All of them.", transferIds: ids },
    { error: true },
  );
  assert.equal(refused.error.code, "invalid_input");
  assert.match(refused.error.message, /33 message units/);
  assert.equal((await s.meter()).usage.length, before);
  assert.equal((await s.task(1)).task.state, "claimed");
  // Without the details message it fits one block: 8 × 4 = 32.
  const done = await s.update(s.wes, claimed, {
    action: "complete",
    summary: "Done",
    transferIds: ids,
  });
  assert.equal(done.data.task.outcome.files.length, 8);
});

test("11 with swarm memory: a claim carries memory, and a complete with files spends 1 + files", async (t) => {
  // Memory has no switch: the first tasks set it up. The brief, then a finish of 1 details
  // message + 2 offers: one message short.
  const s = await setup(t, { memory: true, metering: true, allowance: 3 });
  await s.create(["Hand over the parser"]);
  const claimed = await s.claim(s.wes, 1);
  assert.match(claimed.memory.root, /^# Swarm memory/);
  const files = [];
  for (const name of ["parser.bundle", "report.txt"]) {
    const file = await s.prepare(s.wes, { name });
    await s.upload(file.transferId);
    files.push(file.transferId);
  }
  const finish = {
    action: "complete",
    summary: "Parser handed over",
    details: "Bundle and report attached.",
    transferIds: files,
    links: [{ kind: "commit", role: "head", sha: head }],
  };
  const before = (await s.meter()).usage.length;
  const refused = await s.update(s.wes, claimed, finish, { error: true });
  assert.equal(refused.error.code, "message_allowance_exhausted");
  assert.equal((await s.meter()).usage.length, before, "a refused finish journals nothing");
  const waiting = (await s.task(1)).task;
  assert.equal(waiting.state, "claimed");
  assert.equal(waiting.outcome, undefined);

  // One message more funds it: the same finish now succeeds in one call.
  await s.publish(4);
  const done = await s.update(s.wes, claimed, finish);
  assert.equal(done.data.task.state, "completed");
  // Task results: both files offered in the thread, and the link on the outcome.
  const outcome = done.data.task.outcome;
  assert.deepEqual(
    outcome.files.map((file) => [file.id, file.state]),
    files.map((id) => [id, "available"]),
  );
  assert.deepEqual(outcome.links, [{ kind: "commit", role: "head", sha: head }]);
  // A finish changes nothing in memory; it carries no memory field.
  assert.equal(done.data.memory, undefined);
  // Metering: 1 details message and 1 share for each offer, each under its own ID.
  const usage = (await s.meter()).usage.slice(before);
  assert.deepEqual(
    usage.map((row) => [row.message_id, row.units, row.kind]).toSorted(),
    [
      [done.data.message.id, 1, "message"],
      ...outcome.files.map((file) => [file.messageId, 1, "share"]),
    ].toSorted(),
  );
  // The finished event carries the files and links too.
  const event = (await s.task(1)).events.find((item) => item.kind === "completed");
  assert.deepEqual(
    event.files.map((file) => file.id),
    files,
  );
  assert.equal(event.links.length, 1);
});

test("1: limits and link rules are checked before anything is written", async (t) => {
  const s = await setup(t);
  await s.create(["Rules"]);
  const claimed = await s.claim(s.wes, 1);
  const url = (value) => ({ kind: "url", url: value });
  const long = `https://example.com/${"a".repeat(2048 - "https://example.com/".length)}`;
  const bad = [
    { transferIds: [] },
    { transferIds: Array.from({ length: 9 }, () => randomUUID()) },
    { transferIds: [base.slice(0, 36), base.slice(0, 36)] },
    { links: [] },
    { links: Array.from({ length: 11 }, (_, i) => url(`https://e.com/${i}`)) },
    { links: [url("http://example.com/")] },
    { links: [url("ftp://example.com/")] },
    { links: [url("https://user:pass@example.com/")] },
    { links: [url("https://github.com@evil.example/")] },
    { links: [url(`${long}a`)] },
    { links: [url("https://example.com/a b")] },
    { links: [url("https://example.com/\u0007")] },
    { links: [url("example.com/path")] },
    { links: [{ kind: "pr" }] },
    { links: [{ kind: "commit", sha: "abc1234" }] },
    { links: [{ kind: "commit", sha: base.toUpperCase() }] },
    { links: [{ kind: "commit", sha: `${base}0` }] },
    { links: [{ kind: "branch", name: "-x" }] },
    { links: [{ kind: "branch", name: "a..b" }] },
    { links: [{ kind: "branch", name: "x.lock" }] },
    { links: [{ kind: "branch", name: "a//b" }] },
    { links: [{ kind: "branch", name: "x/" }] },
    { links: [{ kind: "branch", name: "/x" }] },
    { links: [{ kind: "branch", name: "a b" }] },
    { links: [{ kind: "branch", name: "a$b" }] },
    { links: [{ kind: "branch", name: "b".repeat(201) }] },
    { links: [{ kind: "pr", url: "https://e.com/1", role: "head" }] },
    { links: [{ kind: "url", url: "https://e.com/", sha: base }] },
    { links: [{ kind: "deployment", url: "https://e.com/" }] },
    {
      links: [
        { kind: "commit", role: "base", sha: base },
        { kind: "commit", role: "base", sha: head },
      ],
    },
    {
      links: [
        { kind: "commit", role: "head", sha: base },
        { kind: "commit", role: "head", sha: head },
      ],
    },
    { links: [{ ...url("https://e.com/"), label: "x".repeat(101) }] },
    { links: [{ ...url("https://e.com/"), label: "two\nlines" }] },
    { links: [{ ...url("https://e.com/"), label: "   " }] },
  ];
  for (const fields of bad) {
    const result = await s.update(
      s.wes,
      claimed,
      { action: "complete", summary: "Done", ...fields },
      { error: true },
    );
    assert.equal(result.error.code, "invalid_input", JSON.stringify(fields).slice(0, 200));
  }
  // Results only go on complete and fail.
  const progress = await s.update(
    s.wes,
    claimed,
    { action: "progress", links: [url("https://e.com/")] },
    { error: true },
  );
  assert.equal(progress.error.code, "invalid_input");
  assert.equal((await s.task(1)).task.state, "claimed");
  assert.equal((await s.control("results")).results.length, 0);
  // What is allowed: exactly 10 links, a 2,048-byte URL, a 100-byte label, a 64-character SHA.
  const done = await s.update(s.wes, claimed, {
    action: "complete",
    summary: "Done",
    links: [
      url(long),
      { ...url("https://e.com/label"), label: `  ${"é".repeat(50)}  ` },
      { kind: "commit", sha: "c".repeat(64), role: "head" },
      { kind: "commit", sha: base, role: "base", url: "https://github.com/a/b/commit/1" },
      { kind: "commit", sha: head },
      { kind: "branch", name: "feature/task-1_v2.0" },
      ...Array.from({ length: 4 }, (_, i) => url(`https://e.com/${i}`)),
    ],
  });
  const links = done.data.task.outcome.links;
  assert.equal(links.length, 10);
  assert.equal(links[0].url, long);
  assert.equal(links[1].label, "é".repeat(50), "labels are trimmed");
});

test("15: a read_tasks list page ends at the byte budget and continues with the cursor", async (t) => {
  const s = await setup(t);
  const tasks = await s.create(Array.from({ length: 6 }, (_, i) => `Large ${i + 1}`));
  for (const [i, created] of tasks.entries()) {
    const claimed = await s.claim(s.wes, created.number);
    await s.update(s.wes, claimed, {
      action: "complete",
      summary: `Done ${i + 1}`,
      links: Array.from({ length: 10 }, (_, j) => ({
        kind: "url",
        url: `https://e.com/${i}/${j}/${"p".repeat(1990)}`,
      })),
    });
  }
  const first = await s.call("read_tasks", { participantId: s.lead, mode: "list", limit: 25 });
  assert.ok(first.data.items.length < 6, `${first.data.items.length} tasks on the first page`);
  assert.ok(first.data.nextCursor);
  const seen = first.data.items.map((item) => item.number);
  let cursor = first.data.nextCursor;
  while (cursor !== null) {
    const next = await s.call("read_tasks", {
      participantId: s.lead,
      mode: "list",
      limit: 25,
      cursor,
    });
    seen.push(...next.data.items.map((item) => item.number));
    cursor = next.data.nextCursor;
  }
  assert.deepEqual(seen.toSorted(), [1, 2, 3, 4, 5, 6]);
});

test("12, 13: results go with their task, and a server from before task results upgrades", async (t) => {
  const s = await setup(t);
  await s.create(["Old result", "New result"]);
  // A server object from before task results has none of its tables. On its next start it
  // creates them and keeps schema version 11.
  await s.control("drop-results");
  await s.x.control(`resources?server=${s.server.id}`, "restart");
  const inspected = await s.control("inspect");
  assert.equal(inspected.version, 11);
  assert.ok(
    inspected.tables.includes("task_results") && inspected.tables.includes("task_result_files"),
  );
  const one = await s.claim(s.wes, 1);
  await s.update(s.wes, one, { action: "complete", summary: "Old way" });
  // As if a Worker from before task results had finished it: no result row. The event falls back
  // to the task's own summary, and the task shows no files or links.
  await s.control("forget-result", 1);
  const old = await s.task(1);
  assert.equal(old.events.find((event) => event.kind === "completed").summary, "Old way");
  assert.deepEqual(Object.keys(old.task.outcome).toSorted(), ["at", "kind", "reason", "summary"]);
  const two = await s.claim(s.wyn, 2);
  const file = await s.prepare(s.wyn);
  await s.upload(file.transferId);
  await s.update(s.wyn, two, {
    action: "complete",
    summary: "With files",
    transferIds: [file.transferId],
    links: [{ kind: "url", url: "https://e.com/" }],
  });
  const stored = await s.control("results");
  assert.deepEqual([stored.results.length, stored.files.length], [1, 1]);
  // History size counts the result rows; removing the tasks removes them through the trigger,
  // which a previous Worker's pruning runs too.
  const before = (await s.control("inspect")).bytes;
  const pruned = await s.control("prune");
  assert.equal(pruned.tasks, 2);
  const after = await s.control("results");
  assert.deepEqual([after.results.length, after.files.length], [0, 0]);
  assert.ok(after.bytes < before);
  assert.equal((await s.control("inspect")).rows.tasks, 0);
});
