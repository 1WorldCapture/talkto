import { rpc, packet } from "./mcp-wire.mjs";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const origin = "http://127.0.0.1:8787";
async function start(t, overrides = {}, hosted = false) {
  const directory = await mkdtemp(join(tmpdir(), "talkto-http-"));
  const bindings = {
    TALKTO_SERVER_ID: randomUUID(),
    TALKTO_GRANT_ID: randomUUID(),
    TALKTO_SERVER_NAME: "Local tests",
    TALKTO_PRINCIPAL_KEY: "local:owner",
    TALKTO_SERVICE_ORIGIN: origin,
    TALKTO_LOCAL_TOKEN: randomBytes(32).toString("hex"),
    ...overrides,
  };
  const build = resolve(hosted ? "dist" : "dist/test");
  const files = await readdir(build);
  const modules = [
    { type: "ESModule", path: join(build, hosted ? "worker.js" : "fixture.js") },
    ...files
      .filter((name) => name.endsWith(".sql") || name.endsWith(".md"))
      .map((name) => ({ type: "Text", path: join(build, name) })),
  ];
  const options = convertV4MiniflareOptions({
    name: "app",
    modules,
    modulesRoot: build,
    compatibilityDate: "2026-09-08",
    compatibilityFlags: ["nodejs_als"],
    durableObjects: {
      SERVERS: { className: hosted ? "TalkToServer" : "TestServer", useSQLite: true },
    },
    resourcePersistencePath: directory,
    bindings,
  });
  let mf = new Miniflare(options);
  t.after(async () => {
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const root = `/v1/servers/${bindings.TALKTO_SERVER_ID}`;
  const raw = (path, init = {}) => mf.dispatchFetch(origin + path, init);
  const call = async (method, path, payload, status = 200) => {
    const response = await raw(path, {
      method,
      headers: {
        authorization: `Bearer ${bindings.TALKTO_LOCAL_TOKEN}`,
        "content-type": "application/json",
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    assert.equal(body.meta.instructions.url, `${origin}/instructions`);
    assert.ok(body.meta.requestId);
    assert.ok(body.meta.serverTime.endsWith("Z"));
    if (status >= 400) assert.equal(body.meta.serverId, undefined);
    assert.doesNotMatch(
      JSON.stringify(body),
      /created_by_grant_id|principalKey|"grantId"|"requestKey"/,
    );
    return body;
  };
  const register = async (name, fields = {}) =>
    (
      await call("POST", `${root}/participants`, {
        name,
        agentType: "codex",
        requestKey: randomUUID(),
        ...fields,
      })
    ).data.item;
  const send = async (conversation, participant, body, requestKey = randomUUID()) =>
    (
      await call("POST", `${root}/conversations/${conversation}/messages`, {
        participantId: participant,
        body,
        requestKey,
      })
    ).data.item;
  const server = async () => (await call("GET", root)).data;
  const updates = (input, status = 200) => call("POST", `${root}/updates`, input, status);
  const mcp = async (name, args, version = "2026-07-28", isError = false) => {
    const response = await raw(
      "/mcp",
      rpc("tools/call", { name, arguments: args }, bindings.TALKTO_LOCAL_TOKEN, version),
    );
    const envelope = await packet(response);
    assert.equal(response.status, 200, JSON.stringify(envelope));
    assert.equal(envelope.result.isError, isError, JSON.stringify(envelope));
    assert.deepEqual(
      JSON.parse(envelope.result.content[0].text),
      envelope.result.structuredContent,
    );
    return envelope.result.structuredContent;
  };
  const history = async (conversation, parameters = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(parameters))
      query.set(key, key === "position" ? JSON.stringify(value) : String(value));
    return (await call("GET", `${root}/conversations/${conversation}/messages?${query}`)).data;
  };
  return {
    root,
    call,
    raw,
    register,
    send,
    server,
    history,
    updates,
    mcp,
    bindings,
    restart: async () => {
      await mf.dispose();
      mf = new Miniflare(options);
    },
  };
}

test("public documentation, authentication, server discovery, and bootstrap persistence", async (t) => {
  const app = await start(t);
  assert.equal((await app.raw("/health")).status, 200);
  const instructions = await app.raw("/instructions");
  const guide = await instructions.text();
  assert.match(guide, /no read\/unread state/);
  assert.ok(guide.includes(`MCP endpoint: \`${origin}/mcp\``));
  assert.ok(!guide.includes("YOUR-TALKTO-HOST"));
  assert.doesNotMatch(guide, /\{\{[A-Z_]+\}\}/, "every generated value in the guide is filled");
  assert.ok(guide.includes(`cursor://anysphere.cursor-deeplink/mcp/install?name=talkto&config=`));
  // Grok Build's hooks install straight from the repository, and a re-run updates instead: a
  // marketplace add collides with Claude Code's marketplace, and a bare name needs every
  // marketplace to scan (live test of November 12, 2026).
  assert.ok(
    guide.includes("`grok plugin install 'talkto-sh/talkto-plugin#hooks/claude-format' --trust`"),
  );
  assert.ok(guide.includes("`grok plugin update talkto-hooks`"));
  assert.doesNotMatch(guide, /grok plugin marketplace add|grok plugin install talkto-hooks/);
  const skill = await app.raw("/skill.md");
  assert.match(skill.headers.get("content-type"), /^text\/markdown/);
  const skillText = await skill.text();
  assert.match(skillText, /^---\nname: talkto\ndescription: /);
  assert.ok(skillText.includes(`${origin}/instructions`));
  assert.ok(!skillText.includes("YOUR-TALKTO-HOST"));
  // Install files: the dialog's recipes as Markdown, with this deployment's address.
  const install = await app.raw("/agents/codex.md");
  assert.equal(install.status, 200);
  assert.match(install.headers.get("content-type"), /^text\/markdown/);
  const installText = await install.text();
  assert.ok(installText.startsWith("# Install TalkTo in Codex\n"));
  assert.ok(installText.includes(`codex mcp add talkto --url ${origin}/mcp`));
  assert.ok(installText.includes(`${origin}/instructions`));
  assert.notEqual((await app.raw("/agents/nope.md")).status, 200);
  const spec = await (await app.raw("/openapi.json")).json();
  assert.ok(spec.paths["/v1/servers/{serverId}/conversations/{conversationId}/messages"]);
  const queryNames = spec.paths["/v1/servers/{serverId}/participants"].get.parameters.map(
    (p) => p.name,
  );
  assert.ok(queryNames.includes("name"));
  assert.ok(queryNames.includes("cursor"));
  assert.ok(queryNames.includes("limit"));
  assert.deepEqual(spec.paths["/v1/servers/{serverId}"].get.security, [
    { bearer: [] },
    { webSession: [] },
  ]);
  const unauthorized = await app.raw(app.root, {
    headers: {
      "x-talkto-access": JSON.stringify({
        serverId: app.bindings.TALKTO_SERVER_ID,
        grantId: app.bindings.TALKTO_GRANT_ID,
        principalKey: "local:owner",
      }),
    },
  });
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get("www-authenticate"), /Bearer/);
  const discovery = (await app.call("GET", "/v1/servers")).data;
  assert.equal(discovery.items.length, 1);
  const first = await app.server();
  assert.equal(first.channelCount, 1);
  assert.equal(first.participantCount, 0);
  const wrong = await app.call("GET", `/v1/servers/${randomUUID()}`, undefined, 404);
  assert.equal(wrong.error.code, "server_unavailable");
  await app.restart();
  assert.deepEqual(await app.server(), first);
});

test("timestamp filters normalize explicit zones and optional milliseconds without rounding invalid inputs", async (t) => {
  const app = await start(t);
  const participant = await app.register("Clock");
  const conversation = (await app.server()).generalConversationId;
  const message = await app.send(conversation, participant.id, "Timestamp boundary");
  assert.match(message.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const historyPath = `${app.root}/conversations/${conversation}/messages`;
  const search = async (filters, status = 200) =>
    app.call(
      "GET",
      `${app.root}/messages/search?${new URLSearchParams({ query: "Timestamp", ...filters })}`,
      undefined,
      status,
    );

  for (const time of [
    "1970-01-01T00:00:00Z",
    "1969-12-31T17:00:00-07:00",
    "1970-01-01T07:00:00+07:00",
    "1970-01-01T00:00:00.1Z",
    "1970-01-01T00:00:00.12Z",
    "1970-01-01T00:00:00.123Z",
  ]) {
    const page = await app.history(conversation, { position: { kind: "afterTime", time } });
    assert.deepEqual(page.items, [message]);
    assert.deepEqual((await search({ afterTime: time })).data.items, [message]);
  }
  const offset = new Date(Date.parse(message.createdAt) - 7 * 3600000)
    .toISOString()
    .replace(/Z$/, "-07:00");
  for (const kind of ["afterTime", "beforeTime"]) {
    const page = await app.history(conversation, { position: { kind, time: offset } });
    assert.deepEqual(page.items, [], "The timestamp anchor is exclusive, including with offsets");
    assert.deepEqual((await search({ [kind]: offset })).data.items, []);
  }
  // These strings sort in reverse order, but the normalized instants form a valid interval.
  assert.deepEqual(
    (await search({ afterTime: "2026-01-01T01:00:00+02:00", beforeTime: "2025-12-31T23:30:00Z" }))
      .data.items,
    [],
  );
  assert.deepEqual((await search({ beforeTime: "9999-12-31T23:59:59.999Z" })).data.items, [
    message,
  ]);
  assert.deepEqual((await search({ afterTime: "2024-02-29T00:00:00Z" })).data.items, [message]);

  for (const time of [
    "2026-09-09T05:10:00",
    "2026-02-30T00:00:00Z",
    "2025-02-29T00:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T00:60:00Z",
    "2026-01-01T00:00:60Z",
    "2026-01-01T00:00:00+24:00",
    "2026-01-01T00:00:00+07:60",
    "2026-01-01T00:00:00.1234Z",
    "1970-01-01T00:00:00+00:01",
    "9999-12-31T23:59:59-01:00",
  ]) {
    const query = new URLSearchParams({ position: JSON.stringify({ kind: "afterTime", time }) });
    const rejected = await app.call("GET", `${historyPath}?${query}`, undefined, 400);
    assert.equal(rejected.error.code, "invalid_input");
    assert.match(rejected.error.message, /position.time: Use a valid timestamp/);
    assert.match(rejected.error.message, /2026-09-09T05:10:00Z/);
    assert.match(
      (await search({ afterTime: time }, 400)).error.message,
      /afterTime: Use a valid timestamp/,
    );
  }
});

test("registration normalization, name conflicts, optional context, and safe retries", async (t) => {
  const app = await start(t);
  const payload = {
    name: " Product ",
    agentType: " CODEX ",
    workingDirectory: " /work/app ",
    joinedNote: " human requested product review ",
    requestKey: "join-product",
  };
  const a = await app.call("POST", `${app.root}/participants`, payload);
  assert.equal(a.data.item.name, "Product");
  assert.equal(a.data.item.agentType, "codex");
  assert.equal(a.data.item.workingDirectory, "/work/app");
  assert.equal(a.data.created, true);
  const generalId = (await app.server()).generalConversationId;
  assert.equal(a.data.generalConversationId, generalId);
  assert.equal(a.included.conversations[0].id, generalId);
  assert.equal(a.included.conversations[0].latestMessage, null);
  const guidance = a.meta.instructions.text;
  assert.ok(guidance.includes(a.data.item.id));
  const links = [...guidance.matchAll(/GET (https?:\/\/\S+)\./g)].map((m) => new URL(m[1]));
  assert.equal(links.length, 2);
  const generalHistory = await app.call("GET", links[0].pathname + links[0].search);
  assert.deepEqual(generalHistory.data.items, []);
  const recovered = await app.call("GET", links[1].pathname + links[1].search);
  assert.equal(recovered.data.items[0].id, a.data.item.id);
  const b = await app.call("POST", `${app.root}/participants`, payload);
  assert.equal(b.data.item.id, a.data.item.id);
  assert.equal(b.data.created, false);
  assert.equal(b.data.generalConversationId, generalId);
  assert.equal(b.meta.instructions.text, guidance);
  assert.equal(
    (await app.call("POST", `${app.root}/participants`, { ...payload, joinedNote: "changed" }, 409))
      .error.code,
    "idempotency_conflict",
  );
  assert.equal(
    (
      await app.call(
        "POST",
        `${app.root}/participants`,
        { ...payload, name: "product", requestKey: "other" },
        409,
      )
    ).error.code,
    "name_taken",
  );
  for (const fields of [
    { name: "bad name" },
    { workingDirectory: null },
    { extra: "unexpected" },
    { grantId: randomUUID() },
    { agentType: "" },
  ]) {
    await app.call(
      "POST",
      `${app.root}/participants`,
      { ...payload, requestKey: randomUUID(), ...fields },
      400,
    );
  }
  const profile = (await app.call("GET", `${app.root}/participants?name=PRODUCT`)).data.items;
  assert.equal(profile.length, 1);
  assert.equal(profile[0].id, a.data.item.id);
  assert.equal((await app.server()).participantCount, 1);
});

test("agent aliases agree across HTTP, MCP, persisted recovery and registration retries", async (t) => {
  const app = await start(t);
  const cases = [
    [" Claude  Code ", "claude-code"],
    ["CLAUDE_WEB", "claude-web"],
    ["OpenAI Codex", "codex"],
    ["Codex Desktop", "codex-desktop"],
    ["cursor-ide", "cursor"],
    ["pi.dev", "pi"],
    ["ChatGPT Web", "chatgpt-web"],
    ["chatgpt-desktop", "chatgpt-desktop"],
    ["google-gemini-cli", "gemini-cli"],
    ["github_copilot", "github-copilot"],
    ["windsurf-editor", "windsurf"],
    ["cline-vscode", "cline"],
    ["Roo Code", "roo-code"],
    ["open code", "opencode"],
    ["ampcode.com", "amp"],
    ["block-goose", "goose"],
    ["aider-ai", "aider"],
    ["continue.dev", "continue"],
    ["kiro cli", "kiro-cli"],
    ["Hermes Agent", "hermes"],
    ["OpenClaw", "openclaw"],
    ["agy", "antigravity-cli"],
    ["Devin Desktop", "devin-desktop"],
    ["Muse Code", "muse-code"],
    ["Muse", "muse"],
    ["poke", "poke"],
    ["Town", "town"],
    ["grok.com", "grok-web"],
    ["VS Code", "github-copilot"],
    ["CUSTOM_Claude_Wrapper", "custom_claude_wrapper"],
  ];
  for (const [index, [submitted, canonical]] of cases.entries()) {
    const input = { name: `Icon${index}`, agentType: submitted, requestKey: `icon-${index}` };
    const first = await app.call("POST", `${app.root}/participants`, input);
    assert.equal(first.data.item.agentType, canonical);
    const replay = await packet(
      await app.raw(
        "/mcp",
        rpc(
          "tools/call",
          {
            name: "register_participant",
            arguments: { serverId: app.bindings.TALKTO_SERVER_ID, ...input, agentType: canonical },
          },
          app.bindings.TALKTO_LOCAL_TOKEN,
        ),
      ),
    );
    assert.equal(replay.result.isError, false, JSON.stringify(replay));
    assert.equal(replay.result.structuredContent.data.item.id, first.data.item.id);
    assert.equal(replay.result.structuredContent.data.created, false);
  }
  const mcpAlias = await packet(
    await app.raw(
      "/mcp",
      rpc(
        "tools/call",
        {
          name: "register_participant",
          arguments: {
            serverId: app.bindings.TALKTO_SERVER_ID,
            name: "BrowserAlias",
            requestKey: "browser-alias",
            agentType: "Claude Web",
            joinedNote: "My human asked me to review the design.",
          },
        },
        app.bindings.TALKTO_LOCAL_TOKEN,
      ),
    ),
  );
  assert.equal(mcpAlias.result.structuredContent.data.item.agentType, "claude-web");
  assert.equal(
    mcpAlias.result.structuredContent.data.item.joinedNote,
    "My human asked me to review the design.",
  );
  const legacy = { name: "LegacyIcon", agentType: "claude-code", requestKey: "legacy-icon" };
  const first = await app.call("POST", `${app.root}/participants`, legacy);
  assert.equal((await app.raw("/__control/legacy-agent-type")).status, 200);
  await app.restart();
  const recovered = (await app.call("GET", `${app.root}/participants?name=LegacyIcon`)).data
    .items[0];
  assert.equal(recovered.id, first.data.item.id);
  assert.equal(recovered.agentType, "claude-code");
  const retried = await app.call("POST", `${app.root}/participants`, {
    ...legacy,
    agentType: "CLAUDE_CODE",
  });
  assert.equal(retried.data.item.id, recovered.id);
  assert.equal(retried.data.created, false);
  await app.call("POST", `${app.root}/participants`, { ...legacy, agentType: "claude-web" }, 409);
  for (const agentType of [
    "not a client",
    "my.client",
    "cl@ude",
    "a".repeat(65),
    "claude\ncode",
    "<svg>",
    "pi.dev\0",
  ]) {
    await app.call(
      "POST",
      `${app.root}/participants`,
      { name: "Invalid", agentType, requestKey: randomUUID() },
      400,
    );
  }
  // Alias tolerance applies to client types, never to participant name uniqueness.
  await app.call(
    "POST",
    `${app.root}/participants`,
    { name: "Bad Name", agentType: "Claude Code", requestKey: randomUUID() },
    400,
  );
  assert.equal((await app.server()).participantCount, cases.length + 2);
});

test("directory continuations preserve filters and reject incompatible input", async (t) => {
  const app = await start(t);
  for (const name of ["Charlie", "Alpha", "Bravo"]) await app.register(name);
  const first = (await app.call("GET", `${app.root}/participants?limit=1`)).data;
  assert.equal(first.items[0].name, "Alpha");
  assert.ok(first.nextCursor);
  const next = (
    await app.call("GET", `${app.root}/participants?cursor=${first.nextCursor}&limit=1`)
  ).data;
  assert.equal(next.items[0].name, "Bravo");
  await app.call(
    "GET",
    `${app.root}/participants?cursor=${first.nextCursor}&name=Alpha`,
    undefined,
    400,
  );
  await app.call("GET", `${app.root}/participants?surprise=1`, undefined, 400);
  await app.call("GET", `${app.root}/channels?cursor=${first.nextCursor}`, undefined, 400);
  await app.call("GET", `${app.root}/participants?limit=0`, undefined, 400);
  await app.call("GET", `${app.root}/participants?limit=101`, undefined, 400);
});

test("channel lifecycle, revision conflicts, reserved names, and replay after archive", async (t) => {
  const app = await start(t);
  const a = await app.register("Product");
  const s = await app.server();
  const payload = {
    participantId: a.id,
    name: "Planning",
    description: "Feature discussions",
    requestKey: "create-planning",
  };
  const channel = (await app.call("POST", `${app.root}/channels`, payload)).data.item;
  assert.equal((await app.call("POST", `${app.root}/channels`, payload)).data.created, false);
  await app.call(
    "POST",
    `${app.root}/channels`,
    { ...payload, name: "planning", requestKey: "new" },
    409,
  );
  await app.call(
    "POST",
    `${app.root}/channels`,
    { ...payload, name: "general", requestKey: "general" },
    409,
  );
  const sent = await app.send(channel.id, a.id, "archived searchable topic", "original-message");
  const archived = (
    await app.call("PATCH", `${app.root}/channels/${channel.id}`, {
      participantId: a.id,
      archived: true,
      expectedRevision: 0,
    })
  ).data;
  assert.equal(archived.revision, 1);
  assert.ok(archived.archivedAt);
  await app.call(
    "POST",
    `${app.root}/conversations/${channel.id}/messages`,
    { participantId: a.id, body: "new", requestKey: "new" },
    409,
  );
  const replay = (
    await app.call("POST", `${app.root}/conversations/${channel.id}/messages`, {
      participantId: a.id,
      body: sent.body,
      requestKey: "original-message",
    })
  ).data;
  assert.equal(replay.item.id, sent.id);
  assert.equal(replay.created, false);
  assert.equal((await app.history(channel.id)).items.length, 1);
  assert.equal((await app.call("GET", `${app.root}/channels?state=archived`)).data.items.length, 1);
  await app.call("PATCH", `${app.root}/channels/${channel.id}`, {
    participantId: a.id,
    archived: false,
    expectedRevision: 1,
  });
  await app.call(
    "PATCH",
    `${app.root}/channels/${channel.id}`,
    { participantId: a.id, archived: true, expectedRevision: 0 },
    409,
  );
  await app.call(
    "PATCH",
    `${app.root}/channels/${s.generalConversationId}`,
    { participantId: a.id, archived: true, expectedRevision: 0 },
    403,
  );
});

test("direct pairs, shared visibility, own-chat filtering, and sender membership", async (t) => {
  const app = await start(t);
  const a = await app.register("Alpha"),
    b = await app.register("Bravo"),
    c = await app.register("Charlie");
  const direct = (
    await app.call("POST", `${app.root}/direct-chats`, { participantId: a.id, recipientId: b.id })
  ).data.item;
  const reversed = (
    await app.call("POST", `${app.root}/direct-chats`, { participantId: b.id, recipientId: a.id })
  ).data;
  assert.equal(reversed.item.id, direct.id);
  assert.equal(reversed.created, false);
  await app.call(
    "POST",
    `${app.root}/direct-chats`,
    { participantId: a.id, recipientId: a.id },
    400,
  );
  await app.call(
    "POST",
    `${app.root}/direct-chats`,
    { participantId: a.id, recipientId: randomUUID() },
    404,
  );
  await app.send(direct.id, a.id, "pair context");
  const result = await app.call("GET", `${app.root}/conversations/${direct.id}/messages`);
  assert.equal(result.data.items.length, 1);
  assert.equal(result.included.participants.length, 2);
  await app.call(
    "POST",
    `${app.root}/conversations/${direct.id}/messages`,
    { participantId: c.id, body: "outsider", requestKey: "outsider" },
    403,
  );
  assert.equal(
    (await app.call("GET", `${app.root}/direct-chats?withParticipantId=${c.id}`)).data.items.length,
    0,
  );
  assert.equal((await app.call("GET", `${app.root}/direct-chats`)).data.items.length, 1);
});

test("conversation previews show the latest sender, bound Unicode, and survive restart", async (t) => {
  const app = await start(t);
  const a = await app.register("Alpha"),
    b = await app.register("Bravo"),
    c = await app.register("Charlie");
  const general = (await app.server()).generalConversationId;
  const direct = (
    await app.call("POST", `${app.root}/direct-chats`, { participantId: a.id, recipientId: b.id })
  ).data.item;
  assert.equal(direct.latestMessage, null);
  const exact = "🌲".repeat(240);
  const first = await app.send(direct.id, a.id, exact);
  const preview = (message, excerpt = message.body, truncated = false) => ({
    id: message.id,
    sequence: message.sequence,
    senderId: message.senderId,
    createdAt: message.createdAt,
    excerpt,
    truncated,
  });
  const firstListing = await app.call("GET", `${app.root}/direct-chats?withParticipantId=${a.id}`);
  assert.deepEqual(firstListing.data.items[0].latestMessage, preview(first));
  const body = `${exact} full message tail`;
  const second = await app.send(direct.id, b.id, body);
  await app.send(direct.id, a.id, exact, "retry-old");
  const last = await app.send(direct.id, b.id, body);
  await app.send(direct.id, a.id, exact, "retry-old");
  const listed = await app.call("GET", `${app.root}/direct-chats?withParticipantId=${a.id}`);
  assert.deepEqual(listed.data.items[0].latestMessage, preview(last, exact, true));
  assert.equal(listed.included.participants.find((p) => p.id === b.id).name, "Bravo");
  assert.ok(last.sequence > second.sequence);
  const context = await app.call("GET", `${app.root}/messages/${last.id}/context?before=0&after=0`);
  assert.equal(context.data.anchor.body, body);
  assert.deepEqual(context.included.conversations[0].latestMessage, preview(last, exact, true));
  const generalMessage = await app.send(general, c.id, "General from a different sender");
  const channels = await app.call("GET", `${app.root}/channels`);
  assert.deepEqual(channels.data.items[0].latestMessage, preview(generalMessage));
  assert.equal(channels.included.participants.find((p) => p.id === c.id).name, "Charlie");
  await app.restart();
  const reopened = await app.call("POST", `${app.root}/direct-chats`, {
    participantId: b.id,
    recipientId: a.id,
  });
  assert.deepEqual(reopened.data.item.latestMessage, preview(last, exact, true));
  const descriptor = await app.call("GET", `${app.root}/conversations/${direct.id}`);
  assert.deepEqual(descriptor.data.latestMessage, preview(last, exact, true));
  const older = await app.history(direct.id, {
    position: { kind: "beforeMessage", messageId: last.id },
  });
  assert.equal(older.items.length, 3);
});

test("concurrent idempotent sends preserve counts and unique ordered messages", async (t) => {
  const app = await start(t);
  const a = await app.register("Alpha");
  const general = (await app.server()).generalConversationId;
  const attempts = await Promise.all(
    Array.from({ length: 8 }, () =>
      app.call("POST", `${app.root}/conversations/${general}/messages`, {
        participantId: a.id,
        body: "one logical message",
        requestKey: "same",
      }),
    ),
  );
  assert.equal(new Set(attempts.map((r) => r.data.item.id)).size, 1);
  assert.equal(attempts.filter((r) => r.data.created).length, 1);
  await Promise.all(
    Array.from({ length: 8 }, (_, n) => app.send(general, a.id, `unique ${n}`, `unique-${n}`)),
  );
  const page = await app.history(general);
  assert.equal(page.items.length, 9);
  assert.equal(new Set(page.items.map((m) => m.sequence)).size, 9);
  assert.deepEqual(
    page.items.map((m) => m.sequence),
    page.items.map((m) => m.sequence).toSorted((x, y) => x - y),
  );
  assert.equal((await app.server()).messageCount, 9);
  assert.equal((await app.call("GET", `${app.root}/participants/${a.id}`)).data.messageCount, 9);
  await app.call(
    "POST",
    `${app.root}/conversations/${general}/messages`,
    { participantId: a.id, body: "changed", requestKey: "same" },
    409,
  );
});

test("history snapshots, exclusive anchors, bounded pages, and repeatable reads", async (t) => {
  const app = await start(t);
  const a = await app.register("Alpha");
  const general = (await app.server()).generalConversationId;
  const original = [];
  for (let n = 0; n < 6; n++) original.push(await app.send(general, a.id, `history ${n}`));
  const first = await app.history(general, { limit: 2 });
  assert.deepEqual(
    first.items.map((m) => m.id),
    original.slice(-2).map((m) => m.id),
  );
  await app.send(general, a.id, "later append");
  const second = await app.history(general, {
    limit: 2,
    position: { kind: "cursor", cursor: first.nextCursor },
  });
  assert.deepEqual(
    second.items.map((m) => m.id),
    original.slice(2, 4).map((m) => m.id),
  );
  const third = await app.history(general, {
    limit: 2,
    position: { kind: "cursor", cursor: second.nextCursor },
  });
  assert.deepEqual(
    third.items.map((m) => m.id),
    original.slice(0, 2).map((m) => m.id),
  );
  assert.equal(third.nextCursor, null);
  const after = await app.history(general, {
    limit: 2,
    position: { kind: "afterMessage", messageId: original[1].id },
  });
  assert.deepEqual(
    after.items.map((m) => m.id),
    original.slice(2, 4).map((m) => m.id),
  );
  const time = await app.history(general, {
    position: { kind: "afterTime", time: original[2].createdAt },
  });
  assert.ok(time.items.every((m) => m.createdAt > original[2].createdAt));
  assert.deepEqual(await app.history(general), await app.history(general));
  const other = (
    await app.call("POST", `${app.root}/channels`, {
      participantId: a.id,
      name: "Other",
      requestKey: "other",
    })
  ).data.item;
  await app.call(
    "GET",
    `${app.root}/conversations/${other.id}/messages?position=${encodeURIComponent(JSON.stringify({ kind: "beforeMessage", messageId: original[0].id }))}`,
    undefined,
    404,
  );
  await app.call(
    "GET",
    `${app.root}/conversations/${other.id}/messages?position=${encodeURIComponent(JSON.stringify({ kind: "cursor", cursor: first.nextCursor }))}`,
    undefined,
    400,
  );
});

test("search filters, literal terms, stable pages, and message context", async (t) => {
  const app = await start(t);
  const a = await app.register("Alpha"),
    b = await app.register("Bravo");
  const general = (await app.server()).generalConversationId;
  const messages = [];
  for (let n = 0; n < 5; n++)
    messages.push(await app.send(general, n % 2 ? b.id : a.id, `release checklist ${n}`));
  const search = (
    await app.call("GET", `${app.root}/messages/search?query=release%20checklist&limit=2`)
  ).data;
  assert.deepEqual(
    search.items.map((m) => m.id),
    messages
      .slice(-2)
      .toReversed()
      .map((m) => m.id),
  );
  await app.send(general, a.id, "release checklist new");
  const next = (await app.call("GET", `${app.root}/messages/search?cursor=${search.nextCursor}`))
    .data;
  assert.deepEqual(
    next.items.map((m) => m.id),
    messages
      .slice(0, 3)
      .toReversed()
      .map((m) => m.id),
  );
  const filtered = (
    await app.call(
      "GET",
      `${app.root}/messages/search?query=release&senderId=${b.id}&conversationId=${general}`,
    )
  ).data;
  assert.equal(filtered.items.length, 2);
  assert.ok(filtered.items.every((m) => m.senderId === b.id));
  assert.equal(
    (await app.call("GET", `${app.root}/messages/search?query=release%20OR%20absent`)).data.items
      .length,
    0,
  );
  await app.call(
    "GET",
    `${app.root}/messages/search?query=${encodeURIComponent('"*')}`,
    undefined,
    400,
  );
  await app.call(
    "GET",
    `${app.root}/messages/search?query=release&afterTime=2099-01-01T00:00:00.000Z&beforeTime=2000-01-01T00:00:00.000Z`,
    undefined,
    400,
  );
  const context = (
    await app.call("GET", `${app.root}/messages/${messages[2].id}/context?before=1&after=1`)
  ).data;
  assert.equal(context.anchor.id, messages[2].id);
  assert.deepEqual(
    context.before.map((m) => m.id),
    [messages[1].id],
  );
  assert.deepEqual(
    context.after.map((m) => m.id),
    [messages[3].id],
  );
  assert.equal(context.hasMoreBefore, true);
  assert.equal(context.hasMoreAfter, true);
  const zero = (
    await app.call("GET", `${app.root}/messages/${messages[2].id}/context?before=0&after=0`)
  ).data;
  assert.equal(zero.before.length, 0);
  assert.equal(zero.hasMoreBefore, true);
});

test("UTF-8 limits and body budgets never split messages or skip cursor rows", async (t) => {
  const app = await start(t);
  const a = await app.register("Alpha");
  const general = (await app.server()).generalConversationId;
  for (const body of [" ", "a\0b", "\ud800", "😀".repeat(4097)])
    await app.call(
      "POST",
      `${app.root}/conversations/${general}/messages`,
      { participantId: a.id, body, requestKey: randomUUID() },
      400,
    );
  const body = "😀".repeat(4096);
  for (let n = 0; n < 6; n++) await app.send(general, a.id, body, `large-${n}`);
  const first = await app.history(general, { limit: 100 });
  assert.equal(first.items.length, 4);
  assert.ok(first.nextCursor);
  assert.ok(first.items.every((m) => m.body === body));
  const rest = await app.history(general, {
    limit: 100,
    position: { kind: "cursor", cursor: first.nextCursor },
  });
  assert.equal(rest.items.length, 2);
  assert.equal(new Set([...first.items, ...rest.items].map((m) => m.id)).size, 6);
  const context = (
    await app.call("GET", `${app.root}/messages/${first.items[1].id}/context?before=50&after=50`)
  ).data;
  assert.ok(
    [context.anchor, ...context.before, ...context.after].reduce(
      (n, m) => n + Buffer.byteLength(m.body),
      0,
    ) <= 65536,
  );
  await app.call(
    "POST",
    `${app.root}/conversations/${general}/messages`,
    { participantId: a.id, body: "x".repeat(140000), requestKey: "oversized" },
    413,
  );
});

test("failed application transactions roll back messages, summaries, and FTS", async (t) => {
  const app = await start(t);
  const a = await app.register("Alpha");
  const general = (await app.server()).generalConversationId;
  const before = await app.server();
  const result = await (
    await app.raw(`/__control/rollback?participantId=${a.id}&conversationId=${general}`)
  ).json();
  assert.deepEqual(result, { ok: false, error: "InvalidInput" });
  assert.deepEqual(await app.server(), before);
  assert.equal((await app.history(general)).items.length, 0);
  assert.equal(
    (await app.call("GET", `${app.root}/messages/search?query=rollback`)).data.items.length,
    0,
  );
  assert.equal((await app.call("GET", `${app.root}/participants/${a.id}`)).data.messageCount, 0);
});

test("revocation rejects reads, discovery, and retries and survives restart", async (t) => {
  const app = await start(t);
  const a = await app.register("Alpha");
  const general = (await app.server()).generalConversationId;
  await app.send(general, a.id, "already committed", "original");
  assert.deepEqual(await (await app.raw("/__control/revoke")).json(), { ok: true });
  assert.equal((await app.call("GET", app.root, undefined, 404)).error.code, "server_unavailable");
  await app.call("GET", "/v1/servers", undefined, 404);
  await app.call(
    "POST",
    `${app.root}/conversations/${general}/messages`,
    { participantId: a.id, body: "already committed", requestKey: "original" },
    404,
  );
  await app.restart();
  await app.call("GET", app.root, undefined, 404);
});

test("invalid runtime configuration fails closed without leaking credentials", async (t) => {
  const app = await start(t, { TALKTO_SERVER_ID: "not-an-id" });
  const result = await app.call("GET", "/v1/servers", undefined, 503);
  assert.equal(result.error.code, "configuration_unavailable");
  assert.ok(!JSON.stringify(result).includes(app.bindings.TALKTO_LOCAL_TOKEN));
});

test("hosted entry point fails closed without WorkOS configuration", async (t) => {
  const app = await start(t, {}, true);
  assert.equal((await app.raw("/health")).status, 200);
  assert.equal(
    (await app.call("GET", "/v1/servers", undefined, 503)).error.code,
    "identity_unavailable",
  );
  await app.call(
    "POST",
    `${app.root}/participants`,
    { name: "Alpha", agentType: "codex", requestKey: "join" },
    503,
  );
});

test("local MCP uses the same seven tools with loopback credentials and persisted identities", async (t) => {
  const app = await start(t);
  const invoke = async (name, args) => {
    const response = await app.raw(
      "/mcp",
      rpc("tools/call", { name, arguments: args }, app.bindings.TALKTO_LOCAL_TOKEN),
    );
    const result = await packet(response);
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.result.isError, false, JSON.stringify(result));
    return result.result.structuredContent;
  };
  const discovery = await invoke("get_context", { includeInstructions: true });
  assert.equal(discovery.data.items[0].id, app.bindings.TALKTO_SERVER_ID);
  assert.ok(discovery.meta.instructionSheet);
  const registered = await invoke("register_participant", {
    serverId: app.bindings.TALKTO_SERVER_ID,
    name: "LocalMcp",
    agentType: "codex",
    requestKey: "local-mcp",
  });
  await app.restart();
  const recovered = await invoke("get_context", {
    serverId: app.bindings.TALKTO_SERVER_ID,
    participant: { name: "localmcp" },
  });
  assert.equal(recovered.data.self.id, registered.data.item.id);
  const unsupported = rpc("subscriptions/listen", {}, app.bindings.TALKTO_LOCAL_TOKEN);
  const rejected = await app.raw("/mcp", unsupported);
  assert.notEqual(rejected.headers.get("content-type"), "text/event-stream");
  assert.ok(rejected.status >= 400 || (await packet(rejected)).error);
});

test("updates combine selected channels and incoming newly opened DMs without hiding earlier arrivals", async (t) => {
  const app = await start(t);
  const me = await app.register("Watching");
  const peer = await app.register("Peer");
  const third = await app.register("NewPeer");
  const general = (await app.server()).generalConversationId;
  const selected = (
    await app.call("POST", `${app.root}/channels`, {
      participantId: me.id,
      requestKey: randomUUID(),
      name: "Work",
    })
  ).data.item;
  const baseline = await app.updates({
    participantId: me.id,
    mode: "start",
    channelIds: [selected.id],
    directChats: "own",
    startAt: "now",
  });
  assert.deepEqual(baseline.data.messages, []);
  assert.deepEqual(baseline.included, { participants: [], conversations: [] });
  const expected = [await app.send(selected.id, peer.id, "channel input")];
  await app.send(general, peer.id, "unselected channel");
  const chat = (
    await app.call("POST", `${app.root}/direct-chats`, {
      participantId: third.id,
      recipientId: me.id,
    })
  ).data.item;
  expected.push(await app.send(chat.id, third.id, "new DM input"));
  await app.send(chat.id, me.id, "my reply must not hide incoming messages");
  const other = (
    await app.call("POST", `${app.root}/direct-chats`, {
      participantId: third.id,
      recipientId: peer.id,
    })
  ).data.item;
  await app.send(other.id, third.id, "unrelated DM");
  const batch = await app.updates({
    participantId: me.id,
    mode: "poll",
    checkpoint: baseline.data.checkpoint,
  });
  assert.deepEqual(batch.data.messages, expected);
  assert.equal(batch.data.nextCursor, null);
  assert.deepEqual(
    (
      await app.updates({
        participantId: me.id,
        mode: "start",
        channelIds: [selected.id],
        directChats: "none",
        startAt: "beginning",
      })
    ).data.messages,
    [expected[0]],
  );
  assert.deepEqual(
    (
      await app.updates({
        participantId: me.id,
        mode: "start",
        channelIds: [],
        directChats: "own",
        startAt: "beginning",
      })
    ).data.messages,
    [expected[1]],
  );
  assert.deepEqual(
    new Set(batch.included.conversations.map((c) => c.id)),
    new Set([selected.id, chat.id]),
  );
  assert.deepEqual(
    new Set(batch.included.participants.map((p) => p.id)),
    new Set([me.id, peer.id, third.id]),
  );
  assert.doesNotMatch(
    JSON.stringify(batch.included),
    /latestMessage|workingDirectory|joinedNote|messageCount/,
  );
  const count = (await app.server()).messageCount;
  await app.restart();
  const empty = await app.updates({
    participantId: me.id,
    mode: "poll",
    checkpoint: batch.data.checkpoint,
  });
  assert.deepEqual(empty.data.messages, []);
  assert.equal(empty.data.nextCursor, null);
  assert.ok(Buffer.byteLength(JSON.stringify(empty)) <= 8192);
  assert.equal((await app.server()).messageCount, count);
  assert.deepEqual(
    (
      await app.updates({
        participantId: me.id,
        mode: "poll",
        checkpoint: baseline.data.checkpoint,
      })
    ).data.messages,
    expected,
  );
  await app.call("PATCH", `${app.root}/channels/${selected.id}`, {
    participantId: me.id,
    archived: true,
    expectedRevision: selected.revision,
  });
  const archived = await app.updates({
    participantId: me.id,
    mode: "poll",
    checkpoint: baseline.data.checkpoint,
  });
  assert.deepEqual(archived.data.messages, expected);
  assert.ok(archived.included.conversations.find((c) => c.id === selected.id).archivedAt);
});

test("updates wrong-kind errors preserve usable bookmarks through HTTP and MCP", async (t) => {
  const app = await start(t);
  const me = await app.register("BookmarkReceiver");
  const peer = await app.register("BookmarkSender");
  const general = (await app.server()).generalConversationId;
  const first = await app.send(general, peer.id, "first in selected channel");
  const second = await app.send(general, peer.id, "second in selected channel");
  const initial = await app.updates({
    participantId: me.id,
    mode: "start",
    channelIds: [general],
    directChats: "none",
    startAt: "beginning",
    limit: 1,
  });
  assert.deepEqual(initial.data.messages, [first]);
  assert.ok(initial.data.nextCursor);
  const later = await app.send(general, peer.id, "after snapshot");
  await app.send(general, me.id, "own messages stay excluded");
  for (const transport of ["http", "mcp"]) {
    const read = (input, invalid = false) =>
      transport === "http"
        ? app.updates(input, invalid ? 400 : 200)
        : app.mcp(
            "get_updates",
            { serverId: app.bindings.TALKTO_SERVER_ID, ...input },
            "2026-07-28",
            invalid,
          );
    const swappedCheckpoint = await read(
      { participantId: me.id, mode: "continue", cursor: initial.data.checkpoint },
      true,
    );
    assert.equal(swappedCheckpoint.error.code, "invalid_cursor");
    assert.match(swappedCheckpoint.error.message, /mode="poll".*unchanged token as checkpoint/);
    assert.doesNotMatch(swappedCheckpoint.error.message, /replay from the beginning/);
    assert.deepEqual(
      (await read({ participantId: me.id, mode: "poll", checkpoint: initial.data.checkpoint })).data
        .messages,
      [second, later],
    );
    const swappedContinuation = await read(
      { participantId: me.id, mode: "poll", checkpoint: initial.data.nextCursor },
      true,
    );
    assert.equal(swappedContinuation.error.code, "invalid_cursor");
    assert.match(swappedContinuation.error.message, /mode="continue".*unchanged token as cursor/);
    const invalidPage = JSON.parse(Buffer.from(initial.data.nextCursor, "base64url").toString());
    invalidPage.ceiling = later.sequence + 100;
    const invalidHistory = await read(
      {
        participantId: me.id,
        mode: "poll",
        checkpoint: Buffer.from(JSON.stringify(invalidPage)).toString("base64url"),
      },
      true,
    );
    assert.equal(invalidHistory.error.code, "invalid_cursor");
    assert.match(invalidHistory.error.message, /stored history/);
    assert.doesNotMatch(invalidHistory.error.message, /no replay is needed/);
    const corrected = await read({
      participantId: me.id,
      mode: "continue",
      cursor: initial.data.nextCursor,
    });
    assert.deepEqual(corrected.data.messages, [second]);
    assert.deepEqual(
      (await read({ participantId: me.id, mode: "poll", checkpoint: corrected.data.checkpoint }))
        .data.messages,
      [later],
    );
  }
});

test("updates pagination preserves full bodies, a fixed ceiling, replay, and restart recovery", async (t) => {
  const app = await start(t);
  const me = await app.register("Receiver");
  const peer = await app.register("Sender");
  const general = (await app.server()).generalConversationId;
  const watch = {
    participantId: me.id,
    mode: "start",
    channelIds: [general],
    directChats: "own",
    startAt: "beginning",
    limit: 100,
  };
  const expected = [];
  for (let index = 0; index < 108; index++)
    expected.push(await app.send(general, peer.id, `Message ${index}\n日本語 🐙`));
  let page = await app.updates(watch);
  assert.equal(page.data.messages.length, 100);
  const continuation = page.data.nextCursor;
  assert.ok(continuation);
  const later = await app.send(general, peer.id, "after snapshot ceiling");
  await app.restart();
  const result = [...page.data.messages];
  page = await app.updates({
    participantId: me.id,
    mode: "continue",
    cursor: continuation,
    limit: 100,
  });
  result.push(...page.data.messages);
  assert.equal(page.data.nextCursor, null);
  assert.deepEqual(result, expected);
  assert.deepEqual(
    (
      await app.updates({
        participantId: me.id,
        mode: "continue",
        cursor: continuation,
        limit: 100,
      })
    ).data,
    page.data,
  );
  assert.deepEqual(
    (await app.updates({ participantId: me.id, mode: "poll", checkpoint: page.data.checkpoint }))
      .data.messages,
    [later],
  );
  const largeBaseline = (await app.updates({ ...watch, startAt: "now" })).data.checkpoint;
  const large = [];
  for (const body of [
    "🐙".repeat(4096),
    "\u0001".repeat(16384),
    "\u0001".repeat(16384),
    "x".repeat(16384),
    "y".repeat(16384),
    "z".repeat(16384),
  ])
    large.push(await app.send(general, peer.id, body));
  page = await app.updates({
    participantId: me.id,
    mode: "poll",
    checkpoint: largeBaseline,
    limit: 100,
  });
  const collected = [];
  for (let count = 0; ; count++) {
    assert.ok(count < 10);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 131072);
    assert.ok(
      page.data.messages.reduce((sum, message) => sum + Buffer.byteLength(message.body), 0) <=
        65536,
    );
    collected.push(...page.data.messages);
    if (page.data.nextCursor === null) break;
    page = await app.updates({
      participantId: me.id,
      mode: "continue",
      cursor: page.data.nextCursor,
      limit: 100,
    });
  }
  assert.deepEqual(collected, large);
});

test("updates reject invalid selections and checkpoints, preserve upgrade history, and enforce revocation", async (t) => {
  const app = await start(t);
  const me = await app.register("Scope");
  const peer = await app.register("OtherScope");
  const general = (await app.server()).generalConversationId;
  const sent = await app.send(general, peer.id, "retained across upgrade");
  await app.raw("/__control/updates-upgrade");
  await app.restart();
  const input = {
    participantId: me.id,
    mode: "start",
    channelIds: [general],
    directChats: "own",
    startAt: "beginning",
  };
  const first = await app.updates(input);
  assert.deepEqual(first.data.messages, [sent]);
  for (const invalid of [
    { ...input, channelIds: [], directChats: "none" },
    { ...input, channelIds: [general, general] },
    { ...input, limit: 101 },
    { ...input, channelIds: Array.from({ length: 33 }, () => randomUUID()) },
    { ...input, waitSeconds: 30 },
    {
      participantId: me.id,
      mode: "poll",
      checkpoint: first.data.checkpoint,
      channelIds: [general],
    },
  ])
    assert.equal((await app.updates(invalid, 400)).error.code, "invalid_input");
  assert.equal(
    (await app.updates({ ...input, channelIds: [randomUUID()] }, 404)).error.code,
    "conversation_not_found",
  );
  const direct = (
    await app.call("POST", `${app.root}/direct-chats`, {
      participantId: me.id,
      recipientId: peer.id,
    })
  ).data.item;
  assert.equal(
    (await app.updates({ ...input, channelIds: [direct.id] }, 400)).error.code,
    "wrong_conversation_kind",
  );
  const poll = { participantId: me.id, mode: "poll", checkpoint: first.data.checkpoint };
  assert.equal(
    (await app.updates({ ...poll, participantId: peer.id }, 400)).error.code,
    "invalid_cursor",
  );
  assert.equal(
    (
      await app.updates(
        { participantId: me.id, mode: "continue", cursor: first.data.checkpoint },
        400,
      )
    ).error.code,
    "invalid_cursor",
  );
  const state = JSON.parse(Buffer.from(first.data.checkpoint, "base64url").toString());
  for (const altered of [
    { ...state, serverId: randomUUID() },
    { ...state, boundary: Number.MAX_SAFE_INTEGER + 1 },
    { ...state, boundary: sent.sequence + 1 },
    { ...state, version: 2 },
    { ...state, selection: { channelIds: [], directChats: "none" } },
  ]) {
    assert.equal(
      (
        await app.updates(
          { ...poll, checkpoint: Buffer.from(JSON.stringify(altered)).toString("base64url") },
          400,
        )
      ).error.code,
      "invalid_cursor",
    );
  }
  await app.raw("/__control/updates-rotate");
  assert.equal((await app.updates(poll, 400)).error.code, "invalid_cursor");
  assert.deepEqual((await app.updates(input)).data.messages, [sent]);
  await app.raw("/__control/revoke");
  assert.equal((await app.updates(input, 404)).error.code, "server_unavailable");
});

test("updates bound sparse scans and continue empty windows without losing new DMs", async (t) => {
  const app = await start(t);
  const me = await app.register("Sparse");
  const peer = await app.register("BusyElsewhere");
  const general = (await app.server()).generalConversationId;
  const first = await app.updates({
    participantId: me.id,
    mode: "start",
    channelIds: [],
    directChats: "own",
    startAt: "now",
  });
  assert.equal(
    (
      await app.raw("/__control/updates-seed", {
        method: "POST",
        body: JSON.stringify({ participantId: peer.id, conversationId: general, count: 2500 }),
      })
    ).status,
    200,
  );
  const pair = (
    await app.call("POST", `${app.root}/direct-chats`, {
      participantId: peer.id,
      recipientId: me.id,
    })
  ).data.item;
  const dm = await app.send(pair.id, peer.id, "incoming after unrelated history");
  const sparse = await app.updates({
    participantId: me.id,
    mode: "poll",
    checkpoint: first.data.checkpoint,
  });
  assert.deepEqual(sparse.data.messages, []);
  assert.deepEqual(sparse.included, { participants: [], conversations: [] });
  assert.ok(sparse.data.nextCursor);
  const end = await app.updates({
    participantId: me.id,
    mode: "continue",
    cursor: sparse.data.nextCursor,
  });
  assert.deepEqual(end.data.messages, [dm]);
  assert.equal(end.data.nextCursor, null);
  const count = (await app.server()).messageCount;
  for (let index = 0; index < 10; index++) {
    const empty = await app.updates({
      participantId: me.id,
      mode: "poll",
      checkpoint: end.data.checkpoint,
    });
    assert.deepEqual(empty.data.messages, []);
    assert.equal(empty.data.nextCursor, null);
  }
  assert.equal((await app.server()).messageCount, count);
});

test("updates and monitoring instructions reach agents automatically in both MCP eras", async (t) => {
  const app = await start(t);
  const serverId = app.bindings.TALKTO_SERVER_ID;
  const guide = await (await app.raw("/instructions")).text();
  assert.match(guide, /Seven tools/);
  assert.match(guide, /## How to work on TalkTo/);
  assert.match(guide, /only when you need them now/);
  assert.match(guide, /## Keep up while working/);
  assert.match(guide, /Stop checking when the work ends/);
  assert.match(guide, /about every \d+ minutes/, "the check interval is filled in");
  assert.match(guide, /## Files/);
  assert.match(guide, /get_files_access/);
  assert.match(guide, /share_file/);
  assert.match(guide, /fetch only when a share message arrives/);
  assert.match(guide, /Never poll the remote/);
  const spec = await (await app.raw("/openapi.json")).json();
  assert.ok(spec.paths["/v1/servers/{serverId}/updates"].post);
  for (const version of ["2026-07-28", "2025-11-25"]) {
    const method = version === "2026-07-28" ? "server/discover" : "initialize";
    const params =
      method === "initialize"
        ? {
            protocolVersion: version,
            capabilities: {},
            clientInfo: { name: "updates-test", version: "1" },
          }
        : {};
    const connection = await packet(
      await app.raw("/mcp", rpc(method, params, app.bindings.TALKTO_LOCAL_TOKEN, version)),
    );
    assert.match(JSON.stringify(connection.result), /get_updates/);
    assert.match(JSON.stringify(connection.result), /stop when work ends/);
    // The working rules arrive once, with the connection, rather than on every reply.
    assert.match(JSON.stringify(connection.result), /only when you need them now/);
    assert.match(JSON.stringify(connection.result), /get_files_access/);
    assert.match(JSON.stringify(connection.result), /share_file/);
    assert.match(JSON.stringify(connection.result), /fetch only when a share message arrives/);
    const catalog = await packet(
      await app.raw("/mcp", rpc("tools/list", {}, app.bindings.TALKTO_LOCAL_TOKEN, version)),
    );
    const tool = catalog.result.tools.find((tool) => tool.name === "get_updates");
    assert.ok(tool.inputSchema);
    assert.ok(tool.outputSchema);
    // Hosts misread a root anyOf (Claude Code kept only mode "start"); offer flat objects.
    for (const listed of catalog.result.tools) assert.equal(listed.inputSchema.anyOf, undefined);
    assert.deepEqual(tool.inputSchema.properties.mode.enum, ["start", "poll", "continue"]);
    assert.deepEqual(tool.inputSchema.properties.directChats.enum, ["own", "none"]);
    assert.deepEqual(tool.inputSchema.required, ["serverId", "participantId", "mode"]);
    assert.equal(tool.inputSchema.additionalProperties, false);
    // Hosts check replies against the schema listed at session start; a reply field added
    // later must not make running sessions reject the reply.
    for (const listed of catalog.result.tools)
      assert.doesNotMatch(JSON.stringify(listed.outputSchema), /"additionalProperties":false/);
    assert.match(tool.inputSchema.properties.checkpoint.description, /^Only with mode poll\./);
    const reads = catalog.result.tools.find((tool) => tool.name === "read_messages");
    assert.deepEqual(reads.inputSchema.properties.mode.enum, ["history", "search", "around"]);
    assert.equal(reads.inputSchema.properties.participantId, undefined);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    const discovery = await app.mcp("get_context", {}, version);
    // This local server answers get_context {} with its own context, so onboarding comes with it.
    assert.match(discovery.meta.instructions.text, /keeping up is your job/);
    const registered = await app.mcp(
      "register_participant",
      {
        serverId,
        name: `Agent${version.replaceAll("-", "")}`,
        agentType: "codex",
        requestKey: randomUUID(),
      },
      version,
    );
    const participantId = registered.data.item.id;
    assert.match(registered.meta.instructions.text, new RegExp(participantId));
    assert.match(registered.meta.instructions.text, /only when you need them now/);
    assert.match(registered.meta.instructions.text, /about every \d+ minutes/);
    assert.match(registered.meta.instructions.text, /never check while idle/);
    assert.match(registered.meta.instructions.text, /short note about TalkTo/);
    assert.equal(registered.meta.instructionSheet, undefined);
    const action = registered.meta.nextActions.find((action) => action.tool === "get_updates");
    assert.ok(action);
    const baseline = await app.mcp(action.tool, action.arguments, version);
    const rejected = async (name, args) => {
      const failure = await app.mcp(name, args, version, true);
      assert.equal(failure.error.code, "invalid_input");
      return failure.error.message;
    };
    const general = (await app.server()).generalConversationId;
    const start = {
      serverId,
      participantId,
      mode: "start",
      startAt: "beginning",
      channelIds: [general],
      directChats: "own",
      limit: 25,
    };
    assert.match(
      await rejected("get_updates", { ...start, checkpoint: null }),
      /^Arguments do not match get_updates: checkpoint is not accepted here; remove it\./,
    );
    const stringly = await rejected("get_updates", {
      ...start,
      waitSeconds: "20",
      channelIds: "[]",
    });
    assert.match(stringly, /waitSeconds must be a number; channelIds must be an array/);
    assert.match(stringly, /as JSON values, not strings/);
    assert.match(
      await rejected("get_updates", { ...start, channelIds: undefined }),
      /channelIds is required/,
    );
    assert.match(
      await rejected("get_updates", { ...start, directChats: "none", channelIds: [] }),
      /channelIds must be at least one channel ID when directChats is "none"/,
    );
    assert.match(
      await rejected("get_updates", { serverId, participantId, mode: "watch" }),
      /mode must be one of "start", "poll", "continue"/,
    );
    assert.match(
      await rejected("get_updates", { ...start, directChats: "all" }),
      /directChats must be one of "own", "none"/,
    );
    assert.match(
      await rejected("get_updates", { ...start, limit: 0, channelIds: ["general"] }),
      /limit must be a value between 1 and 100; channelIds\[0\] must be a UUID v4/,
    );
    assert.match(
      await rejected("read_messages", {
        serverId,
        participantId,
        mode: "history",
        conversationId: general,
      }),
      /participantId is not accepted here; remove it/,
    );
    const peer = await app.register(`Peer${version.replaceAll("-", "")}`);
    const dm = await app.mcp(
      "send_message",
      {
        serverId,
        participantId: peer.id,
        target: { kind: "direct", recipientId: participantId },
        requestKey: randomUUID(),
        body: "new DM via native MCP",
      },
      version,
    );
    // Other replies carry only a short pointer to the guide.
    assert.match(dm.meta.instructions.text, /^Guide: talkto:\/\/instructions/);
    assert.ok(dm.meta.instructions.text.length < 200, "every reply carries a short pointer");
    const next = baseline.meta.nextActions[0];
    const update = await app.mcp(next.tool, next.arguments, version);
    assert.deepEqual(update.data.messages, [dm.data.item]);
    const http = await app.updates({
      participantId,
      mode: "poll",
      checkpoint: baseline.data.checkpoint,
    });
    assert.deepEqual(update.data, http.data);
    assert.deepEqual(update.included, http.included);
    assert.ok(Buffer.byteLength(JSON.stringify(update)) <= 131072);
    const resumed = await app.mcp(
      "get_context",
      { serverId, participant: { id: participantId } },
      version,
    );
    assert.match(resumed.meta.instructions.text, /Resume your saved/);
    const full = await app.mcp("get_context", { serverId, includeInstructions: true }, version);
    assert.equal(full.meta.instructionSheet, guide);
    const resource = await packet(
      await app.raw(
        "/mcp",
        rpc(
          "resources/read",
          { uri: "talkto://instructions" },
          app.bindings.TALKTO_LOCAL_TOKEN,
          version,
        ),
      ),
    );
    assert.equal(resource.result.contents[0].text, guide);
    const emptyAction = update.meta.nextActions[0];
    const empty = await app.mcp(emptyAction.tool, emptyAction.arguments, version);
    assert.deepEqual(empty.data.messages, []);
    assert.ok(Buffer.byteLength(JSON.stringify(empty)) <= 8192);
    assert.match(empty.meta.instructions.text, /Keep empty checks quiet/);
  }
});

test("updates MCP replies fit their budgets at the maximum channel scope", async (t) => {
  const app = await start(t);
  const me = await app.register("WideWatch");
  const peer = await app.register("WideSender");
  const channelIds = [(await app.server()).generalConversationId];
  for (let index = 1; index < 32; index++) {
    const channel = await app.call("POST", `${app.root}/channels`, {
      participantId: me.id,
      requestKey: randomUUID(),
      name: `Scope${index}`,
    });
    channelIds.push(channel.data.item.id);
  }
  const baseline = await app.mcp("get_updates", {
    serverId: app.bindings.TALKTO_SERVER_ID,
    participantId: me.id,
    mode: "start",
    channelIds,
    directChats: "own",
    startAt: "now",
    limit: 100,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(baseline)) <= 8192);
  const sent = [];
  for (let index = 0; index < 3; index++)
    sent.push(await app.send(channelIds[index], peer.id, "\u0001".repeat(16384)));
  let action = baseline.meta.nextActions[0];
  const received = [];
  for (let count = 0; ; count++) {
    assert.ok(count < 4);
    const batch = await app.mcp(action.tool, action.arguments);
    assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= 131072);
    received.push(...batch.data.messages);
    action = batch.meta.nextActions[0];
    if (batch.data.nextCursor === null) break;
  }
  assert.deepEqual(received, sent);
  const empty = await app.mcp(action.tool, action.arguments);
  assert.deepEqual(empty.data.messages, []);
  assert.ok(Buffer.byteLength(JSON.stringify(empty)) <= 8192);
});

test("a local deployment shares files through its file:// remote without tokens", async (t) => {
  const remote = "file:///tmp/talkto-local-files.git";
  const app = await start(t, { TALKTO_FILES_REMOTE: remote });
  const serverId = app.bindings.TALKTO_SERVER_ID;
  const catalog = await packet(
    await app.raw("/mcp", rpc("tools/list", {}, app.bindings.TALKTO_LOCAL_TOKEN)),
  );
  const names = catalog.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("get_files_access"));
  assert.ok(names.includes("share_file"));
  // Feedback goes to the hosted TalkTo team; a local deployment has no one to send it to.
  assert.ok(!names.includes("send_feedback"));
  const me = await app.register("LocalSharer");
  const context = await app.mcp("get_context", { serverId, participant: { id: me.id } });
  assert.deepEqual(context.data.capabilities, ["files"]);
  const access = await app.mcp("get_files_access", {
    serverId,
    participantId: me.id,
    scope: "write",
  });
  assert.deepEqual(access.data, {
    remote,
    token: null,
    expiresAt: null,
    defaultBranch: "main",
    procedure: [
      `git clone ${remote} talkto-files`,
      "cp <your file> talkto-files/<path>",
      'git -C talkto-files add -A && git -C talkto-files commit -m "<why this file exists>"',
      "git -C talkto-files push origin main",
    ].join("\n"),
  });
  const general = (await app.server()).generalConversationId;
  const commit = "a04d9e7b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f";
  const shared = await app.mcp("share_file", {
    serverId,
    participantId: me.id,
    target: { kind: "conversation", conversationId: general },
    requestKey: randomUUID(),
    path: "ops/runbooks/logout.md",
    commit,
    body: "Corrected WorkOS logout runbook after the provider gap.",
  });
  assert.deepEqual(shared.data.item.share, { path: "ops/runbooks/logout.md", commit, ref: "main" });
  assert.deepEqual((await app.history(general)).items, [shared.data.item]);
  assert.deepEqual((await app.call("GET", `${app.root}/files/shares`)).data, {
    items: [shared.data.item],
    nextCursor: null,
  });
  await app.restart();
  assert.deepEqual((await app.history(general)).items, [shared.data.item]);
});

test("without a local remote the file tools and capability are absent", async (t) => {
  const app = await start(t);
  const catalog = await packet(
    await app.raw("/mcp", rpc("tools/list", {}, app.bindings.TALKTO_LOCAL_TOKEN)),
  );
  assert.ok(!catalog.result.tools.some((tool) => tool.name === "share_file"));
  const context = await app.mcp("get_context", { serverId: app.bindings.TALKTO_SERVER_ID });
  assert.deepEqual(context.data.capabilities, []);
  assert.deepEqual((await app.call("GET", `${app.root}/files/shares`)).data, {
    items: [],
    nextCursor: null,
  });
});

test("urgent priority is stored beside direct messages, unlimited, and visible to every reader", async (t) => {
  const app = await start(t);
  const a = await app.register("Urgent"),
    b = await app.register("Receiver");
  const general = (await app.server()).generalConversationId;
  const direct = (
    await app.call("POST", `${app.root}/direct-chats`, { participantId: a.id, recipientId: b.id })
  ).data.item;
  const post = (conversation, fields, status = 200) =>
    app.call(
      "POST",
      `${app.root}/conversations/${conversation}/messages`,
      { participantId: a.id, requestKey: randomUUID(), ...fields },
      status,
    );

  const channel = await post(general, { body: "everyone stop", priority: "urgent" }, 400);
  assert.equal(channel.error.code, "wrong_conversation_kind");
  const normal = (await post(general, { body: "plain", priority: "normal" })).data.item;
  assert.equal("priority" in normal, false);

  const key = randomUUID();
  const urgent = (
    await post(direct.id, { body: "stop the deploy", priority: "urgent", requestKey: key })
  ).data;
  assert.equal(urgent.item.priority, "urgent");
  const retried = (
    await post(direct.id, { body: "stop the deploy", priority: "urgent", requestKey: key })
  ).data;
  assert.equal(retried.created, false);
  assert.equal(retried.item.id, urgent.item.id);
  const changed = await post(direct.id, { body: "stop the deploy", requestKey: key }, 409);
  assert.equal(changed.error.code, "idempotency_conflict");

  const viaMcp = await app.mcp("send_message", {
    serverId: app.bindings.TALKTO_SERVER_ID,
    participantId: a.id,
    requestKey: randomUUID(),
    body: "and roll back",
    priority: "urgent",
    target: { kind: "direct", recipientId: b.id },
  });
  assert.equal(viaMcp.data.item.priority, "urgent");

  const feed = await app.updates({
    participantId: b.id,
    mode: "start",
    channelIds: [general],
    directChats: "own",
    startAt: "beginning",
  });
  assert.deepEqual(
    feed.data.messages.map((message) => [message.body, message.priority ?? "normal"]),
    [
      ["plain", "normal"],
      ["stop the deploy", "urgent"],
      ["and roll back", "urgent"],
    ],
  );

  // Urgent has no rate limit: a burst well past any former allowance still sends.
  for (let sent = 2; sent < 12; sent += 1)
    await post(direct.id, { body: `urgent ${sent}`, priority: "urgent" });
  const after = (await post(direct.id, { body: "normal still sends" })).data.item;
  assert.equal("priority" in after, false);
  const fromReceiver = (
    await app.call("POST", `${app.root}/conversations/${direct.id}/messages`, {
      participantId: b.id,
      requestKey: randomUUID(),
      body: "my own allowance",
      priority: "urgent",
    })
  ).data.item;
  assert.equal(fromReceiver.priority, "urgent");

  await app.restart();
  const history = await app.history(direct.id, { limit: 100 });
  assert.equal(history.items.filter((message) => message.priority === "urgent").length, 13);
  assert.equal(
    history.items.find((message) => message.body === "normal still sends").priority,
    undefined,
  );
});

test("get_updates waits for a matching message, ends at its deadline, and never outlives access", async (t) => {
  const app = await start(t);
  const a = await app.register("Waker"),
    b = await app.register("Waiter");
  const general = (await app.server()).generalConversationId;
  const side = (
    await app.call("POST", `${app.root}/channels`, {
      participantId: a.id,
      name: "side",
      requestKey: randomUUID(),
    })
  ).data.item;
  const direct = (
    await app.call("POST", `${app.root}/direct-chats`, { participantId: a.id, recipientId: b.id })
  ).data.item;
  const pause = (millis) => new Promise((resolve) => setTimeout(resolve, millis));
  const timed = async (work) => {
    const begun = Date.now();
    const result = await work;
    return { result, millis: Date.now() - begun };
  };
  const watched = { participantId: b.id, channelIds: [general], directChats: "own" };
  const head = (await app.updates({ ...watched, mode: "start", startAt: "now" })).data.checkpoint;

  // Bounds: 0 answers at once, the maximum is 20 seconds.
  const invalid = await app.updates(
    { participantId: b.id, mode: "poll", checkpoint: head, waitSeconds: 21 },
    400,
  );
  assert.equal(invalid.error.code, "invalid_input");
  const immediate = await timed(
    app.updates({ participantId: b.id, mode: "poll", checkpoint: head, waitSeconds: 0 }),
  );
  assert.equal(immediate.result.data.messages.length, 0);
  assert.ok(immediate.millis < 1000, `${immediate.millis}`);

  // Unselected channels and the reader's own sends do not end a wait; the deadline does.
  const quiet = timed(
    app.updates({ participantId: b.id, mode: "poll", checkpoint: head, waitSeconds: 2 }),
  );
  await pause(300);
  await app.send(side.id, a.id, "elsewhere");
  await app.send(general, b.id, "talking to myself");
  const expired = await quiet;
  assert.deepEqual(expired.result.data.messages, []);
  assert.equal(expired.result.data.nextCursor, null);
  assert.ok(expired.millis >= 1900, `${expired.millis}`);
  assert.ok(expired.millis < 6000, `${expired.millis}`);

  // A wait is a hibernatable watch the Worker holds, not a request the server object runs: the
  // object keeps one socket for it and nothing once the wait answers.
  const watching = async () => (await (await app.raw("/__control/watching")).json()).open;
  const settled = async (expected) => {
    for (let attempt = 0; attempt < 40 && (await watching()) !== expected; attempt++)
      await pause(50);
    return watching();
  };
  assert.equal(await settled(0), 0);

  // A direct message ends the wait as soon as it commits, over HTTP.
  const checkpoint = expired.result.data.checkpoint;
  const waiting = timed(
    app.updates({ participantId: b.id, mode: "poll", checkpoint, waitSeconds: 20 }),
  );
  await pause(500);
  assert.equal(await watching(), 1);
  const sent = await app.send(direct.id, a.id, "look now");
  const woken = await waiting;
  assert.deepEqual(
    woken.result.data.messages.map((message) => message.id),
    [sent.id],
  );
  assert.ok(woken.millis < 5000, `${woken.millis}`);
  assert.equal(await settled(0), 0);

  // Over MCP, a wait that starts at now keeps what arrives during the wait.
  const serverId = app.bindings.TALKTO_SERVER_ID;
  const viaMcp = timed(
    app.mcp("get_updates", {
      serverId,
      ...watched,
      mode: "start",
      startAt: "now",
      waitSeconds: 20,
    }),
  );
  await pause(500);
  const channelMessage = await app.send(general, a.id, "standup in five");
  const mcpWoken = await viaMcp;
  assert.deepEqual(
    mcpWoken.result.data.messages.map((message) => message.id),
    [channelMessage.id],
  );
  assert.ok(mcpWoken.millis < 5000, `${mcpWoken.millis}`);

  // A reader holds at most two waits; a third ends the oldest at once with an empty page.
  const latest = mcpWoken.result.data.checkpoint;
  const poll = (status) =>
    timed(
      app.updates(
        { participantId: b.id, mode: "poll", checkpoint: latest, waitSeconds: 20 },
        status,
      ),
    );
  const first = poll(200);
  await pause(300);
  const second = poll(404);
  await pause(300);
  const third = poll(404);
  const displaced = await first;
  assert.deepEqual(displaced.result.data.messages, []);
  assert.ok(displaced.millis < 5000, `${displaced.millis}`);
  assert.equal(await settled(2), 2);

  // An access change for someone else wakes every wait; one that finds nothing new waits again,
  // and the wake ends instead of re-waking the fresh wait forever.
  await pause(300);
  const recheck = timed(app.raw("/__control/recheck").then((response) => response.json()));
  const rechecked = await recheck;
  assert.deepEqual(rechecked.result, { ok: true });
  assert.ok(rechecked.millis < 5000, `${rechecked.millis}`);

  // Revoking access ends the remaining waits instead of holding them to the deadline.
  await pause(300);
  assert.deepEqual(await (await app.raw("/__control/revoke")).json(), { ok: true });
  for (const pending of [second, third]) {
    const ended = await pending;
    assert.equal(ended.result.error.code, "server_unavailable");
    assert.ok(ended.millis < 5000, `${ended.millis}`);
  }
  assert.equal(await settled(0), 0);
});
