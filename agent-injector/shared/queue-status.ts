import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";
import {
  isInheritEntry,
  subagentModelQueueSchema,
  type SubagentQueueEntry,
} from "./settings";

/**
 * 队列项的稳定标识：按内容而不是下标，拖动排序或增删其他项不会让失败记录串位；
 * 修改了某项的 provider/model/mode/thinking 视为新配置，冷却重新计算。
 */
export function queueEntryKey(entry: SubagentQueueEntry): string {
  if (isInheritEntry(entry)) return "inherit";
  return JSON.stringify([
    entry.provider,
    entry.model ?? null,
    entry.modeId ?? null,
    entry.thinkingOptionId ?? null,
  ]);
}

export const QUEUE_ENTRY_STATES = ["ready", "cooldown", "unavailable"] as const;

export type QueueEntryState = (typeof QUEUE_ENTRY_STATES)[number];

export const queueStatusRpc = defineRpc({
  name: "subagent-queue-status",
  input: z.object({ entries: subagentModelQueueSchema }),
  output: z.object({
    error: z.string().nullable(),
    /** 当前该用第几项；null 表示没有可用项（会回退继承父 agent）。 */
    activeIndex: z.number().int().nullable(),
    entries: z.array(
      z.object({
        key: z.string(),
        state: z.enum(QUEUE_ENTRY_STATES),
        detail: z.string().nullable(),
        /** 冷却结束时间（epoch 毫秒）。 */
        retryAt: z.number().nullable(),
        /** 最近一次失败时间（epoch 毫秒），仅冷却中的项有值。 */
        failedAt: z.number().nullable(),
      }),
    ),
  }),
});

/** 手动清除失败冷却：keys 省略表示全部清除。 */
export const resetQueueFailuresRpc = defineRpc({
  name: "subagent-queue-reset",
  input: z.object({ keys: z.array(z.string()).optional() }),
  output: z.object({ cleared: z.number().int() }),
});
