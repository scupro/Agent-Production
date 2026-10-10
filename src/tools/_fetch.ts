import { AppError } from "../lib/errors.ts";
import { withRetry, withTimeout } from "../lib/resilience.ts";
import type { ToolContext } from "./types.ts";

/** 工具共用的外部 HTTP JSON 呼叫：有 timeout、重試、大小上限與 HTTP 狀態檢查。 */
export async function fetchJsonSafe<T>(
  ctx: ToolContext,
  url: string,
  options: {
    timeoutMs?: number;
    maxBytes?: number;
    /** CDN/邊緣快取秒數；0 或不設代表不快取。 */
    cacheTtl?: number;
    headers?: Record<string, string>;
    /** 用於日誌的端點名稱。 */
    label?: string;
  } = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? ctx.config.tools.timeoutMs;
  const maxBytes = options.maxBytes ?? 256 * 1024;
  const label = options.label ?? new URL(url).host;

  return withRetry(
    () =>
      withTimeout(async (signal) => {
        const response = await fetch(url, {
          headers: { accept: "application/json", ...options.headers },
          signal,
          cf: options.cacheTtl ? { cacheTtl: options.cacheTtl } : undefined
        });

        if (!response.ok) {
          // 4xx 是我們請求寫錯，不該重試；5xx/429 才重試。
          const retryable = response.status === 429 || response.status >= 500;
          throw new AppError(
            retryable ? "tool_failed" : "invalid_request",
            `Upstream ${label} responded ${response.status}`,
            { retryable }
          );
        }

        const text = await readCapped(response, maxBytes, timeoutMs);
        try {
          return JSON.parse(text) as T;
        } catch (error) {
          throw new AppError("tool_failed", `Upstream ${label} returned non-JSON body`, {
            cause: error
          });
        }
      }, timeoutMs, `http:${label}`),
    {
      attempts: ctx.config.tools.maxRetries,
      signal: ctx.signal,
      onRetry: (error, attempt, delayMs) =>
        ctx.log.warn("upstream retry", {
          label,
          attempt,
          delay_ms: delayMs,
          error: error instanceof Error ? error.message : String(error)
        })
    }
  );
}

async function readCapped(
  response: Response,
  maxBytes: number,
  timeoutMs: number
): Promise<string> {
  const body = response.body;
  if (!body) return "";

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const chunks: string[] = [];
  let received = 0;
  const deadline = Date.now() + timeoutMs;

  try {
    while (true) {
      if (Date.now() > deadline) {
        throw new AppError("timeout", `Response body exceeded ${timeoutMs}ms`);
      }
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AppError(
          "payload_too_large",
          `Upstream response exceeded ${maxBytes} bytes`
        );
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }

  return chunks.join("");
}
