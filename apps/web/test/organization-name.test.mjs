import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer as createVite } from "vite";

test("a first organization is named from a work email or the person's first name", async (t) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { defaultOrganizationName: name, defaultServerName } = await vite.ssrLoadModule(
    "/src/organization-name.ts",
  );
  // A personal address names a person, not a company: their first name does, or nobody does.
  for (const email of [
    "sam@gmail.com",
    "sam@outlook.com",
    "sam@icloud.com",
    "sam@yahoo.com",
    "sam@proton.me",
    "sam@hotmail.com",
    "sam@yahoo.co.uk",
  ]) {
    assert.equal(name(email, "Sam"), "Sam’s organization");
    assert.equal(name(email, "  Sam "), "Sam’s organization");
    assert.equal(name(email), "My organization");
    assert.equal(name(email, null), "My organization");
    assert.equal(name(email, " "), "My organization");
  }
  // A company address names the company from its domain.
  assert.equal(name("ana@brightfield.com"), "Brightfield");
  assert.equal(name("ana@acme-labs.co.uk"), "Acme Labs");
  assert.equal(name("ana@eng.acme.io"), "Acme");
  assert.equal(name("  Ana@BRIGHTFIELD.COM "), "Brightfield");
  assert.equal(name("ana@acme-labs.co.uk", "Ana"), "Acme Labs", "a work domain still names it");
  // Anything unusable falls back to the old default, within the 100-byte name limit.
  assert.equal(name(""), "My organization");
  assert.equal(name("nobody"), "My organization");
  assert.equal(name("a@localhost"), "My organization");
  assert.equal(name(`${"a".repeat(95)}@gmail.com`), "My organization");
  assert.equal(name("nobody", "Ana"), "Ana’s organization");
  assert.equal(name("sam@gmail.com", "a".repeat(95)), "My organization");
  // A first server is the person's too.
  assert.equal(defaultServerName("Alice"), "Alice’s server");
  assert.equal(defaultServerName(null), "My server");
  assert.equal(defaultServerName(""), "My server");
  assert.equal(defaultServerName("a".repeat(95)), "My server");
});
