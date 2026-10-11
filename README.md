# Agent Production

Cloudflare Workers 上的 AI Agent **生產化模板**，由 [cloudflare/agents-starter](https://github.com/cloudflare/agents-starter) 改造而來。

同一套 agent 同時提供兩種入口：

| 入口 | 用途 | 傳輸 |
|------|------|------|
| `/agents/*` | 面向終端使用者的聊天產品（附 Kumo UI） | WebSocket + HTTP assets |
| `/v1/chat/completions` | 給其他 AI agent / 外部系統呼叫（headless） | OpenAI 相容 REST，可串流 |

底層是 Agents SDK 的 `AIChatAgent`（Durable Object + SQLite），因此具備工具調用、多步推理、排程任務、MCP 整合與斷線復原能力 —— 不只是聊天機器人。

## Quick start

```bash
git clone <this-repo> && cd agents-production
npm install

# 建立 D1 database 並套用 schema
wrangler d1 create prod-agent-db          # 把回傳的 database_id 填入 wrangler.jsonc
wrangler d1 execute prod-agent-db --local --file=./schema.sql

# 產生一組 API key（會印出明文，只顯示一次，請自行保存）
wrangler dev --remote                      # 另開終端機執行
curl -X POST http://localhost:8787/v1/admin/keys \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -d '{"name":"ci-bot","scopes":["chat"]}'

npm run dev                                # 開啟 http://localhost:5173
```

> **本機也需要 Cloudflare 身分驗證。** Workers AI 沒有本地模擬器（`"ai": { "remote": true }`），所以 `wrangler dev` 會開一條遠端代理 session。先跑一次 `wrangler login`，或在 `.env` 設定 `CLOUDFLARE_API_TOKEN`。不需要 OpenAI/Anthropic 的金鑰。

試用提示：

- **"What's the weather in Paris?"** — server-side 工具（自動執行，真實資料來自 Open-Meteo）
- **"What timezone am I in?"** — client-side 工具（瀏覽器回填；headless 情境下不會註冊）
- **"Calculate 5000 * 3"** — approval 工具（超過門檻要先按同意；headless 情境下會被剔除）
- **"Remind me in 5 minutes to take a break"** — 排程
- **拖一張圖問「這是什麼？」** — vision

## Headless / agent-to-agent 用法

不需要任何 SDK，任何能發 HTTP 的程式都能接：

```bash
curl https://<worker>.workers.dev/v1/chat/completions \
  -H "authorization: Bearer $AGENT_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "agent",
    "user": "session-42",
    "stream": true,
    "messages": [{"role":"user","content":"幫我查台北現在的天氣"}]
  }'
```

- `user` 欄位當作 session 路由鍵：同值會打到同一個 Durable Object instance，因而共享對話歷史。不傳則每次都是新 session。
- `stream: true` 回傳標準 OpenAI SSE chunk（含 `usage`）；`false` 回傳完整 JSON。
- 回覆內容是 Markdown，code fence 完整保留 —— 下游要自己渲染。
- 也可用 `?token=` query 參數（需 `ALLOW_QUERY_TOKEN=true`），方便無法設定 header 的 client。

OpenAI 官方 SDK 直接改 baseURL 即可通用：

```python
from openai import OpenAI
client = OpenAI(base_url="https://<worker>.workers.dev/v1", api_key=os.environ["AGENT_API_KEY"])
r = client.chat.completions.create(model="agent", user="s1",
        messages=[{"role":"user","content":"hello"}])
```

第三種途徑是 Agents SDK 的原生 RPC（型別安全、低延遲），適合 Cloudflare 內部的其他 agent：

```ts
import { getAgentByName } from "agents";
const stub = await getAgentByName<ChatAgent>(env.ChatAgent, "session-42");
const result = await stub.processHeadless(messages, { signal });
```

## Project structure

```
src/
  server.ts             # Worker entry：路由分派、auth、rate limit、CORS
  agent/chat-agent.ts   # ChatAgent（AIChatAgent）：LLM 編排、工具、headless 入口
  tools/                # 可插拔工具 registry（每個 ToolGroup 一個檔）
    index.ts            # buildToolSet()：依 config + interactive 過濾
    weather.ts  calculate.ts  http-fetch.ts  schedule.ts  timezone.ts
  lib/
    config.ts           # 全部行為都由 env vars 驅動
    auth.ts             # API key（SHA-256 存 D1）+ Cloudflare Access JWT
    rate-limit.ts       # RPM 限流（記憶體快取 + write-behind 到 D1）
    ssrf.ts             # guardedFetch：白名單 + 私網/metadata 阻擋 + 逐跳重導向驗證
    resilience.ts       # withTimeout / withRetry / CircuitBreaker
    errors.ts           # AppError + 穩定錯誤碼 → HTTP status 對應
    logger.ts           # NDJSON 結構化日誌，自動遮罩金鑰類欄位
    openai.ts           # OpenAI 相容協定的解析與 SSE 序列化
  app.tsx               # Kumo 聊天 UI
  client.tsx  styles.css
schema.sql              # D1：api_keys / rate_limits / usage_events
wrangler.jsonc
```

## What's included（相對 starter 的新增）

### 🔒 安全
- **API key 認證**：只存 SHA-256 hash，不比對明文；key 帶 scopes（`chat` / `history` / `schedule` / `admin` / `*`）與獨立 RPM 上限。
- **Cloudflare Access 支援**：設定 `CF_ACCESS_JWT_AUD` 後，`/agents/*` 瀏覽器流量可用 Access 身分取代自建登入。
- **Rate limiting**：每分鐘請求數限制，超限回 `429` + `Retry-After`。未通過認證的請求也走 IP bucket，提高暴力猜鑰成本。
- **SSRF 防護**：`http_fetch` 與所有模型可控 URL 一律經 `guardedFetch`——僅 HTTPS、域名白名單、拒絕 loopback/RFC1918/CGNAT/link-local/multicast/雲 metadata、`.local`/`.internal` 等內部 TLD，且**手動逐跳跟隨重導向並重新驗證**（否則 302 就能繞過全部檢查）。
- **Payload 防禦**：訊息數量與單則字數上限、回應大小硬上限、錯誤不外洩 stack trace。
- **CORS**：預設封閉，靠 `ALLOWED_ORIGINS` 白名單放行。

### 🔄 可靠性
- `withTimeout` 包住每一次 LLM 與工具呼叫，超時不再無限掛住 turn。
- `withRetry` 指數退避 + jitter，只對可重試錯誤（5xx/429/網路層）生效；4xx 立即失敗不浪費配額。
- `CircuitBreaker` 隔開持續故障的上游，避免雪崩。
- 工具初始化或單一群組載入失敗**不會**讓整個 agent 起不來，只會記在 load report 裡。
- 排程任務失敗有重試預算；用 `broadcast()` 而非 `saveMessages()` 通知，避免 AI 把通知當新 context 重複觸發同一任務而死迴圈。
- 沿用 SDK 的 `chatRecovery`：DO 休眠/重啟後接回未完成的串流。

### ⚙️ 配置化（不改 code 就能調）
所有行為走 `wrangler.jsonc` 的 `[vars]` 或 secrets，啟動時由 `resolveConfig()` 驗證並對越界值發出 warning（詳見下方變數表）。包含模型 id、system prompt、temperature/top_p/max tokens、timeout、max steps、啟用哪些工具、域名白名單、MCP servers、CORS、限流、日誌等級。

###  工具架構
寫一個 `ToolGroup`（`{ name, create(ctx), clientOnly?, requiresApproval? }`）丟進 `src/tools/index.ts` 的 `REGISTRY` 即可，不必碰 agent 核心。registry 會自動處理三件事：

1. 不在 `ENABLED_TOOLS` 內 → 跳過
2. `clientOnly` 且非互動（API/headless）→ 跳過（否則模型會等一個永遠不來的瀏覽器回覆）
3. `requiresApproval` 且非互動 → 跳過（沒人可按「同意」）

demo 工具已換成真實實作：`getWeather` 改用 Open-Meteo（免 key，兩段式 geocoding + forecast，WMO code 轉成人類可讀描述）；新增 `http_fetch` 作為安全的通用抓取工具。

### 🤖 Agent-to-Agent
- `/v1/chat/completions`（OpenAI 相容，串流/非串流皆可）
- `@callable()` RPC 方法（`processHeadless`、`addServer`、`removeServer`、`getStats`）
- MCP client 整合：`MCP_SERVERS` 自動連線，或用 `addServer` 動態掛載

### 📊 可觀察性
NDJSON 結構化日誌（`ts`/`level`/`msg` + 上下文欄位），自動遮罩任何名字含 key/token/secret/password/authorization/cookie/credential 的值。用量事件寫入 D1 `usage_events`（prompt/completion tokens、model、principal、request id），可直接用 D1 SQL 做成本報表。

## Configuration variables

| 變數 | 預設 | 說明 |
|------|------|------|
| `ENVIRONMENT` | `development` | 環境標籤，進入日誌 |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `LLM_PROVIDER` | `workers-ai` | LLM 後端：`workers-ai`（用 `AI` binding，免金鑰）或 `openai`（任何 OpenAI 相容端點）。**設了 `OPENAI_API_KEY` 即自動切換成 `openai`** |
| `AGENT_MODEL` | `@cf/moonshotai/kimi-k2.7-code` | 模型 id。Workers AI 用 `@cf/...`；接 OpenAI 相容端點時改填該端點的模型名（例如 `gpt-4o-mini`） |
| `OPENAI_API_KEY` | 空 | OpenAI 相容端點的 API key（**secret**，`wrangler secret put`） |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI 相容端點 base URL，可換 Azure / vLLM / One-API / 自建服務 |
| `AGENT_SYSTEM_PROMPT` | 內建 | 覆蓋 system prompt（影響最大的單一調整） |
| `LLM_TEMPERATURE` / `LLM_TOP_P` | 模型預設 | 採樣參數 |
| `LLM_MAX_OUTPUT_TOKENS` | 不限 | 輸出 token 上限 |
| `LLM_TIMEOUT_MS` | `60000` | 單次 LLM 呼叫 timeout |
| `MAX_STEPS` | `20` | 一輪對話允許的最大 tool step |
| `MAX_PERSISTED_MESSAGES` | `100` | SQLite 保留訊息數（超出淘汰最舊） |
| `CHAT_RECOVERY` | `true` | DO 重啟後是否接回未完成串流 |
| `ENABLED_TOOLS` | 全部 | 逗號分隔：`weather,timezone,calculate,http_fetch,schedule`；空字串＝只用 MCP |
| `TOOL_TIMEOUT_MS` | `15000` | 單一工具執行 timeout |
| `TOOL_MAX_RETRIES` | `2` | 上游 HTTP 重試次數 |
| `HTTP_ALLOWED_HOSTS` | 空 | `http_fetch` 域名白名單（逗號分隔）；空＝僅靠私網阻擋清單 |
| `MCP_SERVERS` | 空 | 啟動時自動連線的 MCP server URL（逗號分隔） |
| `ALLOWED_ORIGINS` | 空 | CORS 放行來源；`*` 全放行（不建議用於生產） |
| `RATE_LIMIT_RPM` | `60` | 全域每分鐘請求上限 |
| `CF_ACCESS_JWT_AUD` | 空 | 設定後 `/agents/*` 要求 Cloudflare Access 身分 |
| `ALLOW_QUERY_TOKEN` | `false` | 是否允許 `?token=` 代替 header |
| `SCHEDULE_MAX_RETRIES` | `3` | 排程任務失敗重試次數 |
| `API_MAX_MESSAGES` | `100` | 單一 API 請求最大訊息數 |
| `API_MAX_CONTENT_CHARS` | `64000` | 單則訊息最大字數 |

secrets（用 `wrangler secret put`，不要放 vars）：`ADMIN_SECRET`（管理端點保護）、`OPENAI_API_KEY`（只有接 OpenAI 相容端點時需要）。

### 外接 OpenAI 相容端點（自選模型／便宜模型）

預設用 Workers AI（`AI` binding，免金鑰、計費掛 Cloudflare 帳號）。要換成自己的 OpenAI 相容端點：

```bash
wrangler secret put OPENAI_API_KEY      # 該端點的 API key
wrangler deploy                          # 並在 wrangler.jsonc [vars] 或 Dashboard 設定：
#   LLM_PROVIDER = "openai"
#   OPENAI_BASE_URL = "https://your-endpoint/v1"
#   AGENT_MODEL = "gpt-4o-mini"          # 端點提供的模型名，不能再用 @cf/...
```

只設 `OPENAI_API_KEY`（不設 `LLM_PROVIDER`）也會自動切換。UI 聊天與 `/v1/chat/completions` 兩條路徑共用同一個後端設定，行為一致。

## Long conversations: what actually happens

不會被硬截斷，但有刻意管理的機制：

- `maxPersistedMessages`（預設 100）之後淘汰最舊訊息。
- 每次送模型前跑 `pruneMessages()`：只保留最近 2 則之前的 tool call 結果、最近 1 則之前的 reasoning。也就是**長對話中早期的工具輸出與思考鏈會被壓縮**，但對話文字本身保留。這是為了不撐爆 context window。
- 串流斷線可復原（`chatRecovery`），正在生成的回覆不會遺失。

短中期對話完全沒問題；超長對話早期細節會被精簡，但不會切掉。

## Adding a tool

```ts
// src/tools/my-tool.ts
import { tool } from "ai";
import { z } from "zod";
import type { ToolGroup } from "./types.ts";

const myGroup: ToolGroup = {
  name: "my_capability",
  // clientOnly: true,      // 需要瀏覽器回填 → headless 自動剔除
  // requiresApproval: true,// 需要人工核准 → headless 自動剔除
  create: (ctx) => ({
    doThing: tool({
      description: "...",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        // ctx.env / ctx.config / ctx.log / ctx.capabilities / ctx.signal
        return { ok: true };
      }
    })
  })
};
export default myGroup;
```

然後加進 `src/tools/index.ts` 的 `REGISTRY`，並在 `ENABLED_TOOLS` 補上 `my_capability`。

## Scheduled tasks

`executeTask(description, task)` 在 server 端執行實際工作，完成後用 `this.broadcast()` 推一次性事件給連線客戶端（UI 顯示為 toast）。**不要用 `saveMessages()`** —— 注入 chat history 會讓 AI 把通知當成新 context，可能反覆觸發同一任務。

不需要排程就把 `schedule` 從 `ENABLED_TOOLS` 拿掉即可，無需刪 code。

## Using a different model provider

**不用改 code。** 預設走 Workers AI（不需第三方 API key）。
要接任何 OpenAI 相容端點，只設環境變數即可（見上方[配置變數](#configuration-variables)）：

```bash
wrangler secret put OPENAI_API_KEY        # 端點的 API key
# 再設定（wrangler.jsonc [vars] 或 Dashboard）：
#   LLM_PROVIDER   = "openai"             # 不設也行：有 OPENAI_API_KEY 即自動切換
#   OPENAI_BASE_URL = "https://your-endpoint/v1"
#   AGENT_MODEL    = "gpt-4o-mini"         # 端點提供的模型名
```

適用於任何 OpenAI 相容服務：OpenAI 官方、Azure OpenAI、vLLM、Ollama（開 /v1 相容）、One-API 等。
若日後要接**非** OpenAI 相容的 provider（如原生 Anthropic），才需要在 `src/lib/model.ts` 的 `createLlmModel()` 裡加一個分支。

## Deploy

### 一次性的前置作業（本機）

```bash
wrangler d1 create prod-agent-db      # 把回傳的 database_id 填入 wrangler.jsonc
wrangler d1 execute prod-agent-db --remote --file=./schema.sql

# App 機密：從 stdin 讀取，不會出現在終端機歷史或程式碼裡
wrangler secret put ADMIN_SECRET
wrangler secret put OPENAI_API_KEY    # 只有外接 OpenAI 相容端點時需要

git add wrangler.jsonc
git commit -m "chore: bind D1 database"
```

> `database_id` 是資源識別碼、不是憑證（知道它也無法存取資料），可以明文提交。
> 真正的機密（`CLOUDFLARE_API_TOKEN`、`OPENAI_API_KEY`、`ADMIN_SECRET`）都留在
> Cloudflare 與 GitHub 的加密 secret 儲存處，不會進入 repo。

### GitHub Actions 自動部署

`.github/workflows/deploy.yml` 會在 **push 到 `main`**（或手動 workflow_dispatch）時自動：

1. `npm ci` 安裝依賴
2. 套用 `schema.sql` 到遠端 D1（冪等，可安全重複執行）
3. `wrangler deploy`

啟動方式：在 GitHub repo 的 **Settings → Secrets and variables → Actions → New repository secret** 新增：

| Secret | 說明 | Token 所需權限 |
|--------|------|----------------|
| `CLOUDFLARE_API_TOKEN` | 部署用 API token（Dashboard → My Profile → API Tokens → Create Token） | `Account:Read`、`Workers Scripts:Edit`、`D1:Edit`（或直接用 Account:Edit） |

**不需要**把 `OPENAI_API_KEY` / `ADMIN_SECRET` 放進 GitHub secret —— 它們已用 `wrangler secret put` 存在 Worker 上，每次部署都會保留。

### Cloudflare 面板 Builds（Git 整合）

如果你用 dashboard 的 Settings → Builds 連接 repo，指令要**手動填兩格**:

本倉庫採用**零建置部署模式**：前端建置產物 `dist/client/` 已提交進 repo，
`wrangler.jsonc` 的 `assets.directory` 直接指向它。面板 Builds **不需要跑任何前端建置**:

| 欄位 | 建議填 |
|------|--------|
| **Build command** | `npm ci`（只裝依賴讓 wrangler 用本地版；也可留空） |
| **Deploy command** | `npx wrangler deploy`（預設值） |
| **Preview command** | 留預設 `npx wrangler preview`（非 production 分支才會跑） |

> ⚠️ **代價**：改了前端代碼（`src/`、`index.html`、樣式）後，**必須本地 `npm run build` 並把新的 `dist/client/` 一起 commit**,否則面板部署出去的是舊前端。
> GitHub Actions 那條路徑（`npm ci && npm run build`）則每次都會重新建置，不受此限。
> 若嫌麻煩，改回「服務器建置」模式：Build command 填 `npm ci && npx vite build`、把 `assets.directory` 改回 `./public`、並將 `dist/*` 重新 gitignore 即可。

**為什麼面板「讀不到」repo 裡的指令**（設計如此，不是 bug):

- Workers Builds 只認面板輸入的指令，**不會**讀 `package.json` 的 `scripts`。
- **不會**執行 wrangler 設定檔裡的 Custom Builds（官方文件明言 Workers Builds 不支援）。
- 只有 repo **沒有** wrangler 設定檔時，連線流程才會觸發 autoconfig 偵測框架；本模板有 `wrangler.jsonc`,會被跳過——Build command 維持空白、Deploy command 用預設。
- 預設組合 = 只跑 `wrangler deploy`:沒有 `vite build` 就不會產生 `dist/client` 與 `.wrangler/deploy/config.json`,靜態資產只剩 `./public` 的 favicon,網頁全部 404。**Build command 必填。**

**其他面板部署注意事項**:

- **Worker 名稱必須一致**：dashboard 上的 Worker 名要等於 `wrangler.jsonc` 的 `"name"`(目前 `agent-starter`),不符會直接 fail。
- **別與 GitHub Actions 雙開**：兩邊都接同一 repo 會在 push 時搶部署。面板 Builds 和 Actions 擇一，另一個要中斷連線／移除 workflow。
- **面板 Builds 不會跑 D1 schema**:`schema.sql` 需自行執行一次（`wrangler d1 execute prod-agent-db --remote --file=./schema.sql --yes`)。
- **Runtime 機密放 Settings → Variables & Secrets**,不是 Build variables——build vars 只在建置期可見，Worker 執行期拿不到。
- 存檔只套用到**下一次** build;**Retry 會重放「該次 build 當初的 commit」,不是分支最新頭**——修好程式碼後按 Retry 仍會看到舊錯誤。要部署新代碼請推新 commit(或用 Builds 頁的 Deploy Hook 觸發一次全新 build)。

### 手動部署（本機）

```bash
wrangler deploy
```

Agent 就上線於 Cloudflare 全球網路：訊息存 SQLite、串流斷線可復原、閒置時休眠（休眠期間不收 duration 費用）。

### Plan considerations

Workers **Free** plan 也能跑：Durable Objects 的 SQLite backend 在 Free 方案可用，而 Free 唯一不支援的是 legacy key-value backend（本專案沒用到）。要注意的免費額度上限是每日 100,000 requests、13,000 GB-s duration、5 million rows read / 100,000 rows written、5 GB 儲存。

實務提醒：WebSocket 保持連線期間會持續計 duration，長期在線的使用者多的話費用會長得比預期快 —— 若要放大規模建議搭配 WebSocket Hibernation 或直接上 Paid plan。另外 SQLite 儲存的計費自 2026-01 起開始生效。

## Learn more

- [Agents SDK documentation](https://developers.cloudflare.com/agents/)
- [Chat agents API reference](https://developers.cloudflare.com/agents/api-reference/chat-agents/)
- [Durable Objects pricing & limits](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Workers AI models](https://developers.cloudflare.com/workers-ai/models/)
- [MCP Client API](https://developers.cloudflare.com/agents/api-reference/mcp-client-api/)

## License

MIT
