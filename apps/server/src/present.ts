/** A reply field that is left out when absent: `{ [key]: value }` or `{}`. */
export type Present<K extends string, V> = { [P in K]?: V };
/**
 * `{ [key]: value }` when the value is present, else `{}`. Replies leave absent fields out rather
 * than sending null (docs/mcp-compatibility.md), and `exactOptionalPropertyTypes` forbids writing
 * `undefined` into an optional key; spread the result into the reply.
 */
export const present = <K extends string, V>(
  key: K,
  value: V | null | undefined,
): Present<K, V> => {
  const field: Present<K, V> = {};
  if (value !== null && value !== undefined) field[key] = value;
  return field;
};
