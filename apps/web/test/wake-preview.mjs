import { createServer } from "vite";
import { randomBytes, randomUUID } from "node:crypto";
import { start } from "../../server/test/platform-harness.mjs";

// Local-only UI verification of the Auto-start dialog against a real Worker/D1/DO. Wake hosts are
// answered by the stand-in below; no real Anthropic, xAI or Town endpoint is ever called, and every
// token is a throwaway. The proxy signs in through the website path, so adding a wake works as it
// does on the deployed dashboard. Pass `--tokens=off` to see the switch turned off.
const cleanup = [];
const tokensOff = process.argv.includes("--tokens=off");
const host = { status: 200 };
const app = await start(
  { after: (fn) => cleanup.push(fn) },
  {
    manualAlarms: true,
    wakeKey: true,
    wakeTokens: !tokensOff,
    wakeHandler: async () => new Response(null, { status: host.status }),
  },
);
const account = await app.account();
const credential = await app.mcpToken(account.organizationId);
const server = await app.server(account.id, { name: "Release" });
const register = async (name, agentType) =>
  (
    await app.mcp(credential, "register_participant", {
      serverId: server.id,
      name,
      agentType,
      requestKey: randomUUID(),
    })
  ).data;
const routine = await register("nightly-routine", "claude-code");
const fresh = await register("triage-bot", "grok");
const reviewer = await register("reviewer", "codex");
for (const name of ["release", "design-review"])
  await app.mcp(credential, "create_channel", {
    serverId: server.id,
    participantId: reviewer.item.id,
    name,
    requestKey: randomUUID(),
  });
const flow = await app.browserLogin("user_alice", "60m");
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
if (!tokensOff) {
  // nightly-routine already has a wake that has fired once.
  await website(`/v1/servers/${server.id}/participants/${routine.item.id}/wakes`, {
    method: "POST",
    body: JSON.stringify({
      kind: "claude_routine",
      url: "https://api.anthropic.com/v1/claude_code/routines/trig_01PREVIEWROUTINE0000000000/fire",
      token: `sk-ant-oat01-${randomBytes(24).toString("base64url")}`,
      channelIds: [],
      directChats: "own",
    }),
  });
  await app.mcp(credential, "send_message", {
    serverId: server.id,
    participantId: reviewer.item.id,
    requestKey: randomUUID(),
    target: { kind: "direct", recipientId: routine.item.id },
    body: "The release notes are ready for a look.",
  });
  await app.control(`wakes?server=${server.id}`, { action: "deliver" });
  // reviewer's Town wake was turned off when the host refused its secret.
  await website(`/v1/servers/${server.id}/participants/${reviewer.item.id}/wakes`, {
    method: "POST",
    body: JSON.stringify({
      kind: "town",
      url: "https://api.town.com/workflow-webhooks/whk_preview",
      token: `whsec_${randomBytes(24).toString("base64url")}`,
      channelIds: [reviewer.generalConversationId],
      directChats: "none",
    }),
  });
  host.status = 401;
  await app.mcp(credential, "send_message", {
    serverId: server.id,
    participantId: fresh.item.id,
    requestKey: randomUUID(),
    target: { kind: "conversation", conversationId: reviewer.generalConversationId },
    body: "Triage is done for today.",
  });
  await app.control(`wakes?server=${server.id}`, { action: "deliver" });
  host.status = 200;
}
// The person chose slower wakes for two agents; nightly-routine keeps the default.
for (const [agent, cadence] of [
  [fresh, "every_15_minutes"],
  [reviewer, "every_5_minutes"],
])
  await website(`/v1/servers/${server.id}/participants/${agent.item.id}/wake-cadence`, {
    method: "PUT",
    body: JSON.stringify({ cadence }),
  });
const origin = "http://127.0.0.1:5241";
const urls = {
  agents: `${origin}/app/accounts/${account.id}/servers/${server.id}?tab=agents`,
  routine: routine.item.id,
  fresh: fresh.item.id,
};
const vite = await createServer({
  mode: "test",
  cacheDir: "node_modules/.vite-wake-preview",
  server: { host: "127.0.0.1", port: 5241, strictPort: true, hmr: false },
  plugins: [
    {
      name: "wake-fixture",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url === "/__wake-preview") {
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
