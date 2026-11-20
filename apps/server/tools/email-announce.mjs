// Send a TalkTo product update to everyone who gets them (docs/email.md, "Sending a product update").
//
//   pnpm email:announce --env production --file notes.md --dry-run   preview and count, change nothing
//   pnpm email:announce --env production --file notes.md             queue it for sending
//   pnpm email:announce --env production --status                    the latest announcements
//   pnpm email:announce --env production --cancel <id>               stop one that is still going out
//
// The file's first line is `# Subject`; the rest is the body in simple Markdown: paragraphs, `##`
// headings, `-` lists, **bold**, `code` and [links](https://…). Nothing is ever sent from this
// machine: a real run writes one row to the environment's D1 database with `wrangler d1 execute`
// (profile `talkto`), and the Worker's minute cron queues people 500 at a time and sends at most
// 100 emails a minute (TALKTO_EMAIL_BATCH), skipping anyone who unsubscribed.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { experimental_readRawConfig } from "wrangler";

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Split a Markdown file into subject and body, or explain what is wrong with it. */
export function parse(markdown) {
  const text = markdown.replaceAll("\r\n", "\n").trim();
  const [first = "", ...rest] = text.split("\n");
  const subject = first.replace(/^#\s+/, "").trim();
  const body = rest.join("\n").trim();
  const problems = [];
  if (!/^#\s+\S/.test(first)) problems.push("The first line must be the subject, as `# Subject`.");
  if (subject.length > 120) problems.push("Keep the subject under 120 characters.");
  if (body.length === 0) problems.push("The body is empty.");
  if (body.length > 20_000) problems.push("Keep the body under 20,000 characters.");
  if (/!\[/.test(body)) problems.push("Images are not supported: TalkTo emails carry no images.");
  if (/<[a-z/!]/i.test(body)) problems.push("Raw HTML is not supported; use Markdown.");
  if (/\]\(http:\/\//.test(body)) problems.push("Links must use https://.");
  return { subject, body, problems };
}

/** SQL text for a string, as a hex blob, so quotes, semicolons and newlines survive intact. */
const text = (value) => `CAST(X'${Buffer.from(value, "utf8").toString("hex")}' AS TEXT)`;

/** Whether product updates are opt-out, read from the one constant the Worker uses. */
export function optOut() {
  const source = readFileSync(
    fileURLToPath(new URL("../../../packages/api/src/email.ts", import.meta.url)),
    "utf8",
  );
  const match = /export const productUpdatesByDefault = (true|false);/.exec(source);
  if (match === null)
    throw new Error("productUpdatesByDefault not found in packages/api/src/email.ts");
  return match[1] === "true";
}

/** How many people would get it now: active members who did not turn updates off. */
export function recipientsSql(byDefault) {
  const wants = byDefault
    ? "NOT EXISTS(SELECT 1 FROM email_preferences p WHERE p.user_id=m.user_id AND p.product_updates=0)"
    : "EXISTS(SELECT 1 FROM email_preferences p WHERE p.user_id=m.user_id AND p.product_updates=1)";
  return `SELECT COUNT(*) AS recipients FROM (SELECT DISTINCT user_id FROM memberships WHERE status='active') m WHERE ${wants}`;
}
/** Queue one announcement, unless another one is still being queued. */
export function announceSql(id, subject, body, at) {
  return `INSERT INTO email_announcements(id,subject,body,state,created_at)
SELECT '${id}',${text(subject)},${text(body)},'queuing','${at}'
WHERE NOT EXISTS(SELECT 1 FROM email_announcements WHERE state='queuing')`;
}
/** Stop an announcement: queue nobody else, and drop what is not yet sent. */
export function cancelSql(id) {
  if (!idPattern.test(id ?? ""))
    throw new Error(`Expected an announcement ID, got ${JSON.stringify(id)}.`);
  return [
    `UPDATE email_announcements SET state='canceled' WHERE id='${id}' AND state IN ('queuing','queued')`,
    `UPDATE email_outbox SET state='skipped',reason='canceled' WHERE key='product_update:${id}' AND state='pending'`,
  ];
}
/** The latest announcements with what happened to their emails. */
export function statusSql() {
  return `SELECT a.id,a.subject,a.state,a.created_at AS created,a.recipients AS queued,
 (SELECT COUNT(*) FROM email_outbox o WHERE o.key='product_update:'||a.id AND o.state='sent') AS sent,
 (SELECT COUNT(*) FROM email_outbox o WHERE o.key='product_update:'||a.id AND o.state IN ('pending','sending')) AS waiting,
 (SELECT COUNT(*) FROM email_outbox o WHERE o.key='product_update:'||a.id AND o.state='skipped') AS skipped,
 (SELECT COUNT(*) FROM email_outbox o WHERE o.key='product_update:'||a.id AND o.state='failed') AS failed
 FROM email_announcements a ORDER BY a.created_at DESC LIMIT 10`;
}

const configPath = (environment) =>
  fileURLToPath(new URL(`../wrangler.${environment}.jsonc`, import.meta.url));

function execute(environment, sql) {
  const directory = mkdtempSync(join(tmpdir(), "talkto-announce-sql-"));
  const file = join(directory, "statement.sql");
  writeFileSync(file, Array.isArray(sql) ? sql.join(";\n") : sql);
  try {
    const result = spawnSync(
      "wrangler",
      [
        "d1",
        "execute",
        "PLATFORM",
        "--remote",
        "--config",
        configPath(environment),
        "--profile",
        "talkto",
        "--json",
        "--file",
        file,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0)
      throw new Error(`wrangler d1 execute failed:\n${result.error?.message ?? result.stderr}`);
    return JSON.parse(result.stdout).map((part) => part.results ?? []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function preview(subject, body, origin) {
  const { render } = await import("../src/email/render.ts");
  const rendered = render(
    { kind: "product_update", announcementId: "preview" },
    {
      origin,
      unsubscribeUrl: `${origin}/email/unsubscribe?t=preview-only`,
      announcement: { subject, body },
    },
  );
  const directory = mkdtempSync(join(tmpdir(), "talkto-announce-"));
  writeFileSync(join(directory, "email.html"), rendered.html);
  writeFileSync(join(directory, "email.txt"), `Subject: ${rendered.subject}\n\n${rendered.text}\n`);
  return { directory, rendered };
}

async function main(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const environment = value("--env");
  if (!["staging", "production"].includes(environment ?? ""))
    throw new Error("Choose the database with --env staging or --env production.");
  const vars = experimental_readRawConfig({ config: configPath(environment) }).rawConfig.vars ?? {};
  if (argv.includes("--status")) {
    console.table(execute(environment, statusSql())[0]);
    return;
  }
  const cancel = value("--cancel");
  if (cancel !== undefined) {
    execute(environment, cancelSql(cancel));
    console.log(`Canceled ${cancel}. Emails already sent stay sent; nothing else goes out.`);
    return;
  }
  const file = value("--file");
  if (file === undefined)
    throw new Error(
      "Usage: pnpm email:announce --env staging|production --file notes.md [--dry-run] | --status | --cancel <id>",
    );
  const path = resolve(process.env.INIT_CWD ?? process.cwd(), file);
  const { subject, body, problems } = parse(readFileSync(path, "utf8"));
  if (problems.length > 0) throw new Error(problems.join("\n"));
  const [[{ recipients }]] = execute(environment, recipientsSql(optOut()));
  const batch = Number(vars.TALKTO_EMAIL_BATCH ?? 100);
  const on = vars.TALKTO_EMAIL === "resend";
  const { directory } = await preview(
    subject,
    body,
    vars.TALKTO_SERVICE_ORIGIN ?? "https://talkto.sh",
  );
  console.log(`Subject: ${subject}`);
  console.log(`Recipients now: ${recipients} (people who turned updates off are left out)`);
  console.log(
    `Sending takes about ${Math.max(1, Math.ceil(recipients / batch))} minute(s) at ${batch} a minute.`,
  );
  console.log(`Preview: ${join(directory, "email.html")} and ${join(directory, "email.txt")}`);
  console.log(`Email in ${environment}: ${on ? "on (TALKTO_EMAIL = resend)" : "off"}`);
  if (argv.includes("--dry-run")) {
    console.log("Dry run: nothing was written or sent.");
    return;
  }
  if (!on)
    throw new Error(
      `Email is off in ${environment}, so nothing would go out. Turn TALKTO_EMAIL on first (docs/email.md).`,
    );
  const id = randomUUID();
  execute(environment, announceSql(id, subject, body, new Date().toISOString()));
  const [[row]] = execute(environment, `SELECT state FROM email_announcements WHERE id='${id}'`);
  if (row === undefined)
    throw new Error("Another announcement is still being queued. Check --status, or --cancel it.");
  console.log(`Queued announcement ${id}. Follow it with --status; stop it with --cancel ${id}.`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
