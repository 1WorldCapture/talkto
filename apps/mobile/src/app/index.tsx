import { useState } from "react";
import { RefreshControl, SectionList, StyleSheet, Text, View } from "react-native";
import { Stack, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { denied } from "../api/client";
import { useDirectory, useLatestMessage, useScope, type DirectoryEntry } from "../api/queries";
import { HeaderAction } from "../ui/header-action";
import { excerptOf, formatListTime } from "../ui/format";
import { GroupedHeader, GroupedRow } from "../ui/grouped";
import { Failure, Loading, Placeholder, StaleNotice } from "../ui/states";
import { usePalette } from "../ui/theme";

function ServerRow({
  server,
  first,
  last,
}: {
  readonly server: DirectoryEntry;
  readonly first: boolean;
  readonly last: boolean;
}) {
  const palette = usePalette();
  const router = useRouter();
  const latest = useLatestMessage(server.id);
  const message = latest.data?.message ?? null;
  const sender = latest.data?.sender ?? null;
  const excerpt =
    message === null
      ? latest.isPending
        ? " "
        : latest.error !== null
          ? "Messages unavailable"
          : "No messages yet"
      : `${sender === null ? "" : `${sender.name}: `}${excerptOf(message.body)}`;
  return (
    <GroupedRow
      first={first}
      last={last}
      onPress={() =>
        router.push({ pathname: "/servers/[serverId]", params: { serverId: server.id } })
      }
      accessibilityLabel={`${server.name}. ${excerpt}`}
    >
      <View style={styles.line}>
        <Text style={[styles.name, { color: palette.label }]} numberOfLines={1}>
          {server.name}
        </Text>
        {message !== null && (
          <Text style={[styles.time, { color: palette.secondaryLabel }]}>
            {formatListTime(message.createdAt)}
          </Text>
        )}
      </View>
      <Text style={[styles.excerpt, { color: palette.secondaryLabel }]} numberOfLines={2}>
        {excerpt}
      </Text>
    </GroupedRow>
  );
}

export default function Servers() {
  const router = useRouter();
  const client = useQueryClient();
  const scope = useScope();
  const directory = useDirectory();
  const [refreshing, setRefreshing] = useState(false);
  const sections = denied(directory.error) ? [] : (directory.data ?? []);
  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([
      directory.refetch(),
      client.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === scope[0] &&
          query.queryKey[1] === scope[1] &&
          query.queryKey[3] === "latest",
      }),
    ]);
    setRefreshing(false);
  };
  return (
    <>
      <Stack.Screen options={{ title: "Servers" }} />
      <HeaderAction
        ios="person.crop.circle"
        android="account_circle"
        label="Account"
        onPress={() => router.push("/account")}
      />
      <SectionList
        sections={sections.map((section) => ({ ...section, data: [...section.data] }))}
        keyExtractor={(server) => server.id}
        contentInsetAdjustmentBehavior="automatic"
        stickySectionHeadersEnabled={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
        renderSectionHeader={({ section }) => <GroupedHeader title={section.title} />}
        renderItem={({ item, index, section }) => (
          <ServerRow server={item} first={index === 0} last={index === section.data.length - 1} />
        )}
        ListHeaderComponent={
          directory.data !== undefined ? <StaleNotice error={directory.error} /> : undefined
        }
        ListEmptyComponent={
          directory.isPending ? (
            <Loading label="Loading servers" />
          ) : directory.error !== null && directory.data === undefined ? (
            <Failure error={directory.error} retry={() => void directory.refetch()} />
          ) : (
            <Placeholder
              symbol={{ ios: "server.rack", android: "dns", web: "dns" }}
              title="No servers yet"
              detail="Servers you can read appear here. Create one or ask for access on talkto.sh."
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
  line: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  name: { flex: 1, fontSize: 17, fontWeight: "600" },
  time: { fontSize: 15 },
  excerpt: { fontSize: 15, lineHeight: 20, marginTop: 2 },
});
