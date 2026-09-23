import { type ReactNode, useMemo } from "react";
import { Platform, Text, View } from "react-native";
import { Flowchart, parseFlowchart } from "./flowchart";

interface MarkdownTheme {
  foreground: string;
  foregroundMuted: string;
  surface1: string;
  border: string;
}

type Styles = ReturnType<typeof createStyles>;

function createStyles(theme: MarkdownTheme) {
  return {
    bold: { fontWeight: "700" as const },
    italic: { fontStyle: "italic" as const },
    code: { fontFamily: MONO, backgroundColor: theme.surface1 },
    link: { color: theme.foregroundMuted, textDecorationLine: "underline" as const },
    paragraph: { color: theme.foreground, marginVertical: 4, lineHeight: 22 },
    bullet: { color: theme.foreground, marginVertical: 2, lineHeight: 22 },
    quoteText: { color: theme.foregroundMuted, lineHeight: 22 },
    fence: {
      backgroundColor: theme.surface1,
      borderRadius: 6,
      padding: 10,
      marginVertical: 6,
    },
    fenceText: { color: theme.foreground, fontFamily: MONO, fontSize: 12 },
    quote: {
      borderLeftWidth: 3,
      borderLeftColor: theme.border,
      paddingLeft: 10,
      marginVertical: 4,
    },
    hr: { borderTopWidth: 1, borderTopColor: theme.border, marginVertical: 8 },
    heading: [1, 2, 3, 4, 5, 6].map((level) => ({
      color: theme.foreground,
      fontWeight: "700" as const,
      fontSize: 26 - level * 2,
      marginTop: 12,
      marginBottom: 4,
    })),
  };
}

// ponytail: a minimal line/inline renderer — headings, bold, italic, inline
// code, fenced code, bullets, quotes, hr, and link text. No tables, images,
// nested lists, or HTML. Upgrade path: a full markdown parser if the SDK ever
// exposes the host renderer.
const INLINE = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`|\[[^\]]*\]\([^)]*\))/g;
const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";

function renderInline(text: string, styles: Styles, keyPrefix: string): ReactNode[] {
  return text.split(INLINE).map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith("**") && part.endsWith("**"))
      return (
        <Text key={key} style={styles.bold}>
          {part.slice(2, -2)}
        </Text>
      );
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2)
      return (
        <Text key={key} style={styles.italic}>
          {part.slice(1, -1)}
        </Text>
      );
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
      return (
        <Text key={key} style={styles.code}>
          {part.slice(1, -1)}
        </Text>
      );
    const link = part.match(/^\[([^\]]*)\]\(([^)]*)\)$/);
    if (link)
      return (
        <Text key={key} style={styles.link}>
          {link[1] || link[2]}
        </Text>
      );
    return part;
  });
}

export function Markdown({ text, theme }: { text: string; theme: MarkdownTheme }) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  const blocks = useMemo(() => {
    const lines = text.split("\n");
    const out: ReactNode[] = [];
    let paragraph: string[] = [];
    let fence: { lang: string; lines: string[] } | null = null;

    const flushParagraph = (key: string) => {
      if (!paragraph.length) return;
      out.push(
        <Text key={key} style={styles.paragraph}>
          {renderInline(paragraph.join(" "), styles, key)}
        </Text>,
      );
      paragraph = [];
    };

    const flushFence = (key: string) => {
      if (!fence) return;
      const source = fence.lines.join("\n");
      const lang = fence.lang;
      fence = null;
      const isChart =
        (lang === "mermaid" || lang === "flowchart") && parseFlowchart(source) !== null;
      out.push(
        isChart ? (
          <Flowchart key={key} source={source} theme={theme} />
        ) : (
          <View key={key} style={styles.fence}>
            <Text style={styles.fenceText}>{source}</Text>
          </View>
        ),
      );
    };

    lines.forEach((line, index) => {
      const key = `l${index}`;
      const fenceMark = line.trimStart().match(/^```(\w*)/);
      if (fenceMark) {
        if (fence) {
          flushFence(key);
        } else {
          flushParagraph(`${key}-p`);
          fence = { lang: fenceMark[1].toLowerCase(), lines: [] };
        }
        return;
      }
      if (fence) {
        fence.lines.push(line);
        return;
      }
      const trimmed = line.trim();
      if (!trimmed) {
        flushParagraph(key);
        return;
      }
      const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushParagraph(key);
        out.push(
          <Text key={key} style={styles.heading[heading[1].length - 1]}>
            {renderInline(heading[2], styles, key)}
          </Text>,
        );
        return;
      }
      if (/^(-{3,}|_{3,}|\*{3,})$/.test(trimmed)) {
        flushParagraph(key);
        out.push(<View key={key} style={styles.hr} />);
        return;
      }
      const bullet = trimmed.match(/^[-*+]\s+(.*)$/);
      if (bullet) {
        flushParagraph(key);
        out.push(
          <Text key={key} style={styles.bullet}>
            {"• "}
            {renderInline(bullet[1], styles, key)}
          </Text>,
        );
        return;
      }
      const quote = trimmed.match(/^>\s?(.*)$/);
      if (quote) {
        flushParagraph(key);
        out.push(
          <View key={key} style={styles.quote}>
            <Text style={styles.quoteText}>{renderInline(quote[1], styles, key)}</Text>
          </View>,
        );
        return;
      }
      paragraph.push(trimmed);
    });
    flushParagraph("end");
    flushFence("fence-end");
    return out;
  }, [text, styles, theme]);
  return <View>{blocks}</View>;
}
