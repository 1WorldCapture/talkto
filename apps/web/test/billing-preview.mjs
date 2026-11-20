import { createServer } from "vite";
import { randomUUID } from "node:crypto";
import { start } from "../../server/test/platform-harness.mjs";
import { provider } from "../../server/test/billing-provider.mjs";

// Local-only UI verification against real Worker/D1/DO and controlled Stripe.
// No production credentials, payment methods, or network services are used.
const cleanup = [];
const stripe = provider();
const app = await start(
  { after: (fn) => cleanup.push(fn) },
  { stripeHandler: stripe.handler, metering: true, trials: true },
);
const account = await app.account();
const path = `/v1/accounts/${account.id}/billing`;
const input = { plan: "shop", requestKey: "preview", offer: "trial" };
await app.call("user_alice", "POST", `${path}/checkout`, input);
stripe.complete([...stripe.sessions.keys()][0]);
await app.call("user_alice", "POST", `${path}/checkout`, input);
const fresh = await app.account();
const paid = await app.account();
const paidPath = `/v1/accounts/${paid.id}/billing`;
const paidInput = { plan: "shop", requestKey: "preview-paid" };
await app.call("user_alice", "POST", `${paidPath}/checkout`, paidInput);
stripe.complete([...stripe.sessions.keys()].at(-1));
await app.call("user_alice", "POST", `${paidPath}/checkout`, paidInput);
const pending = await app.account();
await app.call("user_alice", "POST", `/v1/accounts/${pending.id}/billing/checkout`, {
  plan: "shop",
  requestKey: "preview-cancel-checkout",
});
const origin = "http://127.0.0.1:5239";
const urls = Object.fromEntries(
  Object.entries({ trial: account, fresh, paid, pending }).map(([name, value]) => [
    name,
    `${origin}/app/accounts/${value.id}/billing`,
  ]),
);
const requests = [];
let responseMode = "normal";
let release;
let exhausted = false;
const vite = await createServer({
  mode: "test",
  cacheDir: "node_modules/.vite-billing-preview",
  server: { host: "127.0.0.1", port: 5239, strictPort: true, hmr: false },
  plugins: [
    {
      name: "billing-fixture",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url === "/__billing-test") {
            if (req.method === "POST") {
              const chunks = [];
              for await (const chunk of req) chunks.push(chunk);
              const command = JSON.parse(Buffer.concat(chunks).toString());
              if (command.mode) responseMode = command.mode;
              if (command.release) release?.();
              if (command.exhaust && !exhausted) {
                const talktoServer = await app.server(account.id);
                const credential = await app.mcpToken(account.organizationId);
                const registered = await app.mcp(credential, "register_participant", {
                  serverId: talktoServer.id,
                  name: "browser-trial",
                  agentType: "codex-desktop",
                  requestKey: randomUUID(),
                });
                for (let i = 0; i < 500; i++)
                  await app.mcp(credential, "send_message", {
                    serverId: talktoServer.id,
                    participantId: registered.data.item.id,
                    target: {
                      kind: "conversation",
                      conversationId: registered.data.generalConversationId,
                    },
                    body: "Local browser trial verification",
                    requestKey: randomUUID(),
                  });
                await app.control(`meter/report?server=${talktoServer.id}`);
                exhausted = true;
              }
            }
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ urls, requests, responseMode, exhausted }));
            return;
          }
          if (!req.url.startsWith("/v1/")) return next();
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const bytes = chunks.length ? Buffer.concat(chunks) : undefined;
          const mutation =
            req.method === "POST" &&
            /\/billing\/(renewal|trial\/convert|checkout\/cancel)$/.test(req.url);
          if (mutation) requests.push({ path: req.url, input: JSON.parse(bytes.toString()) });
          const mode = mutation ? responseMode : "normal";
          if (mutation && mode !== "pending") responseMode = "normal";
          if (mutation && mode === "pending") {
            const state = await app.raw(req.url.replace(/\/(renewal|trial\/convert)$/, ""), {
              headers: { authorization: `Bearer ${await app.token()}` },
            });
            const value = await state.json();
            value.data = { confirmed: false };
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(value));
            return;
          }
          const response = await app.raw(req.url, {
            method: req.method,
            headers: {
              authorization: `Bearer ${await app.token(mode === "denied" ? "user_bob" : "user_alice")}`,
              "content-type": "application/json",
            },
            body: bytes,
          });
          if (mode === "lost") {
            await response.arrayBuffer();
            // A truncated committed reply is deterministic even when Chrome retries a closed socket.
            res.writeHead(200, { "content-type": "application/json" });
            res.end("{");
            return;
          }
          if (mode === "hold")
            await new Promise((resolve) => {
              release = resolve;
            });
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
        });
      },
    },
  ],
});
await vite.listen();
console.log(JSON.stringify({ ...urls, controls: `${origin}/__billing-test` }));
const close = async () => {
  await vite.close();
  for (const fn of cleanup) await fn();
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
