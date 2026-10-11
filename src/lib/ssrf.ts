import { AppError } from "./errors.ts";

/**
 * SSRF 防護。任何「由模型決定 URL」的工具（http_fetch、MCP、webhook）
 * 都必須先經過這裡，否則 agent 就等於一個任人差遣的內網掃描器。
 *
 * 防禦點：
 *  1. 只允許 https（除非明確放寬）
 *  2. 拒絕 IP 字面量指向 loopback / private / link-local / 多播 / 中繼
 *  3. 拒絕 .localhost / .internal / .local 等內部解析域名
 *  4. 拒絕雲供應商 metadata 端點
 *  5. 白名單優先：一旦設定 allowedHosts，其他一律拒絕
 *  6. 重導向手動跟隨並逐跳重新驗證（否則 302 就能繞過全部檢查）
 */

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "instance-data",
  "0.0.0.0",
  "::",
  "::1"
]);

const BLOCKED_TLD_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".localdomain",
  ".corp",
  ".gov.internal"
];

function ipv4ToLong(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    result = result * 256 + n;
  }
  return result;
}

/**
 * 需要拒絕的 IPv4 範圍（對照 RFC 1918 / 3927 / 5735 / 6598 等）：
 *   0.0.0.0/8        this-network-on-this-host
 *   10.0.0.0/8       private
 *   100.64.0.0/10    CGNAT（很多內部服務躲在後面）
 *   127.0.0.0/8      loopback
 *   169.254.0.0/16   link-local（含 169.254.169.254 metadata）
 *   172.16.0.0/12    private
 *   192.0.0.0/24     IETF protocol assignments
 *   192.0.2.0/24     TEST-NET-1
 *   192.168.0.0/16   private
 *   198.18.0.0/15    benchmarking
 *   198.51.100.0/24  TEST-NET-2
 *   203.0.113.0/24   TEST-NET-3
 *   224.0.0.0/4      multicast
 *   240.0.0.0/4      reserved / future use
 */
function isPrivateIpv4(ip: string): boolean {
  if (ipv4ToLong(ip) === null) return true; // 無法解析的奇怪格式一律拒絕

  const [a, b] = ip.split(".").map(Number);

  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 與 192.0.2.0/24
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51) return true;
  if (a === 203 && b === 0) return true;
  if (a >= 224) return true;

  return false;
}

function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h.includes(":")) return false;
  if (h === "::" || h === "::1") return true;
  if (h.startsWith("fe80")) return true; // link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // ULA fc00::/7
  if (h.startsWith("ff")) return true; // multicast
  // IPv4-mapped ::ffff:a.b.c.d
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped) return isPrivateIpv4(mapped[1]);
  // 全零 / 未指定
  if (/^0+(:0+)*$/.test(h)) return true;
  return false;
}

export interface UrlGuardOptions {
  allowedHosts?: string[];
  allowHttp?: boolean;
}

function hostMatches(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === pattern;
}

/** 回傳規範化後的 URL；不安全或不在白名單內則丟 AppError。 */
export function assertSafeUrl(
  raw: string,
  options: UrlGuardOptions = {}
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw AppError.invalid(`"${raw}" is not a valid URL`, "url");
  }

  if (url.protocol !== "https:" && !(options.allowHttp && url.protocol === "http:")) {
    throw new AppError("invalid_request", "Only https:// URLs are allowed", {
      param: "url"
    });
  }

  const host = url.hostname.toLowerCase();

  if (BLOCKED_HOSTS.has(host)) {
    throw new AppError("forbidden", `Host "${host}" is blocked`, { param: "url" });
  }

  if (BLOCKED_TLD_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new AppError("forbidden", `Host "${host}" resolves internally`, {
      param: "url"
    });
  }

  // 字面 IP：直接做位址範圍檢查。域名則無法在 Worker 內解析 DNS，
  // 所以域名只能靠白名單約束（這也是為什麼 production 建議設 allowedHosts）。
  const isIpv6 = host.includes(":");
  const isIpv4 = /^\d+(\.\d+){3}$/.test(host);
  if (isIpv6 || isIpv4) {
    const blocked = isIpv6 ? isPrivateIpv6(host) : isPrivateIpv4(host);
    if (blocked) {
      throw new AppError("forbidden", `Literal IP host "${host}" is not allowed`, {
        param: "url"
      });
    }
  } else if (!options.allowedHosts || options.allowedHosts.length === 0) {
    // 沒有白名單的任意域名抓取，是生產環境最常見的 SSRF 入口。
    throw new AppError(
      "forbidden",
      `Fetching arbitrary domains is disabled. Set HTTP_ALLOWED_HOSTS to allow "${host}".`,
      { param: "url" }
    );
  }

  if (options.allowedHosts && options.allowedHosts.length > 0) {
    const ok = options.allowedHosts.some((pattern) => hostMatches(host, pattern.toLowerCase()));
    if (!ok) {
      throw new AppError("forbidden", `Host "${host}" is not in the allowed list`, {
        param: "url"
      });
    }
  }

  if (url.username || url.password) {
    throw new AppError("invalid_request", "URL credentials are not allowed", { param: "url" });
  }

  return url;
}

export interface GuardedFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  allowedHosts?: string[];
}

/**
 * 帶 SSRF 檢查、大小上限與 timeout 的 fetch，並手動跟隨重導向逐跳重新驗證。
 * 回傳純文字（已截斷到 maxBytes）。
 */
export async function guardedFetch(
  startUrl: string,
  init: GuardedFetchInit
): Promise<{ url: string; status: number; contentType: string; body: string; truncated: boolean }> {
  const maxRedirects = init.maxRedirects ?? 3;
  let url = assertSafeUrl(startUrl, { allowedHosts: init.allowedHosts });
  let hops = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const response = await fetch(url.toString(), {
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
      redirect: "manual",
      signal: init.signal,
      cf: { cacheTtl: 60, cacheKey: url.toString() }
    });

    // 3xx：手動跟隨，避免用 redirect:"follow" 繞過位址檢查。
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) {
        throw new AppError("tool_failed", `Redirect from ${url} without Location header`);
      }
      if (hops >= maxRedirects) {
        throw new AppError("tool_failed", `Too many redirects (>${maxRedirects})`);
      }
      hops += 1;
      url = assertSafeUrl(new URL(location, url).toString(), {
        allowedHosts: init.allowedHosts
      });
      continue;
    }

    const contentType = response.headers.get("content-type") ?? "application/octet-stream";

    // 只取文字內容；二進位/圖片不當成 tool 結果塞進 context。
    if (!/(json|text|xml|html|javascript|csv|yaml|markdown)/i.test(contentType)) {
      await response.body?.cancel().catch(() => undefined);
      throw new AppError(
        "tool_failed",
        `Unsupported content-type "${contentType}" (text only)`
      );
    }

    const capped = await readCappedText(response.body, init.maxBytes, init.timeoutMs);
    return {
      url: url.toString(),
      status: response.status,
      contentType,
      body: capped.text,
      truncated: capped.truncated
    };
  }
}

/**
 * 串流邊讀邊截斷：不先 response.text()，否則對方回 500MB 就會把
 * isolate 記憶體打爆（DO 只有 128MB）。
 */
async function readCappedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  timeoutMs: number
): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: "", truncated: false };

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const chunks: string[] = [];
  let received = 0;
  let truncated = false;

  const deadline = Date.now() + timeoutMs;

  try {
    while (true) {
      if (Date.now() > deadline) {
        throw new AppError("timeout", `Response body exceeded ${timeoutMs}ms`);
      }
      const { done, value } = await reader.read();
      if (done) break;

      received += value.byteLength;
      if (received >= maxBytes) {
        // 只保留不超過上限的那一段，其餘丟掉並停止閱讀。
        const allowed = value.byteLength - (received - maxBytes);
        if (allowed > 0) chunks.push(decoder.decode(value.subarray(0, allowed), { stream: false }));
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }

  return { text: chunks.join(""), truncated };
}
