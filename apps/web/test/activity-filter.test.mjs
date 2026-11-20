import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer as createVite } from "vite";
import { createMemoryHistory } from "@tanstack/react-router";

test("activity URLs restore time selection on Back and reject incomplete or out-of-window ranges", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { createAppRouter } = await vite.ssrLoadModule("/src/router.tsx");
  const selection = {
    query: "review",
    range: "day",
    at: "2026-09-14T20:00:00.000Z",
    start: "2026-09-14T17:00:00.000Z",
    end: "2026-09-14T19:00:00.000Z",
  };
  const path = "/app/accounts/account/servers/server";
  const selected = `${path}?${new URLSearchParams(selection)}`;
  const cleared = `${path}?query=review&range=day`;
  const history = createMemoryHistory({ initialEntries: [selected, cleared] });
  const router = createAppRouter();
  router.update({ history });
  await router.load();
  assert.equal(router.state.matches.at(-1).search.start, undefined);
  history.back();
  await router.load();
  assert.deepEqual(router.state.matches.at(-1).search, selection);
  history.forward();
  await router.load();
  assert.equal(router.state.matches.at(-1).search.start, undefined);
  const reloaded = createAppRouter();
  reloaded.update({ history: createMemoryHistory({ initialEntries: [selected] }) });
  await reloaded.load();
  assert.deepEqual(reloaded.state.matches.at(-1).search, selection);
  for (const invalid of [
    { ...selection, start: "invalid" },
    { ...selection, start: selection.end },
    { ...selection, start: "2026-09-12T00:00:00.000Z" },
    { ...selection, end: "2026-09-15T00:00:00.000Z" },
    { range: "day", at: selection.at, start: selection.start },
    { range: "day", at: selection.at, end: selection.end },
    { range: "day", start: selection.start, end: selection.end },
  ]) {
    history.push(`${path}?${new URLSearchParams(invalid)}`);
    await router.load();
    assert.ok(
      router.state.matches.some((match) => match.status === "error"),
      JSON.stringify(invalid),
    );
  }
});
