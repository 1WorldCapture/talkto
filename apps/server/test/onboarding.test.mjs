import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";
const path = "/v1/onboarding";
const command = (x, state, value, status = 200, user = "user_alice") =>
  x.call(user, "POST", path, { command: { ...value, revision: state.revision } }, status);
const configure = (x, state, accountId = null) =>
  command(x, state, {
    kind: "configure",
    accountId,
    organizationName: "My workspace",
    serverName: "Product studio",
  });
const observe = (x, state, user = "user_alice") =>
  x.call(user, "GET", `${path}/progress?runId=${state.run.id}`);
const join = (x, state, slot, user = "user_alice") =>
  x.call(user, "POST", `/v1/servers/${state.run.setup.serverId}/participants`, {
    agentType: state.run.agents[slot].agentType,
    name: slot === 0 ? "release-guide" : "design-partner",
    requestKey: `onboarding:${state.run.id}:agent:${slot}`,
  });

/** Make Bob a member of the run's organization with access to its server. */
const shareWithBob = async (x, state) => {
  const account = await x.call("user_alice", "GET", `/v1/accounts/${state.run.setup.accountId}`);
  await x.control("member", x.member(account.organizationId, "user_bob"));
  await x.call("user_alice", "PUT", `/v1/servers/${state.run.setup.serverId}/access/user_bob`);
};

test("onboarding creates once, observes two real agents, persists, and replays without duplicating resources", async (t) => {
  const x = await start(t);
  let state = await x.call("user_alice", "GET", path);
  assert.equal(state.run, null);
  state = await configure(x, state);
  state = await command(x, state, { kind: "provision" });
  assert.equal(state.run.step, "agents");
  const id = state.run.setup.serverId;
  const initial = await observe(x, state);
  assert.deepEqual(initial.server.agents, [null, null]);
  assert.ok(state.run.agents.every((agent) => agent.registrationKey !== undefined));
  const first = await join(x, state, 0);
  const retry = await join(x, state, 0);
  assert.equal(first.item.id, retry.item.id);
  state = await command(x, state, { kind: "finish" });
  assert.equal(state.completedAt, null, "one participant does not complete the two-agent flow");
  assert.ok(state.dismissedAt);
  state = await command(x, state, { kind: "step", step: "agents" });
  state = await command(x, state, {
    kind: "agents",
    types: [state.run.agents[0].agentType, "codex"],
  });
  await join(x, state, 1);
  const arrived = await observe(x, state);
  assert.ok(arrived.server.agents.every(Boolean));
  assert.deepEqual(
    arrived.server.agents.map((agent) => agent.name),
    ["release-guide", "design-partner"],
  );
  assert.notEqual(arrived.server.agents[0].id, arrived.server.agents[1].id);
  state = await command(x, state, { kind: "finish" });
  assert.ok(state.completedAt);
  assert.deepEqual(
    state.run.agents.map((agent) => agent.name),
    ["release-guide", "design-partner"],
  );
  const oldWorkerRead = await x.control("onboarding-v1", {
    serverId: id,
    userId: "user_alice",
    names: state.run.agents.map((agent) => agent.name),
  });
  assert.deepEqual((await oldWorkerRead.json()).data.agents, arrived.server.agents);
  assert.equal(state.dismissedAt, null);
  const completedAt = state.completedAt;
  const replay = await command(x, state, { kind: "replay" });
  assert.equal(replay.run.step, "server");
  assert.equal(replay.completedAt, completedAt);
  assert.equal(replay.run.setup.serverId, id);
  const provision = await command(x, replay, { kind: "provision" });
  assert.deepEqual(provision, replay);
  assert.equal((await x.db.prepare("SELECT COUNT(*) AS n FROM servers").first()).n, 1);
  const account = await x.call("user_alice", "GET", `/v1/accounts/${state.run.setup.accountId}`);
  const restore = await x.persistenceCheckpoint();
  assert.deepEqual(await x.call("user_alice", "GET", path), replay, "D1 survives a Worker restart");
  // The controlled external provider keeps its membership map in memory, unlike WorkOS.
  await x.control("member", x.member(account.organizationId, "user_alice"));
  assert.deepEqual((await observe(x, replay)).server.agents, arrived.server.agents);
  await restore();
});

test("invitation keys recognize agent-chosen names while saved legacy names still recover", async (t) => {
  const x = await start(t);
  let state = await configure(x, await x.call("user_alice", "GET", path));
  state = await command(x, state, { kind: "provision" });
  const endpoint = `/v1/servers/${state.run.setup.serverId}/participants`;
  const legacyName = `builder-${state.run.id.slice(0, 8)}`;
  // A teammate's agent: the person's own arrivals would fill an empty slot whatever their name.
  await shareWithBob(x, state);
  const unrelated = await x.call("user_bob", "POST", endpoint, {
    name: legacyName,
    agentType: "codex",
    requestKey: randomUUID(),
  });
  assert.deepEqual(
    (await observe(x, state)).server.agents,
    [null, null],
    "new runs never match a coincidental name",
  );
  const legacy = {
    ...state,
    run: {
      ...state.run,
      agents: [
        { agentType: state.run.agents[0].agentType, name: legacyName },
        { agentType: state.run.agents[1].agentType, name: `reviewer-${state.run.id.slice(0, 8)}` },
      ],
    },
  };
  await x.db
    .prepare("UPDATE user_onboarding SET state=? WHERE user_id=?")
    .bind(JSON.stringify(legacy), "user_alice")
    .run();
  assert.equal((await observe(x, legacy)).server.agents[0].id, unrelated.item.id);
  const chosen = await x.call("user_alice", "POST", endpoint, {
    name: "interface-craft",
    agentType: "codex-desktop",
    requestKey: `onboarding:${state.run.id}:agent:0`,
  });
  const progress = await observe(x, legacy);
  assert.equal(
    progress.server.agents[0].id,
    chosen.item.id,
    "a receipt takes precedence over the legacy name",
  );
  assert.equal(
    progress.server.agents[0].agentType,
    "codex-desktop",
    "actual host type does not have to match the selection",
  );
  assert.equal(progress.server.agents[1], null);
});

test("an agent that joined with a request key of its own fills the next empty slot", async (t) => {
  // A Grok Bot or Muse asked to "join the server I choose" in the install step registers with a
  // fresh key before it sees the join prompt; the wizard used to wait for it forever.
  const x = await start(t);
  let state = await configure(x, await x.call("user_alice", "GET", path));
  state = await command(x, state, { kind: "provision" });
  const endpoint = `/v1/servers/${state.run.setup.serverId}/participants`;
  const own = await x.call("user_alice", "POST", endpoint, {
    name: "grok-helper",
    agentType: "grok-bot",
    requestKey: randomUUID(),
  });
  let progress = await observe(x, state);
  assert.equal(progress.server.agents[0]?.id, own.item.id, "the person's own arrival counts");
  assert.equal(progress.server.agents[1], null);
  await shareWithBob(x, state);
  await x.call("user_bob", "POST", endpoint, {
    name: "bobs-agent",
    agentType: "codex",
    requestKey: randomUUID(),
  });
  progress = await observe(x, state);
  assert.equal(progress.server.agents[1], null, "a teammate's agent never fills a slot");
  const keyed = await x.call("user_alice", "POST", endpoint, {
    name: "release-guide",
    agentType: "claude-code",
    requestKey: `onboarding:${state.run.id}:agent:0`,
  });
  progress = await observe(x, state);
  assert.deepEqual(
    progress.server.agents.map((agent) => agent?.id),
    [keyed.item.id, own.item.id],
    "a slot's own key wins, and the earlier arrival moves to the next empty slot",
  );
  state = await command(x, state, { kind: "finish" });
  assert.ok(state.completedAt);
  assert.deepEqual(
    state.run.agents.map((agent) => agent.name),
    ["release-guide", "grok-helper"],
  );
  // Agents that joined before a run started belong to an earlier setup.
  const { accountId, serverId } = state.run.setup;
  state = await command(x, state, { kind: "new_run" });
  state = await command(x, state, { kind: "use_server", accountId, serverId });
  assert.deepEqual((await observe(x, state)).server.agents, [null, null]);
});

test("new Worker calls remain valid while a server still runs the v1 onboarding receiver", async (t) => {
  const x = await start(t, { legacyOnboarding: true });
  let state = await configure(x, await x.call("user_alice", "GET", path));
  state = await command(x, state, { kind: "provision" });
  assert.deepEqual((await observe(x, state)).server.agents, [null, null]);
  // An already-open v1 browser still uses its v1 name; its registration continues to work.
  const agent = state.run.agents[0];
  const joined = await x.call(
    "user_alice",
    "POST",
    `/v1/servers/${state.run.setup.serverId}/participants`,
    {
      name: agent.name,
      agentType: agent.agentType,
      requestKey: agent.registrationKey,
    },
  );
  assert.equal((await observe(x, state)).server.agents[0].id, joined.item.id);
  // A new name can be registered during rollout; old receivers safely show waiting until upgraded.
  await join(x, state, 1);
  assert.equal((await observe(x, state)).server.agents[1], null);
});

test("onboarding rejects stale writes, foreign runs, forged completion and unsafe browser callbacks", async (t) => {
  const x = await start(t);
  assert.equal((await x.raw(path)).status, 401);
  const initial = await x.call("user_alice", "GET", path);
  let state = await configure(x, initial);
  await command(x, initial, { kind: "dismiss" }, 409);
  state = await command(x, state, { kind: "provision" });
  assert.equal((await x.call("user_bob", "GET", path)).run, null);
  await x.call("user_bob", "GET", `${path}/progress?runId=${state.run.id}`, undefined, 409);
  await x.call(
    "user_alice",
    "POST",
    path,
    {
      command: { kind: "finish", revision: state.revision, completedAt: new Date().toISOString() },
    },
    400,
  );
  const login = await x.browserLogin("user_alice", "5m", undefined, "/onboarding");
  const callback = await login.callback();
  assert.equal(callback.headers.get("location"), "https://talkto.test/onboarding");
  const cookie = callback.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-talkto-session="))
    .split(";")[0];
  const crossSite = await x.raw(path, {
    method: "POST",
    headers: { cookie, origin: "https://outside.test", "content-type": "application/json" },
    body: JSON.stringify({ command: { kind: "dismiss", revision: state.revision } }),
  });
  assert.equal(crossSite.status, 403);
  assert.deepEqual(await x.call("user_alice", "GET", path), state);
  for (const target of ["//evil.test", "/onboarding//evil", "/onboarding\\evil"]) {
    const response = await x.raw(`/auth/login?return_to=${encodeURIComponent(target)}`);
    assert.equal(response.status, 401);
  }
});

test("lost provisioning and invitation responses recover saved intent without sending twice; only accepted members receive explicit access", async (t) => {
  const x = await start(t);
  let state = await configure(x, await x.call("user_alice", "GET", path));
  await x.db.exec(
    "CREATE TRIGGER drop_ready BEFORE UPDATE ON user_onboarding WHEN json_extract(NEW.state,'$.run.setup.kind')='ready' BEGIN SELECT RAISE(ABORT,'lost save'); END;",
  );
  await command(x, state, { kind: "provision" }, 503);
  state = await x.call("user_alice", "GET", path);
  assert.equal(state.run.setup.kind, "creating");
  await command(x, state, { kind: "new_run" }, 400);
  await x.db.exec("DROP TRIGGER drop_ready");
  state = await command(x, state, { kind: "provision" });
  assert.equal((await x.db.prepare("SELECT COUNT(*) AS n FROM servers").first()).n, 1);
  state = await command(x, state, { kind: "step", step: "share" });
  await x.db.exec(
    "CREATE TRIGGER drop_invitation BEFORE UPDATE ON user_onboarding WHEN json_extract(NEW.state,'$.run.invitation.id') IS NOT NULL BEGIN SELECT RAISE(ABORT,'lost save'); END;",
  );
  await command(x, state, { kind: "invite", email: "teammate@example.com" }, 503);
  state = await x.call("user_alice", "GET", path);
  assert.equal(state.run.invitation.id, null);
  await command(x, state, { kind: "invite", email: "teammate@example.com" }, 400);
  await x.db.exec("DROP TRIGGER drop_invitation");
  state = await command(x, state, { kind: "check_invitation" });
  assert.ok(state.run.invitation.id);
  assert.equal((await (await x.control("invitation-deliveries")).json()).sent, 1);
  await command(x, state, { kind: "grant" }, 400);
  await x.control("accept-invitation", { id: state.run.invitation.id, userId: "user_bob" });
  const accepted = await observe(x, state);
  assert.equal(
    accepted.invitee.id,
    "user_bob",
    "acceptor is provided by WorkOS, not inferred from the invitation email",
  );
  assert.equal(accepted.grant, null);
  state = await command(x, state, { kind: "grant" });
  const granted = await observe(x, state);
  assert.equal(granted.grant.userId, "user_bob");
  assert.equal(granted.grant.appliedRevision, granted.grant.revision);
  assert.equal(granted.grant.principalKey, undefined);
  assert.equal((await (await x.control("invitation-deliveries")).json()).sent, 1);
  const bob = await command(
    x,
    await x.call("user_bob", "GET", path),
    {
      kind: "use_server",
      accountId: state.run.setup.accountId,
      serverId: state.run.setup.serverId,
    },
    200,
    "user_bob",
  );
  const teammate = await join(x, state, 0, "user_bob");
  assert.equal(
    (await observe(x, state)).server.agents[0].id,
    teammate.item.id,
    "a currently authorized teammate can use the invitation",
  );
  await x.call("user_alice", "DELETE", `/v1/servers/${state.run.setup.serverId}/access/user_bob`);
  assert.equal((await observe(x, bob, "user_bob")).server, null);
  await command(x, bob, { kind: "agents", types: ["codex", "claude-code"] }, 400, "user_bob");
});

test("simultaneous first setup commands claim one revision and user-controlled resource IDs do not grant access", async (t) => {
  const x = await start(t);
  const state = await x.call("user_alice", "GET", path);
  const token = await x.token();
  const requests = await Promise.all(
    ["One", "Two"].map((name) =>
      x.raw(path, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          command: {
            kind: "configure",
            revision: state.revision,
            accountId: null,
            organizationName: "My workspace",
            serverName: name,
          },
        }),
      }),
    ),
  );
  assert.deepEqual(requests.map((r) => r.status).sort(), [200, 409]);
  const bob = await x.call("user_bob", "GET", path);
  await command(
    x,
    bob,
    { kind: "use_server", accountId: randomUUID(), serverId: randomUUID() },
    404,
    "user_bob",
  );
});

test("new runs pick no agent, choose records one slot, and runs saved with filled-in types still work", async (t) => {
  const x = await start(t);
  let state = await configure(x, await x.call("user_alice", "GET", path));
  state = await command(x, state, { kind: "provision" });
  assert.ok(
    state.run.agents.every((agent) => agent.setup === undefined && agent.agentType === "generic"),
    "nothing is picked for the person",
  );
  const keys = state.run.agents.map((agent) => agent.registrationKey);
  state = await command(x, state, {
    kind: "choose",
    slot: 0,
    setup: "claude-code",
    agentType: "claude-code",
  });
  assert.deepEqual(
    state.run.agents.map(({ setup, agentType }) => ({ setup, agentType })),
    [
      { setup: "claude-code", agentType: "claude-code" },
      { setup: undefined, agentType: "generic" },
    ],
  );
  assert.deepEqual(
    state.run.agents.map((agent) => agent.registrationKey),
    keys,
    "invitation keys never change with the choice",
  );
  await command(x, state, { kind: "choose", slot: 2, setup: "pi", agentType: "pi" }, 400);
  await command(x, state, { kind: "choose", slot: 1, setup: "Pi!", agentType: "pi" }, 400);
  await join(x, state, 0);
  await command(x, state, { kind: "choose", slot: 0, setup: "pi", agentType: "pi" }, 400);
  state = await command(x, state, {
    kind: "choose",
    slot: 1,
    setup: "grok-bot",
    agentType: "grok-bot",
  });
  assert.equal(state.run.agents[1].setup, "grok-bot");
  // An older browser picks types only; a different type drops the guide it no longer matches.
  state = await command(x, state, { kind: "agents", types: ["claude-code", "codex"] });
  assert.equal(state.run.agents[0].setup, "claude-code");
  assert.equal(state.run.agents[1].setup, undefined);

  // A run saved before this release: types filled in for the person and no setup fields.
  const saved = {
    ...state,
    run: {
      ...state.run,
      agents: [
        { ...state.run.agents[0], agentType: "codex", setup: undefined },
        { ...state.run.agents[1], agentType: "claude-code", setup: undefined },
      ],
    },
  };
  await x.db
    .prepare("UPDATE user_onboarding SET state=? WHERE user_id=?")
    .bind(JSON.stringify(saved), "user_alice")
    .run();
  state = await x.call("user_alice", "GET", path);
  assert.ok(state.run.agents.every((agent) => agent.setup === undefined));
  assert.equal((await observe(x, state)).server.agents[0].name, "release-guide");
  state = await command(x, state, { kind: "choose", slot: 1, setup: "muse", agentType: "muse" });
  assert.deepEqual(
    state.run.agents.map(({ setup, agentType }) => ({ setup, agentType })),
    [
      { setup: undefined, agentType: "codex" },
      { setup: "muse", agentType: "muse" },
    ],
  );
});

test("after two agents, onboarding adds slots one at a time up to six, and a v1 rewrite keeps the first two", async (t) => {
  const x = await start(t);
  let state = await configure(x, await x.call("user_alice", "GET", path));
  state = await command(x, state, { kind: "provision" });
  const id = state.run.setup.serverId;
  const register = (slot, name) =>
    x.call("user_alice", "POST", `/v1/servers/${id}/participants`, {
      agentType: "claude-code",
      name,
      requestKey: `onboarding:${state.run.id}:agent:${slot}`,
    });
  await register(0, "billing-web-macbook");
  await register(1, "billing-api-mini");
  assert.equal(state.run.moreAgents, undefined, "a run starts with the v1 pair only");
  assert.equal((await observe(x, state)).server.moreAgents, undefined);
  // No gaps: slot 3 waits for slot 2.
  await command(x, state, { kind: "choose", slot: 3, setup: "pi", agentType: "pi" }, 400);
  state = await command(x, state, {
    kind: "choose",
    slot: 2,
    setup: "claude-code",
    agentType: "claude-code",
  });
  assert.equal(state.run.moreAgents.length, 1);
  assert.equal(state.run.moreAgents[0].registrationKey, `onboarding:${state.run.id}:agent:2`);
  // A waiting slot can change its agent; the next one waits until it joins.
  state = await command(x, state, { kind: "choose", slot: 2, setup: "codex", agentType: "codex" });
  assert.equal(state.run.moreAgents[0].setup, "codex");
  await command(x, state, { kind: "choose", slot: 3, setup: "pi", agentType: "pi" }, 400);
  assert.deepEqual((await observe(x, state)).server.moreAgents, [null]);
  await register(2, "billing-review-mini");
  await command(x, state, { kind: "choose", slot: 2, setup: "pi", agentType: "pi" }, 400);
  for (const slot of [3, 4, 5]) {
    state = await command(x, state, { kind: "choose", slot, setup: "pi", agentType: "pi" });
    await register(slot, `billing-agent-${slot}`);
  }
  // Six is the cap; the schema has no seventh slot.
  await command(x, state, { kind: "choose", slot: 6, setup: "pi", agentType: "pi" }, 400);
  const progress = await observe(x, state);
  assert.deepEqual(
    [...progress.server.agents, ...progress.server.moreAgents].map((agent) => agent.name),
    [
      "billing-web-macbook",
      "billing-api-mini",
      "billing-review-mini",
      "billing-agent-3",
      "billing-agent-4",
      "billing-agent-5",
    ],
  );
  state = await command(x, state, { kind: "finish" });
  assert.ok(state.completedAt);
  assert.deepEqual(
    state.run.moreAgents.map((agent) => agent.name),
    ["billing-review-mini", "billing-agent-3", "billing-agent-4", "billing-agent-5"],
  );
  // The deployed Worker rewrites only the fields it knows: the first two slots survive as before.
  const { moreAgents, ...v1Run } = state.run;
  assert.equal(moreAgents.length, 4);
  await x.db
    .prepare("UPDATE user_onboarding SET state=? WHERE user_id=?")
    .bind(JSON.stringify({ ...state, run: v1Run }), "user_alice")
    .run();
  state = await x.call("user_alice", "GET", path);
  const after = await observe(x, state);
  assert.deepEqual(
    after.server.agents.map((agent) => agent.name),
    ["billing-web-macbook", "billing-api-mini"],
  );
  assert.equal(after.server.moreAgents, undefined);
});
