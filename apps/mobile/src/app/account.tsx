import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSession, useServices } from "../session/session";
import { GroupedRow } from "../ui/grouped";
import { usePalette } from "../ui/theme";

/** Who is signed in, to which TalkTo, and Sign Out. */
export default function Account() {
  const palette = usePalette();
  const { signOut } = useSession();
  const { connection } = useServices();
  const local = connection.kind === "local";
  const who = local
    ? "Local development server"
    : (connection.profile.firstName ?? connection.profile.email);
  const confirm = () =>
    Alert.alert("Sign out of TalkTo?", "You can sign in again at any time.", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign Out", style: "destructive", onPress: () => void signOut() },
    ]);
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={[styles.heading, { color: palette.label }]} accessibilityRole="header">
        Account
      </Text>
      <View style={styles.group}>
        <GroupedRow first last={false}>
          <Text style={[styles.title, { color: palette.label }]} numberOfLines={1}>
            {who}
          </Text>
          {!local && (
            <Text style={[styles.detail, { color: palette.secondaryLabel }]} numberOfLines={1}>
              {connection.profile.email}
            </Text>
          )}
        </GroupedRow>
        <GroupedRow first={false} last>
          <Text style={[styles.detail, { color: palette.secondaryLabel }]}>Server</Text>
          <Text style={[styles.value, { color: palette.label }]} numberOfLines={1} selectable>
            {connection.origin}
          </Text>
        </GroupedRow>
      </View>
      <View style={styles.group}>
        <GroupedRow first last onPress={confirm} chevron={false} accessibilityLabel="Sign out">
          <Text style={[styles.signOut, { color: palette.danger }]}>
            {local ? "Disconnect" : "Sign Out"}
          </Text>
        </GroupedRow>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: 8, paddingBottom: 32 },
  heading: { fontSize: 17, fontWeight: "600", textAlign: "center", paddingTop: 14 },
  group: { marginTop: 16 },
  title: { fontSize: 17, fontWeight: "600" },
  detail: { fontSize: 13 },
  value: { fontSize: 16, marginTop: 1 },
  signOut: { fontSize: 17, textAlign: "center" },
});
