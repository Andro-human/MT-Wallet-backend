import { Router, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { getUserByApiKey } from "../services/supabase.js";
import {
  buildReviewPayload,
  storeReview,
  currentIstMonth,
  ReviewSubmissionSchema,
  MONTH_RE,
} from "../services/monthlyReview.js";

/**
 * MCP wrapper for the monthly-review pipeline, for agent platforms that speak
 * Model Context Protocol instead of raw REST (Gemini Spark's Connected Apps).
 * Auth is the API key embedded in the path (/mcp/<key>) — Spark's custom-MCP
 * OAuth flow is unreliable, and the key already travels in query strings for
 * the REST fallback, so this is the same trust level.
 *
 * Stateless: every request builds a fresh server+transport bound to the
 * authenticated user, so no session affinity is needed across instances.
 */

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

function buildServer(userId: string): McpServer {
  const server = new McpServer({ name: "mtwallet-review", version: "1.0.0" });

  server.registerTool(
    "get_review_payload",
    {
      title: "Get monthly review payload",
      description:
        "Returns the resolved spending data for a month: totals (already refund-netted and " +
        "duplicate-excluded — the ground truth), items[] (every allocation item with its " +
        "ordinal-tagged transactions {n, d, merchant, note, amount}), income_lines, and " +
        "known_slice_labels/known_group_labels from prior months (reuse these labels verbatim " +
        "when they fit). Call this first; group ordinals by meaning; never compute your own numbers.",
      inputSchema: {
        month: z
          .string()
          .regex(MONTH_RE)
          .optional()
          .describe("YYYY-MM. Omit for the current month (IST)."),
      },
    },
    async ({ month }) => {
      const payload = await buildReviewPayload(userId, month ?? currentIstMonth());
      return text(payload);
    },
  );

  server.registerTool(
    "submit_review_groupings",
    {
      title: "Submit the monthly review",
      description:
        "Stores the review after server-side reconciliation. items[] must contain one entry per " +
        "payload item, assigning EVERY transaction ordinal of that item to exactly one labeled " +
        "group. slices[] optionally partitions ALL expense ordinals of the month into 8-14 " +
        "cross-category themes, each ordinal exactly once. The server recomputes every amount " +
        "from the ordinals and rejects the whole submission (nothing stored) on any uncovered, " +
        "duplicate, or foreign ordinal — read errors[] and resubmit corrected groupings.",
      inputSchema: {
        ...ReviewSubmissionSchema.shape,
        month: z
          .string()
          .regex(MONTH_RE)
          .optional()
          .describe("YYYY-MM. Omit for the current month (IST)."),
      },
    },
    async (args) => {
      const submission = ReviewSubmissionSchema.parse({
        ...args,
        month: args.month ?? currentIstMonth(),
      });
      const payload = await buildReviewPayload(userId, submission.month);
      const result = await storeReview(userId, payload, submission);
      if ("errors" in result) {
        return {
          ...text({
            stored: false,
            errors: result.errors,
            hint: "Fix the groupings and call submit_review_groupings again. If transactions changed mid-run, call get_review_payload again first.",
          }),
          isError: true,
        };
      }
      return text(result);
    },
  );

  return server;
}

const router = Router({ mergeParams: true });

router.post("/", async (req: Request, res: Response) => {
  const token = (req.params as { token?: string }).token;
  const user = token ? await getUserByApiKey(token) : null;
  if (!user) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Invalid or missing token in MCP URL" },
      id: null,
    });
    return;
  }

  const server = buildServer(user.id);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] request failed:", (err as Error).message);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless server: no SSE streams or sessions to manage.
for (const method of ["get", "delete"] as const) {
  router[method]("/", (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed (stateless MCP endpoint)" },
      id: null,
    });
  });
}

export default router;
