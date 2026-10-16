/**
 * 右侧「执行输出」面板当前要显示哪个 agent。
 *
 * 斜杠命令(在一个 agent 的输入框里)会先 dispatch 到目标 agent，再把目标写进这个 store，
 * 然后打开 explorer 面板。面板和命令跑在同一个插件 client bundle 里，所以共享这个模块级 store。
 */
export interface OutputTarget {
  agentId: string;
  agentTitle: string | null;
  workspaceId: string;
  workspaceName: string;
  dispatchedAt: number;
}

let current: OutputTarget | null = null;
const listeners = new Set<() => void>();

export function setOutputTarget(target: OutputTarget): void {
  current = target;
  for (const listener of listeners) listener();
}

export function getOutputTarget(): OutputTarget | null {
  return current;
}

export function subscribeOutputTarget(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
