import { Schema } from "effect";
import { Meta } from "./envelope.js";

/** Response for the public process liveness check; it does not check dependencies. */
export const Health = Schema.Struct({
  status: Schema.Literal("ok"),
  meta: Meta,
});

/** Decoded liveness response shared by the API and its consumers. */
export interface Health extends Schema.Schema.Type<typeof Health> {}
