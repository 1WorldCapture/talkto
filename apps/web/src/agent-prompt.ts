import type * as M from "@talkto/api/models";

/**
 * The short message a person pastes into an agent so it joins one server under its own name. The
 * MCP server's instructions and /instructions carry the rest of the procedure, so this only names
 * the server, the invitation key and the identity rule.
 */
export function agentPrompt({
  server,
  mcpUrl,
  invitation,
}: {
  readonly server: { readonly id: string; readonly name: string };
  readonly mcpUrl: string;
  readonly invitation?: {
    readonly requestKey: M.RequestKey;
    /** What the person picked; the agent still reports the app it actually runs in. */
    readonly agentType: typeof M.AgentType.Type | null;
  };
}): string {
  const register = invitation
    ? invited(server.id, invitation.agentType, invitation.requestKey)
    : newParticipant(server.id, null);
  return joinSteps(
    server,
    `If you don't have TalkTo's tools, connect ${mcpUrl} and ask me to sign in.`,
    register,
    mcpUrl,
  );
}

/**
 * The tool a person picked on the join page or in setup: its name, its install file on this
 * deployment (/agents/<id>.md) and the agentType it reports. Null for "Another tool", which
 * connects the MCP address itself.
 */
type PickedTool = {
  readonly name: string;
  readonly installUrl: string;
  /** A hint only; the agent reports the app it actually runs in. */
  readonly agentType: string | null;
} | null;

/**
 * The one prompt on an invitation's join page (/app/join/<id>): install TalkTo in the picked tool
 * when the agent has no TalkTo tools, wait for the person's sign-in, then join like agentPrompt.
 * It names the server and its ID, never the invitation: it holds no secret.
 */
export function joinPrompt({
  server,
  mcpUrl,
  tool,
}: {
  readonly server: { readonly id: string; readonly name: string };
  readonly mcpUrl: string;
  readonly tool: PickedTool;
}): string {
  return joinSteps(
    server,
    install(tool, mcpUrl),
    newParticipant(server.id, tool?.agentType ?? null),
    mcpUrl,
  );
}

/**
 * Setup's one message for an agent (onboarding.tsx): the join page's prompt, except that it joins
 * with the slot's request key, so setup sees exactly this agent arrive. The install file
 * (/agents/<id>.md) tells the agent not to join until the person sends a join prompt; this message
 * says it is that message, in the same words as the invitation join page.
 */
export function setupPrompt({
  server,
  mcpUrl,
  tool,
  requestKey,
}: {
  readonly server: { readonly id: string; readonly name: string };
  readonly mcpUrl: string;
  readonly tool: PickedTool;
  readonly requestKey: M.RequestKey;
}): string {
  return joinSteps(
    server,
    install(tool, mcpUrl),
    invited(server.id, tool?.agentType ?? null, requestKey),
    mcpUrl,
  );
}

const install = (tool: PickedTool, mcpUrl: string) =>
  tool === null
    ? `If you don't have TalkTo's tools, connect ${mcpUrl}. Then ask me to sign in, and wait until I have.`
    : `If you don't have TalkTo's tools, install TalkTo in ${tool.name}: read ${tool.installUrl} and follow it. Then ask me to sign in, and wait until I have. The guide says to wait for a message from me about joining a server; this is that message. Once I have signed in, continue with step 2 below.`;

const agentTypeHint = (selected: string | null) =>
  selected === null
    ? "your agentType (the app you run in)"
    : `your agentType (${JSON.stringify(selected)}, or the app you actually run in)`;

const invited = (serverId: string, selected: string | null, requestKey: M.RequestKey) =>
  `Call register_participant with serverId ${JSON.stringify(serverId)}, your name, ${agentTypeHint(selected)} and requestKey ${JSON.stringify(requestKey)}. Keep the same values if you retry.`;

const newParticipant = (serverId: string, selected: string | null) =>
  `If this task already joined this server, reuse that participant. Otherwise call register_participant with serverId ${JSON.stringify(serverId)}, your name, ${agentTypeHint(selected)} and a new requestKey; keep the same values if you retry.`;

/**
 * The join procedure every prompt shares; only the first and third steps differ. Step 5 has the
 * agent set up its own delivery from the guide ("Verify access and join", then "Keep up while
 * working"): what wakes it, what waits, and which channels to watch in full, so the prompt needs
 * no tool-by-tool steps and stays short.
 */
const joinSteps = (
  server: { readonly id: string; readonly name: string },
  connect: string,
  register: string,
  mcpUrl: string,
) => `Join my TalkTo server ${JSON.stringify(server.name)} (ID ${server.id}).

1. ${connect}
2. Use the name I gave you, or choose one unique to this project and machine, plus your role if it helps, like billing-web-macbook or search-api-desktop. Start with a letter; letters, numbers, - and _ only; up to 64 characters.
3. ${register}
4. Use your own identity. Never use another task's participant.
5. Read ${new URL("/instructions", mcpUrl).toString()}, save its short note about TalkTo, and set up how new messages reach you, as it says for your tool. Tell me the name you joined with, where you saved the note, and how new messages will reach you.`;

/**
 * Asks an agent to install TalkTo in the tool it runs in. The install file (/agents/<id>.md, from
 * the same recipe) explains TalkTo and every detail; the guide's commands follow inline in case the
 * agent cannot open it. It never signs in or joins a server itself.
 */
export function installPrompt({
  tool,
  url,
  commands,
  yours,
}: {
  readonly tool: string;
  /** The tool's install file on this deployment. */
  readonly url: string;
  /** The guide's commands, in order, exactly as it gives them. */
  readonly commands: ReadonlyArray<string>;
  /** What the person does afterwards, in the guide's words. */
  readonly yours: ReadonlyArray<string>;
}): string {
  const plain = (text: string) => text.replaceAll("**", "");
  return `Install TalkTo in ${tool} for me: read ${url} and follow it.

If you can't open it, run these commands in your shell, in order:

${commands.join("\n")}

Don't sign in or join a TalkTo server yet. When you finish, tell me what I have to do myself:
${yours.map((step) => `- ${plain(step)}`).join("\n")}`;
}
