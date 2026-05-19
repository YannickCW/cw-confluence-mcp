// Central tool registrar. Composes definitions from each domain sub-agent and
// wires them onto a single ListTools / CallTool dispatch pair.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ConfluenceClient } from "../confluence/client.js";
import { logger, redactValue } from "../shared/logger.js";

import { getSpaceToolDefinitions } from "./spaces.js";
import { getPageToolDefinitions } from "./pages.js";
import { getVersionToolDefinitions } from "./versions.js";
import { getCommentToolDefinitions } from "./comments.js";
import { getLabelToolDefinitions } from "./labels.js";
import { getAttachmentToolDefinitions } from "./attachments.js";

export interface ToolContext {
  client: ConfluenceClient;
}

// Canonical adapted shape used internally by the dispatcher.
interface AdaptedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  invoke: (args: unknown) => Promise<unknown>;
}

function collectTools(ctx: ToolContext): AdaptedTool[] {
  const attachmentCtx = { client: ctx.client, site: ctx.client.site };

  const adapted: AdaptedTool[] = [];

  // spaces, pages, versions, comments: handler signature is (ctx, args).
  for (const t of getSpaceToolDefinitions()) {
    adapted.push(adaptCtxArgs(t.name, t.description, t.inputSchema, (a) => t.handler(ctx, a)));
  }
  for (const t of getPageToolDefinitions()) {
    adapted.push(adaptCtxArgs(t.name, t.description, t.inputSchema, (a) => t.handler(ctx, a)));
  }
  for (const t of getVersionToolDefinitions()) {
    adapted.push(adaptCtxArgs(t.name, t.description, t.inputSchema, (a) => t.handler(ctx, a)));
  }
  for (const t of getCommentToolDefinitions()) {
    adapted.push(adaptCtxArgs(t.name, t.description, t.inputSchema, (a) => t.handler(ctx, a)));
  }

  // labels: handler signature is (args, ctx).
  for (const t of getLabelToolDefinitions()) {
    adapted.push(adaptCtxArgs(t.name, t.description, t.inputSchema, (a) => t.handler(a, ctx)));
  }

  // attachments: handler signature is (args) with ctx baked in via closure;
  // we re-derive its definitions with the site-aware context.
  for (const t of getAttachmentToolDefinitions(attachmentCtx)) {
    adapted.push(adaptCtxArgs(t.name, t.description, t.inputSchema, (a) => t.handler(a)));
  }

  return adapted;
}

function adaptCtxArgs(
  name: string,
  description: string,
  inputSchema: unknown,
  invoke: (args: unknown) => Promise<unknown>,
): AdaptedTool {
  return {
    name,
    description,
    inputSchema: normaliseInputSchema(inputSchema),
    invoke,
  };
}

// Some sub-agents ship `inputSchema` as a raw Zod schema; others ship a hand-rolled
// JSON Schema. Detect the Zod shape and convert so the wire format is always JSON Schema.
function normaliseInputSchema(schema: unknown): Record<string, unknown> {
  if (schema instanceof z.ZodType) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- zodToJsonSchema's param shape varies by version; runtime check above is sufficient.
    const converted = zodToJsonSchema(schema, { target: "jsonSchema7" }) as Record<string, unknown>;
    // Strip the `$schema` / `$ref` wrappers zod-to-json-schema adds — MCP clients want
    // the schema body inlined.
    delete converted.$schema;
    delete converted.$ref;
    delete converted.definitions;
    return converted;
  }
  return (schema ?? { type: "object" }) as Record<string, unknown>;
}

function isErrorResult(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    (value as { ok: unknown }).ok === false
  );
}

export function registerTools(server: Server, ctx: ToolContext): void {
  const tools = collectTools(ctx);
  const byName = new Map(tools.map((t) => [t.name, t]));

  logger.info(`Registered ${tools.length} tools.`);

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const toolName = req.params.name;
    const tool = byName.get(toolName);
    if (!tool) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: {
                status: 0,
                code: "not_found",
                message: `Unknown tool: ${toolName}`,
                retryable: false,
              },
            }),
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await tool.invoke(req.params.arguments ?? {});
      const isError = isErrorResult(result);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError,
      };
    } catch (err) {
      logger.error(`Tool "${toolName}" threw: ${err instanceof Error ? err.message : String(err)}`);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: {
                status: 0,
                code: "unknown",
                message: `Tool threw: ${err instanceof Error ? err.message : String(err)}`,
                retryable: false,
                details: redactValue(err instanceof Error ? { name: err.name, message: err.message } : { value: String(err) }) as Record<string, unknown>,
              },
            }),
          },
        ],
        isError: true,
      };
    }
  });
}
