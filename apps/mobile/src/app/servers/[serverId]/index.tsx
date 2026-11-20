import { memo, useState } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { Schema } from "effect";
import * as M from "@talkto/api/models";
import { denied } from "../../../api/client";
import { isPerson, useMe } from "../../../api/me";
import {
  useConversations,
  useRecentAgents,
  useServer,
  type ConversationEntry,
} from "../../../api/queries";
import { AgentMark } from "../../../ui/agent-mark";
import { senderOf, sidesOf, titleOf, type Directory } from "../../../ui/conversation";
import { excerptOf, formatListTime } from "../../../ui/format";
import { HeaderAction } from "../../../ui/header-action";
import { Failure, Loading, Placeholder, StaleNotice } from "../../../ui/states";
import { usePalette } from "../../../ui/theme";

const Params = Schema.Struct({ serverId: M.ServerId });

/** Agents by most recent message; each opens its profile. */
function AgentsRow({ serverId }: { readonly serverId: M.ServerId }) {
  const palette = usePalette();
  const router = useRouter();
  const summary = useRecentAgents(serverId);
  const agents = (summary.data?.participants ?? []).filter((participant) => !isPerson(participant));
  if (agents.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.agents}
      accessibilityLabel="Agents"
    >
      {agents.map((agent) => (
        <Pressable
          key={agent.id}
          onPress={() =>
            router.push({
              pathname: "/servers/[serverId]/agents/[participantId]",
              params: { serverId, participantId: agent.id },
            })
          }
          accessibilityRole="button"
          accessibilityLabel={agent.name}
          style={({ pressed }) => [styles.agent, { opacity: pressed ? 0.6 : 1 }]}
        >
          <AgentMark subject={{ agentType: agent.agentType, name: agent.name }} size={56} />
          <Text style={[styles.agentName, { color: palette.label }]} numberOfLines={1}>
            {agent.name}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

/** A channel's tile: the number sign, as the web dashboard marks channels. */
function ChannelTile() {
  const palette = usePalette();
  return (
    <View style={[styles.channelTile, { backgroundColor: palette.fill }]}>
      <SymbolView
        name={{ ios: "number", android: "tag", web: "tag" }}
        size={22}
        weight="medium"
        tintColor={palette.secondaryLabel}
      />
    </View>
  );
}

/** Two agents' marks, overlapped, for a chat between them. */
function PairTile({
  conversation,
  participants,
}: {
  readonly conversation: M.DirectConversation;
  readonly participants: Directory;
}) {
  const palette = usePalette();
  const [first, second] = conversation.participantIds.map((id) => senderOf(participants, id, null));
  return (
    <View style={styles.pair}>
      {first !== undefined && <AgentMark subject={first} size={34} />}
      {second !== undefined && (
        <View style={[styles.pairBack, { borderColor: palette.background }]}>
          <AgentMark subject={second} size={34} />
        </View>
      )}
    </View>
  );
}

const ConversationRow = memo(function ConversationRow({
  serverId,
  entry,
  participants,
  me,
}: {
  readonly serverId: M.ServerId;
  readonly entry: ConversationEntry;
  readonly participants: Directory;
  readonly me: M.ParticipantId | null | undefined;
}) {
  const palette = usePalette();
  const router = useRouter();
  const { conversation } = entry;
  const latest = conversation.latestMessage;
  const sides = conversation.kind === "direct" ? sidesOf(conversation, participants, me) : null;
  const author = latest === null ? null : senderOf(participants, latest.senderId, me);
  const title = titleOf(conversation, participants, me);
  const excerpt =
    latest === null
      ? "No messages yet"
      : `${author?.mine ? "You" : (author?.name ?? "")}: ${excerptOf(latest.excerpt)}`;
  return (
    <Pressable
      onPress={() =>
        router.push({
          pathname: "/servers/[serverId]/conversations/[conversationId]",
          params: { serverId, conversationId: conversation.id },
        })
      }
      accessibilityRole="button"
      accessibilityLabel={`${conversation.kind === "channel" ? "Channel" : "Direct chat"} ${title}. ${excerpt}`}
      style={({ pressed }) => [styles.row, pressed ? { backgroundColor: palette.fill } : null]}
    >
      <View style={styles.leading}>
        {conversation.kind === "channel" ? (
          <ChannelTile />
        ) : sides !== null && sides.other !== null ? (
          <AgentMark subject={senderOf(participants, sides.other, me)} size={48} />
        ) : (
          <PairTile conversation={conversation} participants={participants} />
        )}
      </View>
      <View style={[styles.rowText, { borderBottomColor: palette.separator }]}>
        <View style={styles.line}>
          <Text style={[styles.title, { color: palette.label }]} numberOfLines={1}>
            {conversation.kind === "channel" ? `#${title}` : title}
          </Text>
          {latest !== null && (
            <Text style={[styles.time, { color: palette.secondaryLabel }]}>
              {formatListTime(latest.createdAt)}
            </Text>
          )}
        </View>
        <Text style={[styles.excerpt, { color: palette.secondaryLabel }]} numberOfLines={2}>
          {excerpt}
        </Text>
      </View>
    </Pressable>
  );
});

export default function Server() {
  const router = useRouter();
  const { serverId } = Schema.decodeUnknownSync(Params)(useLocalSearchParams());
  const server = useServer(serverId);
  const conversations = useConversations(serverId);
  const agents = useRecentAgents(serverId);
  const me = useMe(serverId);
  const [refreshing, setRefreshing] = useState(false);
  const blocked = denied(conversations.error);
  const data = blocked ? undefined : conversations.data;
  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([conversations.refetch(), agents.refetch(), server.refetch()]);
    setRefreshing(false);
  };
  return (
    <>
      <Stack.Screen options={{ title: server.data?.name ?? "" }} />
      <HeaderAction
        ios="square.and.pencil"
        android="edit_square"
        label="New message"
        accent
        onPress={() =>
          router.push({ pathname: "/servers/[serverId]/compose", params: { serverId } })
        }
      />
      <FlatList
        data={data?.entries ?? []}
        keyExtractor={(entry) => entry.conversation.id}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
        ListHeaderComponent={
          <>
            {data !== undefined && <StaleNotice error={conversations.error} />}
            {!blocked && <AgentsRow serverId={serverId} />}
          </>
        }
        renderItem={({ item }) => (
          <ConversationRow
            serverId={serverId}
            entry={item}
            participants={data?.participants ?? new Map()}
            me={me}
          />
        )}
        ListEmptyComponent={
          conversations.isPending ? (
            <Loading label="Loading conversations" />
          ) : conversations.error !== null && data === undefined ? (
            <Failure error={conversations.error} retry={() => void conversations.refetch()} />
          ) : (
            <Placeholder
              symbol={{ ios: "bubble.left.and.bubble.right", android: "forum", web: "forum" }}
              title="No conversations yet"
              detail="Channels and direct chats appear here when agents start talking."
            />
          )
        }
        contentContainerStyle={styles.list}
      />
    </>
  );
}

const styles = StyleSheet.create({
  list: { paddingBottom: 32, flexGrow: 1 },
  agents: { paddingHorizontal: 12, paddingTop: 4, paddingBottom: 12, gap: 4 },
  agent: { width: 72, alignItems: "center", gap: 6 },
  agentName: { fontSize: 12, maxWidth: 68 },
  row: { flexDirection: "row", paddingLeft: 16 },
  leading: { width: 48, paddingVertical: 10, marginRight: 12, alignItems: "center" },
  rowText: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 10,
    paddingRight: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  line: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  title: { flex: 1, fontSize: 17, fontWeight: "600" },
  time: { fontSize: 15 },
  excerpt: { fontSize: 15, lineHeight: 20 },
  channelTile: {
    width: 48,
    height: 48,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  pair: { width: 48, height: 48 },
  pairBack: {
    position: "absolute",
    right: -2,
    bottom: -2,
    borderWidth: 2,
    borderRadius: 11,
  },
});
