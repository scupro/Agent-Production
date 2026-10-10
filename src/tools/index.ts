import type { ToolSet } from "ai";
import type { ToolContext, ToolGroup } from "./types.ts";

import calculateGroup from "./calculate.ts";
import httpFetchGroup from "./http-fetch.ts";
import scheduleGroup from "./schedule.ts";
import timezoneGroup from "./timezone.ts";
import weatherGroup from "./weather.ts";

/**
 * 工具 registry：要新增能力只要寫一個 ToolGroup 並加進這個陣列，
 * 不需要改 agent 核心（server / chat-agent）。
 */
export const REGISTRY: ToolGroup[] = [
  weatherGroup,
  timezoneGroup,
  calculateGroup,
  httpFetchGroup,
  scheduleGroup
];

export interface LoadEntry {
  group: string;
  status: "loaded" | "skipped";
  reason?: string;
  tools: string[];
}

export interface BuiltTools {
  tools: ToolSet;
  report: LoadEntry[];
}

/**
 * 依 config.tools.enabled 與互動性（interactive）建立這一輪可用的工具集合。
 *
 * 過濾順序（任何一條不滿足就跳過整個群組）：
 *  1. 名字是否出現在 ENABLED_TOOLS
 *  2. clientOnly 工具在 headless（API / 其他 agent 呼叫）時剔除
 *  3. requiresApproval 工具在 headless 時剔除（沒人可按「同意」）
 */
export function buildToolSet(
  ctx: ToolContext,
  extraGroups: ToolGroup[] = []
): BuiltTools {
  const report: LoadEntry[] = [];
  const tools: ToolSet = {};
  const enabled = new Set<string>(ctx.config.tools.enabled);

  for (const group of [...REGISTRY, ...extraGroups]) {
    const decide = (status: "loaded" | "skipped", reason?: string): LoadEntry => ({
      group: group.name,
      status,
      reason,
      tools: []
    });

    if (!enabled.has(group.name)) {
      report.push(decide("skipped", "not in ENABLED_TOOLS"));
      continue;
    }
    if (group.clientOnly && !ctx.interactive) {
      report.push(decide("skipped", "client-side tool in non-interactive context"));
      continue;
    }
    if (group.requiresApproval && !ctx.interactive) {
      report.push(decide("skipped", "requires human approval, unavailable in headless mode"));
      continue;
    }

    let created: ToolSet;
    try {
      created = group.create(ctx);
    } catch (error) {
      // 單一工具初始化失敗不應讓整個 agent 起不來。
      ctx.log.exception("tool group init failed", error, { group: group.name });
      report.push(decide("skipped", `init failed: ${String(error)}`));
      continue;
    }

    for (const [name, definition] of Object.entries(created)) {
      if (tools[name]) {
        ctx.log.error("duplicate tool name ignored", { name, group: group.name });
        continue;
      }
      tools[name] = definition;
    }

    report.push({ group: group.name, status: "loaded", tools: Object.keys(created) });
  }

  return { tools, report };
}

export { calculateGroup, httpFetchGroup, scheduleGroup, timezoneGroup, weatherGroup };
export type { AgentCapabilities, ToolContext, ToolGroup } from "./types.ts";
