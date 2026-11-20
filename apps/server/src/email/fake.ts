import { Effect, Layer } from "effect";
import * as Model from "./model.js";

/*
  The fake sender (`TALKTO_EMAIL="fake"`): the whole email flow runs, nothing leaves the Worker.
  Sent batches stay in this isolate's memory for tests and local runs, and each send logs its kind
  and subject, never the address or body. Like a real provider, a repeated idempotency key returns
  the first result without recording the batch again.
*/

/** One recorded batch. */
export interface Sent {
  readonly idempotencyKey: string;
  readonly messages: ReadonlyArray<Model.Message>;
  readonly ids: ReadonlyArray<string>;
}
const sent: Sent[] = [];
/** Every batch the fake has accepted in this isolate, oldest first. */
export const outbox = (): ReadonlyArray<Sent> => sent;
/** Forget recorded batches. */
export const clear = () => {
  sent.length = 0;
};
/** The fake fails this many next sends as `ambiguous`, as a timeout would, recording nothing. */
let failures = 0;
/** Make the next `count` sends fail. */
export const failNext = (count: number) => {
  failures = count;
};

/** The fake `Email` port. */
export const layer = Layer.succeed(
  Model.Email,
  Model.Email.of({
    maxBatch: 100,
    send: (messages, idempotencyKey) =>
      Effect.suspend(() => {
        if (failures > 0) {
          failures--;
          return Effect.fail(Model.failure("fake.send", "ambiguous"));
        }
        const prior = sent.find((batch) => batch.idempotencyKey === idempotencyKey);
        if (prior !== undefined) return Effect.succeed(prior.ids);
        const ids = messages.map(() => `fake_${crypto.randomUUID()}`);
        sent.push({ idempotencyKey, messages, ids });
        return Effect.forEach(messages, (message) =>
          Effect.logInfo("TalkTo email (fake)", { kind: message.kind, subject: message.subject }),
        ).pipe(Effect.as(ids));
      }),
  }),
);
