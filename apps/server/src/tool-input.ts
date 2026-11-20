import { Predicate, Result, Schema, SchemaAST, SchemaIssue } from "effect";

/** The field whose literal value selects a union variant, e.g. get_updates `mode`. */
export interface Selector {
  readonly key: string;
  readonly values: ReadonlyArray<string>;
}
const decodeProperties = Schema.decodeUnknownResult(
  Schema.Record(Schema.String, Schema.JsonObject),
);
/** Render an MCP tool schema; `notes` prefix the descriptions of the named properties. */
export const jsonSchema = (
  schema: Schema.Top,
  notes: ReadonlyMap<string, string> = new Map(),
  options: Schema.ToJsonSchemaOptions = {},
) => {
  const document = Schema.toJsonSchemaDocument(schema, options);
  const rendered = { ...document.schema, type: "object" as const, $defs: document.definitions };
  if (notes.size === 0) return rendered;
  const properties = Result.getOrElse(decodeProperties(document.schema.properties), () => ({}));
  const noted = Object.entries(properties).map(([name, property]) => {
    const note = notes.get(name);
    if (note === undefined) return [name, property];
    const { description } = property;
    return [
      name,
      {
        ...property,
        description: Predicate.isString(description) ? `${note} ${description}` : note,
      },
    ];
  });
  return { ...rendered, properties: Object.fromEntries(noted) };
};

/**
 * Render a tool's reply schema. Replies allow fields the schema doesn't name: hosts check replies
 * against the schema they listed when the session started, so a strict schema would make every
 * long-running session reject the first reply that carries a newly added field.
 */
export const replyJsonSchema = (schema: Schema.Top) =>
  jsonSchema(schema, new Map(), { additionalProperties: true });

/** A tool input as offered to MCP hosts, plus what its errors need to name a variant. */
export interface Published {
  readonly inputSchema: ReturnType<typeof jsonSchema>;
  readonly selector: Selector | null;
  /** Fields with a fixed set of string values, across all variants. */
  readonly choices: ReadonlyMap<string, ReadonlyArray<string>>;
}

const literals = (ast: SchemaAST.AST): ReadonlyArray<string> => {
  if (SchemaAST.isLiteral(ast)) return Predicate.isString(ast.literal) ? [ast.literal] : [];
  if (SchemaAST.isUnion(ast) && ast.types.every(SchemaAST.isLiteral))
    return ast.types.flatMap(literals);
  return [];
};
const unique = <A>(values: ReadonlyArray<A>) => [...new Set(values)];
const checkCount = (ast: SchemaAST.AST) => ast.checks?.length ?? 0;

/** One property merged across variants: literals combine, otherwise the loosest variant wins. */
const mergeProperty = (types: ReadonlyArray<SchemaAST.AST>): Schema.Top => {
  const values = types.map(literals);
  if (values.every((list) => list.length > 0)) return Schema.Literals(unique(values.flat()));
  return Schema.make<Schema.Top>(
    types.reduce((loosest, type) => (checkCount(type) < checkCount(loosest) ? type : loosest)),
  );
};

/**
 * Many MCP hosts drop or misread a root `anyOf`: some show no parameters, others keep only the
 * first variant's enum values, so `mode` looks like it can only be "start". Offer union inputs
 * as one flat object instead. The server still decodes every call against the exact union, and
 * its errors name the field to fix.
 */
export function publish(input: Schema.Top): Published {
  const ast = input.ast;
  const variants = SchemaAST.isUnion(ast) ? ast.types.filter(SchemaAST.isObjects) : [];
  if (!SchemaAST.isUnion(ast) || variants.length !== ast.types.length || variants.length === 0)
    return { inputSchema: jsonSchema(input), selector: null, choices: new Map() };
  const names = unique(
    variants.flatMap((variant) => variant.propertySignatures.map((property) => property.name)),
  ).filter(Predicate.isString);
  const typeOf = (variant: SchemaAST.Objects, name: string) =>
    variant.propertySignatures.find((property) => property.name === name)?.type;
  const required = (name: string) =>
    variants.every((variant) => {
      const type = typeOf(variant, name);
      return type !== undefined && !SchemaAST.isOptional(type);
    });
  const selectorKey = names.find(
    (name) =>
      required(name) &&
      variants.every((variant) => {
        const type = typeOf(variant, name);
        return type !== undefined && literals(type).length > 0;
      }),
  );
  const choices = new Map<string, ReadonlyArray<string>>();
  const fields: Record<string, Schema.Top> = {};
  const notes = new Map<string, string>();
  for (const name of names) {
    const owners = variants.filter((variant) => typeOf(variant, name) !== undefined);
    const merged = mergeProperty(owners.flatMap((variant) => typeOf(variant, name) ?? []));
    const values = literals(merged.ast);
    if (values.length > 0) choices.set(name, values);
    const field = required(name) ? merged : Schema.optionalKey(merged);
    fields[name] = field;
    if (selectorKey === undefined || owners.length === variants.length) continue;
    const modes = unique(
      owners.flatMap((variant) => literals(typeOf(variant, selectorKey) ?? merged.ast)),
    );
    notes.set(name, `Only with ${selectorKey} ${modes.join(" or ")}.`);
  }
  const flat = Schema.Struct(fields).annotate({ parseOptions: { onExcessProperty: "error" } });
  return {
    inputSchema: jsonSchema(flat, notes),
    selector:
      selectorKey === undefined
        ? null
        : { key: selectorKey, values: choices.get(selectorKey) ?? [] },
    choices,
  };
}

interface Located {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly issue: SchemaIssue.Issue;
}
/** Flatten an issue tree to the nodes that explain one field each. */
const locate = (issue: SchemaIssue.Issue, path: ReadonlyArray<PropertyKey>): Array<Located> => {
  switch (issue._tag) {
    case "Pointer":
      return locate(issue.issue, [...path, ...issue.path]);
    case "Composite":
      return issue.issues.flatMap((inner) => locate(inner, path));
    case "Encoding":
      return locate(issue.issue, path);
    // A check across fields that names the field it refused, e.g. get_updates waitSeconds.
    case "Filter":
      return issue.issue._tag === "Pointer" ? locate(issue.issue, path) : [{ path, issue }];
    case "AnyOf":
      return issue.issues.length === 0
        ? [{ path, issue }]
        : issue.issues.flatMap((inner) => locate(inner, path));
    default:
      return [{ path, issue }];
  }
};

const segment = (key: PropertyKey) =>
  Predicate.isNumber(key) ? `[${key}]` : `.${String(key).slice(0, 64)}`;
const label = (path: ReadonlyArray<PropertyKey>) =>
  path.length === 0 ? "arguments" : path.map(segment).join("").replace(/^\./, "");
const at = (value: Schema.Json | undefined, path: ReadonlyArray<PropertyKey>) =>
  path.reduce<Schema.Json | undefined>((current, key) => {
    if (Array.isArray(current)) return Predicate.isNumber(key) ? current[key] : undefined;
    if (Predicate.isObject(current) && Predicate.isString(key)) return current[key];
    return undefined;
  }, value);
const article = (type: string) => (/^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`);
const quoted = (values: ReadonlyArray<string>) => values.map((value) => `"${value}"`).join(", ");

/** A union matched no variant: name the choice fields whose value is missing or unknown. */
const variantMismatch = (published: Published, input: Schema.JsonObject): ReadonlyArray<string> => {
  const { selector } = published;
  if (selector === null) return [];
  const chosen = input[selector.key];
  if (!Predicate.isString(chosen) || !selector.values.includes(chosen))
    return [`${selector.key} must be one of ${quoted(selector.values)}`];
  const unknown = [...published.choices].flatMap(([key, allowed]) => {
    const value = input[key];
    return value !== undefined && !(Predicate.isString(value) && allowed.includes(value))
      ? [`${key} must be one of ${quoted(allowed)}`]
      : [];
  });
  return unknown.length > 0
    ? unknown
    : [`no ${selector.key} "${chosen}" variant accepts these fields; check its required fields`];
};

/** Phrase one issue to follow its field name: "limit must be a number". */
const explain = (issue: SchemaIssue.Issue): string => {
  switch (issue._tag) {
    case "MissingKey":
      return "is required";
    case "UnexpectedKey":
      return "is not accepted here; remove it";
    default: {
      const [first] = SchemaIssue.makeFormatterStandardSchemaV1()(issue).issues;
      const message = (first?.message ?? "is not valid").replace(/\.$/, "");
      if (!message.startsWith("Expected ")) return message;
      const expected = message.slice("Expected ".length);
      return `must be ${/^[a-z]+$/.test(expected) ? article(expected) : expected}`;
    }
  }
};

/**
 * Name each rejected field without echoing caller values, so a model can fix its call in one try.
 * `issue` comes from decoding `{ tool, input }`; paths are reported relative to the arguments.
 */
export function describe(
  tool: string,
  issue: SchemaIssue.Issue,
  input: Schema.JsonObject,
  published: Published,
): string {
  const strings: Array<string> = [];
  const seen = new Set<string>();
  const parts: Array<string> = [];
  for (const item of locate(issue, [])) {
    const relative = item.path[0] === "input" ? item.path.slice(1) : item.path;
    const name = label(relative);
    if (seen.has(name)) continue;
    seen.add(name);
    const mismatch = relative.length === 0 ? variantMismatch(published, input) : [];
    if (mismatch.length > 0) {
      parts.push(...mismatch);
      continue;
    }
    const message = explain(item.issue);
    if (
      Predicate.isString(at(input, relative)) &&
      /^must be an? (number|boolean|array|object)$/.test(message)
    )
      strings.push(name);
    parts.push(/^[a-z]/.test(message) ? `${name} ${message}` : `${name}: ${message}`);
  }
  const listed = parts.slice(0, 6).join("; ");
  const more = parts.length > 6 ? `; and ${parts.length - 6} more` : "";
  const hint =
    strings.length > 0
      ? ` Send ${strings.join(" and ")} as JSON values, not strings: 20, not "20"; an array, not a string that holds one.`
      : "";
  return `Arguments do not match ${tool}: ${listed || "check the fields"}${more}.${hint} See the tool's input schema or talkto://instructions.`;
}
