import { getAgentByName, routeAgentRequest } from "agents";

import { ChatAgent } from "./agent/chat-agent.ts";
import { API_CHAT } from "./agent/chat-agent.ts";
import {
  authenticate,
  extractCandidateKey,
  generateApiKey,
  hasScope,
  invalidateApiKeyCache,
  requireScope,
  SCOPES,
  sha256Hex
} from "./lib/auth.ts";
import { resolveConfig } from "./lib/config.ts";
import { AppError } from "./lib/errors.ts";
import type { WorkerEnv } from "./lib/env.ts";
import { createLogger, type Logger } from "./lib/logger.ts";
import {
  clientIpBucket,
  enforceRateLimit
} from "./lib/rate-limit.ts";
import {
  newCompletionId,
  parseChatRequest,
  resolveSession
} from "./lib/openai.ts";

export { ChatAgent };

/**
 * Worker 入口。路由分派：
 *
 *   GET  /health                        健康檢查（免認證）
 *   *    /v1/admin/*                    API key 管理（需 ADMIN_SECRET）
 *   POST /v1/chat/completions           OpenAI 相容 API（需 API key）
 *   *    /agents/*                      聊天 UI 與 Agents SDK 路由
 */
export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const config = resolveConfig(env);
    const log = createLogger(env);
    const requestId = newCompletionId();

    try {
      // ---- 健康檢查（LB / Uptime 監控用，不計費也不認證） ----
      if (url.pathname === "/health") {
        return Response.json({
          ok: true,
          environment: config.environment,
          request_id: requestId
        });
      }

      // ---- CORS preflight ----
      if (request.method === "OPTIONS" && url.pathname.startsWith("/v1/")) {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(request, config)
        });
      }

      // ---- API key 管理 ----
      if (url.pathname.startsWith("/v1/admin/")) {
        return await handleAdmin(request, env, ctx, config, log, requestId);
      }

      // ---- OpenAI 相容 Chat Completions ----
      if (url.pathname === "/v1/chat/completions") {
        return await handleChatCompletions(
          request,
          env,
          ctx,
          config,
          log,
          requestId
        );
      }

      // ---- 其餘全部交給 Agents SDK 路由器（UI / WebSocket / SDK 路由） ----
      const response = await routeAgentRequest(request, env, {
        prefix: "agents",
        onBeforeRequest: (req) =>
          gateBrowserTraffic(req, env, ctx, config, log),
        onBeforeConnect: (req) =>
          gateBrowserTraffic(req, env, ctx, config, log)
      });

      return response ?? new Response("Not found", { status: 404 });
    } catch (error) {
      const appError = AppError.from(error);
      log.error("request failed", {
        path: url.pathname,
        code: appError.code,
        message: appError.message
      });
      return appError.toResponse(requestId);
    }
  }
} satisfies ExportedHandler<WorkerEnv>;

// ---------------------------------------------------------------------------
// /v1/chat/completions
// ---------------------------------------------------------------------------

async function handleChatCompletions(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext,
  config: ReturnType<typeof resolveConfig>,
  log: Logger,
  requestId: string
): Promise<Response> {
  if (request.method !== "POST") {
    throw AppError.invalid("Use POST /v1/chat/completions");
  }

  // 認證 + 限流。principal.id 是 api_keys 表的 row id。
  const principal = await authenticate(request, env, ctx, config, log, {
    scope: SCOPES.chat
  });
  await enforceRateLimit(
    env,
    ctx,
    log,
    principal.id,
    principal.rpmLimit > 0 ? principal.rpmLimit : config.rateLimit.rpm
  );

  // 先解析一次 body：需要 `user` 欄位來決定 session 路由。
  let rawBody: unknown;
  try {
    rawBody = await request.clone().json();
  } catch {
    throw AppError.invalid("Request body must be valid JSON");
  }
  parseChatRequest(rawBody, config); // 驗證；失敗會丟 AppError

  const session = resolveSession(request, rawBody as Parameters<typeof resolveSession>[1]);

  // 依 session 路由到對應的 Durable Object instance。
  const stub = await getAgentByName<WorkerEnv, ChatAgent>(
    env.ChatAgent,
    session
  );
  const doUrl = new URL(
    `https://internal.agent/agents/chat-agent/${session}${API_CHAT}`
  );

  const response = await stub.fetch(new Request(doUrl, request));
  return applyCors(response, request, config);
}

// ---------------------------------------------------------------------------
// /v1/admin/*（API key 管理）
// ---------------------------------------------------------------------------

async function handleAdmin(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext,
  config: ReturnType<typeof resolveConfig>,
  log: Logger,
  requestId: string
): Promise<Response> {
  if (!env.ADMIN_SECRET) {
    // 沒有設定 ADMIN_SECRET 等於關掉管理端點，而不是開放。
    throw new AppError("not_found", "Admin API is not enabled");
  }

  const provided = request.headers.get("x-admin-secret") ?? "";
  const providedHash = await sha256Hex(provided);
  const secretHash = await sha256Hex(env.ADMIN_SECRET);
  if (provided.length === 0 || !constantTimeEqual(providedHash, secretHash)) {
    log.warn("admin auth rejected");
    throw AppError.unauthorized();
  }

  const url = new URL(request.url);

  if (url.pathname === "/v1/admin/keys" && request.method === "POST") {
    return await createApiKey(request, env, ctx, log, requestId);
  }

  if (url.pathname === "/v1/admin/keys" && request.method === "GET") {
    return await listApiKeys(env, requestId);
  }

  if (url.pathname === "/v1/admin/keys/revoke" && request.method === "POST") {
    return await revokeApiKey(request, env, requestId);
  }

  throw AppError.invalid("Unknown admin endpoint");
}

async function createApiKey(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext,
  log: Logger,
  requestId: string
): Promise<Response> {
  const body = (await request.json()) as {
    name?: string;
    scopes?: string[];
    rpm_limit?: number;
    expires_at?: string;
  };

  const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
  if (!name) throw AppError.invalid("`name` is required", "name");

  const scopes = Array.isArray(body.scopes)
    ? body.scopes.filter((s): s is string => typeof s === "string")
    : [SCOPES.chat];
  if (scopes.length === 0) throw AppError.invalid("`scopes` must not be empty", "scopes");

  const rpmLimit =
    typeof body.rpm_limit === "number" && body.rpm_limit > 0
      ? Math.min(Math.round(body.rpm_limit), 10_000)
      : null;

  const expiresAt =
    typeof body.expires_at === "string" && !Number.isNaN(Date.parse(body.expires_at))
      ? new Date(body.expires_at).toISOString()
      : null;

  const { raw, hash } = await generateApiKey();
  const id = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO api_keys (id, name, key_hash, scopes, rpm_limit, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  )
    .bind(id, name, hash, scopes.join(","), rpmLimit, expiresAt)
    .run();

  log.info("api key created", { key_id: id, name, scopes });

  return Response.json(
    {
      id,
      name,
      key: raw, // 明文只會在這一次回應出現
      scopes,
      rpm_limit: rpmLimit,
      expires_at: expiresAt
    },
    { headers: { "x-request-id": requestId } }
  );
}

async function listApiKeys(env: WorkerEnv, requestId: string): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT id, name, scopes, rpm_limit, revoked_at, expires_at, created_at, last_used_at
     FROM api_keys ORDER BY created_at DESC LIMIT 200`
  )
    .all();

  return Response.json(
    {
      keys: rows.results.map((row) => ({
        // key_hash 絕對不列出
        ...(row as Record<string, unknown>),
        key_hash: undefined
      }))
    },
    { headers: { "x-request-id": requestId } }
  );
}

async function revokeApiKey(
  request: Request,
  env: WorkerEnv,
  requestId: string
): Promise<Response> {
  const body = (await request.json()) as { id?: string };
  if (typeof body.id !== "string" || !body.id) {
    throw AppError.invalid("`id` is required", "id");
  }

  const result = await env.DB.prepare(
    "UPDATE api_keys SET revoked_at = ?1 WHERE id = ?2"
  )
    .bind(new Date().toISOString(), body.id)
    .run();

  if (result.success && (result.meta?.changes ?? 0) === 0) {
    throw new AppError("not_found", `No API key with id "${body.id}"`);
  }

  // 清除本 isolate 的快取；其他 isolate 最長 30 秒後自動失效。
  invalidateApiKeyCache();

  return Response.json({ revoked: true, id: body.id }, {
    headers: { "x-request-id": requestId }
  });
}

// ---------------------------------------------------------------------------
// 瀏覽器流量閘門（/agents/*）
// ---------------------------------------------------------------------------

/**
 * 預設開放（與 starter 一致，適合開發）。
 * 設定 CF_ACCESS_JWT_AUD 後即要求 Cloudflare Access 身分，
 * 這是生產上推薦的做法——瀏覽器不需要內嵌任何 secret。
 * 持有效 API key 的程式化呼叫也一併放行。
 */
async function gateBrowserTraffic(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext,
  config: ReturnType<typeof resolveConfig>,
  log: Logger
): Promise<Response | undefined> {
  if (!config.auth.accessAud) return undefined;

  const identity = await ctx.access?.getIdentity().catch(() => undefined);
  if (identity?.email) return undefined;

  const candidate = extractCandidateKey(request, config.auth.allowQueryToken);
  if (candidate) {
    try {
      await authenticate(request, env, ctx, config, log);
      return undefined;
    } catch {
      // 落到下方拒絕
    }
  }

  return new Response("Authentication required", {
    status: 401,
    headers: { "www-authenticate": "Bearer" }
  });
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

function corsHeaders(request: Request, config: ReturnType<typeof resolveConfig>) {
  const allow = allowedOrigin(request, config);
  return {
    ...(allow ? { "access-control-allow-origin": allow } : {}),
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers":
      "authorization, content-type, x-api-key, x-agent-session, x-agent-stateful",
    "access-control-max-age": "86400",
    vary: "Origin"
  };
}

function allowedOrigin(
  request: Request,
  config: ReturnType<typeof resolveConfig>
): string | null {
  if (config.allowedOrigins.includes("*")) return "*";
  const origin = request.headers.get("origin");
  return origin && config.allowedOrigins.includes(origin) ? origin : null;
}

function applyCors(
  response: Response,
  request: Request,
  config: ReturnType<typeof resolveConfig>
): Response {
  const allow = allowedOrigin(request, config);
  if (!allow) return response;

  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", allow);
  headers.set("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

// 常數時間比較（用於 ADMIN_SECRET）。
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// 讓 requireScope / hasScope 在這裡可被未來擴充使用（避免未使用 import 錯誤）。
void requireScope;
void hasScope;
