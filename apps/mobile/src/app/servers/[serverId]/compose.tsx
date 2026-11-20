import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import { SymbolView } from "expo-symbols";
import { Schema } from "effect";
import { describeAgentType } from "@talkto/api/agent-types";
import * as M from "@talkto/api/models";
import { describeError } from "../../../api/client";
import { isPerson, useMessageAgent } from "../../../api/me";
import { useParticipants } from "../../../api/queries";
import { AgentMark } from "../../../ui/agent-mark";
import { Failure, Loading, Placeholder } from "../../../ui/states";
import { usePalette } from "../../../ui/theme";

const Params = Schema.Struct({ serverId: M.ServerId });

/** Pick the agent to message; the chat opens (or reopens) as the person. */
export default function Compose() {
  const palette = usePalette();
  const { serverId } = Schema.decodeUnknownSync(Params)(useLocalSearchParams());
  const participants = useParticipants(serverId);
  const message = useMessageAgent(serverId, { fromSheet: true });
  const [search, setSearch] = useState("");
  const [choice, setChoice] = useState<M.ParticipantId | null>(null);
  const needle = search.trim().toLowerCase();
  const agents = (participants.data ?? [])
    .filter((participant) => !isPerson(participant))
    .filter(
      (agent) =>
        needle === "" ||
        agent.name.toLowerCase().includes(needle) ||
        describeAgentType(agent.agentType).label.toLowerCase().includes(needle),
    );
  const choose = (agentId: M.ParticipantId) => {
    setChoice(agentId);
    message.start(agentId, {
      onError: (error) => Alert.alert("Couldn't open the chat", describeError(error)),
    });
  };
  // A form sheet lays out its first scroll view over everything else, so the title and the
  // search field ride in the list as a sticky header.
  const header = (
    <View style={{ backgroundColor: palette.background }}>
      <Text style={[styles.title, { color: palette.label }]} accessibilityRole="header">
        New Message
      </Text>
      <View style={[styles.search, { backgroundColor: palette.fill }]}>
        <SymbolView
          name={{ ios: "magnifyingglass", android: "search", web: "search" }}
          size={16}
          tintColor={palette.secondaryLabel}
        />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search agents"
          placeholderTextColor={palette.secondaryLabel}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          returnKeyType="search"
          style={[styles.searchField, { color: palette.label }]}
          accessibilityLabel="Search agents"
        />
      </View>
    </View>
  );
  return (
    <FlatList
      style={[styles.screen, { backgroundColor: palette.background }]}
      ListHeaderComponent={header}
      stickyHeaderIndices={[0]}
      data={agents}
      keyExtractor={(agent) => agent.id}
      contentInsetAdjustmentBehavior="never"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      renderItem={({ item }) => (
        <Pressable
          onPress={() => choose(item.id)}
          disabled={message.pending}
          accessibilityRole="button"
          accessibilityLabel={`Message ${item.name}`}
          style={({ pressed }) => [styles.row, pressed ? { backgroundColor: palette.fill } : null]}
        >
          <AgentMark subject={{ agentType: item.agentType, name: item.name }} size={40} />
          <View style={[styles.rowText, { borderBottomColor: palette.separator }]}>
            <View style={styles.rowLabels}>
              <Text style={[styles.name, { color: palette.label }]} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={[styles.type, { color: palette.secondaryLabel }]} numberOfLines={1}>
                {describeAgentType(item.agentType).label}
              </Text>
            </View>
            {message.pending && choice === item.id && <ActivityIndicator />}
          </View>
        </Pressable>
      )}
      ListEmptyComponent={
        participants.isPending ? (
          <Loading label="Loading agents" />
        ) : participants.error !== null ? (
          <Failure error={participants.error} retry={() => void participants.refetch()} />
        ) : (
          <Placeholder
            symbol={{ ios: "person.2", android: "group", web: "group" }}
            title={needle === "" ? "No agents yet" : "No matching agents"}
            detail={needle === "" ? "Agents appear here once they join this server." : undefined}
          />
        )
      }
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  title: { fontSize: 17, fontWeight: "600", textAlign: "center", paddingTop: 22, paddingBottom: 6 },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 8,
    paddingHorizontal: 10,
    borderRadius: 10,
    minHeight: 38,
  },
  searchField: { flex: 1, fontSize: 17, paddingVertical: 8 },
  row: { flexDirection: "row", alignItems: "center", paddingLeft: 16, gap: 12 },
  rowText: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingRight: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLabels: { flex: 1, minWidth: 0 },
  name: { fontSize: 17, fontWeight: "500" },
  type: { fontSize: 14, marginTop: 1 },
});
