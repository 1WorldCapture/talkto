import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../src/platform/migrations/", import.meta.url));

/** Apply each migration and its ledger entry in one D1 batch. Safe to repeat after a restart. */
export async function migratePlatform(database) {
  await database
    .prepare(
      "CREATE TABLE IF NOT EXISTS talkto_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    )
    .run();
  const applied = new Set(
    (await database.prepare("SELECT name FROM talkto_migrations").all()).results.map(
      (row) => row.name,
    ),
  );
  const files = (await readdir(directory)).filter((name) => /^\d{4}\.sql$/.test(name)).sort();
  let count = 0;
  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = await readFile(join(directory, name), "utf8");
    const statements = sql
      .replace(/^--.*$/gm, "")
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean)
      .map((statement) => database.prepare(statement));
    await database.batch([
      ...statements,
      database
        .prepare("INSERT INTO talkto_migrations(name, applied_at) VALUES(?, ?)")
        .bind(name, new Date().toISOString()),
    ]);
    count++;
    console.error(`Applied platform migration ${name}`);
  }
  return count;
}
