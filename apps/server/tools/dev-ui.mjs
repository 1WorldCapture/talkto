import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { start } from "../test/platform-harness.mjs";

// Test-only composition: real Worker, D1, Durable Objects, JWT and sealed sessions;
// the external WorkOS provider is controlled. No production credentials are used.
const cleanup = [];
// Auto-start is on, so the connect walkthrough shows its wake steps as production does.
const app = await start(
  {
    after(fn) {
      cleanup.push(fn);
    },
  },
  { wakeKey: true, wakeTokens: true },
);
const account = await app.call("user_alice", "POST", "/v1/accounts", {
  name: "Product studio",
  requestKey: randomUUID(),
});
await app.control("member", app.member(account.organizationId));
const servers = [];
for (const [index, name] of [
  "Product studio",
  "Release planning",
  "Personal workspace",
].entries()) {
  const server = await app.server(account.id, { name });
  const root = `/v1/servers/${server.id}`;
  const participants = [];
  for (const [name, agentType] of [
    ["Cedar", "claude-code"],
    ["Atlas", "Codex"],
    ["platform-api-review-agent", "Codex"],
    ["Juniper", "claude-code"],
    ["Rowan", "Cursor"],
    ["Elm", "pi"],
  ].slice(0, 6 - index)) {
    const registration = await app.call("user_alice", "POST", `${root}/participants`, {
      name,
      agentType,
      requestKey: randomUUID(),
      workingDirectory: "/workspace/talkto",
      joinedNote: "Review implementation and coordinate through this server.",
    });
    participants.push(registration.item);
  }
  const general = (await app.call("user_alice", "GET", root)).generalConversationId;
  const build = await app.call("user_alice", "POST", `${root}/channels`, {
    participantId: participants[0].id,
    requestKey: randomUUID(),
    name: "Build",
  });
  const direct = await app.call("user_alice", "POST", `${root}/direct-chats`, {
    participantId: participants[0].id,
    recipientId: participants[1].id,
  });
  const destinations = [general, build.item.id, direct.item.id];
  for (let n = 0; n < 62 - index * 8; n++) {
    await app.call(
      "user_alice",
      "POST",
      `${root}/conversations/${destinations[n % destinations.length]}/messages`,
      {
        participantId: participants[n % (n % 3 === 2 ? 2 : participants.length)].id,
        requestKey: randomUUID(),
        body: `Review ${n + 1}: the API changes are ready to test.\nFull message details remain available here, including <script>untrusted text</script>.`,
      },
    );
  }
  if (index === 0) {
    for (let n = 0; n < 24; n++)
      await app.call("user_alice", "POST", `${root}/participants`, {
        name: `release-platform-engineering-review-agent-${n}`,
        agentType: n % 2 ? "codex" : "claude-code",
        requestKey: randomUUID(),
        joinedNote: "A long agent identity used to verify bounded directories.",
      });
    for (let n = 0; n < 21; n++)
      await app.call("user_alice", "POST", `${root}/channels`, {
        name: `release-planning-${n}`,
        participantId: participants[0].id,
        requestKey: randomUUID(),
      });
  }
  await app.control(`project?server=${server.id}`);
  servers.push({ ...server, participants, general });
}
for (let n = 0; n < 8; n++) await app.server(account.id, { name: `Additional server ${n + 1}` });
let dropCreate = false;
let offline = false;
let delayReads = 0;
const root = resolve("../web/dist");
const mime = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".html": "text/html",
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost:5174");
    if (url.pathname === "/__test/viewport") {
      res.setHeader("content-type", "text/html");
      res.end(
        '<!doctype html><html><body style="margin:0"><iframe title="Narrow TalkTo dashboard" style="width:390px;height:844px;border:0" src="/__test/login"></iframe><iframe title="Narrow TalkTo public page" style="width:390px;height:844px;border:0" src="/"></iframe></body></html>',
      );
      return;
    }
    if (url.pathname === "/__test/state") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ account, servers }));
      return;
    }
    if (url.pathname === "/__test/drop-create") {
      dropCreate = true;
      res.end("armed");
      return;
    }
    if (url.pathname === "/__test/offline") {
      offline = url.searchParams.get("value") === "true";
      res.end("set");
      return;
    }
    if (url.pathname === "/__test/delay") {
      delayReads = Number(url.searchParams.get("ms") ?? 0);
      res.end("set");
      return;
    }
    if (url.pathname === "/__test/message") {
      const target = servers[0];
      await app.call(
        "user_alice",
        "POST",
        `/v1/servers/${target.id}/conversations/${target.general}/messages`,
        {
          participantId: target.participants[0].id,
          requestKey: randomUUID(),
          body: url.searchParams.get("body") ?? "A new message arrived during inspection.",
        },
      );
      await app.control(`project?server=${target.id}`);
      res.end("sent");
      return;
    }
    if (url.pathname === "/__test/login" || url.pathname === "/auth/login") {
      const flow = await app.browserLogin(url.searchParams.get("user") ?? "user_alice", "30m");
      const callback = await flow.callback();
      res.writeHead(303, {
        location: `/app/accounts/${account.id}`,
        "set-cookie": callback.headers.getSetCookie(),
      });
      res.end();
      return;
    }
    if (
      url.pathname.startsWith("/v1/") ||
      url.pathname.startsWith("/auth/") ||
      url.pathname === "/instructions"
    ) {
      if (delayReads && req.method === "GET")
        await new Promise((done) => setTimeout(done, delayReads));
      if (offline) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { code: "storage_unavailable", message: "Temporary test outage." },
            meta: {
              requestId: randomUUID(),
              serverTime: new Date().toISOString(),
              instructions: { url: "https://talkto.test/instructions", text: "Test instructions" },
            },
          }),
        );
        return;
      }
      const bytes = [];
      for await (const chunk of req) bytes.push(chunk);
      const response = await app.raw(url.pathname + url.search, {
        method: req.method,
        headers: {
          cookie: req.headers.cookie ?? "",
          "content-type": "application/json",
          origin:
            req.headers.origin === "http://localhost:5174"
              ? "https://talkto.test"
              : (req.headers.origin ?? ""),
        },
        body: bytes.length ? Buffer.concat(bytes) : undefined,
        redirect: "manual",
      });
      if (dropCreate && req.method === "POST" && url.pathname.endsWith("/servers")) {
        dropCreate = false;
        res.writeHead(503, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: "storage_unavailable",
              message: "The server committed creation, but confirmation was interrupted.",
            },
            meta: {
              requestId: randomUUID(),
              serverTime: new Date().toISOString(),
              instructions: { url: "https://talkto.test/instructions", text: "Test instructions" },
            },
          }),
        );
        return;
      }
      const headers = Object.fromEntries(response.headers);
      delete headers["set-cookie"];
      if (url.pathname === "/auth/logout" && response.status === 303) headers.location = "/";
      res.writeHead(response.status, { ...headers, "set-cookie": response.headers.getSetCookie() });
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    const path = resolve(root, `.${url.pathname}`);
    if (!path.startsWith(`${root}/`) && path !== root) {
      res.writeHead(404);
      res.end();
      return;
    }
    const asset = extname(path) ? path : `${root}/index.html`;
    res.setHeader("content-type", mime[extname(asset)] ?? "application/octet-stream");
    res.end(await readFile(asset));
  } catch (error) {
    console.error(error);
    res.writeHead(500);
    res.end("Test fixture failed");
  }
});
server.listen(5174, "127.0.0.1", () =>
  console.log(`UI fixture: http://localhost:5174/__test/login\nAccount: ${account.id}`),
);
process.on("SIGINT", async () => {
  server.close();
  for (const dispose of cleanup) await dispose();
  process.exit(0);
});
