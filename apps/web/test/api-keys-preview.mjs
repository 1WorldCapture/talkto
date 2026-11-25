import { createServer } from "vite";
import { randomUUID } from "node:crypto";
import { start } from "../../server/test/platform-harness.mjs";

// Local-only preview of Account → API keys against a real Worker and D1. The proxy signs in
// through the website path, so making and revoking keys works as on the deployed dashboard.
const cleanup = [];
const app = await start({ after: (fn) => cleanup.push(fn) }, {});
const organization = (name) =>
  app.call("user_alice", "POST", "/v1/accounts", { name, requestKey: randomUUID() });
const acme = await organization("Acme");
await organization("Side projects");
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
for (const body of [
  { name: "Deploy script", access: "full", expiresInDays: 90 },
  { name: "Status board", access: "read", accountId: acme.id },
  { name: "Nightly export", access: "read", expiresInDays: 365 },
])
  await website("/v1/me/api-keys", { method: "POST", body: JSON.stringify(body) });
const origin = "http://127.0.0.1:5242";
const vite = await createServer({
  mode: "test",
  cacheDir: "node_modules/.vite-api-keys-preview",
  server: { host: "127.0.0.1", port: 5242, strictPort: true, hmr: false },
  plugins: [
    {
      name: "api-keys-fixture",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
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
console.log(`${origin}/app/account/api-keys`);
const close = async () => {
  await vite.close();
  for (const fn of cleanup) await fn();
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
