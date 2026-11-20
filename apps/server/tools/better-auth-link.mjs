// Print a one-time account link for a self-hosted copy that signs in with Better Auth
// (docs/self-host-better-auth.md, "Account links"). Run from the repository root:
//
//   pnpm selfhost:link <address> [--hours 24]
//
// It reads TALKTO_SERVICE_ORIGIN, and the copy's BETTER_AUTH_SECRET from the environment, from a
// pipe, or from a hidden prompt. It prints the link and writes nothing to disk. Whoever opens the
// link can create the account for that address once, keeping the address's existing TalkTo ID: use
// it for the first owner, after a password reset, or after switching from Cloudflare Access.
import { createHmac, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

const label = "talkto better-auth account link v1";
const asciiEmail = /^[\x21-\x3f\x41-\x7e]+@[\x21-\x3f\x41-\x7e]+\.[\x21-\x3f\x41-\x7e]+$/;

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const args = process.argv.slice(2);
const hoursAt = args.indexOf("--hours");
const hours = hoursAt === -1 ? 24 : Number(args[hoursAt + 1]);
const email = args.find(
  (value, index) => !value.startsWith("--") && (hoursAt === -1 || index !== hoursAt + 1),
);
if (email === undefined) fail("Usage: pnpm selfhost:link <address> [--hours 24]");
const address = email.trim().toLowerCase();
if (!asciiEmail.test(address) || address.length > 254)
  fail("Give the address in plain ASCII, like name@example.com.");
if (!Number.isInteger(hours) || hours < 1 || hours > 168)
  fail("--hours must be a whole number from 1 to 168 (one week).");
const origin = process.env.TALKTO_SERVICE_ORIGIN?.trim();
if (origin === undefined || !/^https?:\/\/[a-z0-9.:-]+$/.test(origin))
  fail("Set TALKTO_SERVICE_ORIGIN to your TalkTo's address, like https://talkto.example.com.");

/** The secret: from the environment, from a pipe, or typed at a prompt that does not echo it. */
const readSecret = async () => {
  const fromEnvironment = process.env.BETTER_AUTH_SECRET?.trim();
  if (fromEnvironment) return fromEnvironment;
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  const prompt = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  process.stderr.write("BETTER_AUTH_SECRET (not shown): ");
  // Swallow the echo of each typed character.
  prompt._writeToOutput = () => {};
  const value = await new Promise((resolve) => prompt.question("", resolve));
  prompt.close();
  process.stderr.write("\n");
  return value.trim();
};

const secret = await readSecret();
if (secret.length < 32)
  fail("BETTER_AUTH_SECRET must be the copy's secret, at least 32 characters.");
const expiry = String(Math.floor(Date.now() / 1000) + hours * 3600);
const nonce = randomBytes(16).toString("hex");
const mac = createHmac("sha256", secret)
  .update(`${label}\n${address}\n${expiry}\n${nonce}`)
  .digest("base64url");
const code = `${Buffer.from(address).toString("base64url")}.${expiry}.${nonce}.${mac}`;
console.log(`${origin}/auth/sign-in?${new URLSearchParams({ claim: code })}`);
console.error(
  `One account for ${address}, once, within ${hours} hour${hours === 1 ? "" : "s"}. Send it only to that person.`,
);
