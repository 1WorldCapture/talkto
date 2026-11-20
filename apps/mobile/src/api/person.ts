import { randomUUID } from "expo-crypto";
import type * as I from "@talkto/api/inputs";
import * as M from "@talkto/api/models";
import type { Services } from "../session/session";
import { ApiError, request } from "./client";

/** A direct chat the person opened, with the person's own participant in it. */
export interface OpenedChat {
  readonly conversation: M.DirectConversation;
  readonly me: M.ParticipantId;
}

/** What acting as the signed-in person needs; the server derives the sender from the sign-in. */
export interface PersonMessaging {
  /** The person's own participant on the server, or null before their first direct chat. */
  readonly me: (serverId: M.ServerId) => Promise<M.ParticipantId | null>;
  readonly openDirectChat: (serverId: M.ServerId, agentId: M.ParticipantId) => Promise<OpenedChat>;
  readonly sendMessage: (serverId: M.ServerId, message: I.SendPersonMessage) => Promise<M.Message>;
}

/** A server from before the person endpoints answers with the generic missing-route error. */
async function personRoute<A>(work: Promise<A>) {
  try {
    return await work;
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found")
      throw new ApiError(
        "not_found",
        "This server can't take messages from people yet.",
        error.requestId,
        error.status,
      );
    throw error;
  }
}

/** `/v1/servers/:serverId/people/me/…`, as packages/api declares them. */
export function personMessaging(services: Services): PersonMessaging {
  const { api, credentials } = services;
  return {
    // A server without this route reads as "no person yet": every chat stays read-only, and
    // the server's other reads report a server that is really gone.
    async me(serverId) {
      try {
        const result = await request(
          credentials,
          api.server.getPersonSelf({ params: { serverId } }),
        );
        return result.data.participant?.id ?? null;
      } catch (error) {
        if (error instanceof ApiError && error.code === "not_found") return null;
        throw error;
      }
    },
    async openDirectChat(serverId, agentId) {
      const result = await personRoute(
        request(
          credentials,
          api.server.openPersonDirectChat({
            params: { serverId },
            payload: { agentId, requestKey: M.RequestKey.make(randomUUID()) },
          }),
        ),
      );
      const conversation = result.data.item;
      const [low, high] = conversation.participantIds;
      return { conversation, me: low === agentId ? high : low };
    },
    async sendMessage(serverId, message) {
      const result = await personRoute(
        request(
          credentials,
          api.server.sendPersonMessage({ params: { serverId }, payload: message }),
        ),
      );
      return result.data.item;
    },
  };
}
