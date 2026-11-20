import { useEffect } from "react";
import { AppState, Platform } from "react-native";
import { focusManager, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { SplashScreen, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as WebBrowser from "expo-web-browser";
import { SessionProvider, useRequest, useServices, useSession } from "../session/session";
import { useNavigationTheme, usePalette } from "../ui/theme";

void SplashScreen.preventAutoHideAsync();
// Completes the AuthKit redirect when the system browser hands control back to the app.
WebBrowser.maybeCompleteAuthSession();

/** Polling follows the app: React Query pauses intervals while the app is in the background. */
function useAppFocus() {
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (status) => {
      if (Platform.OS !== "web") focusManager.setFocused(status === "active");
    });
    return () => subscription.remove();
  }, []);
}

/**
 * Check the sign-in every minute while the app is open, as the web dashboard's session gate
 * does. A refusal reaches the query cache, which signs out; the check also keeps tokens fresh.
 */
function SessionCheck() {
  const { api } = useServices();
  const run = useRequest();
  useQuery({
    queryKey: ["session"],
    queryFn: ({ signal }) => run(api.platform.currentUser(), signal),
    refetchInterval: 60_000,
  });
  return null;
}

function Navigation() {
  const { state, queries } = useSession();
  const theme = useNavigationTheme();
  const palette = usePalette();
  useAppFocus();
  useEffect(() => {
    if (state.status !== "loading") void SplashScreen.hideAsync();
  }, [state.status]);
  if (state.status === "loading") return null;
  const signedIn = state.status === "signedIn";
  return (
    <QueryClientProvider client={queries}>
      <ThemeProvider value={theme}>
        <StatusBar style="auto" />
        {state.status === "signedIn" && state.connection.kind === "hosted" && <SessionCheck />}
        <Stack
          screenOptions={{
            headerBackButtonDisplayMode: "minimal",
            headerShadowVisible: false,
            headerTintColor: palette.label,
            contentStyle: { backgroundColor: palette.background },
          }}
        >
          <Stack.Protected guard={signedIn}>
            <Stack.Screen
              name="index"
              options={{
                title: "Servers",
                headerLargeTitleEnabled: true,
                contentStyle: { backgroundColor: palette.groupedBackground },
              }}
            />
            <Stack.Screen
              name="servers/[serverId]/index"
              options={{ title: "", headerLargeTitleEnabled: true }}
            />
            <Stack.Screen
              name="servers/[serverId]/conversations/[conversationId]"
              options={{ title: "" }}
            />
            <Stack.Screen
              name="servers/[serverId]/agents/[participantId]"
              options={{
                title: "",
                contentStyle: { backgroundColor: palette.groupedBackground },
              }}
            />
            <Stack.Screen
              name="servers/[serverId]/compose"
              options={{
                title: "New Message",
                presentation: "formSheet",
                sheetAllowedDetents: [0.75, 1],
                sheetGrabberVisible: true,
                headerShown: false,
              }}
            />
            <Stack.Screen
              name="account"
              options={{
                title: "Account",
                presentation: "formSheet",
                sheetAllowedDetents: [0.5],
                sheetGrabberVisible: true,
                headerShown: false,
                contentStyle: { backgroundColor: palette.groupedBackground },
              }}
            />
          </Stack.Protected>
          <Stack.Protected guard={!signedIn}>
            <Stack.Screen name="sign-in" options={{ headerShown: false }} />
          </Stack.Protected>
        </Stack>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

/** A link into a server or chat still has the server list behind it to go back to. */
export const unstable_settings = { anchor: "index" };

export default function RootLayout() {
  return (
    <SessionProvider>
      <Navigation />
    </SessionProvider>
  );
}
