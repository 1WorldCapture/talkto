import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createServer as createVite } from "vite";

// Setup used to stop checking 2 minutes after a step change and ignored returning to the page.
// Installing TalkTo and signing in takes longer, in another app, so people stayed on "Waiting for
// <agent> to join…" after their agent had joined (reported November 2026).
test("setup keeps checking while it waits for an agent, and stops when nothing is awaited", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { awaitsProgress, progressInterval, progressPollMs, progressWatchMs } =
    await vite.ssrLoadModule("/src/onboarding-polling.ts");
  const since = 1_000_000;
  const minutes = (count) => since + count * 60_000;
  const poll = (step, now, visible = true) =>
    progressInterval({ step, visible, watchingSince: since, now });
  assert.ok(progressPollMs >= 3_000 && progressPollMs <= 5_000);
  assert.equal(progressWatchMs, 30 * 60_000);
  for (const step of ["agents", "share"]) {
    assert.equal(awaitsProgress(step), true, `${step} checks when the person returns`);
    assert.equal(poll(step, minutes(0)), progressPollMs);
    assert.equal(poll(step, minutes(3)), progressPollMs, `${step} still polls after 3 minutes`);
    assert.equal(poll(step, minutes(29)), progressPollMs);
    assert.equal(poll(step, minutes(30)), false, `${step} rests after 30 minutes untouched`);
    assert.equal(poll(step, minutes(3), false), false, `${step} does not poll a hidden page`);
  }
  for (const step of ["server", "done"]) {
    assert.equal(awaitsProgress(step), false);
    assert.equal(poll(step, minutes(0)), false, `${step} awaits nothing`);
  }
  // The wizard wires the decision in: returning to the page checks while something is awaited.
  const wizard = await readFile(new URL("../src/onboarding.tsx", import.meta.url), "utf8");
  assert.match(wizard, /refetchOnWindowFocus: awaiting,/);
  assert.match(wizard, /addEventListener\("focus", regain\)/);
  assert.doesNotMatch(wizard, /120_000/);
});
