import net from "node:net";
import type { ForwardRule, ForwardState } from "../shared/rules";

interface Connection {
  client: net.Socket;
  upstream: net.Socket;
  closed: boolean;
}

interface Entry {
  rule: ForwardRule;
  server: net.Server | null;
  connections: Set<Connection>;
  /** 监听失败（致命），例如端口被占用。 */
  listenError: string | null;
  /** 最近一次目标连接失败，仅作提示。 */
  lastConnectionError: string | null;
  totalConnections: number;
  bytesIn: number;
  bytesOut: number;
}

function createEntry(rule: ForwardRule): Entry {
  return {
    rule,
    server: null,
    connections: new Set(),
    listenError: null,
    lastConnectionError: null,
    totalConnections: 0,
    bytesIn: 0,
    bytesOut: 0,
  };
}

function sameEndpoint(a: ForwardRule, b: ForwardRule): boolean {
  return (
    a.listenHost === b.listenHost &&
    a.listenPort === b.listenPort &&
    a.targetHost === b.targetHost &&
    a.targetPort === b.targetPort
  );
}

/**
 * 在 daemon 主机上执行 TCP 端口转发。
 * 规则来自宿主持久化的 settings 文档，sync() 负责让运行状态收敛到文档。
 */
export class ForwardEngine {
  private readonly entries = new Map<string, Entry>();

  sync(rules: readonly ForwardRule[]): void {
    const seen = new Set<string>();
    for (const rule of rules) {
      seen.add(rule.id);
      const entry = this.entries.get(rule.id);
      if (!entry) {
        const created = createEntry(rule);
        this.entries.set(rule.id, created);
        if (rule.enabled) this.start(created);
        continue;
      }
      const endpointChanged = !sameEndpoint(entry.rule, rule);
      entry.rule = rule;
      if (endpointChanged) {
        if (entry.server) this.stop(entry);
        entry.listenError = null;
        entry.lastConnectionError = null;
        if (rule.enabled) this.start(entry);
      } else if (rule.enabled && !entry.server) {
        this.start(entry);
      } else if (!rule.enabled && entry.server) {
        this.stop(entry);
      }
    }
    for (const [id, entry] of [...this.entries]) {
      if (seen.has(id)) continue;
      this.stop(entry);
      this.entries.delete(id);
    }
  }

  states(): ForwardState[] {
    return [...this.entries.values()].map((entry) => ({
      ruleId: entry.rule.id,
      status: entry.listenError ? "error" : entry.server ? "running" : "stopped",
      error: entry.listenError ?? entry.lastConnectionError,
      activeConnections: entry.connections.size,
      totalConnections: entry.totalConnections,
      bytesIn: entry.bytesIn,
      bytesOut: entry.bytesOut,
    }));
  }

  restart(ruleId?: string): number {
    const targets = ruleId
      ? [...this.entries.values()].filter((entry) => entry.rule.id === ruleId)
      : [...this.entries.values()];
    for (const entry of targets) {
      const enabled = entry.rule.enabled;
      this.stop(entry);
      entry.listenError = null;
      entry.lastConnectionError = null;
      if (enabled) this.start(entry);
    }
    return targets.length;
  }

  dispose(): void {
    for (const entry of this.entries.values()) this.stop(entry);
    this.entries.clear();
  }

  private start(entry: Entry): void {
    if (entry.server) return;
    entry.listenError = null;
    const server = net.createServer((client) => this.accept(entry, client));
    entry.server = server;
    server.on("error", (error: Error) => {
      entry.listenError = error.message;
      if (entry.server === server) entry.server = null;
      try {
        server.close();
      } catch {
        // server 可能已经关闭
      }
    });
    server.on("close", () => {
      if (entry.server === server) entry.server = null;
    });
    server.listen({ host: entry.rule.listenHost, port: entry.rule.listenPort });
  }

  private stop(entry: Entry): void {
    if (entry.server) {
      const server = entry.server;
      entry.server = null;
      try {
        server.close();
      } catch {
        // 忽略重复关闭
      }
    }
    for (const connection of [...entry.connections]) {
      this.destroyConnection(entry, connection);
    }
    entry.connections.clear();
  }

  private accept(entry: Entry, client: net.Socket): void {
    const upstream = net.connect({
      host: entry.rule.targetHost,
      port: entry.rule.targetPort,
    });
    const connection: Connection = { client, upstream, closed: false };
    entry.connections.add(connection);
    entry.totalConnections += 1;
    entry.lastConnectionError = null;
    client.setNoDelay(true);
    upstream.setNoDelay(true);

    const close = (): void => this.destroyConnection(entry, connection);

    client.on("error", close);
    client.on("close", close);
    upstream.on("close", close);
    upstream.on("error", (error: Error) => {
      entry.lastConnectionError = `目标 ${entry.rule.targetHost}:${entry.rule.targetPort} 连接失败：${error.message}`;
      close();
    });

    // 手工搬运数据以便统计流量，并处理慢速对端的背压。
    client.on("data", (chunk: Buffer) => {
      entry.bytesIn += chunk.length;
      if (!upstream.write(chunk)) client.pause();
    });
    upstream.on("drain", () => client.resume());
    upstream.on("data", (chunk: Buffer) => {
      entry.bytesOut += chunk.length;
      if (!client.write(chunk)) upstream.pause();
    });
    client.on("drain", () => upstream.resume());

    client.on("end", () => upstream.end());
    upstream.on("end", () => client.end());
  }

  private destroyConnection(entry: Entry, connection: Connection): void {
    if (connection.closed) return;
    connection.closed = true;
    entry.connections.delete(connection);
    connection.client.destroy();
    connection.upstream.destroy();
  }
}
