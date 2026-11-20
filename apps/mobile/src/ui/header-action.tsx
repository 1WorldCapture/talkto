import { Pressable } from "react-native";
import { Stack } from "expo-router";
import { SymbolView, type AndroidSymbol, type SFSymbol } from "expo-symbols";
import { usePalette } from "./theme";

/**
 * One button on the right of the navigation bar: a native toolbar item with an SF Symbol on
 * iOS, and the matching Material Symbol in the app bar on Android.
 */
export function HeaderAction({
  ios,
  android,
  label,
  onPress,
  accent = false,
}: {
  readonly ios: SFSymbol;
  readonly android: AndroidSymbol;
  readonly label: string;
  readonly onPress: () => void;
  /** The screen's primary action, such as composing, takes the accent. */
  readonly accent?: boolean;
}) {
  const palette = usePalette();
  const tint = accent ? palette.accent : palette.label;
  if (process.env.EXPO_OS === "ios")
    return (
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={ios}
          accessibilityLabel={label}
          tintColor={tint}
          onPress={onPress}
        />
      </Stack.Toolbar>
    );
  return (
    <Stack.Screen
      options={{
        headerRight: () => (
          <Pressable
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={label}
            hitSlop={12}
          >
            <SymbolView name={{ ios, android, web: android }} size={24} tintColor={tint} />
          </Pressable>
        ),
      }}
    />
  );
}
