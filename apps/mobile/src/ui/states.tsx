import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { describeError } from "../api/client";
import { usePalette } from "./theme";

/** A quiet spinner where content will be. */
export function Loading({ label }: { readonly label: string }) {
  const palette = usePalette();
  return (
    <View style={styles.center} accessibilityLabel={label} accessibilityRole="progressbar">
      <ActivityIndicator color={palette.secondaryLabel} />
    </View>
  );
}

/** Centred symbol, title and one line of explanation. */
export function Placeholder({
  symbol,
  title,
  detail,
  action,
}: {
  readonly symbol: SymbolViewProps["name"];
  readonly title: string;
  readonly detail?: string | undefined;
  readonly action?: ReactNode;
}) {
  const palette = usePalette();
  return (
    <View style={styles.center}>
      <SymbolView name={symbol} size={40} tintColor={palette.tertiaryLabel} weight="light" />
      <Text style={[styles.title, { color: palette.label }]}>{title}</Text>
      {detail !== undefined && (
        <Text style={[styles.detail, { color: palette.secondaryLabel }]}>{detail}</Text>
      )}
      {action}
    </View>
  );
}

/** A read failed and nothing is cached: explain and offer one retry. */
export function Failure({ error, retry }: { readonly error: Error; readonly retry: () => void }) {
  const palette = usePalette();
  return (
    <Placeholder
      symbol={{ ios: "wifi.exclamationmark", android: "wifi_off", web: "wifi_off" }}
      title="Couldn't load"
      detail={describeError(error)}
      action={
        <Pressable
          onPress={retry}
          accessibilityRole="button"
          style={({ pressed }) => [styles.retry, { opacity: pressed ? 0.5 : 1 }]}
        >
          <Text style={[styles.retryLabel, { color: palette.accent }]}>Try Again</Text>
        </Pressable>
      }
    />
  );
}

/** Cached content stays on screen; one line says it may be out of date. */
export function StaleNotice({ error }: { readonly error: Error | null }) {
  const palette = usePalette();
  if (error === null) return null;
  return (
    <View style={[styles.notice, { backgroundColor: palette.fill }]} accessibilityRole="alert">
      <SymbolView
        name={{ ios: "exclamationmark.triangle.fill", android: "warning", web: "warning" }}
        size={13}
        tintColor={palette.secondaryLabel}
      />
      <Text style={[styles.noticeText, { color: palette.secondaryLabel }]} numberOfLines={2}>
        {describeError(error)} Showing what was last loaded.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 40,
    paddingVertical: 64,
    gap: 6,
  },
  title: { fontSize: 20, fontWeight: "600", marginTop: 10, textAlign: "center" },
  detail: { fontSize: 15, lineHeight: 20, textAlign: "center" },
  retry: { marginTop: 12, paddingVertical: 8, paddingHorizontal: 16 },
  retryLabel: { fontSize: 17 },
  notice: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginVertical: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  noticeText: { flex: 1, fontSize: 13 },
});
