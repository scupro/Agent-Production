import { AppError } from "./errors.ts";
import type { ImagePart, ModelMessage, TextPart } from "ai";
import type { AgentConfig } from "./config.ts";

/** OpenAI Chat Completions 相容協定的型別與工具函式。 */

export type Role = "system" | "developer" | "user" | "assistant" | "tool";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

export interface ChatCompletionRequestMessage {
  role: Role;
  content: string | ContentPart[] | null;
  name?: string;
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatCompletionRequestMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  /** OpenAI 用它標示終端使用者；這裡當作 session 路由鍵使用。 */
  user?: string;
  stop?: string | string[];
  /** 附加到 system prompt 尾端的上下文（不改主 prompt）。 */
  context?: string;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: {
    index: number;
    message: { role: "assistant"; content: string | null; tool_calls?: unknown[] };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | "error";
  }[];
  usage: Usage;
  /** 自訂擴充欄位：agent 內部使用的 session id 與 tool 軌跡。 */
  agent?: { session: string; tool_calls: { name: string; input: unknown }[]; steps: number };
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: {
    index: number;
    delta: { role?: "assistant"; content?: string; tool_calls?: unknown[] };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | "error" | null;
  }[];
  usage?: Usage;
}

const VALID_ROLES: readonly string[] = ["system", "developer", "user", "assistant", "tool"];

export function newCompletionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return (
    "chatcmpl-" +
    Array.from(bytes)
      .map((b) => b.toString(36).padStart(2, "0"))
      .join("")
      .slice(0, 24)
  );
}

function contentLength(content: string | ContentPart[] | null): number {
  if (content === null) return 0;
  if (typeof content === "string") return content.length;
  return content.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 2000), 0);
}

/**
 * 解析並驗證請求。這裡是主要的防禦點：模型 token 會依傳入內容計費，
 * 超大 payload 或異常訊息數必須先擋下，而不是丟給 LLM。
 */
export function parseChatRequest(
  raw: unknown,
  config: AgentConfig
): ChatCompletionRequest {
  if (!raw || typeof raw !== "object") {
    throw AppError.invalid("Request body must be a JSON object");
  }

  const body = raw as Record<string, unknown>;
  const messages = body.messages;

  if (!Array.isArray(messages) || messages.length === 0) {
    throw AppError.invalid("`messages` must be a non-empty array", "messages");
  }
  if (messages.length > config.api.maxMessages) {
    throw new AppError(
      "payload_too_large",
      `Too many messages: ${messages.length} (limit ${config.api.maxMessages})`,
      { param: "messages" }
    );
  }

  for (const [index, message] of messages.entries()) {
    if (!message || typeof message !== "object") {
      throw AppError.invalid(`messages[${index}] must be an object`, "messages");
    }
    const m = message as ChatCompletionRequestMessage;

    if (!VALID_ROLES.includes(m.role)) {
      throw AppError.invalid(
        `messages[${index}].role must be one of ${VALID_ROLES.join(", ")}`,
        "messages"
      );
    }

    const length = contentLength(m.content ?? null);
    if (length > config.api.maxContentChars) {
      throw new AppError(
        "payload_too_large",
        `messages[${index}] content is ${length} chars (limit ${config.api.maxContentChars})`,
        { param: "messages" }
      );
    }
  }

  const last = messages[messages.length - 1] as ChatCompletionRequestMessage;
  if (last.role !== "user") {
    throw AppError.invalid("The last message must have role \"user\"", "messages");
  }

  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw AppError.invalid("`stream` must be a boolean", "stream");
  }

  const temperature =
    typeof body.temperature === "number"
      ? Math.min(Math.max(body.temperature, 0), 2)
      : undefined;
  const topP =
    typeof body.top_p === "number" ? Math.min(Math.max(body.top_p, 0), 1) : undefined;
  const maxTokens =
    typeof body.max_tokens === "number"
      ? Math.min(Math.max(Math.round(body.max_tokens), 1), config.llm.maxOutputTokens)
      : undefined;

  return {
    model: typeof body.model === "string" ? body.model : undefined,
    messages: messages as ChatCompletionRequestMessage[],
    stream: body.stream === true,
    temperature,
    top_p: topP,
    max_tokens: maxTokens,
    user: typeof body.user === "string" ? body.user.slice(0, 200) : undefined,
    stop: typeof body.stop === "string" || Array.isArray(body.stop) ? body.stop : undefined,
    context: typeof body.context === "string" ? body.context.slice(0, 8_000) : undefined
  };
}

/**
 * OpenAI 訊息格式 → AI SDK ModelMessage。
 *
 * 注意：`tool` 角色不支援——我們的工具都在 server 端自動執行，
 * tool-result 歷史不會進入模型輸入（也不該進入，會重複計費）。
 * 需要工具歷史的呼叫端請改用 stateful session。
 */
export function toModelMessages(
  messages: ChatCompletionRequestMessage[]
): ModelMessage[] {
  const result: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role === "tool") {
      throw AppError.invalid(
        'role "tool" is not accepted: tools run server-side in this agent. Omit tool messages or use a stateful session.',
        "messages"
      );
    }

    if (message.role === "system" || message.role === "developer") {
      const text = contentToText(message.content);
      if (text) result.push({ role: "system", content: text });
      continue;
    }

    if (message.role === "assistant") {
      const text = contentToText(message.content);
      if (text) result.push({ role: "assistant", content: text });
      continue;
    }

    // user
    if (typeof message.content === "string") {
      if (message.content) result.push({ role: "user", content: message.content });
      continue;
    }

    if (Array.isArray(message.content)) {
      const parts = message.content
        .map((part): TextPart | ImagePart | null => {
          if (part.type === "text") {
            return part.text ? { type: "text", text: part.text } : null;
          }
          // image_url → AI SDK ImagePart
          if (part.type === "image_url") {
            return {
              type: "image" as const,
              image: part.image_url.url,
              ...(part.image_url.detail ? { detail: part.image_url.detail } : {})
            };
          }
          return null;
        })
        .filter((part): part is NonNullable<typeof part> => part !== null);

      if (parts.length > 0) {
        result.push({ role: "user", content: parts });
      }
    }
  }

  return result;
}

function contentToText(content: string | ContentPart[] | null): string {
  if (content === null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}
export function resolveSession(request: Request, body: ChatCompletionRequest): string {
  const header = request.headers.get("x-agent-session");
  const candidate = (header ?? body.user ?? "api-default").trim();
  // DO name 只留安全字元，避免路徑注入與奇怪 id。
  const safe = candidate.replace(/[^a-zA-Z0-9_.:-]/g, "-").slice(0, 128);
  return safe.length > 0 ? safe : "api-default";
}

export function buildCompletion(options: {
  id: string;
  created: number;
  model: string;
  content: string;
  finishReason?: ChatCompletion["choices"][number]["finish_reason"];
  usage?: Usage;
  agent?: ChatCompletion["agent"];
}): ChatCompletion {
  return {
    id: options.id,
    object: "chat.completion",
    created: options.created,
    model: options.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: options.content || null },
        finish_reason: options.finishReason ?? "stop"
      }
    ],
    usage: options.usage ?? estimateUsage("", options.content),
    ...(options.agent ? { agent: options.agent } : {})
  };
}

export function buildChunk(options: {
  id: string;
  created: number;
  model: string;
  delta?: ChatCompletionChunk["choices"][number]["delta"];
  finishReason?: ChatCompletionChunk["choices"][number]["finish_reason"];
  usage?: Usage;
}): ChatCompletionChunk {
  return {
    id: options.id,
    object: "chat.completion.chunk",
    created: options.created,
    model: options.model,
    choices: [
      {
        index: 0,
        delta: options.delta ?? {},
        finish_reason: options.finishReason ?? null
      }
    ],
    ...(options.usage ? { usage: options.usage } : {})
  };
}

export function sseEncode(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export const SSE_DONE = "data: [DONE]\n\n";

/**
 * Workers AI 不一定在所有模型回傳 usage，所以用字元數做保守估算
 * （約 4 chars/token）。至少讓呼叫端能預算，而不是拿到 0。
 */
export function estimateUsage(prompt: string, completion: string): Usage {
  const promptTokens = Math.ceil(prompt.length / 4);
  const completionTokens = Math.ceil(completion.length / 4);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens
  };
}

export function jsonReponse(payload: unknown, requestId: string): Response {
  return new Response(JSON.stringify(payload), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-request-id": requestId
    }
  });
}

/** 建立 SSE response，把 async generator 產出的 chunk 編碼成 EventSource 框架。 */
export function sseResponse(
  generator: AsyncGenerator<ChatCompletionChunk, void, unknown>,
  requestId: string
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of generator) {
          controller.enqueue(encoder.encode(sseEncode(chunk)));
        }
        controller.enqueue(encoder.encode(SSE_DONE));
      } catch (error) {
        const payload: ChatCompletionChunk & { error?: unknown } = {
          id: requestId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "",
          choices: [{ index: 0, delta: {}, finish_reason: "error" }]
        };
        controller.enqueue(encoder.encode(sseEncode(payload)));
        controller.enqueue(
          encoder.encode(
            sseEncode({
              error: AppError.from(error).toBody(requestId)
            })
          )
        );
        controller.enqueue(encoder.encode(SSE_DONE));
      } finally {
        controller.close();
      }
    },
    cancel() {
      // 客戶端斷線：generator 由 for-await 的 return() 结束，LLM 側靠 abort 取消。
      void generator.return();
    }
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-request-id": requestId
    }
  });
}
