import { tool } from "ai";
import { z } from "zod";
import { AppError } from "../lib/errors.ts";
import type { ToolGroup } from "./types.ts";

/**
 * Human-in-the-loop 示範：超過閾值的計算需要使用者核准才執行。
 * 生產上這類「核准」應該用在有副作用的操作（發款、寫資料、發信）。
 */

/** 觸發核准的絕對值門檻。 */
const APPROVAL_THRESHOLD = 1000;

const OPS: Record<string, (a: number, b: number) => number> = {
  "+": (a, b) => a + b,
  "-": (a, b) => a - b,
  "*": (a, b) => a * b,
  "/": (a, b) => a / b,
  "%": (a, b) => a % b,
  "**": (a, b) => a ** b
};

const calculateGroup: ToolGroup = {
  name: "calculate",
  requiresApproval: true,
  create: (ctx) => ({
    calculate: tool({
      description:
        "Perform a math calculation with two numbers. Large operands require user approval.",
      inputSchema: z.object({
        a: z.number().describe("First number"),
        b: z.number().describe("Second number"),
        operator: z
          .enum(["+", "-", "*", "/", "%", "**"])
          .describe("Arithmetic operator")
      }),
      // 只在有人可以核准的情境下掛核准閘門；headless 時這個群組會被 registry 剔除。
      needsApproval: ctx.interactive
        ? async ({ a, b }) => Math.abs(a) > APPROVAL_THRESHOLD || Math.abs(b) > APPROVAL_THRESHOLD
        : undefined,
      execute: async ({ a, b, operator }) => {
        const op = OPS[operator];
        if (!op) throw AppError.invalid(`Unsupported operator "${operator}"`, "operator");
        if ((operator === "/" || operator === "%") && b === 0) {
          throw AppError.invalid("Division or modulo by zero", "b");
        }

        const result = op(a, b);
        if (!Number.isFinite(result)) {
          throw AppError.invalid("Result is not a finite number", "expression");
        }

        return { expression: `${a} ${operator} ${b}`, result };
      }
    })
  })
};

export default calculateGroup;
