/** 穩定的錯誤碼，讓 client 可以據此處理（不要依賴 message 字串比對）。 */
export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "insufficient_scope"
  | "not_found"
  | "invalid_request"
  | "prompt_exceeded"
  | "rate_limited"
  | "payload_too_large"
  | "timeout"
  | "model_unavailable"
  | "tool_failed"
  | "internal_error";

const HTTP_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  insufficient_scope: 403,
  not_found: 404,
  invalid_request: 400,
  prompt_exceeded: 400,
  rate_limited: 429,
  payload_too_large: 413,
  timeout: 504,
  model_unavailable: 503,
  tool_failed: 502,
  internal_error: 500
};

/**
 * 應用層錯誤。所有可預期的失敗都包成 AppError，
 * 這樣 HTTP 層可以一致地面對，不會把 stack trace 外洩給呼叫端。
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly param?: string;
  readonly headers?: Record<string, string>;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      cause?: unknown;
      retryable?: boolean;
      param?: string;
      headers?: Record<string, string>;
      status?: number;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = options.status ?? HTTP_STATUS[code];
    // 429/502/503/504 預設可重試；其餘為請求本身的問題。
    this.retryable =
      options.retryable ?? [429, 502, 503, 504].includes(this.status);
    this.param = options.param;
    this.headers = options.headers;
  }

  static unauthorized(message = "Missing or invalid credentials") {
    return new AppError("unauthorized", message, {
      headers: { "www-authenticate": "Bearer" }
    });
  }

  static invalid(message: string, param?: string) {
    return new AppError("invalid_request", message, { param });
  }

  /** 從任意拋出值推導出 AppError（非 AppError 視為內部錯誤）。 */
  static from(error: unknown, fallbackMessage = "Internal server error") {
    if (error instanceof AppError) return error;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return new AppError("timeout", "The operation timed out", { cause: error });
    }
    if (error instanceof Error && error.name === "AbortError") {
      return new AppError("timeout", "The operation was aborted", { cause: error });
    }
    return new AppError("internal_error", fallbackMessage, { cause: error });
  }

  /** OpenAI 相容的錯誤格式；非 /v1 路徑也用同樣結構，方便 client 統一解析。 */
  toBody(requestId?: string) {
    return {
      error: {
        message: this.status >= 500 ? "Internal server error" : this.message,
        type: this.code,
        param: this.param ?? null,
        code: this.code,
        request_id: requestId ?? null
      }
    };
  }

  toResponse(requestId?: string): Response {
    return new Response(JSON.stringify(this.toBody(requestId)), {
      status: this.status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-request-id": requestId ?? "",
        ...(this.headers ?? {})
      }
    });
  }
}

/** 判斷錯誤是否值得重試（用於 tool / 外部 HTTP）。 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof AppError) return error.retryable;
  if (error instanceof Error && error.name === "AbortError") return false;
  return true;
}
