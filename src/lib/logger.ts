import type { WorkerEnv } from "./env.ts";

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

/** 出現在這些 key 上的值會被遮罩，避免金鑰進日誌。 */
const SECRET_KEY_PATTERN =
  /(key|token|secret|password|authorization|cookie|credential)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_PATTERN.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

/**
 * 結構化日誌器。輸出 NDJSON，方便 Logs / Golden Signals 解析。
 *
 * 注意：Workers 的 console 輸出會被 Tail/Logs 收集，因此這裡只用 console，
 * 不額外引入外部 exporter。
 */
export class Logger {
  constructor(
    private readonly level: Level = "info",
    private readonly bindings: Record<string, unknown> = {}
  ) {}

  child(extra: Record<string, unknown>): Logger {
    return new Logger(this.level, { ...this.bindings, ...extra });
  }

  private emit(level: Level, message: string, fields?: Record<string, unknown>) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;

    const line = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...redact({ ...this.bindings, ...(fields ?? {}) }) as Record<string, unknown>
    };

    const text = JSON.stringify(line);
    if (level === "error") console.error(text);
    else if (level === "warn") console.warn(text);
    else console.log(text);
  }

  debug(message: string, fields?: Record<string, unknown>) {
    this.emit("debug", message, fields);
  }
  info(message: string, fields?: Record<string, unknown>) {
    this.emit("info", message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>) {
    this.emit("warn", message, fields);
  }
  error(message: string, fields?: Record<string, unknown>) {
    this.emit("error", message, fields);
  }

  /** 記錄 Error 對象，保留 name/message/stack 供除錯。 */
  exception(message: string, error: unknown, fields?: Record<string, unknown>) {
    const err = error as Error | undefined;
    this.emit("error", message, {
      ...fields,
      error_name: err?.name,
      error_message: err?.message ?? String(error),
      error_stack: this.level === "debug" ? err?.stack : undefined
    });
  }
}

export function createLogger(env: WorkerEnv, bindings?: Record<string, unknown>): Logger {
  const raw = (env.LOG_LEVEL ?? "info").toLowerCase();
  const level: Level =
    raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? (raw as Level) : "info";

  return new Logger(level, {
    env: env.ENVIRONMENT ?? "development",
    ...bindings
  });
}

/** 供非 Worker 情境（例如單元測試）使用的預設 logger。 */
export const silentLogger = new Logger("error");
