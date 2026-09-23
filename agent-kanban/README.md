# Agent kanban plugin example

A read-only kanban board over the daemon's live agent directory. Columns group agents by
effective state: **未开始** (`initializing`, or never prompted), **进行中** (`running`, or
waiting on a permission), **已完成** (`idle` / `closed` / `error` after work), and **已关闭**
(archived). Cards show badges for permission waits (需要授权) and failures (出错).

The board subscribes through `paseo.agents.list({ subscribe: {} })` and
`paseo.workspaces.list({ subscribe: {} })`. On SDK >= 0.9 it consumes the returned owned
`subscription` handle, which replays the snapshot after reconnect; on 0.8.x it falls back to
the shared `agents.subscribe` / `workspaces.subscribe` session stream, filtered by the echoed
`subscriptionId`. Tapping a card opens the agent through the host's `navigation.openAgent`.

A "新建任务" button opens a host `Modal` form (task name, prompt, project picker, and an
Agent dropdown listing the daemon's configured `agentProfiles` from `paseo.config.get()`;
the chosen profile's provider/model/mode/thinking/feature values are passed through to
`agents.create` verbatim). Submitting creates a workspace
under the chosen project (`worktree` source for git projects, `directory` otherwise) and an
agent **without** an initial prompt — the prompt is stored on the agent's
`labels["agent-kanban.prompt"]` so the card lands in 未开始. A "▶ 开始执行" button on such
cards calls `paseo.agents.ref(id).send(prompt)`; once the first user message lands,
`lastUserMessageAt` is set and the button disappears.

Column assignment and card projection live in `client/board.ts` as pure functions covered by
`client/board.test.ts`. The plugin has no server entry or subprocess.
