import { Platform } from "react-native";

/** The TalkTo deployment a release build signs in to. */
export const productionOrigin = "https://talkto.sh";
/** The local development server (pnpm dev). The Android emulator reaches the host at 10.0.2.2. */
export const localOrigin =
  Platform.OS === "android" ? "http://10.0.2.2:8787" : "http://127.0.0.1:8787";

/** Loopback addresses use the local server's generated token instead of WorkOS. */
export const isLocalOrigin = (origin: string) =>
  /^http:\/\/(127\.0\.0\.1|localhost|10\.0\.2\.2)(:\d+)?$/.test(origin);

/** A server URL a person may choose in a development build: HTTPS, or a loopback address. */
export function parseOrigin(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (isLocalOrigin(trimmed)) return trimmed;
  return /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(trimmed) ? trimmed.toLowerCase() : null;
}

/**
 * Development-only settings, read from apps/mobile/.env.local (see README). Metro inlines
 * EXPO_PUBLIC_ values; every read sits behind `__DEV__`, so release builds drop them.
 */
export const development = {
  /** The local server's generated token, copied from apps/server/.dev.vars by `pnpm local-env`. */
  localToken: () => (__DEV__ ? (process.env.EXPO_PUBLIC_TALKTO_LOCAL_TOKEN ?? "") : ""),
  /**
   * A staging deployment, where the app's redirect URI is registered first:
   * `EXPO_PUBLIC_TALKTO_STAGING_ORIGIN`. Empty when unset or not a valid server URL, and then the
   * sign-in screen offers no Staging preset.
   */
  stagingOrigin: () =>
    __DEV__ ? (parseOrigin(process.env.EXPO_PUBLIC_TALKTO_STAGING_ORIGIN ?? "") ?? "") : "",
};
