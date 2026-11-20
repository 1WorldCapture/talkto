import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { Schema } from "effect";
import * as M from "@talkto/api/models";
import { usePalette } from "./theme";

/** What the person wrote, checked against the message contract before it is queued. */
export interface Draft {
  readonly body: typeof M.MessageBody.Type;
  readonly urgent: boolean;
}

/** One line of text in the field, and about six before it scrolls. */
const fieldMin = 38;
const fieldMax = 140;

/**
 * The composer for the person's own chat with an agent: a growing field, an Urgent toggle on
 * the left and a round send button. Urgent asks the agent's integration to interrupt its turn.
 */
export function Composer({
  agentName,
  onSend,
  bottomInset,
}: {
  readonly agentName: string;
  readonly onSend: (draft: Draft) => void;
  readonly bottomInset: number;
}) {
  const palette = usePalette();
  const [text, setText] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // iOS keeps a multiline field's grown height after it is cleared, so each send starts a new
  // field, focused, at one line.
  const [field, setField] = useState(0);
  const empty = text.trim() === "";
  const send = () => {
    const body = Schema.decodeUnknownResult(M.MessageBody)(text);
    if (body._tag === "Failure") {
      setProblem(empty ? null : "Messages can be up to 16 KB.");
      return;
    }
    onSend({ body: body.success, urgent });
    setText("");
    setField((current) => current + 1);
    setUrgent(false);
    setProblem(null);
  };
  return (
    <View
      style={[
        styles.bar,
        {
          backgroundColor: palette.background,
          borderTopColor: palette.separator,
          paddingBottom: Math.max(bottomInset, 8),
        },
      ]}
    >
      {(problem !== null || urgent) && (
        <Text
          style={[
            styles.note,
            { color: problem !== null ? palette.danger : palette.secondaryLabel },
          ]}
          accessibilityLiveRegion="polite"
        >
          {problem ?? `Urgent: ${agentName} sees this in its current turn.`}
        </Text>
      )}
      <View style={styles.row}>
        <Pressable
          onPress={() => setUrgent(!urgent)}
          accessibilityRole="switch"
          accessibilityLabel="Urgent"
          accessibilityState={{ checked: urgent }}
          hitSlop={8}
          style={styles.side}
        >
          <SymbolView
            name={{
              ios: urgent ? "exclamationmark.circle.fill" : "exclamationmark.circle",
              android: "priority_high",
              web: "priority_high",
            }}
            size={26}
            tintColor={urgent ? palette.urgent : palette.secondaryLabel}
          />
        </Pressable>
        <TextInput
          key={field}
          autoFocus={field > 0}
          value={text}
          onChangeText={(value) => {
            setText(value);
            if (problem !== null) setProblem(null);
          }}
          placeholder={`Message ${agentName}`}
          placeholderTextColor={palette.tertiaryLabel}
          multiline
          style={[
            styles.field,
            { color: palette.label, borderColor: palette.separator, backgroundColor: palette.card },
          ]}
          accessibilityLabel={`Message ${agentName}`}
        />
        <Pressable
          onPress={send}
          disabled={empty}
          accessibilityRole="button"
          accessibilityLabel="Send"
          accessibilityState={{ disabled: empty }}
          hitSlop={8}
          style={styles.side}
        >
          <SymbolView
            name={{
              ios: "arrow.up.circle.fill",
              android: "arrow_circle_up",
              web: "arrow_circle_up",
            }}
            size={32}
            tintColor={empty ? palette.tertiaryLabel : palette.accentFill}
          />
        </Pressable>
      </View>
    </View>
  );
}

/** Agent-to-agent chats and channels are read-only; offer the person's own chat instead. */
export function ReadOnlyBar({
  agents,
  onMessage,
  onChoose,
  bottomInset,
  busy,
}: {
  /** Agents in this conversation the person can message directly, at most two. */
  readonly agents: ReadonlyArray<{ readonly id: M.ParticipantId; readonly name: string }>;
  readonly onMessage: (agentId: M.ParticipantId) => void;
  /** Channels have many speakers: open the picker instead. */
  readonly onChoose: () => void;
  readonly bottomInset: number;
  readonly busy: boolean;
}) {
  const palette = usePalette();
  const buttons =
    agents.length > 0
      ? agents.map((agent) => ({
          key: agent.id,
          label: `Message ${agent.name}`,
          press: () => onMessage(agent.id),
        }))
      : [{ key: "choose", label: "Message an agent", press: onChoose }];
  return (
    <View
      style={[
        styles.bar,
        styles.readOnly,
        {
          backgroundColor: palette.background,
          borderTopColor: palette.separator,
          paddingBottom: Math.max(bottomInset, 8),
        },
      ]}
    >
      <View style={styles.buttons}>
        {buttons.map((button) => (
          <Pressable
            key={button.key}
            onPress={button.press}
            disabled={busy}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.message,
              { backgroundColor: palette.fill, opacity: busy ? 0.5 : pressed ? 0.6 : 1 },
            ]}
          >
            <SymbolView
              name={{ ios: "bubble.left.fill", android: "chat_bubble", web: "chat_bubble" }}
              size={15}
              tintColor={palette.accent}
            />
            <Text style={[styles.messageLabel, { color: palette.accent }]} numberOfLines={1}>
              {button.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
    paddingHorizontal: 8,
    gap: 6,
  },
  readOnly: { paddingHorizontal: 16 },
  note: { fontSize: 13, paddingHorizontal: 8 },
  row: { flexDirection: "row", alignItems: "flex-end", gap: 6 },
  side: { height: 38, minWidth: 34, alignItems: "center", justifyContent: "center" },
  field: {
    flex: 1,
    fontSize: 17,
    lineHeight: 22,
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 8,
    borderRadius: 19,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: fieldMin,
    maxHeight: fieldMax,
  },
  buttons: { flexDirection: "row", gap: 8 },
  message: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: 44,
    borderRadius: 12,
    paddingHorizontal: 12,
  },
  messageLabel: { fontSize: 16, fontWeight: "600", flexShrink: 1 },
});
