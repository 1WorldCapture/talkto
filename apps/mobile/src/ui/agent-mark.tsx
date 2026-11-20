import { memo, useId } from "react";
import { Image, StyleSheet, Text, View, useColorScheme } from "react-native";
import Svg, { Defs, LinearGradient, Path, Rect, Stop } from "react-native-svg";
import { describeAgentType } from "@talkto/api/agent-types";
import { drawings, type DrawnMark, type MarkFill } from "./agent-mark-drawings";
import { usePalette } from "./theme";

const pictures = {
  droid: require("../../assets/agents/droid.png"),
  gemini: require("../../assets/agents/gemini-cli.png"),
  hermesLight: require("../../assets/agents/hermes-light.png"),
  hermesDark: require("../../assets/agents/hermes-dark.png"),
};
// The dashboard's icon IDs that have their own mark under a different name.
const aliases = new Map<string, DrawnMark>([["openai", "chatgpt"]]);
const isDrawn = (icon: string): icon is DrawnMark => Object.hasOwn(drawings, icon);

/** A participant's mark: its tool's brand mark, or a person's initial. */
export interface MarkSubject {
  readonly agentType: string;
  readonly name: string;
  /** A signed-in person rather than an agent. */
  readonly person?: boolean;
  /** The reader's own participant: the one place the mark uses the accent. */
  readonly mine?: boolean;
}

function Drawing({ id, size }: { readonly id: DrawnMark; readonly size: number }) {
  const palette = usePalette();
  const dark = useColorScheme() === "dark";
  const gradient = `mark${useId().replaceAll(":", "")}`;
  const drawing = drawings[id];
  const ink = drawing.tile === "black" ? "#FFFFFF" : palette.label;
  const fill = (value: MarkFill) => {
    if (value === "ink") return ink;
    if (value === "gradient") return `url(#${gradient})`;
    // Grok Bot turns white with dark eyes on a dark background, as on the web.
    if (value === "grok-body") return dark ? "#FFFFFF" : "#0B0B0C";
    if (value === "grok-eyes") return dark ? "#0B0B0C" : "#FFFFFF";
    return value;
  };
  const side = size * drawing.scale;
  return (
    <Svg width={side} height={side} viewBox={drawing.viewBox}>
      {id === "codex" && (
        <Defs>
          <LinearGradient id={gradient} x1="0.3" y1="0" x2="0.6" y2="1">
            <Stop offset="0" stopColor="#B9ABF3" />
            <Stop offset="0.5" stopColor="#6A8AF2" />
            <Stop offset="1" stopColor="#3127F0" />
          </LinearGradient>
        </Defs>
      )}
      {id === "muse" && (
        <Defs>
          <LinearGradient
            id={gradient}
            x1="133.245"
            y1="109.046"
            x2="24.9203"
            y2="-12.5565"
            gradientUnits="userSpaceOnUse"
          >
            <Stop offset="0.254808" stopColor="#0082FB" />
            <Stop offset="0.697115" stopColor="#0064E0" />
            <Stop offset="1" stopColor="#0040DC" />
          </LinearGradient>
        </Defs>
      )}
      {drawing.paths.map(({ fill: paint, ...outline }, index) =>
        "stroke" in drawing ? (
          <Path
            key={index}
            {...outline}
            fill={fill(paint)}
            stroke={ink}
            strokeWidth={drawing.stroke.width}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <Path key={index} {...outline} fill={fill(paint)} />
        ),
      )}
    </Svg>
  );
}

/** Tools without an official mark get the dashboard's neutral mark, never an invented logo. */
function Generic({ size }: { readonly size: number }) {
  const palette = usePalette();
  const side = size * 0.5;
  return (
    <Svg width={side} height={side} viewBox="0 0 18 18" fill="none" stroke={palette.secondaryLabel}>
      <Rect x="3" y="3" width="12" height="12" strokeWidth={1.4} />
      <Path d="M6 7h6M6 11h6" strokeWidth={1.4} />
    </Svg>
  );
}

/** One mark in a rounded tile. Decorative: the name is always written next to it. */
export const AgentMark = memo(function AgentMark({
  subject,
  size = 36,
}: {
  readonly subject: MarkSubject;
  readonly size?: number;
}) {
  const palette = usePalette();
  const dark = useColorScheme() === "dark";
  const radius = Math.round(size * 0.26);
  const frame = { width: size, height: size, borderRadius: radius };
  if (subject.person) {
    const initial = [...subject.name][0]?.toUpperCase() ?? "?";
    return (
      <View
        style={[
          styles.tile,
          frame,
          { backgroundColor: subject.mine ? palette.accentFill : palette.fill, borderWidth: 0 },
        ]}
        accessible={false}
      >
        <Text
          style={[
            styles.initial,
            { fontSize: size * 0.44, color: subject.mine ? palette.onAccent : palette.label },
          ]}
        >
          {initial}
        </Text>
      </View>
    );
  }
  const icon = describeAgentType(subject.agentType).icon;
  if (icon === "gemini")
    return <Image source={pictures.gemini} style={frame} accessibilityIgnoresInvertColors />;
  const id = aliases.get(icon) ?? (isDrawn(icon) ? icon : null);
  const black = icon === "droid" || (id !== null && drawings[id].tile === "black");
  return (
    <View
      style={[
        styles.tile,
        frame,
        {
          backgroundColor: black ? "#000000" : palette.tile,
          borderColor: black ? (dark ? "#34352F" : "#000000") : palette.tileLine,
        },
      ]}
      accessible={false}
    >
      {icon === "droid" ? (
        <Image
          source={pictures.droid}
          style={{ width: size * 0.62, height: size * 0.62, tintColor: "#FFFFFF" }}
        />
      ) : icon === "hermes" ? (
        <Image
          source={dark ? pictures.hermesDark : pictures.hermesLight}
          style={{ width: size * 0.62, height: size * 0.62, tintColor: palette.label }}
        />
      ) : id !== null ? (
        <Drawing id={id} size={size} />
      ) : (
        <Generic size={size} />
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  tile: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  initial: { fontWeight: "600" },
});
