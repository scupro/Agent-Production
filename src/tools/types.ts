import type { ToolSet } from "ai";
import type { AgentConfig } from "../lib/config.ts";
import type { Logger } from "../lib/logger.ts";
import type { WorkerEnv } from "../lib/env.ts";

/**
 * 工具可以使用的 agent 能力。用介面而不是直接傳 DO，
 * 目的是讓工具可以被單元測試、也能被別的宿主（例如 API 層）重用。
 */
export interface AgentCapabilities {
  /**
   * 排程一個未來會回呼 `executeTask` 的任務。
   * `input` 可以是 ISO 日期字串、相對秒數，或 cron 表達式（SDK 三種都吃）。
   * @returns 排程任務 id
   */
  schedule(input: string | number | Date, description: string): Promise<string>;
  /** 列出目前排程。 */
  listSchedules(): { id: string; description: string; time: number | null }[];
  /** 取消排程；回傳是否成功。 */
  cancelSchedule(id: string): Promise<boolean>;
  /** 推給所有連線 client 的一次性事件（不進 chat history）。 */
  broadcastEvent(type: string, payload: Record<string, unknown>): void;
}

/** 每次建構工具集合時傳入的上下文。 */
export interface ToolContext {
  env: WorkerEnv;
  config: AgentConfig;
  log: Logger;
  capabilities: AgentCapabilities;
  /**
   * 這一輪是否有「人」在另一頭可以核准。
   * WebSocket UI = true；/v1 API 或其他 agent 呼叫 = false。
   * 非互動時必須剔除 needsApproval 工具，否則.turn 會卡在等一個不會來的核准。
   */
  interactive: boolean;
  /** 綁定到上層請求的取消訊號；客戶端斷線時一併中斷外部呼叫。 */
  signal?: AbortSignal;
}

/** 一組工具的建構器。 */
export type ToolFactory = (ctx: ToolContext) => ToolSet;

/** 供 tools/index.ts 註冊用的中繼資料。 */
export interface ToolGroup {
  /** 對應 config.tools.enabled 中的名稱。 */
  name: string;
  create: ToolFactory;
  /**
   * 是否為 client-side 工具（沒有 execute，需要前端 onToolCall 處理）。
   * 在純 API / headless 情境下應排除，否則模型會等待一個永遠不來的瀏覽器回覆。
   */
  clientOnly?: boolean;
  /** 此群組是否有需要人工核准的工具；headless 時整群剔除。 */
  requiresApproval?: boolean;
}

