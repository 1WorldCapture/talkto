import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { Schema } from "effect";
import { describeAgentType } from "@talkto/api/agent-types";
import * as M from "@talkto/api/models";
import { denied, describeError } from "../../../../api/client";
import { isPerson, useMe, useMessageAgent } from "../../../../api/me";
import { useParticipant } from "../../../../api/queries";
import { AgentMark } from "../../../../ui/agent-mark";
import { Button } from "../../../../ui/button";
import { formatAgo, formatCount, formatDateTime } from "../../../../ui/format";
import { GroupedRow } from "../../../../ui/grouped";
import { Failure, Loading, StaleNotice } from "../../../../ui/states";
import { usePalette } from "../../../../ui/theme";

const Params = Schema.Struct({ serverId: M.ServerId, participantId: M.ParticipantId });
const mono = {
  fontFamily: process.env.EXPO_OS === "ios" ? "Menlo" : "monospace",
  fontSize: 15,
} as const;

/** One labelled fact in the details group. */
function Fact({
  label,
  value,
  first,
  last,
  monospace = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly first: boolean;
  readonly last: boolean;
  readonly monospace?: boolean;
}) {
  const palette = usePalette();
  return (
    <GroupedRow first={first} last={last} accessibilityLabel={`${label}: ${value}`}>
      <Text style={[styles.factLabel, { color: palette.secondaryLabel }]}>{label}</Text>
      <Text
        style={[styles.factValue, { color: palette.label }, monospace ? mono : null]}
        selectable
      >
        {value}
      </Text>
    </GroupedRow>
  );
}

export default function Agent() {
  const palette = usePalette();
  const { serverId, participantId } = Schema.decodeUnknownSync(Params)(useLocalSearchParams());
  const participant = useParticipant(serverId, participantId);
  const me = useMe(serverId);
  const message = useMessageAgent(serverId);
  const agent = denied(participant.error) ? undefined : participant.data;
  if (agent === undefined)
    return participant.isPending ? (
      <Loading label="Loading agent" />
    ) : (
      <Failure
        error={participant.error ?? new Error("Not found")}
        retry={() => void participant.refetch()}
      />
    );
  const person = isPerson(agent);
  // The type is under the name already, so the facts start with where the agent works.
  const facts: Array<{ label: string; value: string; monospace?: boolean }> = [];
  if (agent.workingDirectory !== null)
    facts.push({ label: "Working directory", value: agent.workingDirectory, monospace: true });
  if (agent.joinedNote !== null) facts.push({ label: "Note", value: agent.joinedNote });
  facts.push({
    label: "Last active",
    value: agent.lastMessageAt === null ? "No messages yet" : formatAgo(agent.lastMessageAt),
  });
  facts.push({ label: "Messages", value: formatCount(agent.messageCount, "message") });
  facts.push({ label: "Joined", value: formatDateTime(agent.createdAt) });
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: agent.name }} />
      <StaleNotice error={participant.error} />
      <View style={styles.hero}>
        <AgentMark
          subject={{
            agentType: agent.agentType,
            name: agent.name,
            person,
            mine: me === agent.id,
          }}
          size={84}
        />
        <Text style={[styles.name, { color: palette.label }]} selectable>
          {agent.name}
        </Text>
        <Text style={[styles.type, { color: palette.secondaryLabel }]}>
          {person ? "Person" : describeAgentType(agent.agentType).label}
        </Text>
      </View>
      {!person && (
        <View style={styles.action}>
          <Button
            label={message.pending ? "Opening…" : "Message"}
            disabled={message.pending}
            onPress={() =>
              message.start(agent.id, {
                onError: (error) => Alert.alert("Couldn't open the chat", describeError(error)),
              })
            }
          />
        </View>
      )}
      <View style={styles.facts}>
        {facts.map((fact, index) => (
          <Fact
            key={fact.label}
            label={fact.label}
            value={fact.value}
            monospace={fact.monospace === true}
            first={index === 0}
            last={index === facts.length - 1}
          />
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 40 },
  hero: { alignItems: "center", paddingTop: 12, paddingHorizontal: 24, gap: 4 },
  name: { fontSize: 26, fontWeight: "700", marginTop: 10, textAlign: "center" },
  type: { fontSize: 16 },
  action: { paddingHorizontal: 16, paddingTop: 20 },
  facts: { marginTop: 24 },
  factLabel: { fontSize: 13, marginBottom: 2 },
  factValue: { fontSize: 16, lineHeight: 21 },
});
