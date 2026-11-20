import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClientProvider } from "@tanstack/react-query";
import { createServer as createVite } from "vite";
import { start } from "../../server/test/platform-harness.mjs";
import { words } from "./copy-rules.mjs";

/** The Feedback dialog's markup, and its limit refusal through the real Worker. */
const vite = async (t) => {
  const server = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => server.close());
  return server;
};

test("the feedback dialog labels its choice, its field and what it attaches", async (t) => {
  const server = await vite(t);
  const { FeedbackDialog } = await server.ssrLoadModule("/src/feedback.tsx");
  const { createServices, Services } = await server.ssrLoadModule("/src/session.tsx");
  const services = createServices("https://talkto.test");
  t.after(() => services.queries.clear());
  const html = renderToStaticMarkup(
    createElement(
      Services.Provider,
      { value: services },
      createElement(
        QueryClientProvider,
        { client: services.queries },
        createElement(FeedbackDialog, { close: () => {} }),
      ),
    ),
  );
  const text = words(html);
  assert.match(text, /Feedback and bugs/);
  assert.match(html, /<legend class="sr-only">Type<\/legend>/);
  assert.match(
    html,
    /<label class="is-selected"><input type="radio" name="kind" checked="" value="feedback"\/>Feedback<\/label>/,
  );
  assert.match(html, /<label><input type="radio" name="kind" value="bug"\/>Bug<\/label>/);
  const field = html.match(/<label for="([^"]+)">What should we know\?<\/label>/);
  assert.ok(field, html);
  const textarea = html.match(/<textarea[^>]*>/)[0];
  assert.match(textarea, new RegExp(`id="${field[1]}"`));
  assert.match(textarea, /maxLength="5000"|maxlength="5000"/);
  assert.match(textarea, /required/);
  const note = textarea.match(/aria-describedby="([^"]+)"/)[1];
  assert.match(
    html,
    new RegExp(
      `<p id="${note}" class="feedback-note">Sent with this page’s path, the app version and your browser details\\.`,
    ),
  );
  assert.match(html, /<button class="btn">Send<\/button>/);
  assert.match(html, /<button type="button" class="text-button">Cancel<\/button>/);
});

test("a person over the daily limit is told plainly when they can send again", async (t) => {
  const app = await start(t);
  const server = await vite(t);
  const { createApi, request, ApiError } = await server.ssrLoadModule("/src/api.ts");
  const { Notice } = await server.ssrLoadModule("/src/components.tsx");
  const proxy = createServer(async (req, res) => {
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
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    proxy.closeAllConnections();
    proxy.close();
  });
  const api = createApi(`http://127.0.0.1:${proxy.address().port}`);
  const send = () =>
    request(
      api.feedback.send({
        payload: {
          kind: "bug",
          message: "The Send button did nothing.",
          page: "/app",
          requestKey: randomUUID(),
        },
      }),
    );
  const sent = await send();
  assert.equal(sent.data.kind, "bug");
  for (let i = 1; i < 10; i++) await send();
  const refused = await send().then(
    () => assert.fail("The eleventh message today must be refused"),
    (error) => error,
  );
  assert.ok(refused instanceof ApiError);
  assert.equal(refused.code, "feedback_limited");
  assert.ok(Date.parse(refused.retryAt) > Date.now());
  const text = words(renderToStaticMarkup(createElement(Notice, { error: refused })));
  assert.match(text, /You have sent today's 10 messages\. Nothing was sent this time\./);
  assert.match(text, /You can try again (after|in) /);
  assert.doesNotMatch(text, /abuse|spam|blocked/i);
});
