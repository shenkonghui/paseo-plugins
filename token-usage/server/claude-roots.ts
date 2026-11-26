import fs from "node:fs";
import path from "node:path";

/**
 * Claude Code 的配置根默认是 `~/.claude`（会话 transcript 在 `projects/` 下），
 * 进程可用 `CLAUDE_CONFIG_DIR` 指到别处（Paseo 给 provider 配 env 时会用到）。
 * 两个位置都扫，按真实路径去重，防止 override 指回默认目录后重复计数。
 */
export function claudeRoots(homeDir: string): string[] {
  const candidates = [path.join(homeDir, ".claude")];
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override && override.trim().length > 0) {
    candidates.push(override);
  }
  const seen = new Set<string>();
  return candidates.filter((root) => {
    const real = realPathOrSelf(root);
    if (seen.has(real)) {
      return false;
    }
    seen.add(real);
    return true;
  });
}

function realPathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}
