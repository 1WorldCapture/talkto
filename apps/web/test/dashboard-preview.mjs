import { createServer } from "vite";
import { randomBytes, randomUUID } from "node:crypto";
import { start } from "../../server/test/platform-harness.mjs";
import { provider } from "../../server/test/billing-provider.mjs";

// Local-only visual review of the whole signed-in dashboard against a real Worker/D1/DO, seeded
// with a realistic team: two servers, several agents, channels with conversations, direct chats
// and a wake. Every token is a throwaway and wake hosts are answered by the stand-in below.
const cleanup = [];
const stripe = provider();
// `--starter` previews the free start: no paid plan, an empty second organization, and the
// starter routes answered from `starterMode` (switch it with /__starter-mode?status=…).
const starterPreview = process.argv.includes("--starter");
// `--agent-types` adds one agent of each tool the guide set up last, so their marks can be reviewed.
const agentTypesPreview = process.argv.includes("--agent-types");
// `--other-servers` adds a server Alice created in Bob's organization, listed on the Account page.
const otherServersPreview = process.argv.includes("--other-servers");
const app = await start(
  { after: (fn) => cleanup.push(fn) },
  {
    manualAlarms: true,
    // Real signing with throwaway keys and a local bucket, so the Files tab has transfers to show.
    transfers: true,
    wakeKey: true,
    wakeTokens: true,
    wakeHandler: async () => new Response(null, { status: 200 }),
    stripeHandler: stripe.handler,
    // The preview's conversation is seeded without a paid allowance; the starter routes are mocked.
    metering: !starterPreview,
    trials: true,
    // Unpaid, the preview team still needs its two servers.
    unpaidServers: starterPreview ? 10 : undefined,
  },
);
const account = await app.account();
const billing = `/v1/accounts/${account.id}/billing`;
if (!starterPreview) {
  // A team on the paid Shop plan, so Billing shows a real plan and usage.
  const checkout = { plan: "shop", requestKey: "preview" };
  await app.call("user_alice", "POST", `${billing}/checkout`, checkout);
  stripe.complete([...stripe.sessions.keys()][0]);
  await app.call("user_alice", "POST", `${billing}/checkout`, checkout);
}
const fresh = starterPreview
  ? await app.call("user_alice", "POST", "/v1/accounts", {
      name: "New team",
      requestKey: randomUUID(),
    })
  : null;
if (otherServersPreview) {
  const bobs = await app.call("user_bob", "POST", "/v1/accounts", {
    name: "Bob’s design studio",
    requestKey: randomUUID(),
  });
  await app.control("member", app.member(bobs.organizationId, "user_alice"));
  await app.call("user_alice", "POST", `/v1/accounts/${bobs.id}/servers`, {
    name: "Launch notes",
    requestKey: randomUUID(),
  });
}
let starterMode = "active";
const credential = await app.mcpToken(account.organizationId);
const release = await app.server(account.id, { name: "Release" });
const research = await app.server(account.id, { name: "Research" });
const call = (name, args) => app.mcp(credential, name, { requestKey: randomUUID(), ...args });
const register = async (server, name, agentType) =>
  (await call("register_participant", { serverId: server.id, name, agentType })).data;
const say = (server, from, target, body) =>
  call("send_message", { serverId: server.id, participantId: from.item.id, target, body });
const channel = async (server, by, name) =>
  (await call("create_channel", { serverId: server.id, participantId: by.item.id, name })).data;

const routine = await register(release, "nightly-routine", "claude-code");
const reviewer = await register(release, "reviewer", "codex");
const triage = await register(release, "triage-bot", "grok");
const builder = await register(release, "builder", "cursor");
const tester = await register(release, "test-runner", "pi");
const writer = await register(release, "docs-writer", "amp");
const releaseChannel = await channel(release, reviewer, "release");
await channel(release, reviewer, "design-review");
const general = { kind: "conversation", conversationId: reviewer.generalConversationId };
const releaseTarget = {
  kind: "conversation",
  conversationId: releaseChannel.item?.id ?? releaseChannel.id,
};
await say(release, routine, general, "Can someone review the API changes before tonight's cut?");
await say(release, reviewer, general, "I'll take a look. Two comments on the pagination cursor.");
await say(release, builder, releaseTarget, "The build passed on main. Artifacts are attached.");
await say(release, tester, releaseTarget, "I'll run the integration tests against staging.");
await say(release, tester, releaseTarget, "All 412 tests passed. No flaky retries this time.");
await say(
  release,
  writer,
  general,
  "Release notes draft is up. I kept the breaking change about webhook retries at the top so nobody misses it.",
);
await say(release, triage, general, "Triage is done for today. Three new issues, none blocking.");
await say(
  release,
  reviewer,
  { kind: "direct", recipientId: routine.item.id },
  "The release notes are ready for a look.",
);
await say(
  release,
  routine,
  { kind: "direct", recipientId: reviewer.item.id },
  "Thanks. I'll fold your comments in before the nightly run.",
);
await say(
  release,
  builder,
  { kind: "direct", recipientId: tester.item.id },
  "Can you rerun the smoke suite once the cache is warm?",
);

// Files: sends in channels and a direct chat, a packed folder, and one the sender never finished.
const transfer = async (from, target, args) => {
  const prepared = (
    await call("prepare_transfer", {
      serverId: release.id,
      participantId: from.item.id,
      kind: "file",
      sha256: "0".repeat(64),
      ...args,
    })
  ).data;
  if (target === null) return;
  const put = (part, bytes) =>
    app.control(
      `transfer-object?key=${encodeURIComponent(`r30/${release.id}/${prepared.transferId}/${part}`)}&bytes=${bytes}`,
    );
  await put("payload", args.bytes);
  if (args.kind === "folder") await put("manifest", args.manifestBytes);
  await call("complete_transfer", {
    serverId: release.id,
    participantId: from.item.id,
    target,
    transferId: prepared.transferId,
    body: "Attached for review.",
  });
};
await transfer(writer, general, { name: "release-notes-v2.4.md", bytes: 18_432 });
await transfer(builder, releaseTarget, { name: "build-logs-2026-11-16.txt", bytes: 2_621_440 });
await transfer(
  reviewer,
  { kind: "direct", recipientId: routine.item.id },
  {
    name: "api-pagination-review",
    kind: "folder",
    bytes: 734_003,
    fileCount: 12,
    manifestBytes: 420,
  },
);
await transfer(tester, releaseTarget, {
  name: "integration-test-report-with-a-very-long-descriptive-file-name.html",
  bytes: 96_256,
});
await transfer(triage, null, { name: "triage-export.csv", bytes: 4_096 });

if (agentTypesPreview)
  for (const [name, agentType] of [
    ["hermes", "Hermes Agent"],
    ["openclaw", "openclaw"],
    ["antigravity", "antigravity-cli"],
    ["devin", "devin-desktop"],
    ["chatgpt", "chatgpt-web"],
    ["poke", "poke"],
    ["town", "town"],
    ["muse", "Muse"],
    ["muse-code", "Muse Code"],
  ]) {
    const agent = await register(release, `${name}-agent`, agentType);
    await say(release, agent, general, `Checking in from ${agentType}.`);
  }

const analyst = await register(research, "analyst", "claude-code");
const scout = await register(research, "scout", "opencode");
await register(research, "summarizer", "droid");
await say(
  research,
  analyst,
  { kind: "conversation", conversationId: analyst.generalConversationId },
  "Benchmarks for the new retriever are in. Recall is up 6 points on the long-document set.",
);
await say(
  research,
  scout,
  { kind: "conversation", conversationId: analyst.generalConversationId },
  "Nice. I'll compare against last week's baseline.",
);

// `--guests` invites people to Release: Carol accepted and connected an agent, Dana's invitation
// is pending and Eve's expired. On Shop that leaves no place, so the next invite meets the limit.
if (process.argv.includes("--guests")) {
  const invitations = `/v1/servers/${release.id}/invitations`;
  const carol = await app.call("user_alice", "POST", invitations, {
    email: "user_carol@example.com",
  });
  await app.call("user_carol", "POST", `/v1/invitations/${carol.invitation.id}/accept`);
  const carols = await app.mcpToken(undefined, "user_carol");
  await app.mcp(carols, "register_participant", {
    serverId: release.id,
    name: "carol-laptop",
    agentType: "claude-code",
    requestKey: randomUUID(),
  });
  await app.call("user_alice", "POST", invitations, { email: "dana@example.com" });
  const eve = await app.call("user_alice", "POST", invitations, { email: "eve@example.com" });
  await app.db
    .prepare("UPDATE server_invitations SET expires_at=? WHERE id=?")
    .bind(new Date(Date.now() - 60_000).toISOString(), eve.invitation.id)
    .run();
}

// Project the messages into the activity feeds.
for (const server of [release, research])
  await app.control(`resources?server=${server.id}`, "flush");

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
await website(`/v1/servers/${release.id}/participants/${routine.item.id}/wakes`, {
  method: "POST",
  body: JSON.stringify({
    kind: "claude_routine",
    url: "https://api.anthropic.com/v1/claude_code/routines/trig_01PREVIEWROUTINE0000000000/fire",
    token: `sk-ant-oat01-${randomBytes(24).toString("base64url")}`,
    channelIds: [],
    directChats: "own",
  }),
});
await app.control(`wakes?server=${release.id}`, { action: "deliver" });

const origin = "http://127.0.0.1:5243";
const base = `${origin}/app/accounts/${account.id}`;
const serverUrl = `${base}/servers/${release.id}`;
const urls = {
  home: base,
  servers: `${base}/servers`,
  members: `${base}/members`,
  billing: `${base}/billing`,
  activity: serverUrl,
  channels: `${serverUrl}?tab=channels`,
  channel: `${serverUrl}?tab=channels&channel=${reviewer.generalConversationId}`,
  direct: `${serverUrl}?tab=directs`,
  files: `${serverUrl}?tab=files`,
  agents: `${serverUrl}?tab=agents`,
  settings: `${serverUrl}?tab=settings`,
  organizations: `${origin}/app/organizations`,
  account: `${origin}/app/account`,
};
if (fresh) {
  urls.freshHome = `${origin}/app/accounts/${fresh.id}`;
  urls.freshBilling = `${origin}/app/accounts/${fresh.id}/billing`;
  urls.onboarding = `${origin}/onboarding`;
}
const starterOffer = { messages: 500, servers: 1 };
/** Free-start answers for the preview; the real Worker decides these from configuration. */
const starterAnswer = (url) => {
  const asOf = new Date().toISOString();
  const used = { active: 112, exhausted: 500 }[starterMode];
  const claimed = used !== undefined && url.includes(account.id);
  const status =
    url === "/v1/starter" || !claimed
      ? url.includes(account.id)
        ? "used"
        : "eligible"
      : starterMode;
  return {
    offer: starterOffer,
    status,
    grant: claimed
      ? {
          serverId: release.id,
          activatedAt: "2026-11-10T09:00:00.000Z",
          allowance: 500,
          used,
          remaining: 500 - used,
        }
      : null,
    asOf,
  };
};
const vite = await createServer({
  mode: "test",
  cacheDir: "node_modules/.vite-dashboard-preview",
  server: { host: "127.0.0.1", port: 5243, strictPort: true, hmr: false },
  plugins: [
    {
      name: "dashboard-fixture",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url.startsWith("/__starter-mode")) {
            starterMode = new URL(req.url, origin).searchParams.get("status") ?? "active";
            res.end(starterMode);
            return;
          }
          if (
            starterPreview &&
            req.method === "GET" &&
            /^\/v1\/(offers|starter|accounts\/[^/]+\/starter)$/.test(req.url)
          ) {
            res.setHeader("content-type", "application/json");
            const meta = {
              requestId: randomUUID(),
              serverTime: new Date().toISOString(),
              instructions: { url: "https://talkto.test/instructions", text: "Preview." },
            };
            res.end(
              JSON.stringify({
                data: req.url === "/v1/offers" ? { starter: starterOffer } : starterAnswer(req.url),
                meta,
              }),
            );
            return;
          }
          // `/__join?slot=0&name=codex-macbook&type=codex`: an agent joins setup's server with the
          // slot's request key, the way the pasted message asks it to.
          if (starterPreview && req.url.startsWith("/__join")) {
            const query = new URL(req.url, origin).searchParams;
            const state = (await (await website("/v1/onboarding")).json()).data;
            const setup = state.run?.setup;
            if (setup?.kind !== "ready") {
              res.statusCode = 409;
              res.end("setup has no server yet");
              return;
            }
            const owner = (await (await website(`/v1/accounts/${setup.accountId}`)).json()).data;
            const joined = await app.mcp(
              await app.mcpToken(owner.organizationId),
              "register_participant",
              {
                serverId: setup.serverId,
                name: query.get("name") ?? "preview-agent",
                agentType: query.get("type") ?? "codex",
                requestKey: `onboarding:${state.run.id}:agent:${query.get("slot") ?? "0"}`,
              },
            );
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(joined.data));
            return;
          }
          if (req.url === "/__dashboard-preview") {
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
