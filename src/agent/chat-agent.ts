import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { callable, type Schedule } from "agents";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  type ModelMessage
} from "ai";

import { resolveConfig, type AgentConfig } from "../lib/config.ts";
import { AppError } from "../lib/errors.ts";
import type { WorkerEnv } from "../lib/env.ts";
import { createLogger, Logger } from "../lib/logger.ts";
import {
  buildChunk,
  buildCompletion,
  estimateUsage,
  jsonReponse,
  newCompletionId,
  parseChatRequest,
  resolveSession,
  sseResponse,
  toModelMessages,
  type ChatCompletionRequest
} from "../lib/openai.ts";
import { createLlmModel } from "../lib/model.ts";
import { CircuitBreaker, mergeSignals, withRetry } from "../lib/resilience.ts";
import { buildToolSet } from "../tools/index.ts";
import type { AgentCapabilities, ToolContext } from "../tools/types.ts";

/**
 * API 子路徑常數。DO 收到的是完整原始路徑
 * （`/agents/chat-agent/<name>/api/chat`），所以用尾端比對即可，
 * 不會和 SDK 內部的 `chat` / `get-messages` 等路由相撞。
 */
export const API_CHAT = "/api/chat";
export const API_HISTORY = "/api/history";
export const API_STATS = "/api/stats";
export const API_SCHEDULES = "/api/schedules";

/** 依模型共用熔斷器（同 isolate 內跨 session 共享才有意義）。 */
const breakers = new Map<string, CircuitBreaker>();
function breakerFor(model: string): CircuitBreaker {
  let breaker = breakers.get(model);
  if (!breaker) {
    breaker = new CircuitBreaker({ threshold: 5, resetAfterMs: 30_000 });
    breakers.set(model, breaker);
  }
  return breaker;
}

interface TurnOptions {
  messages: ModelMessage[];
  interactive: boolean;
  signal?: AbortSignal;
  /** 附加到 base system prompt 後面的上下文（不會蓋掉預設 prompt）。 */
  extraSystem?: string;
  /** 覆蓋 config 中的取樣參數（來自 OpenAI 請求）。 */
  sampling?: { temperature?: number; topP?: number; maxOutputTokens?: number };
}

interface TurnResult {
  result: Awaited<ReturnType<typeof streamText>>;
  toolNames: string[];
  steps: number;
}

export class ChatAgent extends AIChatAgent<WorkerEnv> {
  private readonly config: AgentConfig;
  private readonly log: Logger;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);

    this.config = resolveConfig(env);
    this.log = createLogger(env, {
      agent: "ChatAgent",
      session: ctx.id.toString(),
      model: this.config.llm.model
    });

    // 這些欄位在基底類別上可寫；用 env 設定而不是硬編碼 class field，
    // 因為 class field 初始化時還拿不到 env。
    this.maxPersistedMessages = this.config.maxPersistedMessages;
    this.chatRecovery = this.config.chatRecovery;
    this.waitForMcpConnections = this.config.waitForMcpConnections;

    if (this.config.warnings.length > 0) {
      this.log.warn("config fell back to defaults", { warnings: this.config.warnings });
    }
  }

  // -------------------------------------------------------------------------
  // 生命週期
  // -------------------------------------------------------------------------

  onStart() {
    // MCP OAuth 回導向：成功就關掉彈窗，失敗要讓使用者看到原因。
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });

    // 開機自動掛上 env 設定的 MCP server（生產上大多數工具應該這樣接，
    // 而不是叫使用者在 UI 裡手動貼 URL）。
    for (const url of this.config.mcpServers) {
      const already = Object.values(this.mcp.mcpConnections).some(
        (conn) => (conn as { serverUrl?: string }).serverUrl === url
      );
      if (already) continue;

      const name = mcpNameFromUrl(url);
      this.ctxWait(
        this.addMcpServer(name, url).then(
          (res) => this.log.info("mcp connected", { name, url, id: res.id }),
          (error: unknown) =>
            this.log.error("mcp connect failed", {
              name,
              url,
              error: error instanceof Error ? error.message : String(error)
            })
        )
      );
    }
  }

  /** 讓 promise 在 DO 生命週期內完成，不會因為 request 結束而被砍掉。 */
  private ctxWait(promise: Promise<unknown>) {
    this.ctx.waitUntil(promise);
  }

  // -------------------------------------------------------------------------
  // 工具／上下文建構
  // -------------------------------------------------------------------------

  private capabilities(): AgentCapabilities {
    return {
      schedule: async (input, description) => {
        const scheduled = await this.schedule(input, "executeTask", description, {
          idempotent: true
        });
        return scheduled.id;
      },
      listSchedules: () =>
        this.getSchedules().map((task) => ({
          id: task.id,
          description: task.payload,
          time: "time" in task ? task.time : null
        })),
      cancelSchedule: async (id) => this.cancelSchedule(id),
      broadcastEvent: (type, payload) => {
        this.broadcast(
          JSON.stringify({ type, ...payload, timestamp: new Date().toISOString() })
        );
      }
    };
  }

  private toolContext(interactive: boolean, signal?: AbortSignal): ToolContext {
    return {
      env: this.env,
      config: this.config,
      log: this.log,
      capabilities: this.capabilities(),
      interactive,
      signal
    };
  }

  /**
   * 共用的「跑一輪 agent」。UI 路徑與 API 路徑都走這裡，
   * 確保兩種入口下的模型參數、工具集合與剪枝行為一致。
   */
  private async runTurn(options: TurnOptions): Promise<TurnResult> {
    const { llm } = this.config;
    const model = createLlmModel(this.config, this.env, this.sessionAffinity);

    const ctx = this.toolContext(options.interactive, options.signal);
    const { tools, report } = buildToolSet(ctx);
    const mcpTools = this.mcp.getAITools();

    const systemPrompt = options.extraSystem
      ? `${llm.systemPrompt}\n\n${options.extraSystem}`
      : llm.systemPrompt;

    const loaded = report.filter((r) => r.status === "loaded").map((r) => r.group);
    this.log.debug("turn tools", {
      loaded,
      skipped: report.filter((r) => r.status === "skipped").map((r) => `${r.group}:${r.reason}`),
      mcp_tools: Object.keys(mcpTools).length,
      interactive: options.interactive
    });

    // 模型側 timeout：用 AbortSignal 而不是 promise 競速，確保子請求會被真的取消。
    const signal = mergeSignals(
      options.signal,
      AbortSignal.timeout(llm.timeoutMs)
    );

    const result = await breakerFor(llm.model).exec(async () =>
      streamText({
        model,
        system: systemPrompt,
        messages: options.messages,
        tools: { ...mcpTools, ...tools },
        temperature: options.sampling?.temperature ?? llm.temperature,
        topP: options.sampling?.topP ?? llm.topP,
        maxOutputTokens: options.sampling?.maxOutputTokens ?? llm.maxOutputTokens,
        stopWhen: stepCountIs(llm.maxSteps),
        abortSignal: signal
      })
    );

    return {
      result,
      toolNames: Object.keys(tools),
      steps: 0
    };
  }

  /**
   * UI（WebSocket）路徑。保留互動式工具與核准閘門。
   */
  async onChatMessage(
    _onFinish: unknown,
    options?: OnChatMessageOptions
  ): Promise<Response> {
    try {
      const { result } = await this.runTurn({
        messages: pruneMessages({
          messages: await convertToModelMessages(this.messages),
          // 只保留最近的 tool call / reasoning，長對話才不會把 context 塞爆。
          toolCalls: "before-last-2-messages",
          reasoning: "before-last-message"
        }),
        interactive: true,
        signal: options?.abortSignal
      });

      return result.toUIMessageStreamResponse();
    } catch (error) {
      const appError = AppError.from(error);
      this.log.error("chat turn failed", { code: appError.code, message: appError.message });
      // 回 5xx 讓前端可以提示重試，同時不把 stack 洩漏出去。
      return appError.toResponse(this.sessionAffinity);
    }
  }

  /** 每輪結束都記一筆，方便在 Logs / Tail 上做統計。 */
  protected override async onChatResponse(result: {
    message: { id: string; role: string; parts: unknown[] };
    requestId: string;
    status: string;
    error?: string;
  }) {
    this.log.info("turn finished", {
      request_id: result.requestId,
      status: result.status,
      parts: result.message?.parts?.length ?? 0,
      error: result.error
    });
  }

  // -------------------------------------------------------------------------
  // HTTP／API 路徑（給其他 agent / 系統用）
  // -------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (path.endsWith(API_CHAT)) return this.handleApiChat(request);
    if (path.endsWith(API_HISTORY)) return this.handleApiHistory(request);
    if (path.endsWith(API_STATS)) return this.handleApiStats(request);
    if (path.endsWith(API_SCHEDULES)) return this.handleApiSchedules(request);

    return super.fetch(request);
  }

  /**
   * OpenAI 相容的 Chat Completions。
   * 預設 **stateless**（OpenAI 語意：client 每趟帶完整 history）。
   * 帶 `x-agent-stateful: 1` 則把這輪結果附加進這個 session 的長期記憶。
   */
  private async handleApiChat(request: Request): Promise<Response> {
    const requestId = newCompletionId();
    const started = Date.now();

    if (request.method !== "POST") {
      throw AppError.invalid(`Use POST for ${API_CHAT}`);
    }

    let body: ChatCompletionRequest;
    try {
      body = parseChatRequest(await request.json(), this.config);
    } catch (error) {
      throw AppError.from(error);
    }

    const stateful = request.headers.get("x-agent-stateful") === "1";
    const session = resolveSession(request, body);

    const history = stateful
      ? await convertToModelMessages(this.messages).catch(() => [] as ModelMessage[])
      : [];

    const incoming = toModelMessages(body.messages);

    this.log.info("api chat request", {
      request_id: requestId,
      session,
      stateful,
      stream: body.stream === true,
      messages: body.messages.length
    });

    const { result } = await this.runTurn({
      messages: [...history, ...incoming],
      interactive: false,
      signal: request.signal,
      extraSystem: body.context,
      sampling: {
        temperature: body.temperature,
        topP: body.top_p,
        maxOutputTokens: body.max_tokens
      }
    });

    const created = Math.floor(started / 1000);
    const model = body.model ?? this.config.llm.model;

    if (body.stream) {
      return sseResponse(
        this.streamChunks({
          result,
          id: requestId,
          created,
          model,
          stateful,
          session,
          lastUser: body.messages[body.messages.length - 1]
        }),
        requestId
      );
    }

    // 非串流：把整個 stream 收完再回。
    let text = "";
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") text += part.text;
      else if (part.type === "error") throw AppError.from(part.error);
    }

    const usage = await readUsage(result, text, incoming);
    if (stateful) await this.persistTurn(body.messages[body.messages.length - 1], text);

    this.recordUsage({
      requestId,
      session,
      model,
      usage,
      latencyMs: Date.now() - started,
      status: "completed"
    });

    this.log.info("api chat completed", {
      request_id: requestId,
      ms: Date.now() - started,
      chars: text.length
    });

    return jsonReponse(
      buildCompletion({ id: requestId, created, model, content: text, usage }),
      requestId
    );
  }

  /** 把 AI SDK 的 fullStream 轉成 OpenAI 的 chunk 串流。 */
  private async *streamChunks(options: {
    result: Awaited<ReturnType<typeof streamText>>;
    id: string;
    created: number;
    model: string;
    stateful: boolean;
    session: string;
    lastUser: { role: string; content: unknown };
  }): AsyncGenerator<
    ReturnType<typeof buildChunk>,
    void,
    unknown
  > {
    const { result, id, created, model, stateful, session, lastUser } = options;

    // 先發一個只帶 role 的 delta，多數 OpenAI client 期待這個。
    yield buildChunk({ id, created, model, delta: { role: "assistant" } });

    let text = "";
    let lastUsage: ReturnType<typeof estimateUsage> | undefined;

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta": {
          text += part.text;
          yield buildChunk({ id, created, model, delta: { content: part.text } });
          break;
        }
        case "tool-call": {
          // 工具呼叫以事件方式告知（非標準 OpenAI 欄位，client 可忽略）。
          yield buildChunk({
            id,
            created,
            model,
            delta: { tool_calls: [{ id: part.toolCallId, name: part.toolName }] }
          });
          break;
        }
        case "error": {
          throw AppError.from(part.error);
        }
        case "finish": {
          lastUsage = mapUsage(part.totalUsage, text, "");
          break;
        }
        default:
          break;
      }
    }

    if (stateful) {
      await this.persistTurn(lastUser, text).catch((error: unknown) =>
        this.log.error("persist turn failed", {
          error: error instanceof Error ? error.message : String(error)
        })
      );
    }

    yield buildChunk({
      id,
      created,
      model,
      finishReason: "stop",
      usage: lastUsage ?? estimateUsage("", text)
    });

    this.recordUsage({
      requestId: id,
      session: options.session,
      model,
      usage: lastUsage ?? estimateUsage("", text),
      latencyMs: Date.now() - created * 1000,
      status: "completed"
    });
  }

  /**
   * 用量統計寫入 D1（best-effort：不阻塞回覆，寫入失敗只記日誌）。
   * 帳務級精準度請改用 Workers AI 的用量 API 或 Cloudflare Logpush。
   */
  private recordUsage(entry: {
    requestId: string;
    session: string;
    model: string;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    latencyMs: number;
    status: string;
  }) {
    this.env.DB.prepare(
      `INSERT INTO usage_events (request_id, session, principal, model, prompt_tokens, completion_tokens, total_tokens, latency_ms, status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    )
      .bind(
        entry.requestId,
        entry.session,
        "api",
        entry.model,
        entry.usage.prompt_tokens,
        entry.usage.completion_tokens,
        entry.usage.total_tokens,
        entry.latencyMs,
        entry.status
      )
      .run()
      .catch((error: unknown) => {
        this.log.warn("usage event write failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  /** 把 API 那輪的 user／assistant 訊息寫回 session 歷史（stateful 模式）。 */
  private async persistTurn(
    lastUser: { role: string; content: unknown } | undefined,
    assistantText: string
  ) {
    const userText =
      typeof lastUser?.content === "string"
        ? lastUser.content
        : Array.isArray(lastUser?.content)
          ? lastUser.content
              .map((p: { type: string; text?: string }) => (p.type === "text" ? (p.text ?? "") : ""))
              .join("")
          : "";

    if (!userText || !assistantText) return;

    await this.saveMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: userText }]
      },
      {
        id: crypto.randomUUID(),
        role: "assistant",
        parts: [{ type: "text", text: assistantText }]
      }
    ]);
  }

  private async handleApiHistory(request: Request) {
    if (request.method !== "GET") throw AppError.invalid("Use GET");
    const limit = Math.min(
      Number.parseInt(new URL(request.url).searchParams.get("limit") ?? "50", 10) || 50,
      200
    );

    return Response.json({
      session: this.sessionAffinity,
      count: this.messages.length,
      messages: this.messages.slice(-limit).map((message) => ({
        id: message.id,
        role: message.role,
        // 只回傳文字與工具名，避免把大型 tool payload 又搬一遍給呼叫端。
        parts: (message.parts ?? []).map((part) =>
          part.type === "text"
            ? { type: "text", text: part.text }
            : { type: part.type }
        )
      }))
    });
  }

  private handleApiStats(request: Request) {
    if (request.method !== "GET") throw AppError.invalid("Use GET");
    return Response.json({
      session: this.sessionAffinity,
      environment: this.config.environment,
      model: this.config.llm.model,
      messages: this.messages.length,
      maxPersistedMessages: this.config.maxPersistedMessages,
      schedules: this.getSchedules().length,
      mcp_servers: Object.keys(this.mcp.mcpConnections).length
    });
  }

  private handleApiSchedules(request: Request) {
    if (request.method !== "GET") throw AppError.invalid("Use GET");
    return Response.json({
      tasks: this.capabilities().listSchedules()
    });
  }

  // -------------------------------------------------------------------------
  // Callable RPC（給其他 Cloudflare agent 直接呼叫，免 HTTP）
  // -------------------------------------------------------------------------

  /**
   * 讓別的 agent 用 RPC 取得一次完整的回覆（包含工具執行）。
   * 走 SDK 的 programmatic turn，所以結果會進這個 session 的歷史。
   */
  @callable()
  async processHeadless(prompt: string, options: { timeoutMs?: number } = {}) {
    if (!prompt?.trim()) throw AppError.invalid("`prompt` is required", "prompt");

    const started = Date.now();
    const signal = AbortSignal.timeout(options.timeoutMs ?? this.config.llm.timeoutMs);

    const turn = await this.saveMessages(
      [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: prompt }]
        }
      ],
      { signal }
    );

    const last = this.messages[this.messages.length - 1];
    const text =
      last?.role === "assistant"
        ? (last.parts ?? [])
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("")
        : "";

    return {
      requestId: turn.requestId,
      status: turn.status,
      error: turn.error ?? null,
      text,
      ms: Date.now() - started
    };
  }

  @callable()
  async getStats() {
    return {
      messages: this.messages.length,
      model: this.config.llm.model,
      environment: this.config.environment
    };
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  @callable()
  async cancelTask(taskId: string) {
    return await this.cancelSchedule(taskId);
  }

  // -------------------------------------------------------------------------
  // 排程任務
  // -------------------------------------------------------------------------

  /**
   * 排程觸發時的實際工作。這裡示範「做工作 + 通知 client」的正確模式：
   *  - 用 broadcast 而不是寫進 chat history（否則模型會把通知當成新的上下文
   *    重複觸發同一個任務）
   *  - 用重試包住，失敗時也通知 client，不會靜默失敗
   */
  async executeTask(description: string, task: Schedule<string>) {
    this.log.info("scheduled task fired", { task_id: task.id, description });

    try {
      await withRetry(async () => this.runScheduledWork(description), {
        attempts: this.config.scheduleMaxRetries,
        baseDelayMs: 1_000,
        budgetMs: 60_000
      });

      this.capabilities().broadcastEvent("scheduled-task", {
        description,
        task_id: task.id,
        status: "completed"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error("scheduled task failed", { task_id: task.id, description, error: message });

      this.capabilities().broadcastEvent("scheduled-task", {
        description,
        task_id: task.id,
        status: "failed",
        error: message
      });

      // 重新拋出讓平台的 alarm 重試機制也生效。
      throw error;
    }
  }

  /**
   * 真正的排程工作內容。生產環境在這裡呼叫 API／發信／寫資料庫；
   * 預設只做一個記號，避免誤觸副作用。
   */
  private async runScheduledWork(description: string): Promise<void> {
    this.log.info("executing scheduled work", { description });
  }
}

// ---------------------------------------------------------------------------
// 輔助
// ---------------------------------------------------------------------------

function mcpNameFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname;
    return host.split(".")[0] ?? "mcp";
  } catch {
    return "mcp";
  }
}

/** 優先使用模型回傳的 usage；沒有才用估算。 */
async function readUsage(
  result: Awaited<ReturnType<typeof streamText>>,
  text: string,
  messages: ModelMessage[]
) {
  try {
    const usage = await Promise.resolve(result.totalUsage);
    const mapped = mapUsage(usage, text, "");
    if (mapped.prompt_tokens > 0 || mapped.completion_tokens > 0) return mapped;
  } catch {
    // 某些模型不提供 usage，落回估算。
  }
  const promptChars = messages.reduce(
    (sum, message) => sum + JSON.stringify(message).length,
    0
  );
  return estimateUsage("x".repeat(promptChars), text);
}

function mapUsage(
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined,
  fallbackPrompt: string,
  fallbackCompletion: string
) {
  const estimated = estimateUsage(fallbackPrompt, fallbackCompletion);
  const inputTokens = usage?.inputTokens ?? estimated.prompt_tokens;
  const outputTokens = usage?.outputTokens ?? estimated.completion_tokens;
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: usage?.totalTokens ?? inputTokens + outputTokens
  };
}
