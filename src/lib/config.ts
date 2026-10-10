import type { WorkerEnv } from "./env.ts";

/** 可插拔的內建工具名稱。用 ENABLED_TOOLS 控制要載入哪些。 */
export const TOOL_NAMES = [
  "weather",
  "timezone",
  "calculate",
  "http_fetch",
  "schedule"
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface LlmConfig {
  model: string;
  systemPrompt: string;
  temperature: number;
  topP: number;
  maxOutputTokens: number;
  timeoutMs: number;
  /** 一輪對話中最多幾個 tool step。 */
  maxSteps: number;
}

export interface ToolsConfig {
  enabled: ToolName[];
  timeoutMs: number;
  maxRetries: number;
  /** http_fetch 的域名白名單；空数组代表只允許公網且非封鎖清單的來源。 */
  allowedHosts: string[];
}

export interface AgentConfig {
  environment: string;
  llm: LlmConfig;
  tools: ToolsConfig;
  /** SQLite 中保留的最大訊息數。 */
  maxPersistedMessages: number;
  /** 中斷後是否自動接回未完成的串流。 */
  chatRecovery: boolean;
  waitForMcpConnections: boolean;
  mcpServers: string[];
  allowedOrigins: string[];
  rateLimit: { rpm: number };
  auth: {
    /** Cloudflare Access JWT 的 aud；設定了就信任 Access 身分給瀏覽器流量。 */
    accessAud: string | null;
    allowQueryToken: boolean;
  };
  logLevel: string;
  scheduleMaxRetries: number;
  api: {
    maxMessages: number;
    maxContentChars: number;
  };
  /** 解析過程中發現的無效設定（不致命的就用預設值繼續跑）。 */
  warnings: string[];
}

const DEFAULT_SYSTEM_PROMPT = `You are a capable AI agent running on Cloudflare Workers.
You can call tools to answer questions, fetch live data, and schedule work.

Guidelines:
- Prefer using a tool over guessing when the answer depends on live or external data.
- When you produce code, always wrap it in a fenced code block with the language tag.
- Be concise; expand only when the user asks for detail.
- If a tool fails, say what failed and what you tried instead, rather than inventing a result.`;

// ---- 解析輔助：壞的 env 值不該讓 Worker 起不來，退回預設並記錄警告 ----

function parseIntWith(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string,
  warnings: string[]
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    warnings.push(`${label}="${raw}" 無效（合法範圍 ${min}-${max}），改用 ${fallback}`);
    return fallback;
  }
  return parsed;
}

function parseFloatWith(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string,
  warnings: string[]
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    warnings.push(`${label}="${raw}" 無效（合法範圍 ${min}-${max}），改用 ${fallback}`);
    return fallback;
  }
  return parsed;
}

function csv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function parseToolList(raw: string | undefined, warnings: string[]): ToolName[] {
  // 未設定 = 全部啟用（維持原本 starter 的行為）。
  if (raw === undefined) return [...TOOL_NAMES];
  if (raw.trim() === "" || raw.trim().toLowerCase() === "none") return [];

  const requested = csv(raw);
  const valid: ToolName[] = [];
  for (const name of requested) {
    if ((TOOL_NAMES as readonly string[]).includes(name)) {
      valid.push(name as ToolName);
    } else {
      warnings.push(`ENABLED_TOOLS 含未知工具 "${name}"，已忽略`);
    }
  }
  return valid;
}

/** 每次 DO 執行個體建立時呼叫一次；結果不可變，可安全跨 request 共用。 */
export function resolveConfig(env: WorkerEnv): AgentConfig {
  const warnings: string[] = [];

  const model = (env.AGENT_MODEL ?? "@cf/moonshotai/kimi-k2.7-code").trim();
  const systemPrompt = (env.AGENT_SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT).trim();

  return {
    environment: (env.ENVIRONMENT ?? "development").trim(),
    llm: {
      model,
      systemPrompt,
      temperature: parseFloatWith(env.LLM_TEMPERATURE, 0.3, 0, 2, "LLM_TEMPERATURE", warnings),
      topP: parseFloatWith(env.LLM_TOP_P, 1, 0, 1, "LLM_TOP_P", warnings),
      maxOutputTokens: parseIntWith(
        env.LLM_MAX_OUTPUT_TOKENS,
        4096,
        256,
        32_000,
        "LLM_MAX_OUTPUT_TOKENS",
        warnings
      ),
      timeoutMs: parseIntWith(env.LLM_TIMEOUT_MS, 120_000, 1_000, 300_000, "LLM_TIMEOUT_MS", warnings),
      maxSteps: parseIntWith(env.MAX_STEPS, 20, 1, 50, "MAX_STEPS", warnings)
    },
    tools: {
      enabled: parseToolList(env.ENABLED_TOOLS, warnings),
      timeoutMs: parseIntWith(env.TOOL_TIMEOUT_MS, 15_000, 500, 60_000, "TOOL_TIMEOUT_MS", warnings),
      maxRetries: parseIntWith(env.TOOL_MAX_RETRIES, 2, 1, 5, "TOOL_MAX_RETRIES", warnings),
      allowedHosts: csv(env.HTTP_ALLOWED_HOSTS).map((h) => h.toLowerCase())
    },
    maxPersistedMessages: parseIntWith(
      env.MAX_PERSISTED_MESSAGES,
      100,
      10,
      1000,
      "MAX_PERSISTED_MESSAGES",
      warnings
    ),
    chatRecovery: parseBool(env.CHAT_RECOVERY, true),
    waitForMcpConnections: true,
    mcpServers: csv(env.MCP_SERVERS),
    allowedOrigins: csv(env.ALLOWED_ORIGINS),
    rateLimit: {
      rpm: parseIntWith(env.RATE_LIMIT_RPM, 60, 1, 10_000, "RATE_LIMIT_RPM", warnings)
    },
    auth: {
      accessAud: (env.CF_ACCESS_JWT_AUD ?? "").trim() || null,
      allowQueryToken: parseBool(env.ALLOW_QUERY_TOKEN, false)
    },
    logLevel: (env.LOG_LEVEL ?? "info").trim(),
    scheduleMaxRetries: parseIntWith(
      env.SCHEDULE_MAX_RETRIES,
      3,
      1,
      10,
      "SCHEDULE_MAX_RETRIES",
      warnings
    ),
    api: {
      maxMessages: parseIntWith(env.API_MAX_MESSAGES, 100, 1, 400, "API_MAX_MESSAGES", warnings),
      maxContentChars: parseIntWith(
        env.API_MAX_CONTENT_CHARS,
        64_000,
        1_000,
        500_000,
        "API_MAX_CONTENT_CHARS",
        warnings
      )
    },
    warnings
  };
}

export { DEFAULT_SYSTEM_PROMPT };
