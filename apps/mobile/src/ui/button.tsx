import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { usePalette } from "./theme";

/** The one filled button style: the accent, for the primary action on a screen. */
export function Button({
  label,
  onPress,
  disabled = false,
  accessory = null,
  kind = "primary",
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly accessory?: ReactNode;
  /** `secondary` is a neutral tinted button for actions beside a primary one. */
  readonly kind?: "primary" | "secondary";
}) {
  const palette = usePalette();
  const primary = kind === "primary";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: primary ? palette.accentFill : palette.fill,
          opacity: disabled ? 0.5 : pressed ? 0.75 : 1,
        },
      ]}
    >
      <View style={styles.inner}>
        {accessory}
        <Text
          style={[styles.label, { color: primary ? palette.onAccent : palette.label }]}
          numberOfLines={1}
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 50,
    borderRadius: 14,
    paddingHorizontal: 20,
    justifyContent: "center",
    flexShrink: 1,
  },
  inner: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  label: { fontSize: 17, fontWeight: "600" },
});
