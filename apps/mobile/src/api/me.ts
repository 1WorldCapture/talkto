import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import type * as M from "@talkto/api/models";
import { useServices } from "../session/session";
import { personMessaging } from "./person";
import { useScope } from "./queries";

/** True for a person participant: `kind: "person"`, which also has agent type "person". */
export const isPerson = (participant: { readonly agentType: string; readonly kind?: "person" }) =>
  participant.kind === "person" || participant.agentType === "person";

/** Acting as the signed-in person on a server. */
export function usePersonMessaging() {
  const services = useServices();
  return useMemo(() => personMessaging(services), [services]);
}

/**
 * The signed-in person's own participant on a server (`GET …/people/me`), or null before they
 * have messaged anyone there. A direct chat between it and an agent is the person's own chat.
 */
export function useMe(serverId: M.ServerId) {
  const messaging = usePersonMessaging();
  return useQuery({
    queryKey: [...useScope(), serverId, "me"],
    queryFn: () => messaging.me(serverId),
    staleTime: 5 * 60_000,
  }).data;
}

/** Where the chat appears once it is open. */
export interface MessageAgentOptions {
  /** Close the agent picker sheet before showing the chat. */
  readonly fromSheet?: boolean;
}

/** Open (or reopen) the person's own chat with an agent and go to it. */
export function useMessageAgent(serverId: M.ServerId, options: MessageAgentOptions = {}) {
  const messaging = usePersonMessaging();
  const client = useQueryClient();
  const router = useRouter();
  const root = useScope();
  const { fromSheet = false } = options;
  const mutation = useMutation({
    mutationFn: (agentId: M.ParticipantId) => messaging.openDirectChat(serverId, agentId),
    onSuccess(opened) {
      client.setQueryData([...root, serverId, "me"], opened.me);
      void client.invalidateQueries({ queryKey: [...root, serverId, "conversations"] });
      if (fromSheet) router.dismiss();
      router.push({
        pathname: "/servers/[serverId]/conversations/[conversationId]",
        params: { serverId, conversationId: opened.conversation.id },
      });
    },
  });
  const { mutate } = mutation;
  const start = useCallback(
    (agentId: M.ParticipantId, handlers: { readonly onError: (error: Error) => void }) =>
      mutate(agentId, handlers),
    [mutate],
  );
  return { start, pending: mutation.isPending, error: mutation.error, reset: mutation.reset };
}
