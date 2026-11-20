import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SymbolView } from "expo-symbols";
import type * as M from "@talkto/api/models";
import { AgentMark } from "./agent-mark";
import { MessageText } from "./message-text";
import { formatBytes, formatClock, formatDateTime } from "./format";
import { usePalette } from "./theme";

/** Who sent a message, as far as this reader can tell. */
export interface Sender {
  readonly name: string;
  readonly agentType: string;
  readonly person: boolean;
  readonly mine: boolean;
}

/** A file announced in Git: path, ref and commit, as the sharer stated them. */
function ShareCard({ share }: { readonly share: M.FileShare }) {
  const palette = usePalette();
  const segments = share.path.split("/");
  const name = segments.at(-1) ?? share.path;
  const folder = segments.slice(0, -1).join("/");
  const facts = [share.ref, share.commit.slice(0, 7)];
  if (share.bytes !== undefined) facts.push(formatBytes(share.bytes));
  return (
    <View
      style={[styles.card, { backgroundColor: palette.card, borderColor: palette.separator }]}
      accessible
      accessibilityLabel={`Shared file ${share.path}, ${facts.join(", ")}`}
    >
      <View style={[styles.cardIcon, { backgroundColor: palette.fill }]}>
        <SymbolView
          name={{ ios: "doc.text", android: "description", web: "description" }}
          size={20}
          tintColor={palette.secondaryLabel}
        />
      </View>
      <View style={styles.cardText}>
        <Text style={[styles.cardTitle, { color: palette.label }]} numberOfLines={1}>
          {name}
        </Text>
        {folder !== "" && (
          <Text style={[styles.cardDetail, { color: palette.secondaryLabel }]} numberOfLines={1}>
            {folder}
          </Text>
        )}
        <Text style={[styles.cardDetail, { color: palette.secondaryLabel }]} numberOfLines={1}>
          {facts.join(" · ")}
        </Text>
      </View>
    </View>
  );
}

/** A file or folder offered for download; agents fetch it, the app only shows the offer. */
function TransferCard({ transfer }: { readonly transfer: M.FileTransfer }) {
  const palette = usePalette();
  const facts = [formatBytes(transfer.bytes)];
  if (transfer.fileCount !== null) facts.push(`${transfer.fileCount.toLocaleString()} files`);
  facts.push(`Expires ${formatDateTime(transfer.expiresAt)}`);
  return (
    <View
      style={[styles.card, { backgroundColor: palette.card, borderColor: palette.separator }]}
      accessible
      accessibilityLabel={`${transfer.kind === "folder" ? "Folder" : "File"} ${transfer.name}, ${facts.join(", ")}`}
    >
      <View style={[styles.cardIcon, { backgroundColor: palette.fill }]}>
        <SymbolView
          name={
            transfer.kind === "folder"
              ? { ios: "folder", android: "folder", web: "folder" }
              : { ios: "doc", android: "draft", web: "draft" }
          }
          size={20}
          tintColor={palette.secondaryLabel}
        />
      </View>
      <View style={styles.cardText}>
        <Text style={[styles.cardTitle, { color: palette.label }]} numberOfLines={1}>
          {transfer.name}
        </Text>
        <Text style={[styles.cardDetail, { color: palette.secondaryLabel }]} numberOfLines={2}>
          {facts.join(" · ")}
        </Text>
      </View>
    </View>
  );
}

/** TalkTo's own notice, such as a new channel: one quiet line, not a message in the sender's voice. */
function NoticeRow({ message, sender }: { readonly message: M.Message; readonly sender: Sender }) {
  const palette = usePalette();
  const channel = message.notice?.channelName ?? "";
  const description = message.body
    .split("\n")
    .find((line) => line.startsWith("Description: "))
    ?.slice("Description: ".length);
  return (
    <View style={styles.notice} accessible>
      <Text style={[styles.noticeText, { color: palette.secondaryLabel }]}>
        <Text style={{ color: palette.label }}>{sender.mine ? "You" : sender.name}</Text> created{" "}
        <Text style={{ color: palette.label }}>#{channel}</Text>
        {description === undefined ? "" : ` · ${description}`} · {formatClock(message.createdAt)}
      </Text>
    </View>
  );
}

/** One message: the sender's mark and name start a run; later messages in the run stay compact. */
export const MessageRow = memo(function MessageRow({
  message,
  sender,
  startsRun,
  onPressSender,
}: {
  readonly message: M.Message;
  readonly sender: Sender;
  readonly startsRun: boolean;
  readonly onPressSender?: (() => void) | undefined;
}) {
  const palette = usePalette();
  const name = sender.mine ? "You" : sender.name;
  if (message.notice !== undefined) return <NoticeRow message={message} sender={sender} />;
  return (
    <View style={[styles.row, startsRun ? styles.runStart : null]}>
      <View style={styles.gutter}>
        {startsRun && (
          <Pressable
            onPress={onPressSender}
            disabled={onPressSender === undefined}
            accessibilityRole="button"
            accessibilityLabel={`${sender.name} details`}
          >
            <AgentMark subject={sender} size={36} />
          </Pressable>
        )}
      </View>
      <View style={styles.content}>
        {startsRun && (
          <View style={styles.header}>
            <Text style={[styles.name, { color: palette.label }]} numberOfLines={1}>
              {name}
            </Text>
            <Text style={[styles.time, { color: palette.secondaryLabel }]}>
              {formatClock(message.createdAt)}
            </Text>
          </View>
        )}
        {message.priority === "urgent" && (
          <View style={styles.urgent}>
            <SymbolView
              name={{
                ios: "exclamationmark.circle.fill",
                android: "priority_high",
                web: "priority_high",
              }}
              size={12}
              tintColor={palette.urgent}
            />
            <Text style={[styles.urgentLabel, { color: palette.urgent }]}>Urgent</Text>
          </View>
        )}
        <MessageText body={message.body} />
        {message.share !== undefined && <ShareCard share={message.share} />}
        {message.transfer !== undefined && <TransferCard transfer={message.transfer} />}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: "row", paddingHorizontal: 16, paddingVertical: 3 },
  runStart: { paddingTop: 12 },
  gutter: { width: 36, marginRight: 10 },
  content: { flex: 1, minWidth: 0, gap: 6 },
  header: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  name: { fontSize: 15, fontWeight: "600", flexShrink: 1 },
  time: { fontSize: 13 },
  urgent: { flexDirection: "row", alignItems: "center", gap: 4 },
  notice: { paddingHorizontal: 16, paddingVertical: 10 },
  noticeText: { fontSize: 13, textAlign: "center" },
  urgentLabel: { fontSize: 12, fontWeight: "600" },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: 360,
  },
  cardIcon: {
    width: 40,
    height: 40,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  cardText: { flex: 1, minWidth: 0, gap: 1 },
  cardTitle: { fontSize: 15, fontWeight: "500" },
  cardDetail: { fontSize: 13 },
});
