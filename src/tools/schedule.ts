import { tool } from "ai";
import { z } from "zod";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import type { ToolGroup } from "./types.ts";

/**
 * 排程工具群：一次性 / 延遲 / cron。
 * 透過 capabilities 間接操作 DO，方便脫框測試。
 */
const scheduleGroup: ToolGroup = {
  name: "schedule",
  create: (ctx) => ({
    scheduleTask: tool({
      description:
        "Schedule a task to be executed later. Use when the user asks to be reminded or wants something done at a specific time or interval." +
        "\n\n" +
        getSchedulePrompt({ date: new Date() }),
      inputSchema: scheduleSchema,
      execute: async ({ when, description }) => {
        if (when.type === "no-schedule") {
          return { ok: false, error: "Not a valid schedule input" };
        }

        const input =
          when.type === "scheduled"
            ? when.date
            : when.type === "delayed"
              ? when.delayInSeconds
              : when.type === "cron"
                ? when.cron
                : null;

        if (input === null || input === undefined) {
          return { ok: false, error: "Invalid schedule type" };
        }

        // cron 表達式先本地驗證，避免把無效排程寫進 alarm 才在後台一直失敗。
        if (when.type === "cron") {
          const parts = String(input).trim().split(/\s+/);
          if (parts.length !== 5) {
            return {
              ok: false,
              error: `Cron must have 5 fields, got ${parts.length}: "${input}"`
            };
          }
        }

        const delaySeconds =
          when.type === "delayed" ? Number(when.delayInSeconds) : undefined;
        if (delaySeconds !== undefined && delaySeconds < 1) {
          return { ok: false, error: "delayInSeconds must be >= 1" };
        }

        try {
          const taskId = await ctx.capabilities.schedule(input, description);
          return {
            ok: true,
            task_id: taskId,
            type: when.type,
            when: String(input),
            description
          };
        } catch (error) {
          return {
            ok: false,
            error: `Error scheduling task: ${error instanceof Error ? error.message : String(error)}`
          };
        }
      }
    }),

    getScheduledTasks: tool({
      description: "List all tasks that are currently scheduled.",
      inputSchema: z.object({}),
      execute: async () => {
        const tasks = ctx.capabilities.listSchedules();
        return {
          count: tasks.length,
          tasks: tasks.map((task) => ({
            id: task.id,
            description: task.description,
            // 轉成 ISO 讓模型不用自己換算 epoch。
            next_run: task.time ? new Date(task.time).toISOString() : null
          }))
        };
      }
    }),

    cancelScheduledTask: tool({
      description: "Cancel a scheduled task by its ID.",
      inputSchema: z.object({
        taskId: z.string().describe("The ID of the task to cancel")
      }),
      execute: async ({ taskId }) => {
        const cancelled = await ctx.capabilities.cancelSchedule(taskId);
        return cancelled
          ? { ok: true, cancelled_task_id: taskId }
          : { ok: false, error: `No scheduled task with id "${taskId}"` };
      }
    })
  })
};

export default scheduleGroup;
