import { createContext, useContext } from "react";
import type * as P from "@talkto/api/platform";
import type * as M from "@talkto/api/models";
import { accountServerPath, sharedServerPath } from "./app-routes.js";

/**
 * True inside a server a guest opens from "Shared with you" (/app/shared/<serverId>). Its links
 * stay under that path, because a guest cannot open the organization's pages.
 */
const SharedView = createContext(false);
/** Marks a subtree as a guest's shared-server view. */
export const SharedServerView = SharedView.Provider;
/** Whether this view is a guest's shared server. */
export const useSharedView = () => useContext(SharedView);
/** The /app path of a server, as this view opens it. */
export function useServerPath(accountId: P.AccountId, serverId: M.ServerId) {
  return useContext(SharedView)
    ? sharedServerPath(serverId)
    : accountServerPath(accountId, serverId);
}
