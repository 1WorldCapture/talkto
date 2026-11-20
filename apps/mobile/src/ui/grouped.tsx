import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { usePalette } from "./theme";

/** An inset grouped row, as in Settings: rounded at the ends of its section. */
export function GroupedRow({
  first,
  last,
  onPress,
  children,
  accessibilityLabel,
  chevron = onPress !== undefined,
}: {
  readonly first: boolean;
  readonly last: boolean;
  readonly onPress?: (() => void) | undefined;
  readonly children: ReactNode;
  readonly accessibilityLabel?: string;
  readonly chevron?: boolean;
}) {
  const palette = usePalette();
  const surface = [
    styles.row,
    { backgroundColor: palette.card },
    first ? styles.first : null,
    last ? styles.last : null,
  ];
  const body = (
    <>
      <View style={styles.body}>{children}</View>
      {chevron && (
        <SymbolView
          name={{ ios: "chevron.right", android: "chevron_right", web: "chevron_right" }}
          size={13}
          weight="semibold"
          tintColor={palette.tertiaryLabel}
        />
      )}
      {!last && <View style={[styles.separator, { backgroundColor: palette.separator }]} />}
    </>
  );
  return onPress === undefined ? (
    <View style={surface} accessibilityLabel={accessibilityLabel}>
      {body}
    </View>
  ) : (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [...surface, pressed ? { backgroundColor: palette.fill } : null]}
    >
      {body}
    </Pressable>
  );
}

/** A grouped section's heading. */
export function GroupedHeader({ title }: { readonly title: string }) {
  const palette = usePalette();
  return (
    <Text
      style={[styles.header, { color: palette.secondaryLabel }]}
      accessibilityRole="header"
      numberOfLines={1}
    >
      {title}
    </Text>
  );
}

const styles = StyleSheet.create({
  row: {
    marginHorizontal: 16,
    paddingLeft: 16,
    paddingRight: 14,
    paddingVertical: 11,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  first: { borderTopLeftRadius: 12, borderTopRightRadius: 12 },
  last: { borderBottomLeftRadius: 12, borderBottomRightRadius: 12 },
  body: { flex: 1, minWidth: 0 },
  separator: {
    position: "absolute",
    left: 16,
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
  },
  header: {
    fontSize: 15,
    fontWeight: "600",
    marginHorizontal: 32,
    marginTop: 24,
    marginBottom: 7,
  },
});
