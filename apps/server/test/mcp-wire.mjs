import { randomUUID } from "node:crypto";

/** Real protocol request, including 2026 per-request metadata and routing headers. */
export function rpc(method, params = {}, token, version = "2026-07-28") {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (version === "2026-07-28") {
    headers["MCP-Protocol-Version"] = version;
    headers["Mcp-Method"] = method;
    if (method === "tools/call") headers["Mcp-Name"] = params.name;
    if (method === "resources/read") headers["Mcp-Name"] = params.uri;
    if (method.startsWith("events/") && params.name !== undefined)
      headers["Mcp-Name"] = params.name;
    params = {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": version,
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "TalkTo integration test", version: "1.0.0" },
      },
    };
  } else headers["MCP-Protocol-Version"] = version;
  return {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
  };
}

/** Legacy Streamable HTTP may deliver a finite SSE result instead of JSON. */
export async function packet(response) {
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const messages = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    const result = messages.find(
      (message) => message.result !== undefined || message.error !== undefined,
    );
    if (result === undefined) throw new Error("Missing SSE result");
    return result;
  }
  return JSON.parse(text);
}
