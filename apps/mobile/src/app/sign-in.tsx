import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Schema } from "effect";
import * as P from "@talkto/api/platform";
import { useSession } from "../session/session";
import {
  development,
  isLocalOrigin,
  localOrigin,
  parseOrigin,
  productionOrigin,
} from "../session/environments";
import * as WorkOS from "../session/workos";
import { usePalette } from "../ui/theme";
import { Button } from "../ui/button";

const MeResponse = Schema.Struct({
  data: Schema.Struct({ user: P.User }),
});
const ServersResponse = Schema.Struct({
  data: Schema.Struct({ items: Schema.Array(Schema.Unknown) }),
});

/** The kit wordmark: lowercase "talkto" with the magenta square, as on the web. */
function Wordmark() {
  const palette = usePalette();
  return (
    <View style={styles.wordmark} accessibilityRole="header" accessibilityLabel="TalkTo">
      <View style={[styles.square, { backgroundColor: palette.accentFill }]} />
      <Text style={[styles.wordmarkText, { color: palette.label }]}>talkto</Text>
    </View>
  );
}

/** Read the signed-in person once, so the app can open offline with their name. */
async function profileOf(session: WorkOS.Session) {
  const response = await fetch(`${session.origin}/v1/me`, {
    headers: { authorization: `Bearer ${session.accessToken}`, accept: "application/json" },
  }).catch(() => null);
  const parsed = Schema.decodeUnknownResult(MeResponse)(await response?.json().catch(() => null));
  if (response?.ok !== true || parsed._tag === "Failure")
    throw new WorkOS.SignInError("Signed in, but TalkTo did not answer. Try again.");
  const { user } = parsed.success.data;
  return { id: user.id, email: user.email, firstName: user.firstName };
}

/** The local server accepts only its generated token; check it before saving it. */
async function checkLocal(origin: string, token: string) {
  const response = await fetch(`${origin}/v1/servers`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  }).catch(() => null);
  if (response === null)
    throw new WorkOS.SignInError(`Nothing answered at ${origin}. Start it with pnpm dev.`);
  if (response.status === 401)
    throw new WorkOS.SignInError("The local server refused this token. Run pnpm local-env again.");
  const parsed = Schema.decodeUnknownResult(ServersResponse)(
    await response.json().catch(() => null),
  );
  if (!response.ok || parsed._tag === "Failure")
    throw new WorkOS.SignInError("The local server did not answer as expected.");
}

/** Development builds only: which server to use, and the local server's token. */
function DeveloperSettings({
  origin,
  setOrigin,
  token,
  setToken,
}: {
  readonly origin: string;
  readonly setOrigin: (value: string) => void;
  readonly token: string;
  readonly setToken: (value: string) => void;
}) {
  const palette = usePalette();
  const presets = (
    [
      ["Local", localOrigin],
      ["Staging", development.stagingOrigin()],
      ["Production", productionOrigin],
    ] as const
  ).filter(([, value]) => value !== "");
  const field = [styles.field, { backgroundColor: palette.fill, color: palette.label }];
  return (
    <View style={[styles.developer, { borderColor: palette.separator }]}>
      <Text style={[styles.developerTitle, { color: palette.secondaryLabel }]}>
        Development build
      </Text>
      <View style={styles.presets}>
        {presets.map(([label, value]) => (
          <Pressable
            key={label}
            onPress={() => setOrigin(value)}
            accessibilityRole="button"
            accessibilityState={{ selected: origin === value }}
            style={[
              styles.preset,
              { backgroundColor: origin === value ? palette.label : palette.fill },
            ]}
          >
            <Text
              style={[
                styles.presetLabel,
                { color: origin === value ? palette.background : palette.label },
              ]}
            >
              {label}
            </Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        value={origin}
        onChangeText={setOrigin}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="Server URL"
        placeholderTextColor={palette.tertiaryLabel}
        style={field}
        accessibilityLabel="Server URL"
      />
      {isLocalOrigin(origin.trim()) &&
        (development.localToken() !== "" ? (
          <Text style={[styles.hint, { color: palette.secondaryLabel }]}>
            Uses the local server's token from .env.local.
          </Text>
        ) : (
          <TextInput
            value={token}
            onChangeText={setToken}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            placeholder="Local token (pnpm local-env fills this in)"
            placeholderTextColor={palette.tertiaryLabel}
            style={field}
            accessibilityLabel="Local server token"
          />
        ))}
    </View>
  );
}

export default function SignIn() {
  const { connect, state } = useSession();
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const [origin, setOrigin] = useState(__DEV__ ? localOrigin : productionOrigin);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    state.status === "signedOut" ? state.notice : null,
  );
  const chosen = parseOrigin(origin);
  const local = chosen !== null && isLocalOrigin(chosen);

  const submit = async () => {
    if (chosen === null) {
      setError("Use an HTTPS address, or the local server's address.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (local) {
        const credential = development.localToken() || token.trim();
        await checkLocal(chosen, credential);
        await connect({ kind: "local", origin: chosen, token: credential });
      } else {
        const session = await WorkOS.signIn(chosen);
        await connect({ kind: "hosted", ...session, profile: await profileOf(session) });
      }
    } catch (cause) {
      if (!(cause instanceof WorkOS.SignInError && cause.cancelled))
        setError(cause instanceof Error ? cause.message : "Sign-in did not finish. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: palette.background }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 96, paddingBottom: insets.bottom + 24 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <Wordmark />
        <Text style={[styles.lede, { color: palette.secondaryLabel }]}>
          Read every server and conversation, and message any agent.
        </Text>
        <View style={styles.spacer} />
        {__DEV__ && (
          <DeveloperSettings
            origin={origin}
            setOrigin={setOrigin}
            token={token}
            setToken={setToken}
          />
        )}
        {error !== null && (
          <Text style={[styles.error, { color: palette.danger }]} accessibilityRole="alert">
            {error}
          </Text>
        )}
        <Button
          label={local ? "Connect to Local Server" : "Sign In"}
          onPress={() => void submit()}
          disabled={busy}
          accessory={busy ? <ActivityIndicator color={palette.onAccent} /> : null}
        />
        {!local && (
          <Text style={[styles.hint, styles.centered, { color: palette.secondaryLabel }]}>
            Sign-in opens TalkTo's sign-in page in your browser.
          </Text>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { flexGrow: 1, paddingHorizontal: 24, gap: 16 },
  wordmark: { flexDirection: "row", alignItems: "center", gap: 10, alignSelf: "center" },
  square: { width: 22, height: 22 },
  wordmarkText: { fontSize: 40, fontWeight: "700", letterSpacing: -1.2 },
  lede: { fontSize: 17, lineHeight: 23, textAlign: "center", paddingHorizontal: 16 },
  spacer: { flex: 1, minHeight: 40 },
  developer: { gap: 10, paddingTop: 16, borderTopWidth: StyleSheet.hairlineWidth },
  developerTitle: { fontSize: 13, fontWeight: "600" },
  presets: { flexDirection: "row", gap: 8 },
  preset: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: 8 },
  presetLabel: { fontSize: 14, fontWeight: "500" },
  field: { fontSize: 15, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10 },
  hint: { fontSize: 13, lineHeight: 18 },
  centered: { textAlign: "center" },
  error: { fontSize: 15, lineHeight: 20, textAlign: "center" },
});
