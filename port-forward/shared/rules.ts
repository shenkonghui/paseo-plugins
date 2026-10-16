import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** 一条端口转发规则：在 daemon 主机监听 listenHost:listenPort，转发到 targetHost:targetPort。 */
export const forwardRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(""),
  listenHost: z.string().min(1).default("127.0.0.1"),
  listenPort: z.number().int().min(1).max(65535),
  targetHost: z.string().min(1).default("127.0.0.1"),
  targetPort: z.number().int().min(1).max(65535),
  enabled: z.boolean().default(true),
});

export type ForwardRule = z.output<typeof forwardRuleSchema>;

/** 规则持久化在宿主侧，所有客户端共享。 */
export const forwardRulesDocument = defineSettings({
  id: "rules",
  scope: "host",
  version: 1,
  schema: z.object({
    rules: z.array(forwardRuleSchema).default([]),
  }),
});

export const statusStateSchema = z.object({
  ruleId: z.string(),
  status: z.enum(["running", "stopped", "error"]),
  error: z.string().nullable().default(null),
  activeConnections: z.number().int().default(0),
  totalConnections: z.number().int().default(0),
  bytesIn: z.number().default(0),
  bytesOut: z.number().default(0),
});

export type ForwardState = z.output<typeof statusStateSchema>;

export const statusRpc = defineRpc({
  name: "portforward.status",
  input: z.object({}),
  output: z.object({
    states: z.array(statusStateSchema).default([]),
    hostname: z.string().default(""),
    hostIps: z.array(z.string()).default([]),
  }),
});

export const scannedPortSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  process: z.string().nullable().default(null),
  pid: z.number().int().nullable().default(null),
  loopback: z.boolean().default(false),
});

export type ScannedPort = z.output<typeof scannedPortSchema>;

export const scanRpc = defineRpc({
  name: "portforward.scan",
  input: z.object({}),
  output: z.object({
    ports: z.array(scannedPortSchema).default([]),
  }),
});

export const restartRpc = defineRpc({
  name: "portforward.restart",
  input: z.object({ ruleId: z.string().optional() }),
  output: z.object({ restarted: z.number().int() }),
});

export function makeRuleId(): string {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function describeRule(rule: ForwardRule): string {
  return `${rule.listenHost}:${rule.listenPort} → ${rule.targetHost}:${rule.targetPort}`;
}

/** 猜测访问 URL；仅对 HTTP(S) 服务有意义。 */
export function buildAccessUrl(rule: ForwardRule, accessHost: string): string {
  const scheme = rule.targetPort === 443 || rule.targetPort === 8443 ? "https" : "http";
  return `${scheme}://${accessHost}:${rule.listenPort}/`;
}
