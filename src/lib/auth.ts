import type { AgentConfig } from "./config.ts";
import { AppError } from "./errors.ts";
import type { Logger } from "./logger.ts";
import type { WorkerEnv } from "./env.ts";

export type PrincipalType = "api_key" | "access";

/** 通過驗證的呼叫者身分。 */
export interface Principal {
  type: PrincipalType;
  /** api key 的 row id，或 Access 身分的 email。 */
  id: string;
  name: string;
  scopes: string[];
  /** 此 principal 的每分鐘請求上限；0 代表用全域預設。 */
  rpmLimit: number;
}

export const SCOPES = {
  chat: "chat",
  schedule: "schedule",
  history: "history",
  admin: "admin"
} as const;

export function hasScope(principal: Principal, scope: string): boolean {
  return principal.scopes.includes("*") || principal.scopes.includes(scope);
}

export function requireScope(principal: Principal, scope: string): void {
  if (!hasScope(principal, scope)) {
    throw new AppError("insufficient_scope", `This endpoint requires the "${scope}" scope`);
  }
}

// ---------------------------------------------------------------------------
// 金鑰雜湊與比對
// ---------------------------------------------------------------------------

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => HEX[b])
    .join("");
}

/** 常數時間字串比較，避免以逐字元早退的方式洩漏資訊。 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** 產生一張新的 API key：明文只回傳一次，資料庫只存雜湊。 */
export async function generateApiKey(): Promise<{ raw: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const raw = "agk_" + Array.from(bytes).map((b) => HEX[b]).join("");
  return { raw, hash: await sha256Hex(raw) };
}

// ---------------------------------------------------------------------------
// 從 request 取出憑證
// ---------------------------------------------------------------------------

export function extractCandidateKey(
  request: Request,
  allowQueryToken: boolean
): string | null {
  const bearer = request.headers.get("authorization");
  if (bearer?.toLowerCase().startsWith("bearer ")) {
    const value = bearer.slice(7).trim();
    if (value) return value;
  }

  const headerKey = request.headers.get("x-api-key");
  if (headerKey?.trim()) return headerKey.trim();

  if (allowQueryToken) {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") ?? url.searchParams.get("api_key");
    if (token?.trim()) return token.trim();
  }

  return null;
}

// ---------------------------------------------------------------------------
// 查庫 + 快取
// ---------------------------------------------------------------------------

interface ApiKeyRow {
  id: string;
  name: string;
  key_hash: string;
  scopes: string | null;
  rpm_limit: number | null;
  revoked_at: string | null;
  expires_at: string | null;
}

interface CacheEntry {
  principal: Principal | null;
  reason?: string;
  expiresAt: number;
}

/**
 * 同 isolate 內的金鑰快取。每次請求都打 D1 會在 Free 方案的每日額度下
 * 很快見頂，也會拉高尾延遲，因此做 30 秒 TTL 的記憶化。
 */
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 500;

function cachePut(hash: string, entry: CacheEntry) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    for (const key of cache.keys()) {
      cache.delete(key);
      if (cache.size < CACHE_MAX_ENTRIES * 0.8) break;
    }
  }
  cache.set(hash, entry);
}

/** 供 key 輪換/撤銷時立即失效（不依賴 TTL）。 */
export function invalidateApiKeyCache(hash?: string) {
  if (hash) cache.delete(hash);
  else cache.clear();
}

function parseScopes(raw: string | null): string[] {
  if (!raw?.trim()) return [SCOPES.chat];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function lookupApiKey(
  env: WorkerEnv,
  ctx: ExecutionContext,
  hash: string
): Promise<{ principal: Principal | null; reason?: string }> {
  const cached = cache.get(hash);
  if (cached && cached.expiresAt > Date.now()) {
    return { principal: cached.principal, reason: cached.reason };
  }

  let row: ApiKeyRow | null;
  try {
    row = await env.DB.prepare(
      "SELECT id, name, key_hash, scopes, rpm_limit, revoked_at, expires_at FROM api_keys WHERE key_hash = ?"
    )
      .bind(hash)
      .first<ApiKeyRow>();
  } catch (error) {
    // D1 讀不到時不能放過未授權請求，也不要讓 agent 整個卡死 → 明確 500。
    throw new AppError("internal_error", "Auth backend unavailable", { cause: error });
  }

  const settle = (principal: Principal | null, reason?: string) => {
    cachePut(hash, { principal, reason, expiresAt: Date.now() + CACHE_TTL_MS });
    return { principal, reason };
  };

  if (!row) return settle(null, "unknown_key");
  if (row.revoked_at) return settle(null, "revoked");
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return settle(null, "expired");

  // DB 已用 WHERE key_hash 過濾，這裡再做一次常數時間確認，
  // 確保「比對」在程式碼層級明確存在、不可被繞過。
  if (!constantTimeEqual(hash, row.key_hash)) return settle(null, "hash_mismatch");

  const principal: Principal = {
    type: "api_key",
    id: row.id,
    name: row.name,
    scopes: parseScopes(row.scopes),
    rpmLimit: row.rpm_limit ?? 0
  };

  cachePut(hash, { principal, expiresAt: Date.now() + CACHE_TTL_MS });

  // 用量統計不阻塞請求路徑。
  ctx.waitUntil(
    env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), row.id)
      .run()
      .catch(() => undefined)
  );

  return { principal };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export interface AuthenticateOptions {
  /** 需要哪個 scope；未提供只驗證身分。 */
  scope?: string;
  /**
   * 若設定 Cloudflare Access（CF_ACCESS_JWT_AUD），信任 Access 已驗證的
   * 瀏覽器身分，讓 Web UI 不必內嵌任何 secret。
   */
  allowAccessIdentity?: boolean;
}

/**
 * 驗證請求。順序：
 *   1. Cloudflare Access 身分（僅在允許時）→ 給瀏覽器 UI 用
 *   2. Bearer / x-api-key / query token → D1 api_keys + 快取
 * 失敗一律丟 AppError，由呼叫端轉成 HTTP 回應。
 */
export async function authenticate(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext,
  config: AgentConfig,
  log: Logger,
  options: AuthenticateOptions = {}
): Promise<Principal> {
  if (options.allowAccessIdentity && config.auth.accessAud) {
    const identity = await ctx.access
      ?.getIdentity()
      .catch(() => undefined as unknown);

    const email = (identity as { email?: string } | undefined)?.email;
    if (email) {
      return {
        type: "access",
        id: email,
        name: email,
        scopes: [SCOPES.chat, SCOPES.history, SCOPES.schedule],
        rpmLimit: 0
      };
    }
  }

  const candidate = extractCandidateKey(request, config.auth.allowQueryToken);
  if (!candidate) {
    log.warn("auth rejected", { reason: "no_credential" });
    throw AppError.unauthorized();
  }

  const hash = await sha256Hex(candidate);
  const { principal, reason } = await lookupApiKey(env, ctx, hash);

  if (!principal) {
    log.warn("auth rejected", { reason: reason ?? "invalid_key" });
    throw AppError.unauthorized("Invalid API key");
  }

  if (options.scope) requireScope(principal, options.scope);

  return principal;
}
