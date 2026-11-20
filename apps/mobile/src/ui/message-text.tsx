import { memo, type ReactNode } from "react";
import { Linking, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { usePalette, type Palette } from "./theme";

/*
  A small, safe Markdown subset for message bodies, matching what apps/web/src/message-body.tsx
  allows: no raw HTML, no remote images, and only absolute web and mail links. Agents write
  this text, so nothing in it becomes anything other than text, code, emphasis or a link.
*/

/**
 * Agents write message text, so only absolute web and mail links open. A pattern rather than
 * `URL.canParse`: React Native's URL implementation does not provide it.
 */
export const safeMessageUrl = (value: string) =>
  /^(https?:\/\/[^\s/?#]+[^\s]*|mailto:[^\s@]+@[^\s@]+)$/i.test(value) ? value : null;

const open = (url: string) => {
  if (url.startsWith("mailto:")) void Linking.openURL(url);
  else void WebBrowser.openBrowserAsync(url);
};

const mono = Platform.select({ ios: "Menlo", default: "monospace" });
const inline =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/g;

function spans(text: string, palette: Palette, key: string): Array<ReactNode> {
  const out: Array<ReactNode> = [];
  let last = 0;
  for (const match of text.matchAll(inline)) {
    const [token, code, bold, link, bare] = match;
    const at = match.index;
    if (at > last) out.push(text.slice(last, at));
    const id = `${key}-${at}`;
    if (code !== undefined)
      out.push(
        <Text key={id} style={[styles.code, { backgroundColor: palette.fill }]}>
          {code.slice(1, -1)}
        </Text>,
      );
    else if (bold !== undefined)
      out.push(
        <Text key={id} style={styles.bold}>
          {bold.slice(2, -2)}
        </Text>,
      );
    else if (link !== undefined || bare !== undefined) {
      const split = link === undefined ? null : /^\[([^\]]+)\]\(([^)]+)\)$/.exec(link);
      const label = split?.[1] ?? token;
      const url = safeMessageUrl(split?.[2] ?? token);
      out.push(
        url === null ? (
          label
        ) : (
          <Text
            key={id}
            style={{ color: palette.accent }}
            onPress={() => open(url)}
            accessibilityRole="link"
          >
            {label}
          </Text>
        ),
      );
    }
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** One paragraph's lines: headings bold, list markers as bullets, quotes muted. */
function Prose({
  text,
  palette,
  id,
}: {
  readonly text: string;
  readonly palette: Palette;
  readonly id: string;
}) {
  const lines = text.split("\n");
  return (
    <Text style={[styles.body, { color: palette.label }]} selectable>
      {lines.map((line, index) => {
        const key = `${id}-${index}`;
        const end = index < lines.length - 1 ? "\n" : "";
        const heading = /^#{1,6}\s+(.*)$/.exec(line);
        if (heading?.[1] !== undefined)
          return (
            <Text key={key} style={styles.bold}>
              {spans(heading[1], palette, key)}
              {end}
            </Text>
          );
        const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
        if (bullet?.[2] !== undefined)
          return (
            <Text key={key}>
              {bullet[1]}
              {"•  "}
              {spans(bullet[2], palette, key)}
              {end}
            </Text>
          );
        const quote = /^>\s?(.*)$/.exec(line);
        if (quote?.[1] !== undefined)
          return (
            <Text key={key} style={{ color: palette.secondaryLabel }}>
              {spans(quote[1], palette, key)}
              {end}
            </Text>
          );
        return (
          <Text key={key}>
            {spans(line, palette, key)}
            {end}
          </Text>
        );
      })}
    </Text>
  );
}

/** A message body: prose and fenced code blocks. */
export const MessageText = memo(function MessageText({ body }: { readonly body: string }) {
  const palette = usePalette();
  const blocks = body.split(/^```[^\n]*\n?/m);
  return (
    <View style={styles.stack}>
      {blocks.map((block, index) => {
        const trimmed = block.replace(/\n+$/, "");
        if (trimmed === "") return null;
        // Odd blocks sit between an opening and a closing fence.
        return index % 2 === 1 ? (
          <ScrollView
            key={index}
            horizontal
            style={[styles.codeBlock, { backgroundColor: palette.fill }]}
            contentContainerStyle={styles.codeContent}
          >
            <Text style={[styles.codeText, { color: palette.label }]} selectable>
              {trimmed}
            </Text>
          </ScrollView>
        ) : (
          // A blank line starts a paragraph, spaced like the gap between blocks.
          trimmed
            .replace(/^\n+/, "")
            .split(/\n[ \t]*\n+/)
            .map((paragraph, part) => (
              <Prose
                key={`${index}-${part}`}
                text={paragraph}
                palette={palette}
                id={`${index}-${part}`}
              />
            ))
        );
      })}
    </View>
  );
});

const styles = StyleSheet.create({
  stack: { gap: 8 },
  body: { fontSize: 16, lineHeight: 22 },
  bold: { fontWeight: "600" },
  code: { fontFamily: mono, fontSize: 13.5 },
  codeBlock: { borderRadius: 8 },
  codeContent: { padding: 10 },
  codeText: { fontFamily: mono, fontSize: 13, lineHeight: 18 },
});
