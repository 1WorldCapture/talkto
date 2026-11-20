import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { WorkOS } from "@workos-inc/node";
import { decodeJwt } from "jose";
import { Effect, Schedule, Schema } from "effect";

const sessionSchema = Schema.Struct({
  origin: Schema.NonEmptyString,
  clientId: Schema.NonEmptyString,
  accessToken: Schema.NonEmptyString,
  refreshToken: Schema.NonEmptyString,
});
const authenticationSchema = Schema.Struct({
  data: Schema.Struct({ clientId: Schema.NonEmptyString, flow: Schema.Literal("workos-device") }),
});
const deviceSchema = Schema.Struct({
  device_code: Schema.NonEmptyString,
  user_code: Schema.NonEmptyString,
  verification_uri_complete: Schema.NonEmptyString,
  expires_in: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  interval: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
});
const tokenSchema = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
});

const [command, suppliedOrigin, method = "GET", path = "/v1/accounts", json] =
  process.argv.slice(2);
if (!suppliedOrigin || !["login", "request"].includes(command))
  throw new Error("Usage: pnpm api login ORIGIN | pnpm api request ORIGIN METHOD /v1/path [JSON]");
const origin = new URL(suppliedOrigin);
if (
  origin.origin !== suppliedOrigin ||
  origin.username ||
  origin.password ||
  (origin.protocol !== "https:" &&
    !(origin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(origin.hostname)))
)
  throw new Error("Use an HTTPS origin, or a loopback development origin.");
const directory = fileURLToPath(new URL("../../../.talkto/", import.meta.url));
const filename = join(
  directory,
  `${createHash("sha256").update(origin.origin).digest("hex")}.json`,
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const save = async (session) => {
  const temp = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(session), { mode: 0o600 });
  await rename(temp, filename);
};
if (command === "login") {
  const response = await fetch(`${origin.origin}/auth`, {
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new Error(`Service authentication discovery failed (${response.status}).`);
  const { data: config } = Schema.decodeUnknownSync(authenticationSchema)(await response.json());
  const authorization = await fetch("https://api.workos.com/user_management/authorize/device", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId }),
  });
  if (!authorization.ok) throw new Error(`Device authorization failed (${authorization.status}).`);
  const device = Schema.decodeUnknownSync(deviceSchema)(await authorization.json());
  console.log(`Open ${device.verification_uri_complete}\nConfirm code: ${device.user_code}`);
  let interval = device.interval ?? 5;
  const poll = Effect.tryPromise({
    try: async (signal) => {
      const result = await fetch("https://api.workos.com/user_management/authenticate", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: config.clientId,
          device_code: device.device_code,
        }),
      });
      const data = await result.json();
      if (result.ok) return Schema.decodeUnknownSync(tokenSchema)(data);
      const failure = Schema.decodeUnknownSync(Schema.Struct({ error: Schema.String }))(data);
      if (failure.error === "slow_down") interval += 5;
      if (["authorization_pending", "slow_down"].includes(failure.error)) return null;
      throw new Error("Device authorization was rejected or expired.");
    },
    catch: () => new Error("Device login failed. Run the login command again."),
  });
  const result = await Effect.runPromise(
    poll.pipe(
      Effect.repeat({
        while: (result) => result === null,
        schedule: Schedule.spaced("5 seconds").pipe(
          Schedule.modifyDelay(() => Effect.succeed(`${interval} seconds`)),
        ),
      }),
      Effect.timeout(`${device.expires_in} seconds`),
    ),
  );
  if (result === null) throw new Error("Device authorization expired.");
  await save({
    origin: origin.origin,
    clientId: config.clientId,
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
  });
  console.log("Signed in. Credentials saved locally with owner-only permissions.");
} else {
  let session;
  try {
    session = Schema.decodeUnknownSync(Schema.fromJsonString(sessionSchema))(
      await readFile(filename, "utf8"),
    );
  } catch {
    throw new Error("Run pnpm api login ORIGIN first.");
  }
  if (session.origin !== origin.origin)
    throw new Error("The saved session belongs to another service.");
  const target = new URL(path, origin);
  if (!path.startsWith("/v1/") || target.origin !== origin.origin)
    throw new Error("Use an API path under /v1/ on the authenticated service.");
  const sdk = new WorkOS({ clientId: session.clientId });
  if ((decodeJwt(session.accessToken).exp ?? 0) <= Math.floor(Date.now() / 1000) + 30) {
    const refreshed = await sdk.userManagement.authenticateWithRefreshToken({
      clientId: session.clientId,
      refreshToken: session.refreshToken,
    });
    session = {
      ...session,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
    };
    await save(session);
  }
  const response = await fetch(target, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(30000),
    headers: { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json" },
    body: json,
  });
  console.log(await response.text());
  if (!response.ok) process.exitCode = 1;
}
