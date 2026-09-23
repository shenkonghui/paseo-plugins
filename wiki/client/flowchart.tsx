import { useMemo } from "react";
import { ScrollView, Text, View } from "react-native";

interface FlowTheme {
  foreground: string;
  foregroundMuted: string;
  surface1: string;
  border: string;
}

interface FlowNode {
  id: string;
  label: string;
  shape: "rect" | "round" | "diamond";
}

interface FlowEdge {
  id: string;
  from: string;
  to: string;
}

interface FlowGraph {
  direction: "TD" | "LR";
  nodes: FlowNode[];
  edges: FlowEdge[];
}

const NODE_RE = /^([A-Za-z0-9_一-鿿][\w一-鿿]*)(?:\(\((.+?)\)\)|\[(.+?)\]|\((.+?)\)|\{(.+?)\})?$/;
const EDGE_SPLIT = /\s*(?:--+|==+|-\.-|\.-)+>?\s*/;
const EDGE_LABEL = /\|[^|]*\|/g;
const UNSUPPORTED = /^(subgraph|end|classDef|class|style|linkStyle|click|direction)\b/i;

function parseNode(token: string): FlowNode | null {
  const match = token.trim().match(NODE_RE);
  if (!match) return null;
  const [, id, circle, rect, round, diamond] = match;
  const label = (circle ?? rect ?? round ?? diamond ?? id).trim().replace(/^"|"$/g, "");
  let shape: FlowNode["shape"] = "rect";
  if (circle || round) shape = "round";
  else if (diamond) shape = "diamond";
  return { id, label: label || id, shape };
}

// ponytail: mermaid `graph`/`flowchart` subset — nodes, -->/---/-.->/==> chains,
// [rect]/(round)/{diamond} shapes, TD and LR directions. Subgraphs, styling,
// edge labels and every other diagram type fall back to the code fence.
export function parseFlowchart(source: string): FlowGraph | null {
  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("%%"));
  const header = lines[0]?.match(/^(?:graph|flowchart)\s+(TD|TB|BT|LR|RL)\s*$/i);
  if (!header) return null;
  const direction = /LR|RL/i.test(header[1]) ? "LR" : "TD";

  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  const addNode = (node: FlowNode) => {
    const existing = nodes.get(node.id);
    if (!existing || (existing.label === existing.id && node.label !== node.id)) {
      nodes.set(node.id, node);
    }
  };

  for (const line of lines.slice(1)) {
    if (UNSUPPORTED.test(line)) return null;
    const statement = line.replace(/;$/, "").replace(EDGE_LABEL, "");
    const tokens = statement.split(EDGE_SPLIT).filter(Boolean);
    if (tokens.length === 0) return null;
    const parsed = tokens.map(parseNode);
    if (parsed.some((node) => node === null)) return null;
    parsed.forEach((node) => addNode(node as FlowNode));
    if (EDGE_SPLIT.test(statement)) {
      for (let i = 0; i + 1 < parsed.length; i++) {
        edges.push({
          id: `e${edges.length}`,
          from: (parsed[i] as FlowNode).id,
          to: (parsed[i + 1] as FlowNode).id,
        });
      }
    }
  }
  return nodes.size > 0 ? { direction, nodes: [...nodes.values()], edges } : null;
}

interface LayoutNode extends FlowNode {
  depth: number;
  row: number;
  width: number;
  height: number;
}

const CHAR_W = 7;
const NODE_PAD_X = 14;
const LINE_H = 18;
const MAX_W = 176;
const MIN_W = 56;
const GAP_DEPTH = 56;
const GAP_ROW = 24;
const EDGE_W = 2;

function estimateSize(label: string): { width: number; height: number } {
  const textW = label.length * CHAR_W;
  const width = Math.min(MAX_W, Math.max(MIN_W, textW + NODE_PAD_X * 2));
  const lines = Math.max(1, Math.ceil(textW / (width - NODE_PAD_X * 2)));
  return { width, height: 16 + lines * LINE_H };
}

// ponytail: layered layout — depth is the longest path from any root (cycle
// edges ignored), row is first-seen order within the depth. No crossing
// reduction; dense graphs get scruffy. Upgrade path: port a real Sugiyama pass.
function layout(graph: FlowGraph): { nodes: LayoutNode[]; edges: FlowEdge[] } {
  const depth = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
  }
  // Kahn over forward edges; leftover nodes (in cycles) settle one past their
  // deepest resolved predecessor.
  const resolved = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of graph.nodes) {
      if (resolved.has(node.id)) continue;
      const preds = incoming.get(node.id) ?? [];
      const known = preds.filter((p) => resolved.has(p));
      if (preds.length === 0 || known.length > 0) {
        depth.set(node.id, known.length ? Math.max(...known.map((p) => depth.get(p)!)) + 1 : 0);
        resolved.add(node.id);
        changed = true;
      }
    }
  }
  for (const node of graph.nodes) {
    if (!depth.has(node.id)) depth.set(node.id, 0);
  }

  const rowCount = new Map<number, number>();
  return {
    edges: graph.edges,
    nodes: graph.nodes.map((node) => {
      const d = depth.get(node.id)!;
      const row = rowCount.get(d) ?? 0;
      rowCount.set(d, row + 1);
      return { ...node, depth: d, row, ...estimateSize(node.label) };
    }),
  };
}

const RADII: Record<FlowNode["shape"], number> = { rect: 6, round: 16, diamond: 4 };
const SCROLL_STYLE = { marginVertical: 6 } as const;
const SCROLL_CONTENT = { flexGrow: 1 } as const;

export function Flowchart({ source, theme }: { source: string; theme: FlowTheme }) {
  const model = useMemo(() => {
    const graph = parseFlowchart(source);
    if (!graph) return null;
    const { nodes, edges } = layout(graph);
    const isTD = graph.direction === "TD";
    const depthSpan = (n: LayoutNode) => (isTD ? n.height : n.width);
    const rowSpan = (n: LayoutNode) => (isTD ? n.width : n.height);
    const byDepth = new Map<number, LayoutNode[]>();
    for (const node of nodes) {
      byDepth.set(node.depth, [...(byDepth.get(node.depth) ?? []), node]);
    }
    const depthOffset = new Map<number, number>();
    let offset = 0;
    for (const d of [...byDepth.keys()].sort((a, b) => a - b)) {
      depthOffset.set(d, offset);
      offset += Math.max(...byDepth.get(d)!.map(depthSpan)) + GAP_DEPTH;
    }
    const rowOffset = new Map<string, number>();
    for (const d of byDepth.keys()) {
      let y = 0;
      for (const node of byDepth.get(d)!.sort((a, b) => a.row - b.row)) {
        rowOffset.set(node.id, y);
        y += rowSpan(node) + GAP_ROW;
      }
    }

    const pos = new Map<
      string,
      { x: number; y: number; cx: number; cy: number; w: number; h: number }
    >();
    let canvasW = 0;
    let canvasH = 0;
    for (const node of nodes) {
      const dStart = depthOffset.get(node.depth)!;
      const rStart = rowOffset.get(node.id)!;
      const box = isTD
        ? { x: rStart, y: dStart, w: node.width, h: node.height }
        : { x: dStart, y: rStart, w: node.width, h: node.height };
      pos.set(node.id, {
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        cx: box.x + box.w / 2,
        cy: box.y + box.h / 2,
      });
      canvasW = Math.max(canvasW, box.x + box.w);
      canvasH = Math.max(canvasH, box.y + box.h);
    }

    const line = { position: "absolute" as const, backgroundColor: theme.foregroundMuted };
    const edgeViews = edges.flatMap((edge) => {
      const a = pos.get(edge.from);
      const b = pos.get(edge.to);
      if (!a || !b) return [];
      if (isTD) {
        const x1 = a.cx;
        const y1 = a.y + a.h;
        const x2 = b.cx;
        const y2 = b.y;
        if (y2 <= y1) return [];
        const midY = y1 + (y2 - y1) / 2;
        return [
          {
            key: `${edge.id}a`,
            style: { ...line, left: x1 - EDGE_W / 2, top: y1, width: EDGE_W, height: midY - y1 },
          },
          {
            key: `${edge.id}b`,
            style: {
              ...line,
              left: Math.min(x1, x2),
              top: midY - EDGE_W / 2,
              width: Math.abs(x2 - x1) || EDGE_W,
              height: EDGE_W,
            },
          },
          {
            key: `${edge.id}c`,
            style: { ...line, left: x2 - EDGE_W / 2, top: midY, width: EDGE_W, height: y2 - midY },
          },
        ];
      }
      const x1 = a.x + a.w;
      const y1 = a.cy;
      const x2 = b.x;
      const y2 = b.cy;
      if (x2 <= x1) return [];
      const midX = x1 + (x2 - x1) / 2;
      return [
        {
          key: `${edge.id}a`,
          style: { ...line, left: x1, top: y1 - EDGE_W / 2, width: midX - x1, height: EDGE_W },
        },
        {
          key: `${edge.id}b`,
          style: {
            ...line,
            left: midX - EDGE_W / 2,
            top: Math.min(y1, y2),
            width: EDGE_W,
            height: Math.abs(y2 - y1) || EDGE_W,
          },
        },
        {
          key: `${edge.id}c`,
          style: { ...line, left: midX, top: y2 - EDGE_W / 2, width: x2 - midX, height: EDGE_W },
        },
      ];
    });

    const nodeViews = nodes.map((node) => {
      const p = pos.get(node.id)!;
      return {
        key: node.id,
        label: node.label,
        style: {
          position: "absolute" as const,
          left: p.x,
          top: p.y,
          width: p.w,
          minHeight: p.h,
          backgroundColor: theme.surface1,
          borderWidth: 1,
          borderColor: theme.border,
          borderRadius: RADII[node.shape],
          paddingHorizontal: 8,
          paddingVertical: 6,
          alignItems: "center" as const,
          justifyContent: "center" as const,
        },
      };
    });

    return {
      edgeViews,
      nodeViews,
      canvasStyle: { width: canvasW, height: canvasH },
      labelStyle: { color: theme.foreground, fontSize: 12, textAlign: "center" as const },
    };
  }, [source, theme]);

  if (!model) return null;
  return (
    <ScrollView horizontal style={SCROLL_STYLE} contentContainerStyle={SCROLL_CONTENT}>
      <View style={model.canvasStyle}>
        {model.edgeViews.map((seg) => (
          <View key={seg.key} style={seg.style} />
        ))}
        {model.nodeViews.map((node) => (
          <View key={node.key} style={node.style}>
            <Text style={model.labelStyle}>{node.label}</Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
