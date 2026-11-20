import type * as W from "@talkto/api/wake";
import type { Adapter } from "./kind.js";
import * as McpEvents from "./mcp-events.js";
import * as ClaudeRoutine from "./claude-routine.js";
import * as GrokBot from "./grok-bot.js";
import * as Town from "./town.js";

/**
 * Every host TalkTo can wake. The pasted-token hosts are separate modules behind the same
 * plumbing: dropping one means deleting its module, this entry, and its `TokenKind` literal.
 */
export const adapters = {
  mcp_events: McpEvents.adapter,
  claude_routine: ClaudeRoutine.adapter,
  grok_bot: GrokBot.adapter,
  town: Town.adapter,
} satisfies { readonly [K in W.Kind]: Adapter };
