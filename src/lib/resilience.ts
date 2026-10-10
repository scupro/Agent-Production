import { AppError } from "./errors.ts";
import type { Logger } from "./logger.ts";

export interface RetryOptions {
  /** 嘗試次數上限（1 代表不重試）。 */
  attempts?: number;
  /** 首次退避基準毫秒。 */
  baseDelayMs?: number;
  /** 退避上限毫秒。 */
  maxDelayMs?: number;
  /** 整體時間預算，超過就不再重試。 */
  budgetMs?: number;
  /** 外部的取消訊號（客戶端斷線時立刻停止重試）。 */
  signal?: AbortSignal;
  /** 自訂「是否可重試」判斷；預設用 isRetryableError。 */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** 每次失敗時的回呼，用於記錄。 */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AppError("timeout", "Aborted before retry delay elapsed"));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** 平等分配 ±20% 抖動，避免大量 client 同步重試造成惊群效應。 */
function jitter(delay: number): number {
  const factor = 0.8 + Math.random() * 0.4;
  return Math.round(delay * factor);
}

/**
 * 指數退避重試。只重試「可重試」的錯誤，並尊重 abort 訊號與時間預算。
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    attempts = 3,
    baseDelayMs = 250,
    maxDelayMs = 8000,
    budgetMs,
    signal,
    shouldRetry,
    onRetry
  } = options;

  const started = Date.now();
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) {
      throw new AppError("timeout", "Request aborted by client");
    }

    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      const retryable = shouldRetry
        ? shouldRetry(error, attempt)
        : AppError.from(error).retryable;

      const isLastAttempt = attempt >= attempts;
      const outOfBudget = budgetMs !== undefined && Date.now() - started >= budgetMs;

      if (!retryable || isLastAttempt || outOfBudget) throw error;

      const delay = jitter(Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs));
      onRetry?.(error, attempt, delay);
      await sleep(delay, signal);
    }
  }

  throw lastError;
}

/**
 * 幫一個 promise 加上的 timeout。用 AbortSignal 而非 setTimeout 竞速，
 * 这样被timeout 的 fetch 也能真正取消，不會殘留計費中的子請求。
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label = "operation"
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fn(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new AppError(
        "timeout",
        `${label} exceeded ${timeoutMs}ms`,
        { cause: error }
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 合併多個 AbortSignal（兼容不支援 AbortSignal.any 的執行環境）。 */
export function mergeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return new AbortController().signal;
  if (present.length === 1) return present[0];

  const anyFn = (AbortSignal as unknown as {
    any?: (signals: AbortSignal[]) => AbortSignal;
  }).any;
  if (typeof anyFn === "function") return anyFn.call(AbortSignal, present);

  const controller = new AbortController();
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener(
      "abort",
      () => controller.abort(signal.reason),
      { once: true }
    );
  }
  return controller.signal;
}

export interface CircuitBreakerOptions {
  /** 連續失敗達此數即斷路。 */
  threshold?: number;
  /** 斷路後多久重新嘗試放通（毫秒）。 */
  resetAfterMs?: number;
  /** 狀態切換時的回呼。 */
  onStateChange?: (open: boolean, failures: number) => void;
}

/**
 * 極簡熔斷器：下游（模型供應商 / 外部 API）持續壞掉時快速失敗，
 * 避免每個請求都等待 timeout 而耗盡 CPU 時間與預算。
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private readonly threshold: number;
  private readonly resetAfterMs: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.threshold ?? 5;
    this.resetAfterMs = options.resetAfterMs ?? 30_000;
  }

  get open(): boolean {
    if (this.failures < this.threshold) return false;
    if (Date.now() - this.openedAt >= this.resetAfterMs) {
      // half-open：允許下一次嘗試，成功即重置。
      this.failures = this.threshold - 1;
      return false;
    }
    return true;
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.open) {
      throw new AppError(
        "model_unavailable",
        "Upstream is temporarily unavailable (circuit open)",
        { headers: { "retry-after": String(Math.ceil(this.resetAfterMs / 1000)) } }
      );
    }

    try {
      const result = await fn();
      this.failures = 0;
      return result;
    } catch (error) {
      // 只有基礎設施類錯誤才計入熔斷，業務 4xx 不該開啟斷路器。
      if (AppError.from(error).retryable) {
        this.failures += 1;
        if (this.failures === this.threshold) this.openedAt = Date.now();
      }
      throw error;
    }
  }
}

/** 包裝 tool 的 execute：統一 timeout、重試、錯誤分級與日誌。 */
export function protectTool<T>(
  name: string,
  log: Logger,
  options: { timeoutMs: number; retries: number; signal?: AbortSignal },
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  return withRetry(
    () =>
      withTimeout(
        (signal) => fn(signal),
        options.timeoutMs,
        `tool:${name}`
      ),
    {
      attempts: options.retries,
      signal: options.signal,
      onRetry: (error, attempt, delayMs) => {
        log.warn("tool retry", {
          tool: name,
          attempt,
          delay_ms: delayMs,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  ).catch((error: unknown) => {
    log.error("tool failed", { tool: name, error: error instanceof Error ? error.message : String(error) });
    throw error;
  });
}
