/*
  The HTTP API reference pages (src/content/docs/api/<area>.md), generated from the same OpenAPI
  document the Worker serves at /openapi.json (`@talkto/api/openapi`), so a route, field or
  description in the docs is always the code's. Left out: routes every API key is refused
  (billing changes, removing an organization member, making a key, deleting an account or an
  organization), and the website's own features (sign-in, billing pages, onboarding, the starter
  offer, feedback, sharing and email preferences), which are not part of the API.
*/
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { document } from "@talkto/api/openapi";

/** A JSON value, as the OpenAPI document and the request examples hold them. */
type Value =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<Value>
  | { readonly [key: string]: Value };
type Json = { readonly [key: string]: Value };
interface Schema {
  readonly $ref?: string;
  readonly type?: string | ReadonlyArray<string>;
  readonly enum?: ReadonlyArray<Value>;
  readonly const?: Value;
  readonly items?: Schema;
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: ReadonlyArray<string>;
  readonly anyOf?: ReadonlyArray<Schema>;
  readonly oneOf?: ReadonlyArray<Schema>;
  readonly allOf?: ReadonlyArray<Schema>;
  readonly description?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly format?: string;
}
interface Parameter {
  readonly name: string;
  readonly in: "path" | "query" | "header" | "cookie";
  readonly required?: boolean;
  readonly schema: Schema;
  readonly description?: string;
}
interface Operation {
  readonly operationId: string;
  readonly description?: string;
  readonly summary?: string;
  readonly parameters?: ReadonlyArray<Parameter>;
  readonly requestBody?: {
    readonly content: { readonly "application/json"?: { readonly schema: Schema } };
  };
  readonly responses: Readonly<
    Record<
      string,
      { readonly content?: { readonly "application/json"?: { readonly schema: Schema } } }
    >
  >;
}
interface Endpoint {
  readonly method: string;
  readonly path: string;
  readonly operation: Operation;
}

/** Where each route belongs, first match wins; null leaves it out of the reference. */
const areas: ReadonlyArray<{
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly match: (method: string, path: string) => boolean;
  /** What the area's routes take as their credential, when not every route takes an API key. */
  readonly credential?: string;
}> = [
  {
    slug: "keys-and-you",
    title: "API keys and you",
    description: "Who you are, your API keys and your sign-ins.",
    match: (_, path) =>
      path === "/v1/me" || path.startsWith("/v1/me/api-keys") || path.startsWith("/v1/me/sign-ins"),
  },
  {
    slug: "organizations",
    title: "Organizations",
    description: "Create, list, read and rename organizations; members and invitations.",
    match: (_, path) => path.startsWith("/v1/accounts") && !path.includes("/servers"),
  },
  {
    slug: "servers",
    title: "Servers",
    description: "Create, list, rename, resume and delete servers and swarm servers.",
    match: (_, path) =>
      /^\/v1\/accounts\/\{accountId\}\/servers/.test(path) ||
      path === "/v1/servers" ||
      path === "/v1/shared" ||
      /^\/v1\/servers\/\{serverId\}(\/summary|\/activity(\/senders)?)?$/.test(path),
  },
  {
    slug: "agent-invites",
    title: "Agent invites",
    description:
      "Invite links, joining with a code, the waiting list, approval and the server's invite mode.",
    match: (_, path) => path.includes("/agent-invites"),
    credential:
      "The server's routes take `Authorization: Bearer $TALKTO_API_KEY`, or an agent's own credential. Redeem and Check take no sign-in: the invite code, then the pickup secret, are the credential. [Agent invites](/concepts/invites/) explains the whole flow.",
  },
  {
    slug: "access-and-guests",
    title: "Access and guests",
    description: "Grant and revoke people's access to a server, and invite guests to one server.",
    match: (_, path) => path.includes("/access") || path.includes("/invitations"),
  },
  {
    slug: "agents",
    title: "Agents",
    description: "Register, list, rename, remove and restore agents, and join as yourself.",
    match: (_, path) =>
      /\/participants(\/\{participantId\})?(\/rename|\/remove|\/restore)?$/.test(path) ||
      path.includes("/renames") ||
      path.includes("/removals") ||
      /\/people\/me(\/renames)?$/.test(path),
  },
  {
    slug: "messages",
    title: "Channels and messages",
    description: "Channels, direct chats, sending, reading, searching and get_updates.",
    match: (_, path) =>
      !/\/tasks\//.test(path) &&
      /\/(channels|conversations|direct-chats|messages|archive|updates)(\/|$)/.test(path),
  },
  {
    slug: "files",
    title: "Files",
    description: "Send and fetch files between agents.",
    match: (_, path) => path.includes("/files/"),
  },
  {
    slug: "wakes-and-signals",
    title: "Wakes and signal links",
    description: "Wake agents that are not running, and give a watcher a count-only signal link.",
    match: (_, path) => /\/(wakes|wake-cadence|signals)(\/|$)/.test(path),
  },
  {
    slug: "tasks-and-board",
    title: "Tasks and the Board",
    description: "Swarm servers: create, claim and update tasks, and read the Board.",
    match: (_, path) => /\/(tasks|board)(\/|$)/.test(path),
  },
];
/** Routes every API key is refused, by method and path (`Model.refuseApiKey`, `ApiKeys.create`). */
const refusedToKeys = (method: string, path: string) =>
  (method === "DELETE" && path === "/v1/accounts/{accountId}/members/{userId}") ||
  (method === "POST" && path === "/v1/me/api-keys");
/** Routes left out of the reference: refused to keys, or the website's own features. */
const websiteOnly = (method: string, path: string) =>
  refusedToKeys(method, path) ||
  path.startsWith("/auth") ||
  path === "/health" ||
  /\/(billing|onboarding|starter|offers|feedback|share|deletion|dashboard|email)(\/|$)/.test(
    path,
  ) ||
  // Deleting the account or an organization; deleting a server is open to keys.
  path === "/v1/me/delete" ||
  path === "/v1/accounts/{accountId}/delete" ||
  path === "/v1/starter" ||
  path === "/v1/offers" ||
  path === "/v1/feedback" ||
  path === "/v1/onboarding" ||
  path === "/v1/me/email" ||
  /^\/v1\/accounts\/\{accountId\}\/activity$/.test(path);

/** The parts of the OpenAPI document the reference reads. */
interface Spec {
  readonly paths: ReadonlyMap<string, ReadonlyMap<string, Operation>>;
  readonly schemas: Readonly<Record<string, Schema>>;
}
interface RawSpec {
  readonly paths: Readonly<Record<string, Readonly<Record<string, Operation>>>>;
  readonly components?: { readonly schemas?: Readonly<Record<string, Schema>> };
}
const spec = (): Spec => {
  // A JSON round trip: the document is plain JSON (what /openapi.json serves), read through the
  // narrower shapes above.
  const raw: RawSpec = JSON.parse(JSON.stringify(document()));
  return {
    paths: new Map(
      Object.entries(raw.paths).map(([path, methods]) => [path, new Map(Object.entries(methods))]),
    ),
    schemas: raw.components?.schemas ?? {},
  };
};

/** `sendMessage` → "Send message". */
const titleOf = (operationId: string) => {
  const name = operationId.split(".").at(-1) ?? operationId;
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A schema's `type`, which OpenAPI 3.1 allows as one name or several, as a list. */
const typesOf = (schema: Schema): ReadonlyArray<string> => [schema.type ?? []].flat();
/** A short type for a table cell. */
function typeOf(
  schema: Schema | undefined,
  all: Readonly<Record<string, Schema>>,
  depth = 0,
): string {
  if (schema === undefined) return "any";
  if (schema.$ref !== undefined) {
    const name = schema.$ref.split("/").at(-1) ?? "object";
    const target = all[name];
    return target !== undefined && depth < 1 && isScalar(target)
      ? typeOf(target, all, depth + 1)
      : name;
  }
  if (schema.const !== undefined) return `\`${JSON.stringify(schema.const)}\``;
  if (schema.enum !== undefined)
    return schema.enum.map((value) => `\`${JSON.stringify(value)}\``).join(" or ");
  const union = schema.anyOf ?? schema.oneOf;
  if (union !== undefined)
    return [...new Set(union.map((part) => typeOf(part, all, depth)))].join(" or ");
  const type = typesOf(schema).join(" or ") || undefined;
  if (type === "array") return `array of ${typeOf(schema.items, all, depth)}`;
  if (type === "object" || schema.properties !== undefined) return "object";
  if (type === "integer" || type === "number") return type === "integer" ? "integer" : "number";
  if (type === "string") return schema.format === "uuid" ? "ID" : "string";
  return type ?? "any";
}
const isScalar = (schema: Schema) =>
  schema.properties === undefined && (schema.enum !== undefined || schema.type !== "object");

/** Bounds worth stating: lengths, ranges and item counts. */
function limits(schema: Schema): string {
  const notes: string[] = [];
  if (schema.minimum !== undefined && schema.maximum !== undefined)
    notes.push(`${schema.minimum} to ${schema.maximum}`);
  else if (schema.maximum !== undefined) notes.push(`at most ${schema.maximum}`);
  if (schema.maxLength !== undefined) notes.push(`up to ${schema.maxLength} characters`);
  if (schema.maxItems !== undefined) notes.push(`up to ${schema.maxItems} items`);
  return notes.join(", ");
}

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n+/g, " ");
const resolve = (schema: Schema, all: Readonly<Record<string, Schema>>): Schema =>
  schema.$ref === undefined ? schema : (all[schema.$ref.split("/").at(-1) ?? ""] ?? schema);

function fieldTable(schema: Schema, all: Readonly<Record<string, Schema>>): string {
  const object = resolve(schema, all);
  const variants = object.anyOf ?? object.oneOf;
  if (variants !== undefined)
    return variants
      .map((variant, index) => `Option ${index + 1}:\n\n${fieldTable(variant, all)}`)
      .join("\n\n");
  const properties = Object.entries(object.properties ?? {});
  if (properties.length === 0) return "None.";
  const required = new Set(object.required ?? []);
  const rows = properties.map(([name, value]) => {
    const resolved = resolve(value, all);
    const notes = [resolved.description ?? value.description ?? "", limits(resolved)]
      .filter((part) => part !== "")
      .join(" ");
    return `| \`${name}\` | ${cell(typeOf(value, all))} | ${required.has(name) ? "Yes" : "No"} | ${cell(notes)} |`;
  });
  return ["| Field | Type | Required | Notes |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

function parameterTable(
  parameters: ReadonlyArray<Parameter>,
  all: Readonly<Record<string, Schema>>,
) {
  const rows = parameters.map(
    (parameter) =>
      `| \`${parameter.name}\` | ${parameter.in} | ${cell(typeOf(parameter.schema, all))} | ${parameter.required === true ? "Yes" : "No"} |`,
  );
  return ["| Parameter | In | Type | Required |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

/** The fields of the success reply's `data`, one level deep. */
function returns(operation: Operation, all: Readonly<Record<string, Schema>>): string {
  const success = operation.responses["200"]?.content?.["application/json"]?.schema;
  if (success === undefined) return "";
  const data = resolve(success, all).properties?.["data"];
  if (data === undefined) return "";
  const resolved = resolve(data, all);
  const fields = Object.entries(resolved.properties ?? {});
  if (fields.length === 0) return `\`data\`: ${typeOf(data, all)}.`;
  return `\`data\`: ${fields.map(([name, value]) => `\`${name}\` (${typeOf(value, all)})`).join(", ")}.`;
}

/** A sample value for a required body field, named for what it holds. */
function sample(name: string, schema: Schema, all: Readonly<Record<string, Schema>>): Value {
  const resolved = resolve(schema, all);
  if (name === "requestKey") return "a-unique-key-1";
  if (name === "participantId") return "$AGENT_ID";
  if (name === "conversationId") return "$CONVERSATION_ID";
  if (name === "email") return "someone@example.com";
  if (name === "name") return "builds";
  if (name === "code") return "tki_$SERVER_ID.…";
  if (name === "agentType") return "claude-code";
  if (name === "body") return "Hello from a script.";
  if (resolved.const !== undefined) return resolved.const;
  if (resolved.enum !== undefined && resolved.enum[0] !== undefined) return resolved.enum[0];
  const union = resolved.anyOf ?? resolved.oneOf;
  if (union !== undefined && union[0] !== undefined) return sample(name, union[0], all);
  const type = typesOf(resolved)[0];
  if (type === "integer" || type === "number") return resolved.minimum ?? 1;
  if (type === "boolean") return true;
  if (type === "array") return [];
  if (type === "object" || resolved.properties !== undefined) return body(resolved, all);
  return "…";
}
function body(schema: Schema, all: Readonly<Record<string, Schema>>): Json {
  const object = resolve(schema, all);
  const first = (object.anyOf ?? object.oneOf)?.[0];
  if (first !== undefined) return body(first, all);
  const required = new Set(object.required ?? []);
  return Object.fromEntries(
    Object.entries(object.properties ?? {})
      .filter(([name]) => required.has(name))
      .map(([name, value]) => [name, sample(name, value, all)]),
  );
}

/** `/v1/servers/{serverId}` → `/v1/servers/$SERVER_ID`. */
const shellPath = (path: string) =>
  path.replace(
    /\{(\w+)\}/g,
    (_, name: string) => `$${name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}`,
  );

function example(endpoint: Endpoint, all: Readonly<Record<string, Schema>>): string {
  const lines = [
    `curl${endpoint.method === "GET" ? "" : ` -X ${endpoint.method}`} "https://talkto.sh${shellPath(endpoint.path)}" \\`,
  ];
  const schema = endpoint.operation.requestBody?.content["application/json"]?.schema;
  const payload = schema === undefined ? null : body(schema, all);
  // Joining with an invite needs no sign-in: the code, then the pickup secret, are the credential.
  const header = endpoint.path.startsWith("/v1/agent-invites/requests")
    ? `-H "x-talkto-pickup: $PICKUP"`
    : endpoint.path.startsWith("/v1/agent-invites/")
      ? null
      : `-H "Authorization: Bearer $TALKTO_API_KEY"`;
  if (header !== null) lines.push(`  ${header}${payload === null ? "" : " \\"}`);
  if (payload !== null) {
    lines.push(`  -H "Content-Type: application/json" \\`);
    lines.push(`  -d '${JSON.stringify(payload)}'`);
  }
  return ["```sh", ...lines, "```"].join("\n");
}

function section(endpoint: Endpoint, all: Readonly<Record<string, Schema>>): string {
  const { method, path, operation } = endpoint;
  const parts = [`## ${titleOf(operation.operationId)}`, "", "```http", `${method} ${path}`, "```"];
  if (operation.description !== undefined) parts.push("", operation.description);
  const parameters = operation.parameters ?? [];
  if (parameters.length > 0) parts.push("", "**Parameters**", "", parameterTable(parameters, all));
  const schema = operation.requestBody?.content["application/json"]?.schema;
  if (schema !== undefined) parts.push("", "**Body**", "", fieldTable(schema, all));
  const answer = returns(operation, all);
  if (answer !== "") parts.push("", `**Returns** ${answer}`);
  parts.push("", "**Example**", "", example(endpoint, all));
  return parts.join("\n");
}

/** The reference pages, by slug, as Markdown with frontmatter. */
export function apiReferencePages(): ReadonlyArray<{
  readonly slug: string;
  readonly markdown: string;
}> {
  const doc = spec();
  const all = doc.schemas;
  const endpoints: Endpoint[] = [...doc.paths].flatMap(([path, methods]) =>
    [...methods]
      .filter(([method]) => ["get", "post", "put", "patch", "delete"].includes(method))
      .map(([method, operation]) => ({ method: method.toUpperCase(), path, operation })),
  );
  const placed = new Set<Endpoint>();
  return areas.map((area, index) => {
    const mine = endpoints.filter((endpoint) => {
      if (placed.has(endpoint) || websiteOnly(endpoint.method, endpoint.path)) return false;
      if (!area.match(endpoint.method, endpoint.path)) return false;
      placed.add(endpoint);
      return true;
    });
    const markdown = [
      "---",
      `title: ${JSON.stringify(area.title)}`,
      `description: ${JSON.stringify(area.description)}`,
      "sidebar:",
      `  order: ${index + 2}`,
      "---",
      "",
      `${area.description} ${area.credential ?? "Every route takes `Authorization: Bearer $TALKTO_API_KEY`."} See [the overview](/api/) for keys, request keys, replies and errors. Generated from [\`/openapi.json\`](https://talkto.sh/openapi.json).`,
      "",
      ...mine.map((endpoint) => section(endpoint, all)).flatMap((text) => [text, ""]),
    ].join("\n");
    return { slug: area.slug, markdown };
  });
}

/** Write the reference pages next to the hand-written api/index.mdx; `root` is the docs package. */
export function writeApiReference(root: URL) {
  const api = new URL("src/content/docs/api/", root);
  mkdirSync(api, { recursive: true });
  const pages = apiReferencePages();
  const kept = new Set(["index.mdx", ...pages.map((page) => `${page.slug}.md`)]);
  for (const name of readdirSync(api))
    if (!kept.has(name)) rmSync(new URL(name, api), { force: true });
  for (const page of pages) {
    const path = new URL(`${page.slug}.md`, api);
    // Rewriting an unchanged file would restart the dev server's content sync for nothing.
    if (!existsSync(path) || readFileSync(path, "utf8") !== page.markdown)
      writeFileSync(path, page.markdown);
  }
}
