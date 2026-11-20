import { Effect, Layer, Schema } from "effect";
import * as O from "@talkto/api/onboarding";
import * as M from "@talkto/api/models";
import * as Model from "../platform/model.js";
import * as Onboarding from "./service.js";
const unavailable = () =>
  new Model.Failure({
    code: "storage_unavailable",
    message: "Setup progress is temporarily unavailable. Your saved choices are safe to retry.",
  });
/** Primary-session D1 writes compare the loaded revision; absence does not mean a failed read. */
export const storeLayer = (database: D1Database) =>
  Layer.sync(Onboarding.Store, () => {
    const db = database.withSession("first-primary");
    return Onboarding.Store.of({
      read: Effect.fn("OnboardingStore.read")(function* (userId) {
        const row = yield* Effect.tryPromise({
          try: () =>
            db.prepare("SELECT state FROM user_onboarding WHERE user_id=?").bind(userId).first(),
          catch: unavailable,
        });
        if (row === null) return O.initial();
        const parsed = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ state: Schema.fromJsonString(O.State) }),
        )(row).pipe(Effect.mapError(unavailable));
        return parsed.state;
      }),
      save: Effect.fn("OnboardingStore.save")(function* (userId, state, at) {
        const next = { ...state, revision: state.revision + 1 };
        const value = yield* Schema.encodeEffect(Schema.fromJsonString(O.State))(next).pipe(
          Effect.mapError(unavailable),
        );
        const statement =
          state.revision === 0
            ? db
                .prepare(
                  "INSERT INTO user_onboarding(user_id,revision,state,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO NOTHING",
                )
                .bind(userId, next.revision, value, at)
            : db
                .prepare(
                  "UPDATE user_onboarding SET revision=?,state=?,updated_at=? WHERE user_id=? AND revision=?",
                )
                .bind(next.revision, value, at, userId, state.revision);
        const result = yield* Effect.tryPromise({ try: () => statement.run(), catch: unavailable });
        if (result.meta.changes !== 1) return yield* Onboarding.conflict();
        return next;
      }),
    });
  });
/** Private bounded RPC adapter; no agent details survive a revoked grant. */
export const serversLayer = (namespace: Env["SERVERS"]) =>
  Layer.succeed(
    Onboarding.Servers,
    Onboarding.Servers.of({
      read: (actor, id, names, agents, more, since) =>
        Effect.tryPromise({
          try: () =>
            namespace.getByName(id).readOnboarding(actor.principalKey, names, agents, more, since),
          catch: unavailable,
        }).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.NullOr(Schema.Struct({ data: O.ServerProgress, included: M.Included })),
            ),
          ),
          Effect.map((outcome) => outcome?.data ?? null),
          Effect.mapError(unavailable),
        ),
    }),
  );
