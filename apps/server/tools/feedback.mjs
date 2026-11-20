import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/*
  Read what people sent with the Feedback button and their agents sent with `send_feedback`
  (docs/feedback.md).

    pnpm feedback                          unread feedback in production, newest first
    pnpm feedback --env staging            the same in staging
    pnpm feedback --mark-read <id> [<id>…] mark those rows read; the only write

  Runs `wrangler d1 execute … --remote --json` with the `talkto` profile. Prints user and account
  IDs, never an email address; an agent's message also shows its server and participant when
  they were recorded. Message text is printed with control characters replaced, so a
  message cannot rewrite the terminal.
*/

const targets = {
  production: { database: "talkto-platform-production", config: "wrangler.production.jsonc" },
  staging: { database: "talkto-platform-staging", config: "wrangler.staging.jsonc" },
};
/** Rows shown per run; the count says when more are waiting. */
export const pageSize = 100;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The run the arguments ask for; throws on anything it does not understand. */
export function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      env: { type: "string", default: "production" },
      "mark-read": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return { help: true };
  const target = targets[values.env];
  if (target === undefined)
    throw new Error(`--env must be production or staging, not ${values.env}.`);
  if (!values["mark-read"]) {
    if (positionals.length > 0) throw new Error(`Unexpected arguments: ${positionals.join(" ")}`);
    return { env: values.env, ...target, ids: null };
  }
  if (positionals.length === 0) throw new Error("--mark-read needs at least one feedback ID.");
  const bad = positionals.filter((id) => !uuid.test(id));
  if (bad.length > 0) throw new Error(`Not feedback IDs: ${bad.join(" ")}`);
  return { env: values.env, ...target, ids: [...new Set(positionals)] };
}

/** Unread rows, newest first, and how many are unread in all. Read-only. */
export const listQuery = `SELECT id,created_at,kind,source,user_id,account_id,server_id,participant_id,page,app_version,user_agent,message,(SELECT COUNT(*) FROM feedback WHERE read_at IS NULL) AS unread FROM feedback WHERE read_at IS NULL ORDER BY created_at DESC, id DESC LIMIT ${pageSize}`;

/** Set `read_at` on unread rows among `ids`. IDs are checked as UUIDs before they reach SQL. */
export function markReadQuery(ids) {
  if (ids.length === 0 || ids.some((id) => !uuid.test(id)))
    throw new Error("Invalid feedback IDs.");
  return `UPDATE feedback SET read_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE read_at IS NULL AND id IN (${ids.map((id) => `'${id}'`).join(",")}) RETURNING id`;
}

/** Characters that can move the cursor, recolour or reorder terminal text. Tab and newline stay. */
const unsafe = (code) =>
  (code < 0x20 && code !== 0x09 && code !== 0x0a) ||
  (code >= 0x7f && code <= 0x9f) ||
  (code >= 0x200b && code <= 0x200f) ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2060 && code <= 0x2069) ||
  code === 0xfeff;

/** Text safe to print: control, bidirectional and zero-width characters become U+FFFD. */
export function clean(value) {
  return Array.from(String(value ?? ""), (character) =>
    unsafe(character.codePointAt(0) ?? 0) ? "\uFFFD" : character,
  ).join("");
}

/** The listing as plain text. */
export function format(rows, env) {
  if (rows.length === 0) return `No unread feedback in ${env}.`;
  const unread = rows[0].unread;
  const lines = [
    `${unread} unread in ${env}${unread > rows.length ? `, newest ${rows.length} shown` : ""}:`,
  ];
  const optional = (value) => (value === null || value === undefined ? "-" : clean(value));
  for (const row of rows) {
    lines.push(
      "",
      `${clean(row.kind) === "bug" ? "BUG     " : "FEEDBACK"} ${clean(row.created_at)}  ${clean(row.id)}  from ${clean(row.source)}`,
      `  user ${clean(row.user_id)}  account ${optional(row.account_id)}`,
      ...(row.server_id === null
        ? []
        : [`  server ${clean(row.server_id)}  participant ${optional(row.participant_id)}`]),
      ...(row.page === null ? [] : [`  page ${clean(row.page)}`]),
      `  version ${optional(row.app_version)}  browser ${optional(row.user_agent)}`,
      ...clean(row.message)
        .split("\n")
        .map((line) => `  | ${line}`),
    );
  }
  lines.push(
    "",
    `Mark read: pnpm feedback${env === "production" ? "" : ` --env ${env}`} --mark-read <id> …`,
  );
  return lines.join("\n");
}

function execute(run, command) {
  const server = fileURLToPath(new URL("..", import.meta.url));
  if (!existsSync(new URL(`../${run.config}`, import.meta.url)))
    throw new Error(`${run.config} is missing in apps/server.`);
  const result = spawnSync(
    "wrangler",
    [
      "d1",
      "execute",
      run.database,
      "--remote",
      "--config",
      run.config,
      "--profile",
      "talkto",
      "--json",
      "--command",
      command,
    ],
    { cwd: server, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0)
    throw new Error(
      `wrangler d1 execute ${run.database} failed:\n${result.error?.message ?? result.stderr ?? result.stdout}`,
    );
  const [first] = JSON.parse(result.stdout);
  if (first?.success !== true)
    throw new Error(`wrangler d1 execute ${run.database} did not succeed.`);
  return first;
}

function main() {
  const run = parse(process.argv.slice(2));
  if (run.help) {
    console.log(
      "pnpm feedback [--env production|staging] [--mark-read <id> …]\nLists unread feedback, newest first. --mark-read sets read_at on those IDs.",
    );
    return;
  }
  if (run.ids === null) {
    console.log(format(execute(run, listQuery).results, run.env));
    return;
  }
  const result = execute(run, markReadQuery(run.ids));
  const changed = result.results.length;
  console.log(
    `Marked ${changed} of ${run.ids.length} read in ${run.env}.${changed < run.ids.length ? " The others were already read or do not exist." : ""}`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
