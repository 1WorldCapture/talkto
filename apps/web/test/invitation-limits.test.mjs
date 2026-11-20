import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer as createVite } from "vite";
import { start } from "../../server/test/platform-harness.mjs";
import { words } from "./copy-rules.mjs";

test("a refused invitation shows when it can be tried again, plainly and in local time", async (t) => {
  const app = await start(t, { invitations: "defaults" });
  const account = await app.account();
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { createApi, request, ApiError } = await vite.ssrLoadModule("/src/api.ts");
  const { Notice } = await vite.ssrLoadModule("/src/components.tsx");
  const { formatRetry } = await vite.ssrLoadModule("/src/format.ts");
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await app.raw(req.url, {
      method: req.method,
      headers: { authorization: `Bearer ${await app.token()}`, "content-type": "application/json" },
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const api = createApi(`http://127.0.0.1:${server.address().port}`);
  const send = () =>
    request(
      api.platform.sendInvitation({
        params: { accountId: account.id },
        payload: { email: "teammate@example.com" },
      }),
    );
  await send();
  const refused = await send().then(
    () => assert.fail("The second invitation within the cooldown must be refused"),
    (error) => error,
  );
  assert.ok(refused instanceof ApiError);
  assert.equal(refused.code, "invitation_limited");
  assert.ok(Date.parse(refused.retryAt) > Date.now());
  const text = words(renderToStaticMarkup(createElement(Notice, { error: refused })));
  assert.match(text, /sent an invitation recently/);
  assert.match(text, /You can try again in (10|9) minutes\./);
  assert.doesNotMatch(text, /fraud|abuse|suspicious|spam|blocked/i);

  const now = new Date(2026, 10, 12, 9, 0);
  const at = (hours, minutes = 0, day = 12) =>
    new Date(2026, 10, day, hours, minutes).toISOString();
  assert.equal(formatRetry(at(9, 0, 12), now), "You can try again in a minute.");
  assert.equal(formatRetry(at(9, 10), now), "You can try again in 10 minutes.");
  assert.match(formatRetry(at(16, 0), now), /^You can try again after .+ today\.$/);
  assert.match(formatRetry(at(1, 0, 13), now), /^You can try again after .+ tomorrow\.$/);
});
