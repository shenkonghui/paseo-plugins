import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";

interface WikiFile {
  directory: string;
  path: string;
  name: string;
}

interface TreeFolder {
  kind: "folder";
  key: string;
  name: string;
  children: TreeNode[];
}
interface TreeFile {
  kind: "file";
  file: WikiFile;
}
type TreeNode = TreeFolder | TreeFile;

const INDENT = 14;

// ponytail: same file reachable through two configured directories shows under
// each — dedup happens at the server listing level, not here.
function buildTree(files: WikiFile[]): TreeFolder[] {
  const roots = new Map<string, TreeFolder>();
  const folder = (parent: TreeFolder, name: string, key: string): TreeFolder => {
    let node = parent.children.find((c): c is TreeFolder => c.kind === "folder" && c.name === name);
    if (!node) {
      node = { kind: "folder", key, name, children: [] };
      parent.children.push(node);
    }
    return node;
  };

  for (const file of files) {
    const root =
      roots.get(file.directory) ??
      (() => {
        const node: TreeFolder = {
          kind: "folder",
          key: `dir:${file.directory}`,
          name: file.directory,
          children: [],
        };
        roots.set(file.directory, node);
        return node;
      })();
    const rel = file.path.startsWith(`${file.directory}/`)
      ? file.path.slice(file.directory.length + 1)
      : file.name;
    const parts = rel.split("/");
    let parent = root;
    for (let i = 0; i < parts.length - 1; i++) {
      parent = folder(parent, parts[i], `${parent.key}/${parts[i]}`);
    }
    parent.children.push({ kind: "file", file });
  }

  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      const an = a.kind === "folder" ? a.name : a.file.name;
      const bn = b.kind === "folder" ? b.name : b.file.name;
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return an.localeCompare(bn);
    });
    nodes.forEach((n) => n.kind === "folder" && sort(n.children));
  };
  const list = [...roots.values()].sort((a, b) => a.name.localeCompare(b.name));
  list.forEach((root) => sort(root.children));
  return list;
}

interface Styles {
  row: object;
  rowActive: object;
  heading: object;
  name: object;
  detail: object;
}

function FileRow({
  file,
  depth,
  active,
  styles,
  onSelect,
}: {
  file: WikiFile;
  depth: number;
  active: boolean;
  styles: Styles;
  onSelect: (path: string) => void;
}) {
  const onPress = useCallback(() => onSelect(file.path), [onSelect, file.path]);
  const style = useMemo(
    () => [styles.row, { paddingLeft: 12 + depth * INDENT }, active && styles.rowActive],
    [styles, depth, active],
  );
  return (
    <Pressable onPress={onPress} style={style}>
      <Text style={styles.name} numberOfLines={1}>
        {file.name}
      </Text>
    </Pressable>
  );
}

function FolderRow({
  node,
  depth,
  isCollapsed,
  styles,
  onToggle,
}: {
  node: TreeFolder;
  depth: number;
  isCollapsed: boolean;
  styles: Styles;
  onToggle: (key: string) => void;
}) {
  const onPress = useCallback(() => onToggle(node.key), [onToggle, node.key]);
  const style = useMemo(
    () => [
      styles.row,
      {
        paddingLeft: 12 + depth * INDENT,
        flexDirection: "row" as const,
        alignItems: "center" as const,
      },
    ],
    [styles, depth],
  );
  return (
    <Pressable onPress={onPress} style={style}>
      <Icon
        name={isCollapsed ? "ChevronRight" : "ChevronDown"}
        size={14}
        color={(styles.heading as { color?: string }).color}
      />
      <Text style={styles.name} numberOfLines={1}>
        {node.name}
      </Text>
    </Pressable>
  );
}

function TreeRows({
  nodes,
  depth,
  collapsed,
  selected,
  styles,
  onToggle,
  onSelect,
}: {
  nodes: TreeNode[];
  depth: number;
  collapsed: ReadonlySet<string>;
  selected: string | null;
  styles: Styles;
  onToggle: (key: string) => void;
  onSelect: (path: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === "file") {
          return (
            <FileRow
              key={node.file.path}
              file={node.file}
              depth={depth}
              active={selected === node.file.path}
              styles={styles}
              onSelect={onSelect}
            />
          );
        }
        const isCollapsed = collapsed.has(node.key);
        return (
          <View key={node.key}>
            <FolderRow
              node={node}
              depth={depth}
              isCollapsed={isCollapsed}
              styles={styles}
              onToggle={onToggle}
            />
            {isCollapsed ? null : (
              <TreeRows
                nodes={node.children}
                depth={depth + 1}
                collapsed={collapsed}
                selected={selected}
                styles={styles}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            )}
          </View>
        );
      })}
    </>
  );
}

export function FileTree({
  files,
  selected,
  styles,
  onSelect,
}: {
  files: WikiFile[];
  selected: string | null;
  styles: Styles;
  onSelect: (path: string) => void;
}) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const onToggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  return (
    <TreeRows
      nodes={tree}
      depth={0}
      collapsed={collapsed}
      selected={selected}
      styles={styles}
      onToggle={onToggle}
      onSelect={onSelect}
    />
  );
}
