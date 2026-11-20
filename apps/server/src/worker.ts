import * as Hosted from "./hosted.js";
import * as Sentry from "@sentry/cloudflare";
import * as Telemetry from "./telemetry.js";
import { WorkspaceQuota as Quota } from "./metering/coordinator.js";
import { TalkToServer as Server } from "./server-object.js";

/** The same server class, instrumented at its Cloudflare boundary including internal RPC and alarms. */
export const TalkToServer = Sentry.instrumentDurableObjectWithSentry(Telemetry.options, Server);
/** Preserve the instance type expected by Wrangler's generated Durable Object binding. */
export type TalkToServer = Server;

export const WorkspaceQuota = Sentry.instrumentDurableObjectWithSentry(Telemetry.options, Quota);
export type WorkspaceQuota = Quota;

/** Hosted API with WorkOS or, on a self-hosted copy, Cloudflare Access or Better Auth authentication, platform management, and direct server routing. */
export default Sentry.withSentry(
  Telemetry.options,
  Telemetry.monitored(Hosted.makeWorker(Hosted.configuredAuthentication)),
);
