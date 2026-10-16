import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { useCallback, useMemo } from "react";
import { Pressable, Text, View, type TextStyle } from "react-native";

type Theme = PluginScreenProps["theme"];

const MONO = "monospace";
/** 缩进一层对应的像素，用于嵌套列表。 */
const INDENT_STEP = 12;

interface ListItem {
  text: string;
  indent: number;
}

type Block =
  | { type: "code"; lang: string; code: string }
  | { type: "heading"; level: number; text: string }
  | { type: "list"; ordered: boolean; items: ListItem[] }
  | { type: "quote"; text: string }
  | { type: "hr" }
  | { type: "paragraph"; text: string };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UL_RE = /^\s*[-*+]\s+/;
const OL_RE = /^\s*\d+[.)]\s+/;
const UL_ITEM_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_ITEM_RE = /^(\s*)\d+[.)]\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?/;
/** 分隔线：三个及以上的 `-` / `*` / `_`。 */
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * 行内语法：code / bold / strike / italic / link。无捕获组，便于 split 保留分隔符。
 * 故意不支持 `_`/`__` 变体——会把 `some_var_name`、`__init__` 之类的标识符误当强调。
 */
const INLINE_RE = /`[^`\n]+`|\*\*[^*\n]+\*\*|~~[^~\n]+~~|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\n]+\)/g;

function indentOf(whitespace: string): number {
  return Math.min(6, Math.floor(whitespace.replace(/\t/g, "  ").length / 2));
}

function isBlockStart(line: string): boolean {
  return (
    line.trim() === "" ||
    /^```/.test(line) ||
    HR_RE.test(line) ||
    HEADING_RE.test(line) ||
    QUOTE_RE.test(line) ||
    UL_RE.test(line) ||
    OL_RE.test(line)
  );
}

function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      const lang = (fence[1] ?? "").trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index] ?? "")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      index += 1; // 跳过收尾的 ```
      blocks.push({ type: "code", lang, code: code.join("\n") });
      continue;
    }
    if (HR_RE.test(line)) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: (heading[1] ?? "").length, text: heading[2] ?? "" });
      index += 1;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && QUOTE_RE.test(lines[index] ?? "")) {
        quote.push((lines[index] ?? "").replace(QUOTE_RE, ""));
        index += 1;
      }
      blocks.push({ type: "quote", text: quote.join("\n") });
      continue;
    }
    if (UL_RE.test(line)) {
      const items: ListItem[] = [];
      while (index < lines.length) {
        const match = UL_ITEM_RE.exec(lines[index] ?? "");
        if (!match) break;
        items.push({ text: match[2] ?? "", indent: indentOf(match[1] ?? "") });
        index += 1;
      }
      blocks.push({ type: "list", ordered: false, items });
      continue;
    }
    if (OL_RE.test(line)) {
      const items: ListItem[] = [];
      while (index < lines.length) {
        const match = OL_ITEM_RE.exec(lines[index] ?? "");
        if (!match) break;
        items.push({ text: match[2] ?? "", indent: indentOf(match[1] ?? "") });
        index += 1;
      }
      blocks.push({ type: "list", ordered: true, items });
      continue;
    }
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && !isBlockStart(lines[index] ?? "")) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join("\n") });
  }
  return blocks;
}

function useStyles(theme: Theme) {
  return useMemo(
    () => ({
      root: { gap: 6 },
      heading: { fontWeight: "700" as const, color: theme.colors.foreground },
      h1: { fontSize: 16 },
      h2: { fontSize: 15 },
      h3: { fontSize: 14, fontWeight: "600" as const },
      codeBlock: {
        backgroundColor: theme.colors.surface2,
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 6,
        gap: 4,
      },
      codeHeader: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      codeLang: { color: theme.colors.foregroundMuted, fontSize: 11 },
      codeCopy: { color: theme.colors.accent, fontSize: 11 },
      codeText: { fontFamily: MONO, fontSize: 13, lineHeight: 19, color: theme.colors.foreground },
      inlineCode: { fontFamily: MONO, fontSize: 13, color: theme.colors.accent },
      bold: { fontWeight: "700" as const },
      italic: { fontStyle: "italic" as const },
      strike: { textDecorationLine: "line-through" as const },
      link: { color: theme.colors.accent, textDecorationLine: "underline" as const },
      hr: { height: 1, backgroundColor: theme.colors.border },
      list: { gap: 3 },
      listItem: { flexDirection: "row" as const, gap: 6 },
      bullet: { color: theme.colors.foregroundMuted, minWidth: 14 },
      listText: { flex: 1 },
      quote: {
        borderLeftWidth: 3,
        borderLeftColor: theme.colors.border,
        paddingLeft: 8,
      },
      quoteText: { color: theme.colors.foregroundMuted },
    }),
    [theme],
  );
}

type Styles = ReturnType<typeof useStyles>;

function renderInline(text: string, styles: Styles, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  text.split(INLINE_RE).forEach((part, index) => {
    if (part.length === 0) return;
    const key = `${keyPrefix}-${index}`;
    if (/^`[^`]+`$/.test(part)) {
      nodes.push(
        <Text key={key} style={styles.inlineCode}>
          {part.slice(1, -1)}
        </Text>,
      );
    } else if (/^\*\*[^*]+\*\*$/.test(part)) {
      nodes.push(
        <Text key={key} style={styles.bold}>
          {part.slice(2, -2)}
        </Text>,
      );
    } else if (/^~~[^~]+~~$/.test(part)) {
      nodes.push(
        <Text key={key} style={styles.strike}>
          {part.slice(2, -2)}
        </Text>,
      );
    } else if (/^\*[^*]+\*$/.test(part)) {
      nodes.push(
        <Text key={key} style={styles.italic}>
          {part.slice(1, -1)}
        </Text>,
      );
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
      if (link) {
        const url = link[2] ?? "";
        nodes.push(
          <Text
            key={key}
            style={styles.link}
            onPress={() => {
              void openExternalUrl(url);
            }}
          >
            {link[1]}
          </Text>,
        );
      } else {
        nodes.push(<Text key={key}>{part}</Text>);
      }
    }
  });
  return nodes;
}

function CodeBlock({
  code,
  lang,
  theme,
  styles,
}: {
  code: string;
  lang: string;
  theme: Theme;
  styles: Styles;
}) {
  const toast = useToast();
  const handleCopy = useCallback(() => {
    copyText(code)
      .then(() => toast.show("已复制"))
      .catch(() => toast.show("复制失败", { variant: "error" }));
  }, [code, toast]);

  return (
    <View style={styles.codeBlock}>
      <View style={styles.codeHeader}>
        <Text style={styles.codeLang}>{lang.length > 0 ? lang : "code"}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="复制代码" onPress={handleCopy}>
          <Text style={styles.codeCopy}>复制</Text>
        </Pressable>
      </View>
      <Text style={styles.codeText}>{code.length > 0 ? code : " "}</Text>
    </View>
  );
}

function BlockView({
  block,
  index,
  theme,
  styles,
  baseStyle,
}: {
  block: Block;
  index: number;
  theme: Theme;
  styles: Styles;
  baseStyle?: TextStyle;
}) {
  switch (block.type) {
    case "code":
      return <CodeBlock code={block.code} lang={block.lang} theme={theme} styles={styles} />;
    case "heading": {
      const level = block.level <= 1 ? styles.h1 : block.level === 2 ? styles.h2 : styles.h3;
      return (
        <Text style={[styles.heading, level]}>
          {renderInline(block.text, styles, `h${index}`)}
        </Text>
      );
    }
    case "hr":
      return <View style={styles.hr} />;
    case "quote":
      return (
        <View style={styles.quote}>
          <Markdown text={block.text} theme={theme} baseStyle={styles.quoteText} />
        </View>
      );
    case "list":
      return (
        <View style={styles.list}>
          {block.items.map((item, itemIndex) => (
            <View key={itemIndex} style={styles.listItem}>
              <Text style={styles.bullet}>{block.ordered ? `${itemIndex + 1}.` : "•"}</Text>
              <Text style={[baseStyle, styles.listText, { marginLeft: item.indent * INDENT_STEP }]}>
                {renderInline(item.text, styles, `l${index}-${itemIndex}`)}
              </Text>
            </View>
          ))}
        </View>
      );
    default:
      return <Text style={baseStyle}>{renderInline(block.text, styles, `p${index}`)}</Text>;
  }
}

/** 轻量 markdown 渲染（标题 / 代码块 / 列表 / 引用 / 分隔线 / 粗体 / 斜体 / 行内码 / 链接），不引入额外依赖。 */
export function Markdown({
  text,
  theme,
  baseStyle,
}: {
  text: string;
  theme: Theme;
  baseStyle?: TextStyle;
}) {
  const styles = useStyles(theme);
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <View style={styles.root}>
      {blocks.map((block, index) => (
        <BlockView
          key={index}
          block={block}
          index={index}
          theme={theme}
          styles={styles}
          baseStyle={baseStyle}
        />
      ))}
    </View>
  );
}
