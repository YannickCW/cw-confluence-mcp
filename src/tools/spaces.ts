// MCP tool layer for spaces (§4.1).
// Three tools: space_list, space_get, space_search. All read-only.
//
// Each handler validates input with zod, then delegates to `endpoints/spaces.ts`,
// returning the canonical `Result<T>` shape from `confluence/errors.ts`. Phase-4
// wiring converts that into MCP `{ content, isError }` envelopes.

import { z } from "zod";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import {
  getSpace,
  listSpaces,
  searchSpaces,
  type SpaceDetail,
  type SpaceSearchHit,
  type SpaceSummary,
} from "../confluence/endpoints/spaces.js";
import { fail, type Result } from "../confluence/errors.js";
import type { PaginatedOutput } from "../confluence/pagination.js";
import { PaginationInput, SpaceStatus, SpaceType } from "../shared/schemas.js";
import type { ToolContext } from "./register.js";

// -- Input schemas ---------------------------------------------------------

const SpaceListInputSchema = z
  .object({
    type: SpaceType.optional(),
    status: SpaceStatus.optional(),
  })
  .merge(PaginationInput);

const SpaceGetInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    key: z.string().min(1).optional(),
  })
  .refine((v) => Boolean(v.id) !== Boolean(v.key), {
    message: "Provide exactly one of `id` or `key`.",
  });

const SpaceSearchInputSchema = z
  .object({
    query: z.string().min(1, "query must not be empty"),
    type: SpaceType.optional(),
  })
  .merge(PaginationInput);

export type SpaceListInput = z.infer<typeof SpaceListInputSchema>;
export type SpaceGetInput = z.infer<typeof SpaceGetInputSchema>;
export type SpaceSearchInput = z.infer<typeof SpaceSearchInputSchema>;

// -- JSON Schema (loose) for MCP tool definitions --------------------------
// We hand-author these so the tool surface is stable even if we change the
// internal zod schemas. Phase 4 may swap for `zod-to-json-schema` if desired.

const PAGINATION_JSON_SCHEMA: Record<string, unknown> = {
  cursor: { type: "string", description: "Opaque cursor from a previous response." },
  page: { type: "integer", minimum: 1, description: "1-indexed page (v1 fallbacks only)." },
  pagelen: { type: "integer", minimum: 1, maximum: 100, default: 25 },
};

const spaceListJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["global", "personal"] },
    status: { type: "string", enum: ["current", "archived"], default: "current" },
    ...PAGINATION_JSON_SCHEMA,
  },
};

const spaceGetJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
    key: { type: "string", minLength: 1 },
  },
  description: "Provide exactly one of `id` or `key`.",
};

const spaceSearchJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: { type: "string", minLength: 1 },
    type: { type: "string", enum: ["global", "personal"] },
    ...PAGINATION_JSON_SCHEMA,
  },
};

// -- Tool handlers ---------------------------------------------------------

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.length > 0 ? i.path.join(".") + ": " : ""}${i.message}`)
    .join("; ");
}

export async function spaceListHandler(
  ctx: ToolContext,
  rawArgs: unknown,
): Promise<Result<PaginatedOutput<SpaceSummary>>> {
  const parsed = SpaceListInputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return fail(0, "validation", formatZodError(parsed.error));
  }
  const { type, status, ...pagination } = parsed.data;
  return listSpaces(ctx.client, {
    ...(type !== undefined ? { type } : {}),
    ...(status !== undefined ? { status } : {}),
    pagination,
  });
}

export async function spaceGetHandler(
  ctx: ToolContext,
  rawArgs: unknown,
): Promise<Result<SpaceDetail>> {
  const parsed = SpaceGetInputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return fail(0, "validation", formatZodError(parsed.error));
  }
  return getSpace(ctx.client, parsed.data);
}

export async function spaceSearchHandler(
  ctx: ToolContext,
  rawArgs: unknown,
): Promise<Result<PaginatedOutput<SpaceSearchHit>>> {
  const parsed = SpaceSearchInputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return fail(0, "validation", formatZodError(parsed.error));
  }
  const { query, type, ...pagination } = parsed.data;
  return searchSpaces(ctx.client, {
    query,
    ...(type !== undefined ? { type } : {}),
    pagination,
  });
}

// -- Tool definitions ------------------------------------------------------

export interface SpaceToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
  handler: (ctx: ToolContext, args: unknown) => Promise<Result<unknown>>;
}

export function getSpaceToolDefinitions(): SpaceToolDefinition[] {
  return [
    {
      name: "space_list",
      description:
        "List accessible Confluence spaces. Filter by type (global/personal) and status (current/archived, default current). Paginated.",
      inputSchema: spaceListJsonSchema,
      handler: spaceListHandler,
    },
    {
      name: "space_get",
      description:
        "Fetch one space by `key` or `id` (exactly one). Returns full metadata plus the storage-format description when present.",
      inputSchema: spaceGetJsonSchema,
      handler: spaceGetHandler,
    },
    {
      name: "space_search",
      description:
        'Keyword search over space name + description. Composes CQL `type = "space" AND text ~ "<query>"`. Optionally filter by type post-hoc.',
      inputSchema: spaceSearchJsonSchema,
      handler: spaceSearchHandler,
    },
  ];
}

// -- Phase-4 registration entry point --------------------------------------
//
// `tools/register.ts` imports `registerSpaceTools` and merges its definitions
// into the MCP `ListTools`/`CallTool` dispatch. We deliberately do **not** call
// `server.setRequestHandler(...)` here so the wiring agent can compose all
// domains into a single dispatcher.

export function registerSpaceTools(
  _server: Server,
  _ctx: ToolContext,
): SpaceToolDefinition[] {
  // The actual wiring (`ListToolsRequestSchema` / `CallToolRequestSchema`) is
  // Phase 4's job — it sees the full set of definitions from all sub-agents
  // and registers one handler for both requests. We expose our defs here.
  return getSpaceToolDefinitions();
}
