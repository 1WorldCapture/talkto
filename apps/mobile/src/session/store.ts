import * as SecureStore from "expo-secure-store";
import { Schema } from "effect";

/** The person behind a hosted session, kept so the app opens offline with the right name. */
export const Profile = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  firstName: Schema.NullOr(Schema.String),
});
/** Parsed profile. */
export interface Profile extends Schema.Schema.Type<typeof Profile> {}

/**
 * Where the app reads from and with which credential. `hosted` is a WorkOS sign-in to a TalkTo
 * deployment. `local` is the local development server (pnpm dev) and its generated token; the
 * app offers it only in development builds.
 */
export const Connection = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("hosted"),
    origin: Schema.String,
    clientId: Schema.String,
    accessToken: Schema.String,
    refreshToken: Schema.String,
    profile: Profile,
  }),
  Schema.Struct({
    kind: Schema.Literal("local"),
    origin: Schema.String,
    token: Schema.String,
  }),
]);
/** Parsed connection. */
export type Connection = typeof Connection.Type;

const connectionKey = "talkto.connection.v1";
const storedConnection = Schema.fromJsonString(Connection);

/** Tokens live only in the Keychain (iOS) or Keystore-backed storage (Android). */
export async function readConnection() {
  const stored = await SecureStore.getItemAsync(connectionKey);
  if (stored === null) return null;
  const parsed = Schema.decodeUnknownResult(storedConnection)(stored);
  return parsed._tag === "Success" ? parsed.success : null;
}

/** Save after sign-in and after every refresh: WorkOS rotates the refresh token. */
export async function writeConnection(connection: Connection) {
  await SecureStore.setItemAsync(connectionKey, Schema.encodeSync(storedConnection)(connection), {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
  });
}

/** Forget the credential on sign-out or when WorkOS refuses it. */
export async function clearConnection() {
  await SecureStore.deleteItemAsync(connectionKey);
}

/** Who reads: the WorkOS user, or the one local development owner. */
export const scopeOf = (connection: Connection) =>
  connection.kind === "hosted" ? connection.profile.id : "local";
