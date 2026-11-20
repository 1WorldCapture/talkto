import { Schema } from "effect";
import * as M from "./models.js";

/**
 * Renaming keeps a participant's ID, conversations, history and checkpoints; only its server-local
 * name changes. Every change is recorded as a notice that `get_updates` delivers to every agent,
 * whatever it watches, and that people see in the server's Activity view.
 */
/** Stable MCP tool name for an agent renaming itself. */
export const toolName = "rename_participant";
/** Most notices one listing or one `get_updates` page returns. */
export const maxNotices = 100;

/** Stable identity of one recorded rename. */
export const RenameId = Schema.String.check(
  Schema.isUUID(4),
  Schema.isPattern(/^[0-9a-f-]+$/),
).pipe(Schema.brand("RenameId"));
/** Parsed rename identity. */
export type RenameId = typeof RenameId.Type;

/**
 * Who made the change. `self` means it came through an agent operation naming this participant,
 * which only connections of the person who registered the agent may do; TalkTo cannot tell which
 * of that person's agents called. `person` names the signed-in person who renamed it on the
 * dashboard, by their participant's current name.
 */
export const RenamedBy = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("self") }),
  Schema.Struct({
    kind: Schema.Literal("person"),
    participantId: M.ParticipantId,
    name: M.Name,
  }),
]).annotate({ identifier: "RenamedBy" });
/** Parsed actor. */
export type RenamedBy = typeof RenamedBy.Type;

/**
 * One name change: the same participant, its previous name and its new name. `sequence` shares the
 * message sequence, so a `get_updates` checkpoint orders renames and messages together.
 */
export const Rename = Schema.Struct({
  id: RenameId,
  sequence: M.Count,
  participantId: M.ParticipantId,
  previousName: M.Name,
  name: M.Name,
  renamedAt: M.Timestamp,
  renamedBy: RenamedBy,
}).annotate({ identifier: "ParticipantRename" });
/** Parsed rename notice. */
export interface Rename extends Schema.Schema.Type<typeof Rename> {}

const strict = { parseOptions: { onExcessProperty: "error" } } as const;
/** An agent renames its own registration (HTTP payload; the participant is in the path). */
export const RenameSelf = Schema.Struct({
  name: M.Name,
  requestKey: M.RequestKey,
}).annotate(strict);
/** Parsed self-rename. */
export interface RenameSelf extends Schema.Schema.Type<typeof RenameSelf> {}
/** A signed-in person renames one agent on a server they can access. */
export const RenameAgent = Schema.Struct({
  agentId: M.ParticipantId,
  name: M.Name,
  requestKey: M.RequestKey,
}).annotate(strict);
/** Parsed person rename. */
export interface RenameAgent extends Schema.Schema.Type<typeof RenameAgent> {}

/**
 * The participant's current profile and the recorded change. `changed` is true only on the call
 * that changed the name: a retry returns the original `rename` with `changed: false` and never
 * restores an older name; submitting the exact current name changes nothing (`rename: null`).
 */
export const Result = Schema.Struct({
  participant: M.Participant,
  rename: Schema.NullOr(Rename),
  changed: Schema.Boolean,
}).annotate({ identifier: "RenameResult" });
/** Parsed rename result. */
export interface Result extends Schema.Schema.Type<typeof Result> {}

/** Recent renames on a server, optionally for one participant, newest first. */
export const ListInput = Schema.Struct({
  participantId: Schema.optionalKey(M.ParticipantId),
  limit: Schema.optionalKey(M.Limit),
}).annotate(strict);
/** Parsed listing request. */
export interface ListInput extends Schema.Schema.Type<typeof ListInput> {}
/** Newest first, at most `limit` (default 25, at most 100). */
export const List = Schema.Struct({ items: Schema.Array(Rename) }).annotate({
  identifier: "RenameList",
});
/** Parsed listing. */
export interface List extends Schema.Schema.Type<typeof List> {}
