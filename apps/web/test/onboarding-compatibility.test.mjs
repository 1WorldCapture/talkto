import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { createServer } from "vite";
import { start } from "../../server/test/platform-harness.mjs";

test("deployed v1 readers accept new onboarding records and completed progress survives a v1 rewrite", async (t) => {
  const app = await start(t);
  const vite = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const O = await vite.ssrLoadModule("/../../packages/api/src/onboarding.ts");
  const M = await vite.ssrLoadModule("/../../packages/api/src/models.ts");
  // Freeze the v1 slot contract: name is required, and registrationKey did not exist.
  const slotV1 = Schema.Struct({ name: M.Name, agentType: M.AgentType });
  // v1 runs had no slots after the first two.
  const runFieldsV1 = Object.fromEntries(
    Object.entries(O.Run.fields).filter(([key]) => key !== "moreAgents"),
  );
  const stateV1 = Schema.Struct({
    ...O.State.fields,
    run: Schema.NullOr(Schema.Struct({ ...runFieldsV1, agents: Schema.Tuple([slotV1, slotV1]) })),
  });
  const readV1 = Schema.decodeUnknownSync(stateV1);
  let state = await app.call("user_alice", "GET", "/v1/onboarding");
  const act = async (command) => {
    state = await app.call("user_alice", "POST", "/v1/onboarding", {
      command: { ...command, revision: state.revision },
    });
    assert.equal(readV1(state).revision, state.revision);
  };
  await act({
    kind: "configure",
    accountId: null,
    organizationName: "Compatibility",
    serverName: "Team",
  });
  await act({ kind: "provision" });
  // A picked agent adds a field v1 readers do not know; they must still read the record.
  await act({ kind: "choose", slot: 0, setup: "claude-code", agentType: "claude-code" });
  const serverId = state.run.setup.serverId;
  const identities = [];
  for (const [index, name] of ["release-guide", "interface-craft"].entries()) {
    const registered = await app.call(
      "user_alice",
      "POST",
      `/v1/servers/${serverId}/participants`,
      {
        name,
        agentType: "codex-desktop",
        requestKey: state.run.agents[index].registrationKey,
      },
    );
    identities.push(registered.item.id);
  }
  // A third agent is a slot outside the v1 tuple: v1 readers still read the run and its progress.
  await act({ kind: "choose", slot: 2, setup: "pi", agentType: "pi" });
  await app.call("user_alice", "POST", `/v1/servers/${serverId}/participants`, {
    name: "release-review",
    agentType: "pi",
    requestKey: state.run.moreAgents[0].registrationKey,
  });
  const progressV1 = Schema.decodeUnknownSync(
    Schema.Struct({
      server: Schema.Struct({
        server: M.Server,
        agents: Schema.Tuple([Schema.NullOr(M.Participant), Schema.NullOr(M.Participant)]),
      }),
    }),
  );
  const third = await app.call(
    "user_alice",
    "GET",
    `/v1/onboarding/progress?runId=${state.run.id}`,
  );
  assert.equal(third.server.moreAgents[0].name, "release-review");
  assert.deepEqual(
    progressV1(third).server.agents.map((agent) => agent.id),
    identities,
  );
  await act({ kind: "finish" });
  assert.equal(state.run.moreAgents[0].name, "release-review");
  const legacy = readV1(state);
  assert.equal("moreAgents" in legacy.run, false, "a v1 rewrite drops only the added slots");
  assert.ok(legacy.completedAt);
  assert.deepEqual(
    legacy.run.agents.map((agent) => agent.name),
    ["release-guide", "interface-craft"],
  );
  assert.ok(legacy.run.agents.every((agent) => agent.registrationKey === undefined));
  // Old code rewrites only fields it knows; the next release must still recover actual identities.
  await app.db
    .prepare("UPDATE user_onboarding SET state=? WHERE user_id=?")
    .bind(JSON.stringify(legacy), "user_alice")
    .run();
  const progress = await app.call(
    "user_alice",
    "GET",
    `/v1/onboarding/progress?runId=${state.run.id}`,
  );
  assert.deepEqual(
    progress.server.agents.map((agent) => agent.id),
    identities,
  );
  const oldCall = await app.control("onboarding-v1", {
    serverId,
    userId: "user_alice",
    names: legacy.run.agents.map((agent) => agent.name),
  });
  assert.deepEqual(
    (await oldCall.json()).data.agents.map((agent) => agent.id),
    identities,
  );
  const denied = await app.control("onboarding-v1", {
    serverId,
    userId: "user_bob",
    names: legacy.run.agents.map((agent) => agent.name),
  });
  assert.equal(await denied.json(), null);
});

// The simple setup (November 18, 2026) retired the teammate step and the replay-only screens, but
// keeps every saved step name: a run left at "share" still decodes and still finishes, and Skip
// setup leaves a ready, dismissed run.
test("runs saved at retired steps still decode, and Skip setup leaves a dismissed run", async (t) => {
  const app = await start(t);
  const vite = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const O = await vite.ssrLoadModule("/../../packages/api/src/onboarding.ts");
  const { skipSetupCommands, leaveCommands } = await vite.ssrLoadModule("/src/onboarding.tsx");
  const { sendsToSetup } = await vite.ssrLoadModule("/src/app-routes.ts");
  assert.deepEqual(O.Step.literals, ["server", "agents", "share", "done"]);
  const read = Schema.decodeUnknownSync(O.State);
  const send = async (user, commands) => {
    let state = await app.call(user, "GET", "/v1/onboarding");
    for (const command of commands)
      state = await app.call(user, "POST", "/v1/onboarding", {
        command: { ...command, revision: state.revision },
      });
    return state;
  };
  const draft = { accountId: null, organizationName: "Compatibility", serverName: "Team" };
  const skipped = read(await send("user_alice", skipSetupCommands(draft)));
  assert.equal(skipped.run.setup.kind, "ready");
  assert.ok(skipped.dismissedAt);
  // A run an older release left on the teammate step.
  const shared = read(
    await send("user_bob", [
      { kind: "configure", ...draft },
      { kind: "provision" },
      { kind: "step", step: "share" },
    ]),
  );
  assert.equal(shared.run.step, "share");
  const page = await app.call("user_bob", "GET", "/v1/accounts?limit=20");
  const accounts = { items: page.items, more: page.nextCursor !== null };
  assert.equal(sendsToSetup(shared, accounts), true, "an unfinished run resumes setup");
  const left = read(await send("user_bob", leaveCommands));
  assert.equal(left.run.step, "done");
  assert.equal(sendsToSetup(left, accounts), false);
});
