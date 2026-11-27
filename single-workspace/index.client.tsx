import { installBareMode } from "./client/bare-mode";

/**
 * 不贡献任何可见界面：插件 client bundle 在每个 app 实例里都会加载，
 * 这里只在 URL 带 `?bare=1` 时接管，隐藏左侧栏。
 */
export default function contribute() {
  return installBareMode();
}
