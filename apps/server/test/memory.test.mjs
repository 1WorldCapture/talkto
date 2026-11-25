import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";
import { outputSchemas } from "./mcp-output.mjs";
import { packet, rpc } from "./mcp-wire.mjs";

/**
 * Hand one receive-pack body that TalkTo's Git writer sent to real Git: unpack it into a bare
 * repository, point main at `head` and check every object strictly. Returns `git show main:path`.
 */
const realGit = (t, body, head, path) => {
  const directory = mkdtempSync(join(tmpdir(), "talkto-memory-git-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (args, input) =>
    execFileSync("git", ["-C", directory, ...args], { input, encoding: "utf8" });
  git(["init", "--quiet", "--bare"]);
  const bytes = Buffer.from(body, "base64");
  execFileSync("git", ["-C", directory, "unpack-objects", "-q"], {
    input: bytes.subarray(bytes.indexOf("PACK")),
  });
  git(["update-ref", "refs/heads/main", head]);
  git(["fsck", "--strict", "--no-dangling"]);
  return git(["show", `main:${path}`]);
};

/*
  Swarm memory on Cloudflare Artifacts (docs/swarm-server-spec.md, 14): one Git repository per
  swarm server, delivered on claim from a cache of its last good head, changed by agents with real
  Git, and announced one line per commit in a memory channel that never wakes anyone. Every test
  runs on the real Worker, D1 and server object; the Git store is the fake in memory-fake.ts, which
  keeps real Git objects. `/__control/memory` reads the ledger and acts as an agent's Git would.
*/

/**
 * A swarm server with memory offered, a lead and workers over Alice's MCP connection. Memory has no
 * switch: with `on`, the lead's first get_context sets it up. With `join`, Alice (the server's
 * creator) joins as a person first, so her person creates the memory channel and sends the lines
 * no single agent wrote. Agents register over MCP, whose reply shows the context and so sets memory
 * up too; with `http` they register over HTTP, which does not, so a later call is memory's first.
 */
const setup = async (
  t,
  options = {},
  { on = true, join = true, http = false, budgets = null } = {},
) => {
  const x = await start(t, { board: true, memory: true, manualAlarms: true, ...options });
  const account = await x.account();
  if (budgets !== null) await x.control(`quota/configure?account=${account.id}`, { budgets });
  const server = await x.server(account.id, { board: true });
  const root = `/v1/servers/${server.id}`;
  const credential = await x.mcpToken(account.organizationId);
  const call = (name, args, error = false) =>
    x.mcp(credential, name, { serverId: server.id, ...args }, error);
  const person = join ? (await x.call("user_alice", "POST", `${root}/people/me`)).item.id : null;
  const register = async (name) =>
    http
      ? (
          await x.call("user_alice", "POST", `${root}/participants`, {
            name,
            agentType: "codex",
            requestKey: randomUUID(),
          })
        ).item.id
      : (await call("register_participant", { name, agentType: "codex", requestKey: randomUUID() }))
          .data.item.id;
  const lead = await register("Lead");
  const wes = await register("Wes");
  const wyn = await register("Wyn");
  const create = (tasks) =>
    call("create_tasks", { participantId: lead, requestKey: randomUUID(), tasks });
  const claim = (participantId, selector = { next: {} }, error = false) =>
    call("claim_task", { participantId, requestKey: randomUUID(), ...selector }, error);
  const update = (participantId, claimed, action, error = false) =>
    call(
      "update_task",
      {
        participantId,
        requestKey: randomUUID(),
        taskId: claimed.task.id,
        leaseToken: claimed.lease.token,
        epoch: claimed.lease.epoch,
        ...action,
      },
      error,
    );
  const control = async (input) => {
    const response = await x.control(`memory?server=${server.id}`, input);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const inspect = () => control({ action: "inspect" });
  /** Act on the repository as an agent's Git would. */
  const git = (input) => control({ action: "git", git: input });
  /** Let the next claim read the head now, as if its 30 seconds had passed. */
  const stale = () => control({ action: "stale" });
  const board = (value, status = 200, user = "user_alice") =>
    x.call(user, "PUT", `${root}/board`, value, status);
  const context = async (participantId = lead) =>
    (await call("get_context", { participant: { id: participantId } })).data.board;
  /** get_context's board.memory once the lead's first context set memory up. */
  const started = on ? (await context()).memory : null;
  /** Create one task, claim it as `worker`, and return the claim. */
  const take = async (worker, title, labels = []) => {
    await create([{ title, brief: `Do this: ${title}.`, labels }]);
    const claimed = await claim(worker);
    assert.equal(claimed.data.claimed, true, JSON.stringify(claimed));
    return claimed.data;
  };
  const writeAccess = (participantId, claimed, error = false) =>
    call(
      "get_memory_access",
      {
        participantId,
        write: {
          taskId: claimed.task.id,
          leaseToken: claimed.lease.token,
          epoch: claimed.lease.epoch,
        },
      },
      error,
    );
  return {
    x,
    account,
    server,
    root,
    credential,
    call,
    lead,
    wes,
    wyn,
    create,
    claim,
    update,
    control,
    inspect,
    git,
    stale,
    board,
    person,
    context,
    started,
    take,
    writeAccess,
  };
};
/** A published allowance, so the local meter journals every unit it spends. */
const allowance = async (s, messages) => {
  const response = await s.x.control(`quota/publish?account=${s.account.id}`, {
    accountId: s.account.id,
    start: new Date(Date.now() - 3600000).toISOString(),
    end: new Date(Date.now() + 3600000).toISOString(),
    allowance: messages,
    overdraft: 0,
  });
  assert.equal(response.status, 200, await response.clone().text());
};
const bodies = (state) => state.posts.map((post) => post.body);
/** A person signed in on the TalkTo website: session cookie and the website's Origin. */
const website = async (x, user = "user_alice") => {
  const flow = await x.browserLogin(user);
  const cookie = (await flow.callback()).headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-talkto-session="))
    .split(";")[0];
  return async (method, path) => {
    const response = await x.raw(path, {
      method,
      headers: { cookie, origin: "https://talkto.test" },
    });
    return { status: response.status, json: await response.json() };
  };
};
/** The Board's top as Settings reads it, over Alice's website session. */
const boardTop = async (s) => {
  const response = await (await website(s.x))("GET", `${s.root}/board`);
  assert.equal(response.status, 200);
  return response.json.data;
};

test("the first get_context sets memory up: mem-<serverId> from the template, and its channel", async (t) => {
  const s = await setup(t);
  // Always true: memory has no switch; the field stays for older output schemas.
  assert.equal(s.started.enabled, true);
  assert.equal(s.started.files, 1);
  assert.match(s.started.version, /^[0-9a-f]{40}$/);
  const state = await s.inspect();
  assert.equal(state.repository.name, `mem-${s.server.id}`);
  assert.equal(state.repository.seeded, 1);
  assert.equal(state.repository.tokens, 1500);
  assert.equal(state.repository.good_head, s.started.version);
  // One commit on main: the root AGENTS.md, norms and a map with empty folders.
  assert.deepEqual(Object.keys(state.git.files), ["AGENTS.md"]);
  assert.equal(state.git.refs["refs/heads/main"], s.started.version);
  const root = state.git.files["AGENTS.md"];
  // The seed push is a real Git pack: real Git unpacks it, checks it strictly, and reads the same file.
  assert.equal(realGit(t, state.git.pushes[0].body, s.started.version, "AGENTS.md"), root);
  assert.match(root, /## Norms/);
  assert.match(root, /## Map\n- `decisions\/`/);
  assert.match(root, /`research\/`/);
  assert.match(root, /`traps\/`/);
  assert.match(root, /Never record what you changed or fixed/);
  assert.match(root, /integer cents, and reports errors with HTTP 200/);
  // Its own first commit is memory's start, never a change note, and the ledger has no tokens left.
  assert.deepEqual(bodies(state), []);
  assert.deepEqual(state.tokens, []);
  // The memory channel, created by the creator's person, described, and announced in General.
  const history = await s.call("read_messages", {
    mode: "history",
    conversationId: s.started.channelId,
  });
  const channel = history.included.conversations.find((item) => item.id === s.started.channelId);
  assert.equal(channel.name, "memory");
  assert.equal(channel.createdByParticipantId, s.person);
  assert.match(channel.description, /No reply needed; nothing here wakes anyone/);
  assert.equal(state.repository.poster_id, s.person);
  // Later calls keep the same repository and channel; Settings shows memory started.
  const again = await s.context(s.wes);
  assert.deepEqual(again.memory, s.started);
  assert.deepEqual((await boardTop(s)).memory, { started: true });
  assert.equal((await s.inspect()).git.pushes.length, 1, "seeded once");
});

test("an existing swarm's first claim sets memory up, with no PUT, and later claims carry it", async (t) => {
  const s = await setup(t, {}, { on: false, join: false, http: true });
  assert.equal((await s.inspect()).repository, null, "agents registered without memory");
  // Nothing to claim yet: the claim still sets memory up.
  const empty = await s.claim(s.wes);
  assert.equal(empty.data.claimed, false);
  const state = await s.inspect();
  assert.equal(state.repository.seeded, 1);
  assert.equal(state.git.pushes.length, 1);
  // Without the creator's person on the server, the agent whose call set memory up made the channel.
  assert.equal(state.repository.poster_id, null);
  const channel = await s.call("read_messages", {
    mode: "history",
    conversationId: state.repository.channel_id,
  });
  const made = channel.included.conversations.find(
    (item) => item.id === state.repository.channel_id,
  );
  assert.equal(made.name, "memory");
  assert.equal(made.createdByParticipantId, s.wes);
  const claimed = await s.take(s.wyn, "First task");
  assert.match(claimed.memory.root, /^# Swarm memory/);
  assert.equal(claimed.memory.version, state.repository.good_head);
});

test("concurrent first calls set memory up once: one repository, one seed, one channel", async (t) => {
  const s = await setup(t, {}, { on: false, http: true });
  assert.equal((await s.inspect()).repository, null);
  const replies = await Promise.all([
    s.claim(s.wes),
    s.claim(s.wyn),
    s.call("read_memory", { participantId: s.lead }),
    s.context(s.lead),
  ]);
  for (const reply of replies.slice(0, 2)) assert.equal(reply.data.claimed, false);
  assert.match(replies[2].data.text, /^# Swarm memory/);
  const state = await s.inspect();
  assert.equal(state.repository.seeded, 1);
  assert.equal(state.git.pushes.length, 1, "seeded once");
  assert.equal(state.commits.length, 1, "one start commit");
  assert.deepEqual(
    state.channels.filter((name) => name.startsWith("memory")),
    ["memory"],
  );
  assert.equal(state.repository.channel_id, replies[3].memory.channelId);
});

test("an Artifacts failure while setting up leaves the claim working; a later claim sets it up", async (t) => {
  const s = await setup(t, {}, { on: false, http: true });
  await s.git({ action: "levers", failPushes: 1 });
  await s.create([
    { title: "One", brief: "Do one." },
    { title: "Two", brief: "Do two." },
  ]);
  // create_tasks tried first and failed at the seed push; the claim tries again and succeeds.
  let state = await s.inspect();
  assert.equal(state.repository.seeded, 0);
  assert.equal(state.repository.channel_id, null);
  await s.git({ action: "levers", failPushes: 2 });
  const first = await s.claim(s.wes);
  assert.equal(first.data.claimed, true, "the claim succeeds without memory");
  assert.ok(!("memory" in first.data));
  const read = await s.call("read_memory", { participantId: s.wes }, true);
  assert.equal(read.error.code, "memory_unavailable");
  // A later call sets it up: the claim carries memory.
  const second = await s.claim(s.wyn);
  assert.equal(second.data.claimed, true);
  assert.match(second.data.memory.root, /^# Swarm memory/);
  state = await s.inspect();
  assert.equal(state.repository.seeded, 1);
  assert.notEqual(state.repository.channel_id, null);
  assert.equal(state.git.pushes.length, 1, "one seed push landed");
});

test("a server whose memory was switched off before is on now, with its channel and repository", async (t) => {
  const s = await setup(t);
  const before = await s.inspect();
  // The old switch's off, as staging stored it.
  await s.control({ action: "switch-off" });
  assert.equal((await s.inspect()).repository.enabled, 0);
  const claimed = await s.take(s.wes, "After the switch");
  assert.equal(claimed.memory.version, s.started.version);
  const read = await s.call("read_memory", { participantId: s.wes });
  assert.equal(read.data.version, s.started.version);
  const context = await s.context(s.wes);
  assert.equal(context.memory.channelId, s.started.channelId);
  assert.equal(context.memory.enabled, true);
  const after = await s.inspect();
  assert.equal(after.repository.name, before.repository.name);
  assert.equal(after.repository.channel_id, before.repository.channel_id);
  assert.equal(after.git.pushes.length, 1, "never seeded again");
  assert.equal(after.channels.filter((name) => name.startsWith("memory")).length, 1);
  // Its commit lines are posted again.
  await s.git({
    action: "commit",
    message: "Add the retry trap",
    files: { "traps/retry.md": "R" },
  });
  await s.stale();
  await s.take(s.wyn, "Read again");
  assert.deepEqual(bodies(await s.inspect()), ["Add the retry trap"]);
});

test("PUT …/board refuses memory.enabled as unknown input; tokens and from need no switch", async (t) => {
  const s = await setup(t, {}, { on: false, http: true });
  for (const enabled of [true, false]) {
    const refused = await s.board({ memory: { enabled } }, 400);
    assert.equal(refused.error.code, "invalid_input");
    const both = await s.board({ memory: { enabled, tokens: 800 } }, 400);
    assert.equal(both.error.code, "invalid_input");
  }
  assert.equal((await s.inspect()).repository, null, "a refused body sets nothing up");
  assert.deepEqual((await boardTop(s)).memory, { started: false });
  // tokens alone sets memory up and saves the budget.
  const saved = await s.board({ memory: { tokens: 800 } });
  assert.equal(saved.memory.tokens, 800);
  assert.equal(saved.memory.enabled, undefined);
  assert.match(saved.memory.version, /^[0-9a-f]{40}$/);
  assert.match(saved.memory.channelId, /.+/);
  // Settings shows memory started, with no switch.
  assert.deepEqual((await boardTop(s)).memory, { started: true });
});

test("fork: a new server's memory starts from another server the person can access", async (t) => {
  const s = await setup(t);
  await s.git({ action: "commit", files: { "traps/build.md": "Run the build twice." } });
  const second = await s.x.server(s.account.id, { name: "Second", board: true });
  const forked = await s.x.call("user_alice", "PUT", `/v1/servers/${second.id}/board`, {
    memory: { from: s.server.id },
  });
  const copy = await s.control({ action: "inspect", repository: `mem-${second.id}` });
  assert.deepEqual(Object.keys(copy.files).toSorted(), ["AGENTS.md", "traps/build.md"]);
  assert.equal(forked.memory.version, copy.refs["refs/heads/main"]);
  assert.equal(copy.pushes.length, 0, "a fork is not seeded again");
  // A server the person cannot access, or this server itself, cannot be the source.
  const bobs = await s.x.call("user_bob", "POST", "/v1/accounts", {
    name: "Bob's team",
    requestKey: randomUUID(),
  });
  const hidden = await s.x.call("user_bob", "POST", `/v1/accounts/${bobs.id}/servers`, {
    name: "Hidden",
    board: true,
    requestKey: randomUUID(),
  });
  await s.x.call("user_bob", "PUT", `/v1/servers/${hidden.id}/board`, { memory: {} });
  const third = await s.x.server(s.account.id, { name: "Third", board: true });
  const refused = await s.x.call(
    "user_alice",
    "PUT",
    `/v1/servers/${third.id}/board`,
    { memory: { from: hidden.id } },
    403,
  );
  assert.equal(refused.error.code, "forbidden");
  const self = await s.x.call(
    "user_alice",
    "PUT",
    `/v1/servers/${third.id}/board`,
    { memory: { from: third.id } },
    400,
  );
  assert.equal(self.error.code, "invalid_input");
  assert.equal(
    (await s.control({ action: "inspect", repository: `mem-${third.id}` })).exists,
    false,
  );
});

test("a claim carries the root map and its labels' files within the budget; the rest are omitted", async (t) => {
  const s = await setup(t);
  const map = [
    "# Swarm memory",
    "",
    "## Norms",
    "- Keep this short.",
    "",
    "## Map",
    "- `traps/payments.md`: the payments API's traps. Open before payments work.",
    "- `decisions/storage.md`: why storage is SQLite. Open before you change storage.",
    "- `research/latency.md`: measured latencies, with sources.",
    "",
  ].join("\n");
  await s.git({
    action: "commit",
    message: "Map payments, storage and latency",
    files: {
      "AGENTS.md": map,
      "traps/payments.md": "The payments API returns integer cents and errors with HTTP 200.",
      "decisions/storage.md": "---\nlabels: [storage]\n---\nSQLite, for one writer per server.",
      // Past the 1,500-token budget on its own.
      "research/latency.md": `---\nlabels: [payments]\n---\n${"Measured 40 ms at p50. ".repeat(400)}`,
    },
  });
  await s.stale();
  const claimed = await s.take(s.wes, "Refund", ["area=payments"]);
  const memory = claimed.memory;
  // The root map always comes, in full; then the files the labels route to.
  assert.equal(memory.root, map);
  assert.match(memory.version, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    memory.files.map((file) => file.path),
    ["traps/payments.md"],
  );
  assert.ok(memory.tokens <= 1500, `${memory.tokens} tokens`);
  // The oversized match and the unmatched file are listed with what their map lines say.
  assert.deepEqual(memory.omitted, [
    { path: "research/latency.md", about: "measured latencies, with sources." },
    {
      path: "decisions/storage.md",
      about: "why storage is SQLite. Open before you change storage.",
    },
  ]);
  // read_memory serves an omitted file, and lists every file without a path.
  const read = await s.call("read_memory", { participantId: s.wes, path: "decisions/storage.md" });
  assert.match(read.data.text, /SQLite, for one writer/);
  const listing = await s.call("read_memory", { participantId: s.wes });
  assert.equal(listing.data.path, "AGENTS.md");
  assert.deepEqual(
    listing.data.files.map((file) => [file.path, file.labels]),
    [
      ["AGENTS.md", []],
      ["decisions/storage.md", ["storage"]],
      ["research/latency.md", ["payments"]],
      ["traps/payments.md", []],
    ],
  );
  const missing = await s.call("read_memory", { participantId: s.wes, path: "nope.md" }, true);
  assert.equal(missing.error.code, "invalid_input");
  // A label routed by front matter, and a smaller budget: the root always comes.
  await s.board({ memory: { tokens: 500 } });
  const storage = await s.take(s.wyn, "Move tables", ["area=storage"]);
  assert.equal(storage.memory.root, map);
  assert.deepEqual(
    storage.memory.files.map((file) => file.path),
    ["decisions/storage.md"],
  );
});

test("a new head is posted once, commit by commit, as TalkTo; never metered as a message, never a mention", async (t) => {
  const s = await setup(t, { metering: true });
  await allowance(s, 100);
  const before = (await s.inspect()).usage.length;
  await s.git({
    action: "commit",
    message: "Add the build trap",
    files: { "traps/build.md": "A" },
  });
  await s.git({
    action: "commit",
    message: "Correct the build trap: it needs Node 22\n\nThe old line said Node 20.",
    files: { "traps/build.md": "B" },
  });
  // Within 30 seconds of the last read, a claim keeps the cache.
  const early = await s.take(s.wes, "Early");
  assert.equal(early.memory.version, s.started.version);
  await s.stale();
  const late = await s.take(s.wyn, "Late");
  assert.notEqual(late.memory.version, s.started.version);
  await s.stale();
  await s.take(s.lead, "Again");
  const state = await s.inspect();
  assert.deepEqual(bodies(state), [
    "Add the build trap",
    "Correct the build trap: it needs Node 22",
  ]);
  // Sent by the server creator's person, mentioning nobody, with no notice to wake on.
  for (const post of state.posts) assert.equal(post.senderId, s.person);
  for (const post of state.posts) assert.deepEqual([post.mentions, post.notices], [0, 0]);
  const read = await s.call("read_messages", {
    mode: "history",
    conversationId: s.started.channelId,
  });
  for (const message of read.data.items) assert.equal(message.notice, undefined);
  // Each commit counts as one unit under its own usage ID; the posts themselves are never metered.
  const metered = state.commits.filter((commit) => commit.metered === 1);
  assert.equal(metered.length, 2);
  const used = state.usage.slice(before).map((row) => row.id);
  for (const commit of metered) assert.ok(used.includes(commit.usage_id));
  for (const post of state.posts) assert.ok(!used.includes(post.id), "a memory post is free");
});

test("get_memory_access: read tokens for any agent, write tokens only for the claim holder, rate-limited", async (t) => {
  const s = await setup(t, { taskBudgets: true });
  const taskCalls = async () =>
    (await (await s.x.control(`quota/budgets?account=${s.account.id}`)).json()).calls.filter(
      (entry) => entry.lane === "task",
    ).length;
  const before = await taskCalls();
  const read = await s.call("get_memory_access", { participantId: s.lead });
  assert.equal(read.data.scope, "read");
  assert.equal(read.data.commands.push, undefined);
  assert.match(
    read.data.commands.clone,
    /^git -c http\.extraHeader="Authorization: Bearer [^"]+" clone https:/,
  );
  // Never in the remote URL.
  assert.ok(!read.data.remote.includes(read.data.token));
  assert.ok(Date.parse(read.data.expiresAt) - Date.now() <= 600_000);
  assert.equal(await taskCalls(), before + 1, "a grant is one task operation");
  // A write token only for the holder of a live claim, ending no later than its lease.
  const claimed = await s.take(s.wes, "Write");
  const stranger = await s.writeAccess(s.wyn, claimed, true);
  assert.equal(stranger.error.code, "claim_lost");
  const write = await s.writeAccess(s.wes, claimed);
  assert.equal(write.data.scope, "write");
  assert.match(write.data.commands.push, /push https:\S+ HEAD:main$/);
  assert.ok(Date.parse(write.data.expiresAt) <= Date.parse(claimed.lease.expiresAt));
  let state = await s.inspect();
  const ledger = state.tokens.find((token) => token.scope === "write");
  assert.equal(ledger.task_id, claimed.task.id);
  assert.equal(ledger.revoked_at, null);
  // The claim ends: its write token is revoked at once, and the head is read.
  await s.update(s.wes, claimed, { action: "complete", summary: "Done" });
  state = await s.inspect();
  const ended = state.tokens.find((token) => token.id === ledger.id);
  assert.notEqual(ended.revoked_at, null);
  assert.notEqual(ended.settled_at, null);
  assert.equal(state.git.tokens.find((token) => token.id === ended.token_id).revoked, true);
  // Six read tokens an hour per agent: the seventh is refused with when to retry.
  for (let n = 0; n < 5; n += 1) await s.call("get_memory_access", { participantId: s.lead });
  const limited = await s.call("get_memory_access", { participantId: s.lead }, true);
  assert.equal(limited.error.code, "rate_limited");
  assert.equal(limited.error.scope, "participant");
  assert.ok(limited.error.retryAfterSeconds > 0);
});

test("a lapsed lease revokes its write token at the alarm, and the head is read then", async (t) => {
  const s = await setup(t);
  const claimed = await s.take(s.wes, "Slow");
  const write = await s.writeAccess(s.wes, claimed);
  await s.git({
    action: "commit",
    message: "Record the flaky staging host",
    files: { "outside.md": "x" },
  });
  await s.x.control(`board?server=${s.server.id}`, { action: "lapse" });
  await s.x.control(`board?server=${s.server.id}`, { action: "alarm" });
  const state = await s.inspect();
  const token = state.tokens.find((item) => item.scope === "write");
  assert.notEqual(token.revoked_at, null);
  assert.equal(state.git.tokens.find((item) => item.id === token.token_id).revoked, true);
  assert.deepEqual(bodies(state), ["Record the flaky staging host"]);
  assert.ok(write.data.token.length > 0);
});

test("a commit line is sent by the one agent whose write token could push it; otherwise by the creator", async (t) => {
  // One write token live: its agent sent the commit line.
  const one = await setup(t);
  const claimed = await one.take(one.wes, "Edit");
  await one.writeAccess(one.wes, claimed);
  await one.git({
    action: "commit",
    message: "Add the deploy trap",
    files: { "traps/deploy.md": "A" },
  });
  await one.update(one.wes, claimed, { action: "progress" });
  const solo = await one.inspect();
  assert.deepEqual(bodies(solo), ["Add the deploy trap"]);
  assert.equal(solo.posts[0].senderId, one.wes);
  assert.deepEqual([solo.posts[0].mentions, solo.posts[0].notices], [0, 0]);
  const read = await one.call("read_messages", {
    mode: "history",
    conversationId: one.started.channelId,
  });
  const line = read.data.items.find((item) => item.body === "Add the deploy trap");
  assert.equal(line.senderId, one.wes);
  assert.equal(line.notice, undefined);

  // No write token: the server creator's person sent it, though another agent made the channel
  // and the creator joined only later.
  const none = await setup(t, {}, { join: false });
  assert.equal((await none.inspect()).repository.poster_id, null);
  const person = (await none.x.call("user_alice", "POST", `${none.root}/people/me`)).item.id;
  await none.git({
    action: "commit",
    message: "Add the cache decision",
    files: { "decisions/cache.md": "One cache." },
  });
  await none.stale();
  await none.take(none.lead, "Read");
  // Two agents could push: the line cannot say which, so the creator's person sent it.
  const first = await none.take(none.wes, "First");
  const second = await none.take(none.wyn, "Second");
  await none.writeAccess(none.wes, first);
  await none.writeAccess(none.wyn, second);
  await none.git({
    action: "commit",
    message: "Add the build trap",
    files: { "traps/build.md": "B" },
  });
  await none.update(none.wes, first, { action: "progress" });
  const shared = await none.inspect();
  assert.deepEqual(bodies(shared), ["Add the cache decision", "Add the build trap"]);
  assert.deepEqual(
    shared.posts.map((post) => post.senderId),
    [person, person],
  );
  assert.equal(shared.repository.poster_id, person);
});

test("with the creator not on the server, lines come from the channel's agent, then the earliest agent left", async (t) => {
  const s = await setup(t, {}, { join: false });
  // The lead's registration set memory up, so the lead made the channel; nobody created a person.
  let state = await s.inspect();
  assert.equal(state.repository.poster_id, null);
  await s.git({ action: "delete-main" });
  await s.stale();
  await s.take(s.wes, "After delete");
  state = await s.inspect();
  assert.match(bodies(state)[0], /^TalkTo restored memory: main was deleted/);
  assert.equal(state.posts[0].senderId, s.lead, "the channel's creating agent");
  // A commit no write token could have pushed comes from the same agent.
  await s.git({ action: "commit", message: "Add the queue trap", files: { "traps/q.md": "Q" } });
  await s.stale();
  await s.claim(s.wyn);
  state = await s.inspect();
  assert.deepEqual(state.posts.map((post) => [post.body, post.senderId]).at(-1), [
    "Add the queue trap",
    s.lead,
  ]);
  // Bob, a member, removes the lead: the earliest-joined agent still on the server sends the next.
  await s.x.control("member", s.x.member(s.account.organizationId, "user_bob"));
  await s.x.call("user_alice", "PUT", `${s.root}/access/user_bob`);
  const bob = await website(s.x, "user_bob");
  const removed = await bob("POST", `${s.root}/participants/${s.lead}/remove`);
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  await s.git({ action: "delete-main" });
  await s.stale();
  await s.claim(s.wyn);
  state = await s.inspect();
  assert.equal(state.posts.length, 3, "every line is posted");
  assert.match(state.posts[2].body, /^TalkTo restored memory: main was deleted/);
  assert.equal(state.posts[2].senderId, s.wes);
  assert.equal(state.repository.poster_id, null, "no person is created for the creator");
});

test("the holder's next update_task reads the head; concurrent pushes are both posted, in order", async (t) => {
  const s = await setup(t);
  const claimed = await s.take(s.wes, "Edit");
  await s.writeAccess(s.wes, claimed);
  const base = (await s.inspect()).git.refs["refs/heads/main"];
  const first = await s.git({
    action: "commit",
    parent: base,
    message: "Add the deploy trap",
    files: { "traps/deploy.md": "Deploy needs the staging flag." },
  });
  // A second agent pushed from the same base: Git refuses it; it pulls, rebases and pushes again.
  const stale = await s.git({
    action: "commit",
    parent: base,
    message: "Add the cache decision",
    files: { "decisions/cache.md": "One cache." },
  });
  assert.equal(stale.rejected, "non-fast-forward");
  await s.git({
    action: "commit",
    message: "Add the cache decision",
    files: { "decisions/cache.md": "One cache." },
  });
  await s.update(s.wes, claimed, { action: "progress" });
  const state = await s.inspect();
  assert.deepEqual(bodies(state), ["Add the deploy trap", "Add the cache decision"]);
  assert.deepEqual(
    state.files.map((file) => file.path),
    ["AGENTS.md", "decisions/cache.md", "traps/deploy.md"],
  );
  assert.ok(first.hash);
  // Other branches are ignored, and not deleted.
  await s.git({ action: "branch", branch: "draft", files: { "draft.md": "Unreviewed." } });
  await s.update(s.wes, claimed, { action: "progress" });
  const after = await s.inspect();
  assert.equal(after.posts.length, 2);
  assert.ok(after.git.refs["refs/heads/draft"]);
  assert.ok(!after.files.some((file) => file.path === "draft.md"));
});

test("a force push is put back at the last good head, said in one line, and its token revoked", async (t) => {
  const s = await setup(t);
  const claimed = await s.take(s.wes, "Careless");
  await s.writeAccess(s.wes, claimed);
  await s.git({
    action: "commit",
    message: "Add the queue trap",
    files: { "traps/queue.md": "Q" },
  });
  await s.update(s.wes, claimed, { action: "progress" });
  const good = (await s.inspect()).repository.good_head;
  await s.git({ action: "force", message: "Start over", files: { "AGENTS.md": "Gone." } });
  await s.update(s.wes, claimed, { action: "progress" });
  const state = await s.inspect();
  assert.equal(state.git.refs["refs/heads/main"], good);
  assert.equal(state.repository.good_head, good);
  assert.equal(state.git.files["traps/queue.md"], "Q");
  const [, line] = bodies(state);
  assert.match(
    line,
    /^TalkTo restored memory: main was replaced by [0-9a-f]{7}, which does not contain/,
  );
  assert.match(line, /the write token that could do it is revoked/);
  // Restore lines come from the server creator's person.
  assert.equal(state.posts.at(-1).senderId, s.person);
  assert.equal(bodies(state).length, 2, "the forced commit is never posted");
  const token = state.tokens.find((item) => item.scope === "write");
  assert.notEqual(token.revoked_at, null);
  // The holder can ask again while the claim is live.
  const again = await s.writeAccess(s.wes, claimed);
  assert.equal(again.data.scope, "write");
});

test("a deleted main is restored, even when the good commit is gone from the store", async (t) => {
  const s = await setup(t);
  const good = s.started.version;
  await s.git({ action: "delete-main" });
  await s.stale();
  await s.take(s.wes, "After delete");
  let state = await s.inspect();
  assert.equal(state.git.refs["refs/heads/main"], good);
  assert.match(bodies(state)[0], /^TalkTo restored memory: main was deleted\. main is back at/);
  // The store lost the commit too: TalkTo writes a new one from its cached files.
  await s.git({ action: "delete-main" });
  await s.git({ action: "drop", hash: good });
  await s.stale();
  await s.take(s.wyn, "After loss");
  state = await s.inspect();
  const head = state.git.refs["refs/heads/main"];
  assert.notEqual(head, good);
  assert.equal(state.repository.good_head, head);
  assert.deepEqual(Object.keys(state.git.files), ["AGENTS.md"]);
  assert.equal(
    realGit(t, state.git.pushes.at(-1).body, head, "AGENTS.md"),
    state.git.files["AGENTS.md"],
  );
  assert.equal(bodies(state).length, 2);
});

test("the monthly edit cap makes memory read-only: write tokens refused and revoked", async (t) => {
  const s = await setup(t, { taskBudgets: true }, { budgets: { memoryMonthly: 2 } });
  const claimed = await s.take(s.wes, "Edits");
  await s.writeAccess(s.wes, claimed);
  await s.git({ action: "commit", message: "One", files: { "a.md": "1" } });
  await s.git({ action: "commit", message: "Two", files: { "b.md": "2" } });
  await s.update(s.wes, claimed, { action: "progress" });
  const state = await s.inspect();
  assert.ok(state.repository.capped_until > Date.now());
  assert.deepEqual(bodies(state), ["One", "Two"], "landed commits are still posted");
  const refused = await s.writeAccess(s.wes, claimed, true);
  assert.equal(refused.error.code, "rate_limited");
  assert.equal(refused.error.scope, "organization");
  // Reading still works.
  const read = await s.call("get_memory_access", { participantId: s.wes });
  assert.equal(read.data.scope, "read");
  await s.update(s.wes, claimed, { action: "progress" });
  const after = await s.inspect();
  for (const token of after.tokens.filter((item) => item.scope === "write"))
    assert.notEqual(token.revoked_at, null);
});

test("without a binding memory is cleanly unavailable: no tools, no claim field, no guide lines", async (t) => {
  for (const options of [{ memory: true, memoryBinding: false }, { memory: false }]) {
    const s = await setup(t, options, { on: false });
    const refused = await s.board({ enabled: true, memory: { tokens: 800 } }, 400);
    assert.equal(refused.error.code, "invalid_input");
    const settings = await s.board({ enabled: true });
    assert.equal(settings.memory, undefined);
    const claimed = await s.take(s.wes, "No memory");
    assert.ok(!("memory" in claimed));
    const context = (await s.call("get_context", { participant: { id: s.lead } })).data;
    assert.ok(!("memory" in context.board));
    const listed = await outputSchemas(s.x.raw, s.credential);
    assert.equal(listed.read_memory, undefined);
    assert.equal(listed.get_memory_access, undefined);
    const http = await s.x.call(
      "user_alice",
      "GET",
      `${s.root}/memory?participantId=${s.wes}`,
      undefined,
      503,
    );
    assert.equal(http.error.code, "memory_unavailable");
    const guide = await (await s.x.raw("/instructions")).text();
    assert.doesNotMatch(guide, /\*\*Memory\.\*\*|<!--|get_memory_access/);
    // The block sits after the result files bullet; removing it leaves no gap there.
    assert.match(guide, /\(links still work\)\.\n- \*\*Silence shows\.\*\*/);
  }
});

/** The one line a claim's memory carries (tasks.ts, memoryCompleteNote). */
const completeNote =
  "Learned something the next agent would trip on? Add it to memory before you complete: get_memory_access with write, while you still hold the claim.";
/** `{ toolName: description }` from a live tools/list. */
const toolDescriptions = async (raw, credential) => {
  const listed = await packet(await raw("/mcp", rpc("tools/list", {}, credential)));
  return Object.fromEntries(listed.result.tools.map((tool) => [tool.name, tool.description]));
};

test("with memory, a claim says to write before complete, while its write token can still be had", async (t) => {
  const s = await setup(t);
  const claimed = await s.take(s.wes, "Remember");
  assert.equal(claimed.memory.note, completeNote);
  // The note counts in the memory's token estimate.
  assert.equal(
    claimed.memory.tokens,
    Math.ceil(Buffer.byteLength(JSON.stringify({ ...claimed.memory, tokens: 0 })) / 4),
  );
  // update_task's description says it where the agent decides to complete; claim_task's says
  // memory is the swarm's shared notes, and neither names the root file.
  const described = await toolDescriptions(s.x.raw, s.credential);
  assert.match(
    described.update_task,
    /before complete: if you learned something the next agent would trip on, add it to memory \(get_memory_access with write, while you still hold the claim\)/,
  );
  assert.match(
    described.claim_task,
    /the swarm's shared notes, kept by every agent on the server \(not your own project files\)/,
  );
  assert.doesNotMatch(described.claim_task, /AGENTS\.md/);
  const guide = await (await s.x.raw("/instructions")).text();
  assert.match(guide, /- \*\*When to write\.\*\* Before you complete: /);
  // complete ends the claim, so its reply adds no memory line: a write token is refused after it.
  const completed = await s.update(s.wes, claimed, { action: "complete", summary: "Done" });
  assert.ok(!("memory" in completed.data) && !("note" in completed.data));
  assert.equal((await s.writeAccess(s.wes, claimed, true)).error.code, "claim_lost");
  // With the board off, nothing is claimed, so no claim carries the note.
  await s.board({ enabled: false });
  const off = await s.claim(s.wyn, { next: {} }, true);
  assert.equal(off.error.code, "board_off");
});

test("without memory, no claim carries the note and the guide has no line on when to write", async (t) => {
  for (const options of [{ memory: false }, { memory: true, memoryBinding: false }]) {
    const s = await setup(t, options, { on: false });
    await s.board({ enabled: true });
    const claimed = await s.take(s.wes, "No memory");
    assert.ok(!("memory" in claimed));
    assert.doesNotMatch(JSON.stringify(claimed), /next agent would trip on/);
    const guide = await (await s.x.raw("/instructions")).text();
    assert.doesNotMatch(guide, /When to write/);
  }
});

test("memory on: the guide gains the reading and writing protocol, never its markers", async (t) => {
  const x = await start(t, { board: true, memory: true });
  const guide = await (await x.raw("/instructions")).text();
  assert.match(
    guide,
    /\(links still work\)\.\n- \*\*Memory\.\*\* Every swarm server keeps a swarm memory/,
  );
  assert.match(guide, /- \*\*Edit, do not add\.\*\* /);
  assert.match(guide, /Do not write what you changed or fixed/);
  assert.match(guide, /run `commands\.pull` \(it rebases your commit\)/);
  assert.match(guide, /Never put it in a file, a remote URL/);
  assert.match(guide, /Work without it\.\n- \*\*Silence shows\.\*\*/);
  assert.doesNotMatch(guide, /<!--|`remember`|`used`/);
});

test("rollback: version 11, memory's tables stand alone, and an older Worker's pruning still works", async (t) => {
  const s = await setup(t);
  await s.git({ action: "commit", message: "Add a trap", files: { "traps/x.md": "x" } });
  await s.stale();
  const claimed = await s.take(s.wes, "Prune me");
  await s.update(s.wes, claimed, { action: "complete", summary: "Done" });
  const first = await s.inspect();
  assert.equal(first.version, 11);
  assert.deepEqual(first.tables, [
    "memory_commits",
    "memory_files",
    "memory_repository",
    "memory_tokens",
  ]);
  assert.deepEqual(first.foreignKeys, []);
  assert.deepEqual(first.triggers, []);
  await s.x.control(`resources?server=${s.server.id}`, "restart");
  const again = await s.inspect();
  assert.deepEqual([again.version, again.tables, again.files.length], [11, first.tables, 2]);
  const legacy = await s.control({ action: "legacy-prune" });
  assert.equal(legacy.pruned, 1);
  assert.equal(legacy.files.length, 2, "memory is current state, not history");
});

test("deleting the server deletes its memory repository", async (t) => {
  const s = await setup(t);
  const name = `mem-${s.server.id}`;
  assert.equal((await s.control({ action: "inspect", repository: name })).exists, true);
  await s.x.call(
    "user_alice",
    "POST",
    `/v1/accounts/${s.account.id}/servers/${s.server.id}/delete`,
    {
      confirmation: s.server.name,
    },
  );
  const other = await s.x.server(s.account.id, { name: "Other", board: true });
  const response = await s.x.control(`memory?server=${other.id}`, {
    action: "inspect",
    repository: name,
  });
  const gone = await response.json();
  assert.equal(gone.exists, false);
  assert.equal(gone.removed, true);
});

test("a setup that failed is reported with its step and resumes on retry; memory settings change alone", async (t) => {
  const events = [];
  const bodies = [];
  const s = await setup(
    t,
    {
      telemetry: async (request) => {
        const body = await request.text();
        bodies.push(body);
        const lines = body.trim().split("\n");
        for (let i = 1; i + 1 < lines.length; i += 2)
          if (JSON.parse(lines[i]).type === "event") events.push(JSON.parse(lines[i + 1]));
        return Response.json({});
      },
    },
    { on: false, http: true },
  );
  await s.git({ action: "levers", failPushes: 1 });
  // `PUT …/board` with memory alone: the board switch is not part of it.
  const failed = await s.board({ memory: { tokens: 1500 } }, 503);
  assert.equal(failed.error.code, "memory_unavailable");
  const reported = async () => {
    for (
      let i = 0;
      i < 100 && !events.some((e) => e.tags?.["talkto.code"] === "memory_store_failed");
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    return events.find((e) => e.tags?.["talkto.code"] === "memory_store_failed");
  };
  const event = await reported();
  assert.ok(event, "the failed store call is reported");
  assert.equal(event.tags["talkto.memory_step"], "seed_push");
  assert.equal(event.tags["talkto.operation"], "memory.receivePack");
  assert.equal(event.tags["talkto.provider_code"], "HTTP_500");
  assert.ok(
    bodies.every((body) => !/fake-secret|Bearer/.test(body)),
    "no token reaches Sentry",
  );
  // The repository was created and recorded; the retry seeds it and creates the channel.
  const half = await s.inspect();
  assert.equal(half.repository.seeded, 0);
  assert.equal(half.git.exists, true);
  const again = await s.board({ memory: { tokens: 1500 } });
  assert.equal(again.enabled, true, "the board switch is unchanged");
  assert.match(again.memory.version, /^[0-9a-f]{40}$/);
  assert.match(again.memory.channelId, /.+/);
  const state = await s.inspect();
  assert.equal(state.repository.seeded, 1);
  assert.equal(state.git.pushes.length, 1, "one seed push landed");
  assert.equal(state.git.refs["refs/heads/main"], again.memory.version);
  // And the budget alone, leaving the board on.
  const budget = await s.board({ memory: { tokens: 900 } });
  assert.equal(budget.enabled, true);
  assert.equal(budget.memory.tokens, 900);
});

test("the Artifacts adapter on a binding that answers as real Artifacts does", async () => {
  const { Effect } = await import("effect");
  const { load } = await import("./sources.mjs");
  const Artifacts = await load("../src/memory/artifacts.ts");
  const Git = await load("../src/memory/git.ts");
  const Model = await load("../src/memory/model.ts");
  const Template = await load("../src/memory/template.ts");
  const Fake = await load("./memory-fake.ts");
  const run = (effect) => Effect.runPromise(Effect.result(effect));
  const ok = async (effect) => {
    const result = await run(effect);
    assert.equal(result._tag, "Success", JSON.stringify(result));
    return result.success;
  };
  const real = Fake.realistic();
  const original = globalThis.fetch;
  globalThis.fetch = real.fetch;
  try {
    const repos = Artifacts.make(real.binding);
    const name = "mem-adapter";
    const { remote } = await ok(repos.create(name));
    assert.deepEqual([...real.live.keys()], [], "the creation token is revoked");
    const duplicate = await run(repos.create(name));
    assert.equal(duplicate.failure.code, "ALREADY_EXISTS", "read from the message");
    assert.equal(await ok(repos.head(name)), null, "an empty repository has no head");
    const built = await ok(Git.tree(Template.files));
    const seed = await ok(
      Git.commit({ tree: built.root, parents: [], message: Template.message, at: 0 }),
    );
    const body = await ok(
      Git.receivePack({ old: Model.zeroHash, next: seed.id, objects: [...built.objects, seed] }),
    );
    assert.equal(Git.accepted(await ok(repos.push(name, remote, body))), true);
    assert.deepEqual([...real.live.keys()], [], "the push token is revoked");
    const head = await ok(repos.head(name));
    assert.equal(head.hash, seed.id);
    assert.equal((await ok(repos.commit(name, seed.id))).tree, head.tree);
    assert.equal(await ok(repos.commit(name, "0".repeat(40))), null);
    const [entry] = await ok(repos.tree(name, head.tree));
    assert.deepEqual([entry.name, entry.kind], ["AGENTS.md", "blob"]);
    // The file's bytes come over Git, never readBlob or readFile, whose Blob cannot cross RPC.
    const bytes = await ok(repos.blob(name, remote, entry.hash));
    assert.equal(new TextDecoder().decode(bytes), Template.files[0].text);
    assert.equal(real.counts.blobReads, 1);
    assert.deepEqual([...real.live.keys()], [], "the read token is revoked");
    // A stale compare-and-swap is refused, not applied.
    const stale = await ok(Git.receivePack({ old: "1".repeat(40), next: seed.id, objects: [] }));
    assert.equal(Git.accepted(await ok(repos.push(name, remote, stale))), false);
    await ok(repos.remove(name));
    const gone = await run(repos.head(name));
    assert.equal(gone.failure.code, "REPOSITORY_NOT_FOUND");
    assert.ok(real.counts.gets > 0);
    assert.equal(real.counts.disposed, real.counts.gets, "every handle is disposed");
    assert.ok(real.counts.results > 0);
    assert.equal(
      real.counts.resultsDisposed,
      real.counts.results,
      "every RPC result is disposed: create, log, readCommit, readTree, createToken",
    );
    // A runtime without a method answers through the stub, whose every name is a function.
    const older = Fake.realistic({ lacking: ["log"] });
    const olderRepos = Artifacts.make(older.binding);
    await ok(olderRepos.create(name));
    const unsupported = await run(olderRepos.head(name));
    assert.equal(unsupported.failure.code, "UNSUPPORTED");
    assert.match(unsupported.failure.detail, /does not implement the method/);
  } finally {
    globalThis.fetch = original;
  }
});
