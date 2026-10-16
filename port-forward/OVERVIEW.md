在 Paseo 里管理 daemon 主机上的 TCP 端口转发：把某个「监听地址:端口」的流量转发到
「目标地址:端口」，并提供服务器监听端口的扫描视图。适合访问只绑定在 `127.0.0.1`、
firewall 只放通部分端口、或需要统一入口的开发服务。

## 界面

侧边栏「端口转发」surface（服务器图标 `ArrowRightLeft`）有两个标签：

- **转发规则**：规则的启停、编辑、删除、重试、打开地址、复制地址；每条规则展示实时状态
  （运行中 / 已停止 / 错误）、活动连接数、累计连接数和上下行流量。
- **服务器端口**：扫描 daemon 主机上监听中的 TCP 端口（`ss` / `lsof` / `netstat`），显示
  绑定地址、进程名和 PID；对公开监听的端口可直接打开，或一键生成一条转发规则
  （监听 `0.0.0.0:<端口+10000>`，目标为 `127.0.0.1:<端口>`）。

顶部可以选择「访问主机」——规则公开监听时用它生成可点击的 URL。默认取 daemon 主机的第一
个非回环 IPv4 地址，可切换到其他网卡地址或 `localhost`。

规则保存在宿主侧 settings 文档里（`settings.rules`），daemon 重启、插件重载后自动恢复，
所有连接的客户端看到同一份规则。

## 语义与定位

规则在 **daemon 所在机器**上执行，server 端（Node `net`）监听并双向搬运 TCP 数据，
client 端只做管理界面和打开链接。因此：

- daemon 就在你本机时：这就是常规的本地端口转发，例如
  `127.0.0.1:8080 → 127.0.0.1:8080` 或 `127.0.0.1:15432 → db.internal:5432`。
- daemon 在远程服务器时：规则让远程端口（包括只绑定 `127.0.0.1` 的服务）在服务器的
  其他地址上可达。若你的客户端能连上 daemon 主机，就能通过「访问主机」里的地址访问这些
  服务，无需再登录服务器开服务。

服务器上 8080 已被占用时，把目标设为 `127.0.0.1:8080`、监听端口设为 18080，即可用
`http://<daemon主机>:18080` 访问原来的本机服务。

## 实现

- `server/engine.ts`：转发引擎。对每条启用规则 `net.createServer` + `net.connect`，
  手工搬运数据以统计流量并处理背压；监听失败（如端口占用）记为错误状态，连接目标失败
  记录最近一次错误。`sync()` 让运行状态收敛到 settings 文档。
- `server/scan.ts`：跨平台监听端口扫描（Linux `ss -tlnpH`，macOS `lsof`，Windows
  `netstat -ano`）与非回环 IPv4 枚举。
- `shared/rules.ts`：Zod 契约（settings 文档 + 状态/扫描/重启 RPC）。
- `client/forward-surface.tsx` + `client/rule-modal.tsx`：surface 与规则表单。
- `index.server.ts` 注册 settings 与 RPC；`index.client.tsx` 注册 surface、侧边栏项和
  Command Center 项。

RPC：`portforward.status`（运行时状态 + 主机信息）、`portforward.scan`（端口扫描）、
`portforward.restart`（按规则或全量重启）。

## 已知边界

- 只转发 TCP；UDP 不支持。
- 转发规则运行在 daemon 主机上，不会在客户端本机创建监听。需要严格 `localhost:<端口>`
  且 daemon 在远程时，请配合本地 SSH（`ssh -N -L 8080:127.0.0.1:8080 user@host`）或在
  daemon 本机运行 Paseo。
- 监听 `0.0.0.0` 会把端口暴露给能访问 daemon 主机的网络，UI 会以「公开监听」标注；
  敏感服务建议绑定具体网卡地址或加访问控制。
- 端口扫描需要读取进程信息：Linux 下非 root 运行的 daemon 只能看到自己用户的进程名，
  其他进程显示 PID 或未知；这是 `ss` 的权限限制。
- 「打开」默认按 HTTP 猜测 URL（443/8443 用 https）；非 Web 服务请自行使用客户端连接。
