import { describe, expect, it } from "vitest";
import { parseFlowchart } from "./flowchart";

describe("parseFlowchart", () => {
  it("parses a TD graph with labels and chained edges", () => {
    const graph = parseFlowchart(
      [
        "graph TD",
        "  A[开始] --> B{判断}",
        "  B -->|是| C(处理)",
        "  B --> D[结束]",
        "  C --> D",
      ].join("\n"),
    );
    expect(graph).not.toBeNull();
    expect(graph!.direction).toBe("TD");
    expect(graph!.nodes.map((n) => n.id).sort()).toEqual(["A", "B", "C", "D"]);
    expect(graph!.nodes.find((n) => n.id === "B")!.shape).toBe("diamond");
    expect(graph!.edges).toHaveLength(4);
  });

  it("parses flowchart LR", () => {
    const graph = parseFlowchart("flowchart LR\n  a --> b --> c");
    expect(graph!.direction).toBe("LR");
    expect(graph!.edges).toHaveLength(2);
  });

  it("falls back on unsupported statements and non-graph sources", () => {
    expect(parseFlowchart("graph TD\n  subgraph s\n    a --> b\n  end")).toBeNull();
    expect(parseFlowchart("just some code")).toBeNull();
    expect(parseFlowchart("sequenceDiagram\n  a->>b: hi")).toBeNull();
  });
});
