import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { randomUUID } from "expo-crypto";
import { Schema } from "effect";
import * as M from "@talkto/api/models";
import { denied, describeError } from "../../../../api/client";
import { useConversationFeed } from "../../../../api/feed";
import { useMe, useMessageAgent, usePersonMessaging } from "../../../../api/me";
import type * as I from "@talkto/api/inputs";
import { useConversation, useScope } from "../../../../api/queries";
import { Composer, ReadOnlyBar, type Draft } from "../../../../ui/composer";
import { senderOf, sidesOf, titleOf, type Directory } from "../../../../ui/conversation";
import { formatDay } from "../../../../ui/format";
import { HeaderAction } from "../../../../ui/header-action";
import { MessageRow } from "../../../../ui/message-row";
import { MessageText } from "../../../../ui/message-text";
import { AgentMark } from "../../../../ui/agent-mark";
import { Failure, Loading, Placeholder, StaleNotice } from "../../../../ui/states";
import { usePalette } from "../../../../ui/theme";

const Params = Schema.Struct({ serverId: M.ServerId, conversationId: M.ConversationId });
/** Messages from one sender within five minutes share one heading. */
const runGap = 5 * 60_000;

/** A message the person wrote that the server has not confirmed. */
interface Pending {
  readonly key: M.RequestKey;
  readonly draft: Draft;
  readonly status: "sending" | "failed";
  readonly problem: string | null;
}

type Item =
  | { readonly kind: "message"; readonly message: M.Message; readonly startsRun: boolean }
  | { readonly kind: "day"; readonly key: string; readonly label: string }
  | { readonly kind: "pending"; readonly pending: Pending };

/** Newest first, as the inverted list draws them, with a heading where each day starts. */
function itemsOf(messages: ReadonlyArray<M.Message>, pending: ReadonlyArray<Pending>) {
  const items: Array<Item> = pending
    .slice()
    .reverse()
    .map((entry) => ({ kind: "pending", pending: entry }));
  messages.forEach((message, index) => {
    const older = messages[index + 1];
    const day = new Date(message.createdAt).toDateString();
    const newDay = older === undefined || new Date(older.createdAt).toDateString() !== day;
    const startsRun =
      newDay ||
      older === undefined ||
      older.senderId !== message.senderId ||
      // TalkTo's notices are not in their sender's voice, so they never join or continue a run.
      older.notice !== undefined ||
      message.notice !== undefined ||
      Date.parse(message.createdAt) - Date.parse(older.createdAt) > runGap;
    items.push({ kind: "message", message, startsRun });
    if (newDay) items.push({ kind: "day", key: `day-${day}`, label: formatDay(message.createdAt) });
  });
  return items;
}

/** The person's unconfirmed message: what they wrote, and whether it is on its way or failed. */
function PendingRow({
  pending,
  name,
  onRetry,
  onDiscard,
}: {
  readonly pending: Pending;
  readonly name: string;
  readonly onRetry: () => void;
  readonly onDiscard: () => void;
}) {
  const palette = usePalette();
  const failed = pending.status === "failed";
  const choose = () => {
    if (Platform.OS === "ios")
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ["Try Again", "Delete Message", "Cancel"],
          destructiveButtonIndex: 1,
          cancelButtonIndex: 2,
          title: pending.problem ?? "Not sent",
        },
        (index) => {
          if (index === 0) onRetry();
          if (index === 1) onDiscard();
        },
      );
    else
      Alert.alert("Not sent", pending.problem ?? undefined, [
        { text: "Delete", style: "destructive", onPress: onDiscard },
        { text: "Try Again", onPress: onRetry },
      ]);
  };
  return (
    <Pressable
      onPress={failed ? choose : undefined}
      disabled={!failed}
      accessibilityRole={failed ? "button" : "text"}
      accessibilityLabel={
        failed ? `Not sent: ${pending.draft.body}. Double-tap for options.` : undefined
      }
      style={styles.pending}
    >
      <View style={styles.pendingGutter}>
        <AgentMark subject={{ agentType: "person", name, person: true, mine: true }} size={36} />
      </View>
      <View style={[styles.pendingContent, { opacity: failed ? 1 : 0.55 }]}>
        <Text style={[styles.pendingName, { color: palette.label }]}>You</Text>
        <MessageText body={pending.draft.body} />
        <View style={styles.pendingStatus}>
          {failed ? (
            <Text style={[styles.pendingLabel, { color: palette.danger }]}>
              Not sent. Tap to try again.
            </Text>
          ) : (
            <>
              <ActivityIndicator size="small" />
              <Text style={[styles.pendingLabel, { color: palette.secondaryLabel }]}>
                {pending.draft.urgent ? "Sending urgently…" : "Sending…"}
              </Text>
            </>
          )}
        </View>
      </View>
    </Pressable>
  );
}

function DayHeading({ label }: { readonly label: string }) {
  const palette = usePalette();
  return (
    <Text style={[styles.day, { color: palette.secondaryLabel }]} accessibilityRole="header">
      {label}
    </Text>
  );
}

export default function Conversation() {
  const palette = usePalette();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { serverId, conversationId } = Schema.decodeUnknownSync(Params)(useLocalSearchParams());
  const selected = useConversation(serverId, conversationId);
  const feed = useConversationFeed(serverId, conversationId);
  const me = useMe(serverId);
  const messaging = usePersonMessaging();
  const messageAgent = useMessageAgent(serverId);
  const client = useQueryClient();
  const scope = useScope();
  const [pending, setPending] = useState<ReadonlyArray<Pending>>([]);
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    const shown = Keyboard.addListener("keyboardWillShow", () => setKeyboard(true));
    const hidden = Keyboard.addListener("keyboardWillHide", () => setKeyboard(false));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  const conversation = denied(selected.error) ? undefined : selected.data?.data;
  const participants = useMemo<Directory>(() => {
    const all = new Map(feed.participants);
    for (const participant of selected.data?.included.participants ?? [])
      all.set(participant.id, participant);
    return all;
  }, [feed.participants, selected.data]);
  const sides = conversation?.kind === "direct" ? sidesOf(conversation, participants, me) : null;
  const agent = sides?.other ?? null;
  const agentName = agent === null ? "" : (participants.get(agent)?.name ?? "the agent");
  // The mark shows the person's own initial; the row still says "You".
  const myName = me === null || me === undefined ? "You" : (participants.get(me)?.name ?? "You");

  const send = useMutation({
    mutationFn: (entry: Pending) => {
      const base = { conversationId, requestKey: entry.key, body: entry.draft.body };
      const message: I.SendPersonMessage = entry.draft.urgent
        ? { ...base, priority: "urgent" }
        : base;
      return messaging.sendMessage(serverId, message);
    },
    onSuccess(message, entry) {
      feed.add(message);
      setPending((all) => all.filter((item) => item.key !== entry.key));
      // The server's list and the Servers excerpt show this message without waiting for a poll.
      for (const list of ["conversations", "latest"])
        void client.invalidateQueries({ queryKey: [...scope, serverId, list] });
    },
    onError(error, entry) {
      setPending((all) =>
        all.map((item) =>
          item.key === entry.key
            ? { ...item, status: "failed", problem: describeError(error) }
            : item,
        ),
      );
    },
  });
  const { mutate } = send;
  const queue = useCallback(
    (draft: Draft) => {
      const entry: Pending = {
        key: M.RequestKey.make(randomUUID()),
        draft,
        status: "sending",
        problem: null,
      };
      setPending((all) => [...all, entry]);
      mutate(entry);
    },
    [mutate],
  );
  // A retry reuses the request key, so a send that did arrive is not delivered twice.
  const retry = (entry: Pending) => {
    const again: Pending = { ...entry, status: "sending", problem: null };
    setPending((all) => all.map((item) => (item.key === entry.key ? again : item)));
    mutate(again);
  };
  const discard = (entry: Pending) =>
    setPending((all) => all.filter((item) => item.key !== entry.key));

  const items = useMemo(() => itemsOf(feed.messages, pending), [feed.messages, pending]);
  const title =
    conversation === undefined
      ? ""
      : conversation.kind === "channel"
        ? `#${conversation.name}`
        : titleOf(conversation, participants, me);
  const openAgent = (participantId: M.ParticipantId) =>
    router.push({
      pathname: "/servers/[serverId]/agents/[participantId]",
      params: { serverId, participantId },
    });
  const startChat = (agentId: M.ParticipantId) =>
    messageAgent.start(agentId, {
      onError: (error) => Alert.alert("Couldn't open the chat", describeError(error)),
    });

  const error = feed.history.error ?? feed.live.error;
  const bottomInset = keyboard ? 0 : insets.bottom;
  const footer =
    conversation === undefined ? null : agent !== null ? (
      <Composer agentName={agentName} onSend={queue} bottomInset={bottomInset} />
    ) : (
      <ReadOnlyBar
        agents={(sides?.agents ?? []).slice(0, 2).map((id) => ({
          id,
          name: participants.get(id)?.name ?? "agent",
        }))}
        onMessage={startChat}
        onChoose={() =>
          router.push({ pathname: "/servers/[serverId]/compose", params: { serverId } })
        }
        bottomInset={bottomInset}
        busy={messageAgent.pending}
      />
    );

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={0}
    >
      <Stack.Screen options={{ title }} />
      {agent !== null && (
        <HeaderAction
          ios="info.circle"
          android="info"
          label={`${agentName} details`}
          onPress={() => openAgent(agent)}
        />
      )}
      {feed.history.data === undefined ? (
        feed.history.isPending ? (
          <Loading label="Loading messages" />
        ) : (
          <Failure
            error={feed.history.error ?? new Error("Unavailable")}
            retry={() => void feed.history.refetch()}
          />
        )
      ) : items.length === 0 ? (
        <Placeholder
          symbol={{
            ios: "bubble.left",
            android: "chat_bubble_outline",
            web: "chat_bubble_outline",
          }}
          title="No messages yet"
          detail={
            agent !== null
              ? `Say hello to ${agentName}.`
              : "Messages appear here as agents send them."
          }
        />
      ) : (
        <FlatList
          inverted
          data={items}
          keyExtractor={(item) =>
            item.kind === "message"
              ? item.message.id
              : item.kind === "day"
                ? item.key
                : item.pending.key
          }
          renderItem={({ item }) =>
            item.kind === "day" ? (
              <DayHeading label={item.label} />
            ) : item.kind === "pending" ? (
              <PendingRow
                pending={item.pending}
                name={myName}
                onRetry={() => retry(item.pending)}
                onDiscard={() => discard(item.pending)}
              />
            ) : (
              <MessageRow
                message={item.message}
                sender={senderOf(participants, item.message.senderId, me)}
                startsRun={item.startsRun}
                onPressSender={
                  item.message.senderId === me ? undefined : () => openAgent(item.message.senderId)
                }
              />
            )
          }
          onEndReached={() => {
            if (feed.history.hasNextPage && !feed.history.isFetchingNextPage)
              void feed.history.fetchNextPage();
          }}
          onEndReachedThreshold={0.5}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.list}
          ListHeaderComponent={<StaleNotice error={denied(error) ? null : error} />}
          ListFooterComponent={
            feed.history.isFetchingNextPage ? (
              <ActivityIndicator style={styles.older} />
            ) : !feed.history.hasNextPage ? (
              <Text style={[styles.start, { color: palette.tertiaryLabel }]}>
                Start of the conversation
              </Text>
            ) : undefined
          }
        />
      )}
      {footer}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  list: { paddingVertical: 8 },
  day: { textAlign: "center", fontSize: 13, fontWeight: "600", paddingTop: 20, paddingBottom: 4 },
  older: { paddingVertical: 16 },
  start: { textAlign: "center", fontSize: 13, paddingVertical: 20 },
  pending: { flexDirection: "row", paddingHorizontal: 16, paddingTop: 12, paddingBottom: 3 },
  pendingGutter: { width: 36, marginRight: 10 },
  pendingContent: { flex: 1, minWidth: 0, gap: 6 },
  pendingName: { fontSize: 15, fontWeight: "600" },
  pendingStatus: { flexDirection: "row", alignItems: "center", gap: 6 },
  pendingLabel: { fontSize: 13 },
});
