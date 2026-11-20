import { queryOptions } from "@tanstack/react-query";
import { Schema } from "effect";
import * as P from "@talkto/api/platform";
import type * as M from "@talkto/api/models";
import { input, request, type Client } from "./api.js";

/** Reuse the same Home request during route prefetch and visible rendering. */
export function homeQuery(api: Client, userId: P.UserId, accountId: P.AccountId, limit: number) {
  return queryOptions({
    queryKey: ["human", userId, accountId, "home", limit],
    queryFn: ({ signal }) =>
      request(api.platform.dashboard({ params: { accountId }, query: { limit } }), signal),
  });
}

/** Reuse server context without bypassing the management endpoint's permission checks. */
export function managedServerQuery(
  api: Client,
  userId: P.UserId,
  accountId: P.AccountId,
  serverId: M.ServerId,
) {
  return queryOptions({
    queryKey: ["human", userId, accountId, serverId, "management"],
    queryFn: ({ signal }) =>
      request(api.platform.managedServer({ params: { accountId, serverId } }), signal),
  });
}

/**
 * Organization free-start state, shared by Home's prefetch and every view that shows it. Owners
 * poll it on every organization page, so it keeps the default retry of transient failures: one
 * dropped connection must not end the read.
 */
export function starterQuery(api: Client, userId: P.UserId, accountId: P.AccountId | null) {
  return queryOptions({
    queryKey: ["human", userId, accountId, "starter"],
    queryFn: ({ signal }) =>
      request(
        api.starter.state({
          params: input(Schema.Struct({ accountId: P.AccountId }), { accountId }),
        }),
        signal,
      ),
  });
}
