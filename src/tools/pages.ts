// MCP tool registrations for pages (read + write).
//
// Read tools (B):  page_list, page_get, page_get_children, page_get_ancestors, page_search.
// Write tools (C): page_create, page_update.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
import type { ToolContext } from "./register.js";
import {
  createPage,
  getPage,
  getPageAncestors,
  getPageChildren,
  listPages,
  searchPages,
  updatePage,
  PAGE_UPDATE_ALLOWED_FIELDS,
} from "../confluence/endpoints/pages.js";
import { forbiddenFieldError, validationError, type Result } from "../confluence/errors.js";
import {
  BodyStorage,
  PageId,
  PageStatus,
  PaginationInput,
  SpaceKey,
} from "../shared/schemas.js";

// ---- Shared schemas -------------------------------------------------

const SpaceKeyOrId = z
  .string()
  .min(1, "space must not be empty")
  .max(255, "space too long");

// ---- Tool input schemas ---------------------------------------------

const PageListInput = z.object({
  space: SpaceKeyOrId,
  parent_id: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  status: PageStatus.optional(),
  sort: z.string().min(1).optional(),
  cursor: z.string().optional(),
  page: z.number().int().min(1).optional(),
  pagelen: z.number().int().min(1).max(100).optional(),
});

const PageGetInput = z.object({
  page_id: PageId,
  version: z.number().int().min(1).optional(),
});

const PageGetChildrenInput = z.object({
  page_id: PageId,
  sort: z.string().min(1).optional(),
  cursor: z.string().optional(),
  page: z.number().int().min(1).optional(),
  pagelen: z.number().int().min(1).max(100).optional(),
});

const PageGetAncestorsInput = z.object({
  page_id: PageId,
});

const PageSearchInput = z.object({
  query: z.string().min(1).optional(),
  space: SpaceKey.optional(),
  label: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  updated_since: z.string().min(1).optional(),
  creator: z.string().min(1).optional(),
  status: PageStatus.optional(),
  cursor: z.string().optional(),
  page: z.number().int().min(1).optional(),
  pagelen: z.number().int().min(1).max(100).optional(),
});

const PageCreateInput = z.object({
  space: SpaceKey,
  title: z.string().min(1, "title must not be empty"),
  body_storage: BodyStorage,
  parent_id: z.string().min(1).optional(),
  labels: z.array(z.string().min(1)).optional(),
});

// page_update intentionally uses .strict() — any extra key is a validation/forbidden_field error.
// We use a permissive zod schema and check the allowlist explicitly so we can emit `forbidden_field`
// for known-but-forbidden keys (status, parent_id, space_key, version_message).
const PageUpdateInputBase = z.object({
  page_id: PageId,
  title: z.string().min(1, "title must not be empty"),
  body_storage: BodyStorage,
});

// ---- Helpers --------------------------------------------------------

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

// ---- Tool definitions ----------------------------------------------

export interface ToolDefinition<Args = unknown, Out = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (ctx: ToolContext, args: Args) => Promise<Result<Out>>;
}

export function getPageToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "page_list",
      description:
        "List pages in a space. Filter by parent_id, label, status. Lightweight metadata; no body.",
      inputSchema: PageListInput,
      handler: async (ctx, rawArgs) => {
        const parsed = PageListInput.safeParse(rawArgs);
        if (!parsed.success) return zodValidationFailure(parsed.error);
        const a = parsed.data;
        return listPages(ctx.client, {
          space: a.space,
          ...(a.parent_id ? { parent_id: a.parent_id } : {}),
          ...(a.label ? { label: a.label } : {}),
          ...(a.status ? { status: a.status } : {}),
          ...(a.sort ? { sort: a.sort } : {}),
          pagination: buildPagination(a),
        });
      },
    },
    {
      name: "page_get",
      description:
        "Fetch a page with body in storage format (XHTML), labels, version, and ancestors. Optional `version` for historical content.",
      inputSchema: PageGetInput,
      handler: async (ctx, rawArgs) => {
        const parsed = PageGetInput.safeParse(rawArgs);
        if (!parsed.success) return zodValidationFailure(parsed.error);
        return getPage(ctx.client, parsed.data);
      },
    },
    {
      name: "page_get_children",
      description: "Direct children of a page (lightweight metadata).",
      inputSchema: PageGetChildrenInput,
      handler: async (ctx, rawArgs) => {
        const parsed = PageGetChildrenInput.safeParse(rawArgs);
        if (!parsed.success) return zodValidationFailure(parsed.error);
        const a = parsed.data;
        return getPageChildren(ctx.client, {
          page_id: a.page_id,
          ...(a.sort ? { sort: a.sort } : {}),
          pagination: buildPagination(a),
        });
      },
    },
    {
      name: "page_get_ancestors",
      description:
        "Full ancestor chain of a page (closest ancestor first, root last). Not paginated.",
      inputSchema: PageGetAncestorsInput,
      handler: async (ctx, rawArgs) => {
        const parsed = PageGetAncestorsInput.safeParse(rawArgs);
        if (!parsed.success) return zodValidationFailure(parsed.error);
        return getPageAncestors(ctx.client, parsed.data);
      },
    },
    {
      name: "page_search",
      description:
        "Search pages with optional plain-text query and structured filters (space, label, title, updated_since, creator, status). MCP composes CQL safely.",
      inputSchema: PageSearchInput,
      handler: async (ctx, rawArgs) => {
        const parsed = PageSearchInput.safeParse(rawArgs);
        if (!parsed.success) return zodValidationFailure(parsed.error);
        const a = parsed.data;
        return searchPages(ctx.client, {
          ...(a.query ? { query: a.query } : {}),
          ...(a.space ? { space: a.space } : {}),
          ...(a.label ? { label: a.label } : {}),
          ...(a.title ? { title: a.title } : {}),
          ...(a.updated_since ? { updated_since: a.updated_since } : {}),
          ...(a.creator ? { creator: a.creator } : {}),
          ...(a.status ? { status: a.status } : {}),
          pagination: buildPagination(a),
        });
      },
    },
    {
      name: "page_create",
      description:
        "Create a new page under a chosen parent (defaults to space homepage). Optional labels are applied after creation.",
      inputSchema: PageCreateInput,
      handler: async (ctx, rawArgs) => {
        const parsed = PageCreateInput.safeParse(rawArgs);
        if (!parsed.success) return zodValidationFailure(parsed.error);
        const a = parsed.data;
        return createPage(ctx.client, {
          space: a.space,
          title: a.title,
          body_storage: a.body_storage,
          ...(a.parent_id ? { parent_id: a.parent_id } : {}),
          ...(a.labels ? { labels: a.labels } : {}),
        });
      },
    },
    {
      name: "page_update",
      description:
        "Update an existing page. Allowlisted fields only: title, body_storage. Forbidden fields (status, parent_id, space_key, version_message, …) are rejected before any HTTP call. Version is auto-incremented; 409 conflicts retry once.",
      inputSchema: PageUpdateInputBase,
      handler: async (ctx, rawArgs) => {
        // Allowlist check first — runs BEFORE any HTTP call.
        if (rawArgs !== null && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
          const allowed = new Set<string>(PAGE_UPDATE_ALLOWED_FIELDS);
          for (const key of Object.keys(rawArgs as Record<string, unknown>)) {
            if (!allowed.has(key)) {
              return forbiddenFieldError(key);
            }
          }
        }
        const parsed = PageUpdateInputBase.safeParse(rawArgs);
        if (!parsed.success) return zodValidationFailure(parsed.error);
        return updatePage(ctx.client, parsed.data);
      },
    },
  ];
}

/** Wire all page tools into the MCP server. Phase 4 calls this. */
export function registerPageTools(_server: Server, _ctx: ToolContext): void {
  // The actual MCP `setRequestHandler` wiring lives in `register.ts` for ListTools/CallTool
  // dispatch. This function exists for symmetry with sibling sub-agent contracts and is a
  // no-op until Phase 4 chooses a routing strategy.
  // (Phase 4 will collect `getPageToolDefinitions()` together with sibling getters and
  // install a single dispatcher.)
}
