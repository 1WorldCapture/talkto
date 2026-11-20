import { Schema } from "effect";
import fixture from "./platform-fixture.js";
import type { TestEnv } from "./platform-fixture.js";

/** Temporary Cloudflare verification deployment. Every route requires a separate operator secret. */
export default {
  async fetch(
    request: Request<unknown, IncomingRequestCfProperties>,
    env: TestEnv,
    ctx: ExecutionContext,
  ) {
    const config = Schema.decodeUnknownOption(
      Schema.Struct({ VERIFY_TOKEN: Schema.String.check(Schema.isMinLength(32)) }),
    )(env);
    if (
      config._tag === "None" ||
      request.headers.get("x-verification-key") !== config.value.VERIFY_TOKEN
    )
      return new Response("Not found", { status: 404 });
    return fixture.fetch(request, env, ctx);
  },
};
export { PlatformTestServer, TestQuota } from "./platform-fixture.js";
