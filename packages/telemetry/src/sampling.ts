import type { TracesSamplerSamplingContext } from "@sentry/core";

/** Root decisions only. Descendants preserve an explicit incoming decision. */
export type Work = "billing" | "routine" | "health";

/** Customer POST actions; reads, webhooks and reconciliation remain routine. */
export function classifyRequest(method: string, url: string): Work {
  try {
    const path = new URL(url, "https://talkto.invalid").pathname;
    if (path === "/health") return "health";
    if (
      method === "POST" &&
      /^\/v1\/accounts\/[^/]+\/billing\/(checkout(?:\/cancel|\/confirm)?|renewal|trial\/convert|portal)$/.test(
        path,
      )
    )
      return "billing";
  } catch {
    return "routine";
  }
  return "routine";
}

/** The installed Cloudflare SDK supplies normalizedRequest before starting HTTP spans. */
export function classify(context: TracesSamplerSamplingContext): Work {
  if (context.normalizedRequest?.url)
    return classifyRequest(
      context.normalizedRequest.method ?? "GET",
      context.normalizedRequest.url,
    );
  return context.attributes?.["talkto.work"] === "billing" ? "billing" : "routine";
}

/** Shared head policy; error event sampling is independent and stays at 100%. */
export function sample(context: TracesSamplerSamplingContext): number {
  // Prefer the actual decision over baggage's rate: never reselect an unsampled parent.
  if (context.parentSampled !== undefined) return Number(context.parentSampled);
  const work = classify(context);
  return work === "health" ? 0 : work === "billing" ? 1 : 0.01;
}
