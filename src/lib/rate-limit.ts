import { AppError } from "./errors.ts";
import type { Logger } from "./logger.ts";
import type { WorkerEnv } from "./env.ts";

/**
 * 每分鐘請求數（RPM）限流，固定窗口實作。
 *
 * 取捨：
 *  - 以「同 isolate 記憶體計數」做即時判斷，每個 key 每分鐘最多只寫入一次
 *    D1（write-behind），所以成本幾乎為零。
 *  - 代價是多 isolate / 多地理位置之間不是嚴格原子，短時間內容許少量超發。
 *    需要嚴格全域限流時，請改用 Cloudflare Rate Limiting（WAF）或獨立的
 *    limiter Durable Object；這裡的選擇針對「單 agent、低成本、可接受最終一致」。
 */

interface Window {
  count: number;
  windowStart: number;
  synced: boolean;
}

const WINDOWS = new Map<string, Window>();
const WINDOW_MS = 60_000;
/** 防止 map 無限成長（每個不同 client 都會產生一個 key）。 */
const MAX_KEYS = 2_000;

function currentWindow(now: number): number {
  return Math.floor(now / WINDOW_MS) * WINDOW_MS;
}

function prune(now: number) {
  for (const [key, win] of WINDOWS) {
    if (now - win.windowStart > WINDOW_MS * 2) WINDOWS.delete(key);
  }
  if (WINDOWS.size > MAX_KEYS) {
    for (const key of Array.from(WINDOWS.keys()).slice(0, WINDOWS.size - MAX_KEYS)) {
      WINDOWS.delete(key);
    }
  }
}

/**
 * @param bucketKey 通常是 `api_keys.id` 或 client IP。
 * @param limit 每分鐘允許的請求數；<=0 表示不限制。
 */
export async function enforceRateLimit(
  env: WorkerEnv,
  ctx: ExecutionContext,
  log: Logger,
  bucketKey: string,
  limit: number
): Promise<void> {
  if (limit <= 0) return;

  const now = Date.now();
  const windowStart = currentWindow(now);

  let win = WINDOWS.get(bucketKey);
  if (!win || win.windowStart !== windowStart) {
    if (WINDOWS.size > MAX_KEYS) prune(now);
    win = { count: 0, windowStart, synced: false };
    WINDOWS.set(bucketKey, win);
  }

  win.count += 1;

  if (win.count > limit) {
    const retryAfterMs = windowStart + WINDOW_MS - now;
    const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
    log.warn("rate limited", { bucket: bucketKey, count: win.count, limit });
    throw new AppError(
      "rate_limited",
      `Rate limit exceeded: ${limit} requests/minute for this credential.`,
      { headers: { "retry-after": String(retryAfter) } }
    );
  }

  // 每個窗口只同步一次給 D1（供後台統計／跨重啟參考）。
  if (!win.synced) {
    win.synced = true;
    const row = {
      bucket_key: bucketKey,
      window_start: windowStart,
      request_count: win.count,
      limit_value: limit
    };
    ctx.waitUntil(
      env.DB.prepare(
        `INSERT INTO rate_limits (bucket_key, window_start, request_count, limit_value)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (bucket_key, window_start)
         DO UPDATE SET request_count = MAX(request_count, excluded.request_count)`
      )
        .bind(row.bucket_key, row.window_start, row.request_count, row.limit_value)
        .run()
        .catch((error: unknown) => {
          // 統計寫入失敗不應影響請求；但要能被發現。
          log.warn("rate limit sync failed", {
            error: error instanceof Error ? error.message : String(error)
          });
        })
    );
  }
}

/**
 * 依位址的粗粒度保護：用在尚未通過认证的請求（例如暴力猜 key）。
 * 這不是嚴格限流，只是讓攻擊成本變高。
 */
export function clientIpBucket(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    "unknown-ip"
  );
}
