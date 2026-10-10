/**
 * LLM 後端工廠：依 config.llm.provider 決定這一輪用哪個模型。
 *
 *  - "workers-ai"（預設）：Workers AI，綁定 env.AI，免 API key，
 *    並以 sessionAffinity 讓同一 session 命中同一後端 replica（KV cache 友好）。
 *  - "openai"：任何 OpenAI 相容端點（api.openai.com、Azure、vLLM、
 *    One-API、本地 Ollama/OpenAI 相容服務……），自訂 base URL 與 key。
 *
 * 兩種後端都回傳 AI SDK 的 LanguageModel，可直接餵給 streamText，
 * 因此 UI 聊天與 /v1/chat/completions 的行為完全一致。
 */
import { createOpenAI } from "@ai-sdk/openai";
import { createWorkersAI } from "workers-ai-provider";

import type { AgentConfig } from "./config.ts";
import type { WorkerEnv } from "./env.ts";

export function createLlmModel(
  config: AgentConfig,
  env: WorkerEnv,
  sessionAffinity: string
) {
  if (config.llm.provider === "openai") {
    const openai = createOpenAI({
      apiKey: config.llm.apiKey,
      baseURL: config.llm.baseUrl
    });
    return openai(config.llm.model);
  }

  const workersai = createWorkersAI({ binding: env.AI });
  return workersai(config.llm.model, { sessionAffinity });
}
