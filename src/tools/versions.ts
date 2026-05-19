// MCP tool registrations for page versions (§4.4).

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
import type { ToolContext } from "./register.js";
import {
  getPageVersion,
  listPageVersions,
} from "../confluence/endpoints/versions.js";
import { validationError, type Result } from "../confluence/errors.js";
import { PageId, PaginationInput } from "../shared/schemas.js";
import type { ToolDefinition } from "./pages.js";

const PageVersionsListInput = z.object({
  page_id: PageId,
  cursor: z.string().optional(),
  page: z.number().int().min(1).optional(),
  pagelen: z.number().int().min(1).max(100).optional(),
});

const PageVersionGetInput = z.object({
  page_id: PageId,
  version: z.number().int().min(1),
});

function buildPagination(args: { cursor?: string; page?: number; pagelen?: number }) {
  return PaginationInput.parse({
    ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
    ...(args.page !== undefined ? { page: args.page } : {}),
    ...(args.pagelen !== undefined ? { pagelen: args.pagelen } : {}),
  });
}

function zodValidationFailure(err: z.ZodError) {
  const first = err.issues[0];
  const path = first?.path?.join(".") ?? "";
  const msg = first?.message ?? "Invalid input";
  return validationError(path ? `${path}: ${msg}` : msg, { issues: err.issues });
}

export function getVersionToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "page_versions_list",
      description: "List historical versions of a page. Read-only — versions cannot be restored via MCP.",
      inputSchema: PageVersionsListInput,
      handler: async (ctx, rawArgs): Promise<Result<unknown>> => {
        const parsed = PageVersionsListInput.safeParse(rawArgs);
        if (!parsed.success) return zodValidationFailure(parsed.error);
        const a = parsed.data;
        return listPageVersions(ctx.client, {
          page_id: a.page_id,
          pagination: buildPagination(a),
        });
      },
    },
    {
      name: "page_version_get",
      description: "Fetch a specific historical version of a page (body in storage format).",
      inputSchema: PageVersionGetInput,
      handler: async (ctx, rawArgs): Promise<Result<unknown>> => {
        const parsed = PageVersionGetInput.safeParse(rawArgs);
        if (!parsed.success) return zodValidationFailure(parsed.error);
        return getPageVersion(ctx.client, parsed.data);
      },
    },
  ];
}

/** Wire version tools into the MCP server. Phase 4 calls this. */
export function registerVersionTools(_server: Server, _ctx: ToolContext): void {
  // See note in `tools/pages.ts` — Phase 4 wires a single dispatcher across all sub-agents.
}
