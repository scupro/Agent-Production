/**
 * 生產環境的 binding / 變數型別。
 *
 * `env.d.ts` 是由 `wrangler types` 產生的，內容只包含 `AI` 與 `ChatAgent`。
 * 這裡以 interface extension 的方式補上生產化新增的 binding，避免每次改
 * wrangler 設定就要重新產生檔案造成衝突。
 */

/** D1 資料庫 binding（認證金鑰、限流、用量統計）。 */
export interface ProductionBindings {
  /** 存放 API key、rate limit 計數、用量事件。 */
  DB: D1Database;
}

/**
 * 可在 wrangler.jsonc `[vars]` 或 secrets 中設定的選項。
 * 全部是字串型別（Workers vars 的限制），由 `resolveConfig` 負責解析與驗證。
 */
export interface ProductionVars {
  /** 執行環境標籤，用於日誌與行為差異（development | staging | production）。 */
  ENVIRONMENT?: string;
  /** LLM 後端：workers-ai（預設，用 AI binding）或 openai（OpenAI 相容端點）。 */
  LLM_PROVIDER?: string;
  /** Workers AI 模型 id，例如 "@cf/moonshotai/kimi-k2.7-code"。 */
  AGENT_MODEL?: string;
  /** OpenAI 相容端點的 API key（wrangler secret put OPENAI_API_KEY）。 */
  OPENAI_API_KEY?: string;
  /** OpenAI 相容端點 base URL，預設 https://api.openai.com/v1。 */
  OPENAI_BASE_URL?: string;
  /** 覆蓋內建 system prompt。 */
  AGENT_SYSTEM_PROMPT?: string;
  /** temperature / top_p / 最大輸出 token。 */
  LLM_TEMPERATURE?: string;
  LLM_TOP_P?: string;
  LLM_MAX_OUTPUT_TOKENS?: string;
  /** 單次 LLM 呼叫的 timeout（毫秒）。 */
  LLM_TIMEOUT_MS?: string;
  /** 一輪對話允許的最大 tool step 數。 */
  MAX_STEPS?: string;
  /** SQLite 中保留的最大訊息數。 */
  MAX_PERSISTED_MESSAGES?: string;
  /** DO 重啟後是否自動接回未完成的串流（true/false，預設 true）。 */
  CHAT_RECOVERY?: string;
  /** 逗號分隔的工具清單；空字串代表不啟用任何自建工具（僅 MCP）。 */
  ENABLED_TOOLS?: string;
  /** 單一工具執行的 timeout（毫秒）。 */
  TOOL_TIMEOUT_MS?: string;
  /** 外部 HTTP 呼叫重試次數上限。 */
  TOOL_MAX_RETRIES?: string;
  /** http_fetch 工具允許的域名白名單（逗號分隔）。 */
  HTTP_ALLOWED_HOSTS?: string;
  /** 要自動連線的 MCP server（逗號分隔 URL）。 */
  MCP_SERVERS?: string;
  /** CORS 放行來源（逗號分隔）；`*` 表示全放行（不建議用於生產）。 */
  ALLOWED_ORIGINS?: string;
  /** 每個 API key 每分鐘允許的請求數。 */
  RATE_LIMIT_RPM?: string;
  /** /agents/* 瀏覽器流量是否要求 Cloudflare Access 身分。 */
  CF_ACCESS_JWT_AUD?: string;
  /** 是否允許 /v1 API 使用 query token（方便無法設定 header 的 client）。 */
  ALLOW_QUERY_TOKEN?: string;
  /** 日誌等級：debug | info | warn | error。 */
  LOG_LEVEL?: string;
  /** 排程任務執行失敗時的重試次數。 */
  SCHEDULE_MAX_RETRIES?: string;
  /** 單一請求可傳入的最大訊息數（API 防禦）。 */
  API_MAX_MESSAGES?: string;
  /** 單一訊息內容的最大字數（API 防禦）。 */
  API_MAX_CONTENT_CHARS?: string;
  /** 管理端點共用金鑰（wrangler secret put ADMIN_SECRET）；未設定 = 管理端點關閉 */
  ADMIN_SECRET?: string;
}

export type WorkerEnv = Env & ProductionBindings & ProductionVars;
