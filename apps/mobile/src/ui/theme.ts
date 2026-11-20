import { useColorScheme } from "react-native";
import { DarkTheme, DefaultTheme, type Theme } from "expo-router";

/*
  iOS system colours, so the app sits with the rest of the phone in light and dark. TalkTo's
  magenta (--lamp and --lamp-ink in apps/web/src/brand-app.css) is the one accent: primary
  actions, the send button and the person's own mark. Everything else stays neutral.
*/
const light = {
  background: "#FFFFFF",
  groupedBackground: "#F2F2F7",
  card: "#FFFFFF",
  label: "#000000",
  secondaryLabel: "rgba(60, 60, 67, 0.6)",
  tertiaryLabel: "rgba(60, 60, 67, 0.3)",
  separator: "rgba(60, 60, 67, 0.29)",
  fill: "rgba(118, 118, 128, 0.12)",
  tile: "#F2F2F7",
  tileLine: "rgba(60, 60, 67, 0.12)",
  accent: "#A300A3",
  accentFill: "#F01EF0",
  accentSoft: "#F6E8F6",
  onAccent: "#FFFFFF",
  urgent: "#C4320A",
  danger: "#D70015",
};
const dark: typeof light = {
  background: "#000000",
  groupedBackground: "#000000",
  card: "#1C1C1E",
  label: "#FFFFFF",
  secondaryLabel: "rgba(235, 235, 245, 0.6)",
  tertiaryLabel: "rgba(235, 235, 245, 0.3)",
  separator: "rgba(84, 84, 88, 0.6)",
  fill: "rgba(118, 118, 128, 0.24)",
  tile: "#1C1C1E",
  tileLine: "rgba(84, 84, 88, 0.5)",
  accent: "#FF6BFF",
  accentFill: "#F01EF0",
  accentSoft: "#2A0F2A",
  onAccent: "#FFFFFF",
  urgent: "#FF9F0A",
  danger: "#FF453A",
};
/** The palette for the current system appearance. */
export type Palette = typeof light;

/** Colours follow the system light or dark setting. */
export function usePalette(): Palette {
  return useColorScheme() === "dark" ? dark : light;
}

/** Navigation chrome in the same colours; back buttons stay neutral, not magenta. */
export function useNavigationTheme(): Theme {
  const scheme = useColorScheme();
  const base = scheme === "dark" ? DarkTheme : DefaultTheme;
  const palette = scheme === "dark" ? dark : light;
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: palette.label,
      background: palette.background,
      card: palette.background,
      text: palette.label,
      border: palette.separator,
    },
  };
}
