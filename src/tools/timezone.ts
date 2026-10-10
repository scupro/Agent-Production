import { tool } from "ai";
import { z } from "zod";
import type { ToolGroup } from "./types.ts";

/**
 * Client-side 工具示範：沒有 execute，由瀏覽器（app.tsx 的 onToolCall）回填結果。
 * headless / API 情境下不該註冊這個群組（見 registry 的 clientOnly 過濾）。
 */
const timezoneGroup: ToolGroup = {
  name: "timezone",
  clientOnly: true,
  create: () => ({
    getUserTimezone: tool({
      description:
        "Get the user's timezone and local time from their browser. Use this when you need the user's local time.",
      inputSchema: z.object({})
    })
  })
};

export default timezoneGroup;
