import { tool } from "ai";
import { z } from "zod";
import { guardedFetch } from "../lib/ssrf.ts";
import { withTimeout } from "../lib/resilience.ts";
import { AppError } from "../lib/errors.ts";
import type { ToolGroup } from "./types.ts";

/**
 * 讓模型可以抓網頁/API 的工具，安全邊界全部在 guardedFetch 裡：
 *   - 僅 https
 *   - 需通过域名白名單（HTTP_ALLOWED_HOSTS）
 *   - 拒绝内網 / metadata 位址
 *   - 重導向逐跳重新驗證
 *   - 回應大小與時間都有硬上限（避免把 128MB 的 isolate 塞爆或撑爆 context）
 */

/** 單一抓取最多餵給模型的字數。再大就截斷，讓模型知道要去問或分段抓。 */
const MAX_RESPONSE_CHARS = 24_000;
const MAX_RESPONSE_BYTES = 512 * 1024;

const httpFetchGroup: ToolGroup = {
  name: "http_fetch",
  create: (ctx) => ({
    http_fetch: tool({
      description:
        "Fetch a URL over HTTPS and return its text content. Restricted to the configured allowed hosts. Use for reading public APIs or documentation pages.",
      inputSchema: z.object({
        url: z.string().url().describe("The https:// URL to fetch"),
        method: z.enum(["GET", "HEAD"]).default("GET").describe("HTTP method"),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe("Optional additional request headers (avoid secrets)")
      }),
      execute: async ({ url, method, headers }) => {
        const timeoutMs = ctx.config.tools.timeoutMs;

        const result = await withTimeout(
          (signal) =>
            guardedFetch(url, {
              method,
              headers,
              maxBytes: MAX_RESPONSE_BYTES,
              timeoutMs,
              signal: ctx.signal ?? signal,
              allowedHosts: ctx.config.tools.allowedHosts
            }),
          timeoutMs + 2_000,
          "tool:http_fetch"
        );

        if (result.status >= 400) {
          throw new AppError(
            "tool_failed",
            `Upstream returned ${result.status} for ${result.url}`,
            { retryable: result.status >= 500 || result.status === 429 }
          );
        }

        const body =
          result.body.length > MAX_RESPONSE_CHARS
            ? result.body.slice(0, MAX_RESPONSE_CHARS)
            : result.body;

        return {
          url: result.url,
          status: result.status,
          content_type: result.contentType,
          truncated: result.truncated || body.length < result.body.length,
          content: body
        };
      }
    })
  })
};

export default httpFetchGroup;
