import fs from "node:fs";
import path from "node:path";

/**
 * CodeBuddy 国内版与国际版都写 `<home>/.codebuddy/projects`。国际版通常由 Paseo
 * 放在独立 HOME 下运行（provider 的 env 里设了 `HOME`，见 `~/.paseo/homes/*`），
 * 所以主目录之外还要把 Paseo 管理的各 home 扫一遍；按 `.codebuddy` 的真实路径去重，
 * 防止某个 home 把它软链回主目录后重复计数。
 */
export function codebuddyHomes(homeDir: string): string[] {
  const homes = [homeDir];
  const homesDir = path.join(homeDir, ".paseo", "homes");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(homesDir, { withFileTypes: true });
  } catch {
    return homes;
  }

  const seen = new Set([realPathOrSelf(path.join(homeDir, ".codebuddy"))]);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(homesDir, entry.name);
    const dataDir = path.join(candidate, ".codebuddy");
    if (!fs.existsSync(dataDir)) {
      continue;
    }
    const real = realPathOrSelf(dataDir);
    if (seen.has(real)) {
      continue;
    }
    seen.add(real);
    homes.push(candidate);
  }
  return homes;
}

function realPathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}
