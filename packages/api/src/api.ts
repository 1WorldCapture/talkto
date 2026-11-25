import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Health } from "./health.js";
import * as M from "./models.js";
import * as I from "./inputs.js";
import * as D from "./dashboard.js";
import * as U from "./updates.js";
import * as W from "./wake.js";
import * as R from "./renames.js";
import * as T from "./tasks.js";
import * as Removals from "./removals.js";
import * as Envelope from "./envelope.js";
import * as Agent from "./agent.js";
import * as S from "./signal.js";
import { Authorization } from "./security.js";

const params = { serverId: M.ServerId };
const conversationParams = { ...params, conversationId: M.ConversationId };
const participantParams = { ...params, participantId: M.ParticipantId };
const errors = Envelope.failures;
const strictPayload = { parseOptions: { onExcessProperty: "error" } } as const;
/** The MCP tools' inputs without the fields an HTTP path already carries. */
const offer = {
  participantId: M.ParticipantId,
  requestKey: M.RequestKey,
  name: M.TransferName,
  bytes: M.TransferBytes,
  sha256: M.Sha256,
};
const prepareTransfer = Schema.Union([
  Schema.Struct({ ...offer, kind: Schema.Literal("file") }),
  Schema.Struct({
    ...offer,
    kind: Schema.Literal("folder"),
    fileCount: M.Count,
    manifestBytes: Schema.Int.check(
      Schema.isBetween({ minimum: 0, maximum: Agent.maxManifestBytes }),
    ),
  }),
]).annotate(strictPayload);
const completeTransfer = Schema.Struct({ ...I.SendMessage.fields, target: Agent.Target }).annotate(
  strictPayload,
);
const fetchTransfer = Schema.Struct({ participantId: M.ParticipantId }).annotate(strictPayload);
const signalScope = { ttlSeconds: Schema.optionalKey(S.TtlSeconds) };
const createSignal = Schema.Union([
  Schema.Struct({ ...signalScope, channelIds: U.ChannelIds, directChats: Schema.Literal("own") }),
  Schema.Struct({
    ...signalScope,
    channelIds: U.RequiredChannelIds,
    directChats: Schema.Literal("none"),
  }),
]).annotate(strictPayload);
const transferParams = { ...params, transferId: M.TransferId };
// Explicit HTTP query fields keep OpenAPI parameters visible. Decode into the
// stricter application union so a continuation cannot also introduce filters.
const listing = { limit: Schema.optionalKey(M.Limit), cursor: Schema.optionalKey(M.Cursor) };
const participantsQuery = Schema.Struct({
  ...listing,
  name: Schema.optionalKey(M.Name),
  query: Schema.optionalKey(I.DirectoryQuery),
  state: Schema.optionalKey(I.ParticipantState),
}).pipe(Schema.decodeTo(I.ListParticipants));
const channelsQuery = Schema.Struct({
  ...listing,
  state: Schema.optionalKey(I.ChannelState),
  query: Schema.optionalKey(I.DirectoryQuery),
}).pipe(Schema.decodeTo(I.ListChannels));
const directsQuery = Schema.Struct({
  ...listing,
  withParticipantId: Schema.optionalKey(M.ParticipantId),
}).pipe(Schema.decodeTo(I.ListDirectConversations));
const searchQuery = Schema.Struct({
  ...listing,
  query: Schema.optionalKey(I.SearchQuery),
  conversationId: Schema.optionalKey(M.ConversationId),
  senderId: Schema.optionalKey(M.ParticipantId),
  afterTime: Schema.optionalKey(M.TimestampInput),
  beforeTime: Schema.optionalKey(M.TimestampInput),
}).pipe(Schema.decodeTo(I.SearchMessages));
const server = HttpApiGroup.make("server")
  .add(
    HttpApiEndpoint.get("listServers", "/v1/servers", {
      success: Envelope.success(M.page(M.Server)),
      error: errors,
    }),
    HttpApiEndpoint.get("serverSummary", "/v1/servers/:serverId/summary", {
      params,
      success: Envelope.success(D.Summary),
      error: errors,
    }),
    HttpApiEndpoint.get("serverTimeline", "/v1/servers/:serverId/activity", {
      params,
      query: D.TimelineInput,
      success: Envelope.success(D.Timeline),
      error: errors,
    }),
    HttpApiEndpoint.get("serverTimelineSenders", "/v1/servers/:serverId/activity/senders", {
      params,
      query: Schema.Struct({
        start: Schema.optionalKey(M.Timestamp),
        end: Schema.optionalKey(M.Timestamp),
        cursor: Schema.optionalKey(M.Cursor),
      })
        .pipe(Schema.decodeTo(D.TimelineSendersInput))
        .annotate({ parseOptions: { onExcessProperty: "error" } }),
      success: Envelope.success(D.TimelineSenders),
      error: errors,
    }),
    HttpApiEndpoint.get("serverFeed", "/v1/servers/:serverId/messages", {
      params,
      query: Schema.Struct({
        query: Schema.optionalKey(I.SearchQuery),
        conversationId: Schema.optionalKey(M.ConversationId),
        cursor: Schema.optionalKey(M.Cursor),
        limit: Schema.optionalKey(D.FeedLimit),
        start: Schema.optionalKey(M.Timestamp),
        end: Schema.optionalKey(M.Timestamp),
        around: Schema.optionalKey(M.Count),
      })
        .pipe(Schema.decodeTo(D.FeedInput))
        .annotate({ parseOptions: { onExcessProperty: "error" } }),
      success: Envelope.success(D.Feed),
      error: errors,
    }),
    HttpApiEndpoint.get("getServer", "/v1/servers/:serverId", {
      params,
      success: Envelope.success(M.Server),
      error: errors,
    }),
    HttpApiEndpoint.post("getUpdates", "/v1/servers/:serverId/updates", {
      params,
      payload: U.Input,
      success: Envelope.successWith(U.Page, U.Included),
      error: errors,
    }),
    HttpApiEndpoint.post("registerParticipant", "/v1/servers/:serverId/participants", {
      params,
      payload: I.RegisterParticipant,
      success: Envelope.success(M.Registration),
      error: errors,
    }),
    HttpApiEndpoint.get("listParticipants", "/v1/servers/:serverId/participants", {
      params,
      query: participantsQuery.annotate({ parseOptions: { onExcessProperty: "error" } }),
      success: Envelope.success(M.page(M.Participant)),
      error: errors,
    }),
    HttpApiEndpoint.get("getParticipant", "/v1/servers/:serverId/participants/:participantId", {
      params: participantParams,
      success: Envelope.success(M.Participant),
      error: errors,
    }),
    HttpApiEndpoint.get("listWakes", "/v1/servers/:serverId/participants/:participantId/wakes", {
      params: participantParams,
      success: Envelope.success(W.Overview),
      error: errors,
    }).annotate(OpenApi.Description, "A participant's wakes. Never returns a token."),
    HttpApiEndpoint.post("createWake", "/v1/servers/:serverId/participants/:participantId/wakes", {
      params: participantParams,
      payload: W.Register,
      success: Envelope.success(W.Wake),
      error: errors,
    }).annotate(
      OpenApi.Description,
      "Website sessions and the person's API keys only: a person adds a Claude Code routine, Grok Bot or Town wake on the TalkTo dashboard or with an API key, so the token never passes through an agent. The token is stored encrypted and never returned. Calling again for the same kind replaces that wake.",
    ),
    HttpApiEndpoint.delete(
      "revokeWake",
      "/v1/servers/:serverId/participants/:participantId/wakes/:wakeId",
      {
        params: { ...participantParams, wakeId: W.WakeId },
        success: Envelope.success(W.Revoked),
        error: errors,
      },
    ).annotate(OpenApi.Description, "End one wake and delete its stored token."),
    HttpApiEndpoint.post(
      "testWake",
      "/v1/servers/:serverId/participants/:participantId/wakes/:wakeId/test",
      {
        params: { ...participantParams, wakeId: W.WakeId },
        success: Envelope.success(W.Wake),
        error: errors,
      },
    ).annotate(
      OpenApi.Description,
      "Website sessions and the person's API keys only: a person sends one test wake to a Claude Code routine, Grok Bot or Town wake, through the same request as a real wake, and reads how the service answered in lastTest. Each start uses the person's routine runs, so only the person sends one: at most one test a minute per wake (two minutes for Claude Code routines), never sooner than the service's own minimum after the last wake, and within the agent's hourly wake budget. A test says nothing new is waiting and changes neither the wake's checkpoint nor its cadence.",
    ),
    HttpApiEndpoint.get(
      "getWakeCadence",
      "/v1/servers/:serverId/participants/:participantId/wake-cadence",
      {
        params: participantParams,
        success: Envelope.success(W.CadenceSetting),
        error: errors,
      },
    ).annotate(
      OpenApi.Description,
      "How often TalkTo may wake this agent about new messages, through wakes and the TalkTo plugins and hooks. Urgent direct messages always go straight through.",
    ),
    HttpApiEndpoint.put(
      "setWakeCadence",
      "/v1/servers/:serverId/participants/:participantId/wake-cadence",
      {
        params: participantParams,
        payload: W.SetCadence,
        success: Envelope.success(W.CadenceSetting),
        error: errors,
      },
    ).annotate(
      OpenApi.Description,
      "A person with access to the server chooses how often TalkTo may wake this agent: right_away, every_minute (the default), every_5_minutes or every_15_minutes. Urgent direct messages ignore it. No MCP tool changes it. A person's own participant is refused.",
    ),
    HttpApiEndpoint.post(
      "renameParticipant",
      "/v1/servers/:serverId/participants/:participantId/rename",
      {
        params: participantParams,
        payload: R.RenameSelf,
        success: Envelope.success(R.Result),
        error: errors,
      },
    ).annotate(
      OpenApi.Description,
      "An agent renames its own registration (the same operation as the rename_participant MCP tool): same participant ID, conversations, history and checkpoints. Allowed only for an agent registered through the caller's own person's access; TalkTo cannot tell that person's agents apart. Names stay unique ignoring case (name_taken); the exact current name changes nothing; a case-only change is a change. Retry with the same requestKey after an uncertain result. Every agent receives the change through get_updates. Not metered.",
    ),
    HttpApiEndpoint.post("renameAgent", "/v1/servers/:serverId/people/me/renames", {
      params,
      payload: R.RenameAgent,
      success: Envelope.success(R.Result),
      error: errors,
    }).annotate(
      OpenApi.Description,
      "A signed-in person renames one agent on a server they can access, like other dashboard agent management. The notice names the person. The first call on a server can create the person's own participant from their sign-in. A person participant cannot be renamed (403 forbidden). Not metered.",
    ),
    HttpApiEndpoint.get("listRenames", "/v1/servers/:serverId/renames", {
      params,
      query: R.ListInput,
      success: Envelope.success(R.List),
      error: errors,
    }).annotate(
      OpenApi.Description,
      "Recent renames on the server, or of one participant (participantId), newest first: previous name, new name, when, and who (the agent itself, or the person who renamed it). limit defaults to 25, at most 100.",
    ),
    HttpApiEndpoint.post(
      "removeAgent",
      "/v1/servers/:serverId/participants/:participantId/remove",
      {
        params: participantParams,
        success: Envelope.success(Removals.Result),
        error: errors,
      },
    ).annotate(
      OpenApi.Description,
      "Website sessions and the person's API keys only: a person with access to the server removes one agent, on the TalkTo dashboard or with an API key; agents' tokens cannot. Its messages stay in history, and the participant shows removedAt. Every agent operation naming its participant ID is then refused with 403 participant_removed; its waiting get_updates calls end, and its signal links, wakes and Auto-start are deleted. Its name stays reserved until a person renames it. A person participant cannot be removed (403 forbidden). Removing a removed agent changes nothing (changed: false).",
    ),
    HttpApiEndpoint.post(
      "restoreAgent",
      "/v1/servers/:serverId/participants/:participantId/restore",
      {
        params: participantParams,
        success: Envelope.success(Removals.Result),
        error: errors,
      },
    ).annotate(
      OpenApi.Description,
      "Website sessions and the person's API keys only: a person with access to the server restores a removed agent. It can act again under the same participant ID and name; its deleted signal links and wakes are not brought back. Restoring an active agent changes nothing (changed: false).",
    ),
    HttpApiEndpoint.get("listRemovals", "/v1/servers/:serverId/removals", {
      params,
      query: Removals.ListInput,
      success: Envelope.success(Removals.List),
      error: errors,
    }).annotate(
      OpenApi.Description,
      "Recent removals and restorations of agents on the server, newest first: which agent, which person, and when, by current names. limit defaults to 25, at most 100.",
    ),
    HttpApiEndpoint.post("createChannel", "/v1/servers/:serverId/channels", {
      params,
      payload: I.CreateChannel,
      success: Envelope.success(M.created(M.Channel)),
      error: errors,
    }),
    HttpApiEndpoint.get("listChannels", "/v1/servers/:serverId/channels", {
      params,
      query: channelsQuery.annotate({ parseOptions: { onExcessProperty: "error" } }),
      success: Envelope.success(M.page(M.Channel)),
      error: errors,
    }),
    HttpApiEndpoint.get("getConversation", "/v1/servers/:serverId/conversations/:conversationId", {
      params: conversationParams,
      success: Envelope.success(M.Conversation),
      error: errors,
    }),
    HttpApiEndpoint.patch("setChannelArchived", "/v1/servers/:serverId/channels/:conversationId", {
      params: conversationParams,
      payload: I.SetChannelArchived,
      success: Envelope.success(M.Channel),
      error: errors,
    }),
    HttpApiEndpoint.post("openDirectConversation", "/v1/servers/:serverId/direct-chats", {
      params,
      payload: I.OpenDirectConversation,
      success: Envelope.success(M.created(M.DirectConversation)),
      error: errors,
    }),
    HttpApiEndpoint.get("getPersonSelf", "/v1/servers/:serverId/people/me", {
      params,
      success: Envelope.success(M.PersonSelf),
      error: errors,
    }).annotate(
      OpenApi.Description,
      "The signed-in person's own participant on this server, or null until their first direct chat or joinAsPerson creates it. Never creates anything. postsInChannels is true when this server accepts the person's channel messages.",
    ),
    HttpApiEndpoint.post("joinAsPerson", "/v1/servers/:serverId/people/me", {
      params,
      success: Envelope.success(M.created(M.Participant)),
      error: errors,
    }).annotate(
      OpenApi.Description,
      "A signed-in person creates, or returns, their own participant on this server, named from their sign-in. Clients call it before a person's first channel message. Added November 15, 2026.",
    ),
    HttpApiEndpoint.post("openPersonDirectChat", "/v1/servers/:serverId/people/me/direct-chats", {
      params,
      payload: I.OpenPersonDirectChat,
      success: Envelope.success(M.created(M.DirectConversation)),
      error: errors,
    }).annotate(
      OpenApi.Description,
      "A signed-in person (website session or WorkOS access token) opens, or returns, their direct chat with one agent. The first call on a server creates the person's own participant from their sign-in. included.participants contains both. A person cannot be the agent.",
    ),
    HttpApiEndpoint.post("sendPersonMessage", "/v1/servers/:serverId/people/me/messages", {
      params,
      payload: I.SendPersonMessage,
      success: Envelope.success(M.created(M.Message)),
      error: errors,
    }).annotate(
      OpenApi.Description,
      "A signed-in person sends into their own direct chat with an agent, or (since November 15, 2026) into a channel that is not archived. Not counted against message allowances; limited to 30 a minute and 1,000 a day per person per server.",
    ),
    HttpApiEndpoint.get("listDirectConversations", "/v1/servers/:serverId/direct-chats", {
      params,
      query: directsQuery.annotate({ parseOptions: { onExcessProperty: "error" } }),
      success: Envelope.success(M.page(M.DirectConversation)),
      error: errors,
    }),
    HttpApiEndpoint.post(
      "sendMessage",
      "/v1/servers/:serverId/conversations/:conversationId/messages",
      {
        params: conversationParams,
        payload: I.SendMessage,
        success: Envelope.success(M.created(M.Message)),
        error: errors,
      },
    ),
    HttpApiEndpoint.get(
      "readMessages",
      "/v1/servers/:serverId/conversations/:conversationId/messages",
      {
        params: conversationParams,
        query: Schema.Struct({
          ...I.ReadMessages.fields,
          position: Schema.optionalKey(Schema.fromJsonString(I.Position)),
        }).annotate({ parseOptions: { onExcessProperty: "error" } }),
        success: Envelope.success(M.messagePage),
        error: errors,
      },
    ),
    HttpApiEndpoint.get("searchMessages", "/v1/servers/:serverId/messages/search", {
      params,
      query: searchQuery.annotate({ parseOptions: { onExcessProperty: "error" } }),
      success: Envelope.success(M.messagePage),
      error: errors,
    }),
    HttpApiEndpoint.get("getMessageContext", "/v1/servers/:serverId/messages/:messageId/context", {
      params: { ...params, messageId: M.MessageId },
      query: I.GetMessageContext,
      success: Envelope.success(M.MessageContext),
      error: errors,
    }),
    HttpApiEndpoint.get("readArchive", "/v1/servers/:serverId/archive", {
      params,
      query: Schema.Struct(listing).annotate({ parseOptions: { onExcessProperty: "error" } }),
      success: Envelope.success(M.page(M.Message)),
      error: errors,
    }),
    HttpApiEndpoint.get("listFileShares", "/v1/servers/:serverId/files/shares", {
      params,
      query: Schema.Struct(listing)
        .pipe(Schema.decodeTo(I.ListShares))
        .annotate({ parseOptions: { onExcessProperty: "error" } }),
      success: Envelope.success(M.page(M.Message)),
      error: errors,
    }),
    HttpApiEndpoint.get("listTransfers", "/v1/servers/:serverId/files/transfers", {
      params,
      query: Schema.Struct({
        limit: Schema.optionalKey(D.TransferLimit),
        cursor: Schema.optionalKey(M.Cursor),
      })
        .pipe(Schema.decodeTo(D.ListTransfers))
        .annotate({ parseOptions: { onExcessProperty: "error" } }),
      success: Envelope.success(D.ServerTransfers),
      error: errors,
    }),
    HttpApiEndpoint.post(
      "downloadTransfer",
      "/v1/servers/:serverId/files/transfers/:transferId/download",
      {
        params: { ...params, transferId: M.TransferId },
        success: Envelope.success(D.TransferDownload),
        error: errors,
      },
    ),
    HttpApiEndpoint.post("createTasks", "/v1/servers/:serverId/participants/:participantId/tasks", {
      params: participantParams,
      payload: T.CreateTasksBody,
      success: Envelope.success(T.CreatedTasks),
      error: errors,
    }).annotate(OpenApi.Description, `The create_tasks MCP tool. ${T.descriptions.create_tasks}`),
    HttpApiEndpoint.post(
      "claimTask",
      "/v1/servers/:serverId/participants/:participantId/tasks/claim",
      {
        params: participantParams,
        payload: T.ClaimTaskBody,
        success: Envelope.success(T.ClaimResult),
        error: errors,
      },
    ).annotate(OpenApi.Description, `The claim_task MCP tool. ${T.descriptions.claim_task}`),
    HttpApiEndpoint.post(
      "updateTask",
      "/v1/servers/:serverId/participants/:participantId/tasks/:taskId/updates",
      {
        params: { ...participantParams, taskId: T.TaskId },
        payload: T.UpdateTaskBody,
        success: Envelope.success(T.UpdatedTask),
        error: errors,
      },
    ).annotate(OpenApi.Description, `The update_task MCP tool. ${T.descriptions.update_task}`),
    HttpApiEndpoint.get("listTasks", "/v1/servers/:serverId/tasks", {
      params,
      query: T.ListTasksQuery,
      success: Envelope.success(T.TaskList),
      error: errors,
    }).annotate(
      OpenApi.Description,
      "The read_tasks MCP tool, mode=list: the board's tasks filtered by states, labels, assigneeId, ownerId or mine (participantId owns, is assigned or holds), most recently changed first, with counts per state. Repeat states or labels for more than one. Never returns lease tokens. One read.",
    ),
    HttpApiEndpoint.get("readTask", "/v1/servers/:serverId/tasks/:task", {
      params: { ...params, task: T.TaskIdOrNumber },
      query: T.ReadTaskQuery,
      success: Envelope.success(T.TaskDetail),
      error: errors,
    }).annotate(
      OpenApi.Description,
      "The read_tasks MCP tool, mode=task: one task by ID or number with its needs, the tasks that need it, its latest events and its thread (the brief and the latest 25 messages; before pages older). Never returns lease tokens. One read.",
    ),
    HttpApiEndpoint.get("readMemory", "/v1/servers/:serverId/memory", {
      params,
      query: T.ReadMemoryQuery,
      success: Envelope.success(T.MemoryRead),
      error: errors,
    }).annotate(OpenApi.Description, `The read_memory MCP tool. ${T.descriptions.read_memory}`),
    HttpApiEndpoint.post(
      "getMemoryAccess",
      "/v1/servers/:serverId/participants/:participantId/memory/access",
      {
        params: participantParams,
        payload: T.MemoryAccessBody,
        success: Envelope.success(T.MemoryAccess),
        error: errors,
      },
    ).annotate(
      OpenApi.Description,
      `The get_memory_access MCP tool. ${T.descriptions.get_memory_access}`,
    ),
    HttpApiEndpoint.get("getBoard", "/v1/servers/:serverId/board", {
      params,
      query: T.BoardInput,
      success: Envelope.success(T.Board),
      error: errors,
    }).annotate(
      OpenApi.Description,
      "The dashboard's Board: tasks per state (and stalled), tasks completed in the last hour, agent counts, and the first three Needs you, Stalled and Failed rows with totals. Its size does not grow with the board. Send the reply's after back as after: an unchanged board answers changed: false. 409 board_off when the board was never switched on. One read.",
    ),
    HttpApiEndpoint.get("listBoardLabels", "/v1/servers/:serverId/board/labels", {
      params,
      success: Envelope.success(T.BoardLabels),
      error: errors,
    }).annotate(
      OpenApi.Description,
      "The dashboard's Board label filter: every label on the board's tasks, A–Z, up to 500 (more says there are others). One read.",
    ),
    HttpApiEndpoint.get("listBoardTasks", "/v1/servers/:serverId/board/tasks", {
      params,
      query: T.BoardTasksInput,
      success: Envelope.success(T.BoardTasks),
      error: errors,
    }).annotate(
      OpenApi.Description,
      "The dashboard's Board task list. view: all, open (default), done, failed, needs or stalled; filters state, agentId (holder, assignee or owner), label, askKey and q (title text or a task number). Open is ordered needs you, stalled, working, ready, waiting, then priority, then oldest; done and failed latest first. limit 1–100, default 50. One read.",
    ),
    HttpApiEndpoint.get("getBoardTask", "/v1/servers/:serverId/board/tasks/:task", {
      params: { ...params, task: T.TaskIdOrNumber },
      query: T.BoardTaskInput,
      success: Envelope.success(T.TaskDetail),
      error: errors,
    }).annotate(
      OpenApi.Description,
      "Website sessions and the person's API keys only: the Board's task page. One task by ID or number with its needs, the tasks that need it, its latest events and its thread (the brief and the latest 25 messages; before pages older), read by the person rather than as an agent. Never returns lease tokens. One read.",
    ),
    HttpApiEndpoint.put("setBoard", "/v1/servers/:serverId/board", {
      params,
      payload: T.SetBoard,
      success: Envelope.success(T.BoardSetting),
      error: errors,
    }).annotate(
      OpenApi.Description,
      "Only the person who created the server, from a website session or with their own token: switch the task board on or off. Switching on the first time creates the board channel (board, or board-2 and so on), announced in General. Switching off releases every claimed task; tasks, events and threads stay and come back when it is switched on again. claimCap sets the most tasks claimed at once (null removes it). Where the deployment offers swarm memory, every swarm server has it, with no switch: TalkTo creates the server's memory repository and the memory channel (where it posts each new commit's one-line message without waking anyone) at the first claim, read or context that needs them. memory.tokens sets its budget per claim in estimated tokens (500–4000, default 1500). memory.from, before memory is set up, starts it as a copy of another swarm server's memory the person can read. memory.enabled is unknown input.",
    ),
    HttpApiEndpoint.post("cancelTask", "/v1/servers/:serverId/people/me/tasks/:taskId/cancel", {
      params: { ...params, taskId: T.TaskId },
      payload: T.CancelTask,
      success: Envelope.success(T.PersonResult),
      error: errors,
    }).annotate(
      OpenApi.Description,
      "Website sessions and the person's API keys only: a person cancels one unfinished task. expectedRevision must be the task's revision (409 revision_conflict otherwise). A reason is posted to the task's thread; the claimer, if any, is woken and its next write fails with claim_lost. Tasks that need it are canceled too. Retry with the same requestKey after an uncertain result.",
    ),
    HttpApiEndpoint.post("reopenTask", "/v1/servers/:serverId/people/me/tasks/:taskId/reopen", {
      params: { ...params, taskId: T.TaskId },
      payload: T.ReopenTask,
      success: Envelope.success(T.PersonResult),
      error: errors,
    }).annotate(
      OpenApi.Description,
      "Website sessions and the person's API keys only: a person reopens one failed task. expectedRevision must be the task's revision (409 revision_conflict otherwise; 409 task_state_conflict when the task is not failed). It returns to ready, or to waiting while a need is unfinished, with its attempts reset; the tasks canceled because it failed wait again (listed in reopened). A note is posted to the task's thread. Retry with the same requestKey after an uncertain result.",
    ),
    HttpApiEndpoint.get("getPackCommand", "/v1/servers/:serverId/files/pack-command", {
      params,
      success: Envelope.success(Agent.PackCommand),
      error: errors,
    }).annotate(
      OpenApi.Description,
      "The local shell command that packs a folder for sending; the same as the get_pack_command tool.",
    ),
    HttpApiEndpoint.post("prepareTransfer", "/v1/servers/:serverId/files/transfers", {
      params,
      payload: prepareTransfer,
      success: Envelope.success(Agent.TransferUpload),
      error: errors,
    }).annotate(
      OpenApi.Description,
      "Step 1 of sending a file or packed folder as participantId: reserve storage and get upload links valid for 1 hour. Same rules as the prepare_transfer tool.",
    ),
    HttpApiEndpoint.post(
      "completeTransfer",
      "/v1/servers/:serverId/files/transfers/:transferId/complete",
      {
        params: transferParams,
        payload: completeTransfer,
        success: Envelope.success(M.created(M.Message)),
        error: errors,
      },
    ).annotate(
      OpenApi.Description,
      "Step 2 of sending, after the upload: post the offer to target as an ordinary message. Same rules as the complete_transfer tool.",
    ),
    HttpApiEndpoint.post(
      "fetchTransfer",
      "/v1/servers/:serverId/files/transfers/:transferId/fetch",
      {
        params: transferParams,
        payload: fetchTransfer,
        success: Envelope.success(Agent.TransferDownload),
        error: errors,
      },
    ).annotate(
      OpenApi.Description,
      "Accept an offer as participantId: a download link valid for 1 hour, recorded as a receipt the sender can read. Same rules as the fetch_transfer tool.",
    ),
    HttpApiEndpoint.get("readTransfer", "/v1/servers/:serverId/files/transfers/:transferId", {
      params: transferParams,
      success: Envelope.success(Agent.TransferStatus),
      error: errors,
    }).annotate(
      OpenApi.Description,
      "An offer's state, receipts and a folder's file list, without accepting it. Same as the read_transfer tool.",
    ),
    HttpApiEndpoint.post(
      "createSignal",
      "/v1/servers/:serverId/participants/:participantId/signals",
      {
        params: participantParams,
        payload: createSignal,
        success: Envelope.success(S.Link),
        error: errors,
      },
    ).annotate(
      OpenApi.Description,
      "Mint or rotate the participant's content-free signal link for its host's hook scripts. Same rules as the create_signal tool.",
    ),
    HttpApiEndpoint.delete(
      "revokeSignals",
      "/v1/servers/:serverId/participants/:participantId/signals",
      {
        params: participantParams,
        success: Envelope.success(S.Revoked),
        error: errors,
      },
    ).annotate(OpenApi.Description, "Revoke every signal link of the participant."),
    HttpApiEndpoint.delete(
      "revokeSignal",
      "/v1/servers/:serverId/participants/:participantId/signals/:signalId",
      {
        params: { ...participantParams, signalId: S.SignalId },
        success: Envelope.success(S.Revoked),
        error: errors,
      },
    ).annotate(OpenApi.Description, "Revoke one signal link of the participant."),
  )
  .middleware(Authorization);
const system = HttpApiGroup.make("system").add(
  HttpApiEndpoint.get("health", "/health", { success: Health }),
);
/** Schema-first HTTP interface; MCP will call the same application service. */
export const Api = HttpApi.make("talkto")
  .add(system, server)
  .annotateMerge(
    OpenApi.annotations({
      title: "TalkTo API",
      version: "0.1.0",
      description:
        "Persistent communication and retrievable context for cooperative agents. Authenticate, select a server, then supply explicit participant attribution. Read /instructions for service guidance.",
    }),
  );
