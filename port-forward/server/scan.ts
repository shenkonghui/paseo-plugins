import { execFile } from "node:child_process";
import os from "node:os";
import type { ScannedPort } from "../shared/rules";

function run(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

/** 解析 `0.0.0.0:8080`、`*:8080`、`[::]:8080`、`[::1]:8080`、`127.0.0.1:8080`。 */
export function parseListenAddress(value: string): { host: string; port: number } | null {
  const trimmed = value.trim();
  const bracketed = /^\[(.+)\]:(\d{1,5})$/u.exec(trimmed);
  if (bracketed) {
    return { host: normalizeHost(bracketed[1]), port: Number(bracketed[2]) };
  }
  const plain = /^(.+):(\d{1,5})$/u.exec(trimmed);
  if (plain) {
    return { host: normalizeHost(plain[1]), port: Number(plain[2]) };
  }
  return null;
}

function normalizeHost(host: string): string {
  const normalized = host.trim();
  if (normalized === "*" || normalized === "::" || normalized === "0.0.0.0") return "0.0.0.0";
  return normalized;
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host.startsWith("127.");
}

function dedupe(ports: ScannedPort[]): ScannedPort[] {
  const byPort = new Map<number, ScannedPort>();
  for (const port of ports) {
    const existing = byPort.get(port.port);
    if (!existing) {
      byPort.set(port.port, port);
      continue;
    }
    // 同一端口优先保留公开绑定，并合并进程信息。
    const preferred = existing.loopback && !port.loopback ? { ...port } : { ...existing };
    preferred.process = preferred.process ?? existing.process ?? port.process;
    preferred.pid = preferred.pid ?? existing.pid ?? port.pid;
    byPort.set(port.port, preferred);
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

/** 从 ss/netstat 输出里找 `users:(("nginx",pid=1912,fd=7))` 的进程名与 PID。 */
function parseProcessInfo(line: string): { process: string | null; pid: number | null } {
  const user = /"([^"]+)",pid=(\d+)/u.exec(line);
  if (!user) return { process: null, pid: null };
  return { process: user[1], pid: Number(user[2]) };
}

function parseSsOutput(stdout: string): ScannedPort[] {
  const ports: ScannedPort[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("LISTEN")) continue;
    const columns = trimmed.split(/\s+/u);
    if (columns.length < 5) continue;
    const local = parseListenAddress(columns[3]);
    if (!local) continue;
    const info = parseProcessInfo(trimmed);
    ports.push({
      host: local.host,
      port: local.port,
      process: info.process,
      pid: info.pid,
      loopback: isLoopbackHost(local.host),
    });
  }
  return ports;
}

function parseNetstatOutput(stdout: string): ScannedPort[] {
  const ports: ScannedPort[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.includes("LISTEN")) continue;
    const columns = trimmed.split(/\s+/u);
    // Linux netstat: tcp 0 0 0.0.0.0:8080 0.0.0.0:* LISTEN 1912/nginx
    // Windows netstat: TCP 0.0.0.0:8080 0.0.0.0:0 LISTENING 1912
    const localIndex = columns[0] === "tcp" || columns[0] === "tcp6" ? 3 : 1;
    const local = parseListenAddress(columns[localIndex] ?? "");
    if (!local) continue;
    const tail = columns.slice(localIndex + 1).join(" ");
    let process: string | null = null;
    let pid: number | null = null;
    const linuxProcess = /(\d+)\/([^\s]+)/u.exec(tail);
    if (linuxProcess) {
      pid = Number(linuxProcess[1]);
      process = linuxProcess[2];
    } else {
      const windowsPid = /LISTENING\s+(\d+)/u.exec(trimmed);
      if (windowsPid) pid = Number(windowsPid[1]);
    }
    ports.push({
      host: local.host,
      port: local.port,
      process,
      pid,
      loopback: isLoopbackHost(local.host),
    });
  }
  return ports;
}

function parseLsofOutput(stdout: string): ScannedPort[] {
  const ports: ScannedPort[] = [];
  for (const line of stdout.split("\n")) {
    const match = /\s(\S+):(\d{1,5})\s+\(LISTEN\)/u.exec(line);
    if (!match) continue;
    const local = parseListenAddress(`${match[1]}:${match[2]}`);
    if (!local) continue;
    const columns = line.trim().split(/\s+/u);
    const pid = Number(columns[1]);
    ports.push({
      host: local.host,
      port: local.port,
      process: columns[0] ?? null,
      pid: Number.isFinite(pid) ? pid : null,
      loopback: isLoopbackHost(local.host),
    });
  }
  return ports;
}

async function scanLinux(): Promise<ScannedPort[]> {
  const ss = await run("ss", ["-tlnpH"]);
  if (ss !== null) return dedupe(parseSsOutput(ss));
  const netstat = await run("netstat", ["-tlnp"]);
  return netstat === null ? [] : dedupe(parseNetstatOutput(netstat));
}

async function scanDarwin(): Promise<ScannedPort[]> {
  const lsof = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]);
  if (lsof !== null) return dedupe(parseLsofOutput(lsof));
  const netstat = await run("netstat", ["-an", "-p", "tcp"]);
  return netstat === null ? [] : dedupe(parseNetstatOutput(netstat));
}

async function scanWindows(): Promise<ScannedPort[]> {
  const netstat = await run("netstat", ["-ano"]);
  return netstat === null ? [] : dedupe(parseNetstatOutput(netstat));
}

/** 列出 daemon 主机当前监听的 TCP 端口。 */
export async function scanListeningPorts(): Promise<ScannedPort[]> {
  if (process.platform === "linux") return scanLinux();
  if (process.platform === "darwin") return scanDarwin();
  if (process.platform === "win32") return scanWindows();
  return [];
}

/** 非回环 IPv4 地址，用于生成可从其他机器访问的 URL。 */
export function listHostIps(): string[] {
  const result: string[] = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.internal || address.family !== "IPv4") continue;
      result.push(address.address);
    }
  }
  return result;
}
