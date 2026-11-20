import { createServer } from "vite";
import { randomUUID } from "node:crypto";
import { start } from "../../server/test/platform-harness.mjs";

// Local-only visual review of the invited person's side (join.tsx, shared.tsx) against a real
// Worker/D1/DO: alice invites carol, who has no organization, and the dashboard runs signed in as
// carol. `/__signed-out?on=1` drops carol's cookie to show the sign-in gate. `/__arrive` registers
// carol's agent on launch-room and, beside it, one of alice's that the join page leaves out.
// Every token is a throwaway. Run `pnpm --filter @talkto/server build` first, then `node test/join-preview.mjs`.
const cleanup = [];
const app = await start({ after: (fn) => cleanup.push(fn) }, { manualAlarms: true });
const account = await app.account();
const room = await app.server(account.id, { name: "launch-room" });
const research = await app.server(account.id, { name: "research", requestKey: randomUUID() });
const credential = await app.mcpToken(account.organizationId);
for (const [name, agentType] of [
  ["release-captain", "claude-code"],
  ["reviewer", "codex"],
])
  await app.mcp(credential, "register_participant", {
    requestKey: randomUUID(),
    serverId: room.id,
    name,
    agentType,
  });
const invite = (server, email) =>
  app.call("user_alice", "POST", `/v1/servers/${server.id}/invitations`, { email });
const joining = await invite(room, "user_carol@example.com");
const elsewhere = await invite(room, "user_dave@example.com");
const canceled = await invite(research, "user_erin@example.com");
await app.call(
  "user_alice",
  "DELETE",
  `/v1/servers/${research.id}/invitations/${canceled.invitation.id}`,
);
const archive = await app.server(account.id, { name: "archive", requestKey: randomUUID() });
const withdrawn = await invite(archive, "user_carol@example.com");
await app.call(
  "user_alice",
  "DELETE",
  `/v1/servers/${archive.id}/invitations/${withdrawn.invitation.id}`,
);
// A second invitation waits under "Shared with you".
await invite(research, "user_carol@example.com");

const flow = await app.browserLogin("user_carol", "120m");
const cookie = (await flow.callback()).headers
  .getSetCookie()
  .find((value) => value.startsWith("__Host-talkto-session="))
  .split(";")[0];
let signedOut = false;
const website = (path, init = {}) => {
  const headers = { origin: "https://talkto.test", "content-type": "application/json" };
  if (!signedOut) headers.cookie = cookie;
  return app.raw(path, { ...init, headers: { ...headers, ...init.headers } });
};

const origin = "http://127.0.0.1:5244";
const urls = {
  join: `${origin}/app/join/${joining.invitation.id}`,
  mismatch: `${origin}/app/join/${elsewhere.invitation.id}`,
  canceled: `${origin}/app/join/${withdrawn.invitation.id}`,
  incomplete: `${origin}/app/join/sinv_short`,
  entry: `${origin}/app`,
  organizations: `${origin}/app/organizations`,
  shared: `${origin}/app/shared/${room.id}`,
  signedOut: `${origin}/__signed-out?on=1`,
  signedIn: `${origin}/__signed-out?on=0`,
  arrive: `${origin}/__arrive`,
};
const vite = await createServer({
  mode: "test",
  cacheDir: "node_modules/.vite-join-preview",
  server: { host: "127.0.0.1", port: 5244, strictPort: true, hmr: false },
  plugins: [
    {
      name: "join-fixture",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url.startsWith("/__signed-out")) {
            signedOut = new URL(req.url, origin).searchParams.get("on") === "1";
            res.end(signedOut ? "signed out" : "signed in");
            return;
          }
          if (req.url.startsWith("/__arrive")) {
            const carols = await app.mcpToken(undefined, "user_carol");
            for (const [token, name, agentType] of [
              [carols, "carol-laptop", "claude-code"],
              [credential, "nightly-builder", "codex"],
            ])
              await app.mcp(token, "register_participant", {
                requestKey: randomUUID(),
                serverId: room.id,
                name,
                agentType,
              });
            res.end("arrived");
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
