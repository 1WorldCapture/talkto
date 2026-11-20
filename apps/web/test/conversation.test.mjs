import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer as createVite } from "vite";
import { start } from "../../server/test/platform-harness.mjs";

test("dialogue renders full escaped history in sequence order across bounded pages and concurrent arrivals", async (t) => {
  const app = await start(t);
  const workspace = await app.account();
  const server = await app.server(workspace.id);
  const root = `/v1/servers/${server.id}`;
  const call = (method, path, payload) => app.call("user_alice", method, root + path, payload);
  const peers = [];
  for (const [name, agentType] of [
    ["code-review-agent", "codex"],
    ["browser-review-agent", "chatgpt-web"],
  ]) {
    peers.push(
      (await call("POST", "/participants", { name, agentType, requestKey: randomUUID() })).item,
    );
  }
  const chat = (
    await call("POST", "/direct-chats", {
      participantId: peers[0].id,
      recipientId: peers[1].id,
    })
  ).item;
  const general = (await call("GET", "/channels")).items[0];
  const send = (conversationId, index, body) =>
    call("POST", `/conversations/${conversationId}/messages`, {
      participantId: peers[index % 2].id,
      body,
      requestKey: randomUUID(),
    });
  const committed = [];
  for (let index = 0; index < 55; index++) {
    committed.push(
      (
        await send(
          chat.id,
          index,
          `Message ${index}\n\nFull body with Unicode: 雪 🌱\n<img src=x onerror=alert(1)>\n${"Long prose. ".repeat(60)}END-${index}`,
        )
      ).item,
    );
  }
  await send(general.id, 0, "CHANNEL-ONLY-CONTENT");
  const get = async (query) =>
    (
      await app.raw(`${root}/messages?${new URLSearchParams(query)}`, {
        headers: { authorization: `Bearer ${await app.token()}` },
      })
    ).json();
  const latest = await get({ conversationId: chat.id, limit: "50" });
  assert.equal(latest.data.items.length, 50);
  const arrival = (await send(chat.id, 1, "ARRIVAL-AFTER-SNAPSHOT")).item;
  const earlier = await get({ cursor: latest.data.nextCursor, limit: "50" });
  assert.equal(earlier.data.items.length, 5);
  assert.equal(earlier.data.nextCursor, null);
  assert.deepEqual(
    [...earlier.data.items.toReversed(), ...latest.data.items.toReversed()].map((m) => m.id),
    committed.map((m) => m.id),
  );
  const pending = await get({ cursor: latest.data.liveCursor });
  assert.deepEqual(
    pending.data.items.map((m) => m.id),
    [arrival.id],
  );
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { MessageDialogue } = await vite.ssrLoadModule("/src/message-dialogue.tsx");
  const render = (page) =>
    renderToStaticMarkup(
      createElement(MessageDialogue, {
        rows: page.data.items.map((message) => ({ message, included: page.included })),
        position: "latest",
        empty: "No messages yet.",
      }),
    );
  const html = render(latest);
  assert.equal((html.match(/data-message-id=/g) ?? []).length, 50);
  assert.ok(html.indexOf("<p>Message 5</p>") < html.indexOf("<p>Message 54</p>"));
  assert.ok(html.includes("END-54"), "full body must not be truncated");
  assert.ok(html.includes("雪 🌱"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(!html.includes("<img"), "message text must never become HTML");
  assert.ok(!html.includes("<details"), "message bodies are readable without expanding rows");
  assert.ok(!html.includes("CHANNEL-ONLY-CONTENT"));
  assert.ok(!html.includes("ARRIVAL-AFTER-SNAPSHOT"));
  assert.ok(html.includes("browser-review-agent"));
  assert.ok(html.includes('aria-label="ChatGPT · Browser"'));
  const channel = await get({ conversationId: general.id });
  assert.ok(render(channel).includes("CHANNEL-ONLY-CONTENT"));
});

test("message Markdown renders a safe subset as elements, never raw HTML or unsafe links", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { MessageBody } = await vite.ssrLoadModule("/src/message-body.tsx");
  const html = renderToStaticMarkup(
    createElement(MessageBody, {
      body: [
        "# Plan",
        "**bold** `code` [run](https://example.com/run) [bad](javascript:alert(1)) [data](data:text/html,x) [local](/app)",
        "<script>alert(1)</script> <b>raw</b> <img src=x onerror=alert(1)>",
        "![chart](https://example.com/c.png) mail@example.com",
        "at async /workspace/talkto/node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/core.js:1284:12",
        "Upgrade pkg@1.2.3 next. <ops@example.com> [Write to us](mailto:team@example.com) <mailto:help@example.com>",
        "at load (https://cdn.example.com/app.js:1:2) and (https://x.io/p).",
      ].join("\n\n"),
    }),
  );
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes("<code>code</code>"));
  assert.ok(
    html.includes(
      '<a href="https://example.com/run" target="_blank" rel="noopener noreferrer">run</a>',
    ),
  );
  assert.ok(html.includes('href="mailto:mail@example.com"'));
  assert.ok(!/href="(javascript|data):|href="\/app"/.test(html), "only http(s) and mailto links");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("&lt;b&gt;raw&lt;/b&gt;"));
  assert.ok(
    !/<(script|b|img|h1)[ >]/.test(html),
    "raw HTML, images and headings never become elements",
  );
  assert.ok(!html.includes(" id="), "message content never adds page ids");
  assert.ok(html.includes('href="https://example.com/c.png"'), "images become links");
  assert.ok(html.includes('dir="auto"'));
  assert.ok(
    html.includes(
      "<p>at async /workspace/talkto/node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/core.js:1284:12</p>",
    ),
    "a path with package@version stays text",
  );
  assert.ok(html.includes("Upgrade pkg@1.2.3 next."), "package@version stays text");
  assert.ok(!html.includes("mailto:workspace") && !html.includes("mailto:pkg"));
  for (const address of ["ops@example.com", "team@example.com", "help@example.com"])
    assert.ok(html.includes(`href="mailto:${address}"`), `${address} stays a link`);
  assert.ok(
    html.includes(
      'at load (<a href="https://cdn.example.com/app.js:1:2" target="_blank" rel="noopener noreferrer">https://cdn.example.com/app.js:1:2</a>) and (<a href="https://x.io/p"',
    ),
    "bare URLs link only the URL itself",
  );
});
