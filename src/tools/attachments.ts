// Attachment MCP tools (read-only metadata — §4.8).
// Tools: `attachments_list`, `attachment_get`.
//
// Hard non-goals (§1): no upload, overwrite, delete, or binary download.
// `download_url` is the only egress — agents fetch bytes themselves.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";

import {
  getAttachment,
  listAttachments,
  type AttachmentItem,
} from "../confluence/endpoints/attachments.js";
import type { Result } from "../confluence/errors.js";
import { validationError } from "../confluence/errors.js";
import type { PaginatedOutput } from "../confluence/pagination.js";
import {
  AttachmentId,
  PageId,
  PaginationInput,
  type PaginationInputT,
} from "../shared/schemas.js";
import type { ToolContext } from "./register.js";

// ---------- input schemas ----------

const AttachmentsListInput = z.object({
  page_id: PageId,
  media_type: z.string().min(1).optional(),
  cursor: z.string().optional(),
  page: z.number().int().min(1).optional(),
  pagelen: z.number().int().min(1).max(100).optional(),
});

const AttachmentGetInput = z.object({
  attachment_id: AttachmentId,
});

// ---------- extended context ----------
//
// The shared `ToolContext` is `{ client }`. Attachment download URLs from
// Confluence v2 are commonly relative (e.g. `/wiki/download/attachments/...`),
// so we need the site hostname to render fully-qualified URLs. The client
// keeps its credentials private and exposes no site getter, so we accept it
// here as an extension to ToolContext. (Foundation gap — flagged in the
// sub-agent report. Phase 4 wiring should pass `site` through.)
export interface AttachmentToolContext extends ToolContext {
  site: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  handler: (args: unknown) => Promise<unknown>;
}

// ---------- public API ----------

export function getAttachmentToolDefinitions(
  ctx: AttachmentToolContext,
): ToolDefinition[] {
  return [
    {
      name: "attachments_list",
      description:
        "List attachments on a Confluence page. Returns metadata only — fetch bytes via `download_url`. Supports `media_type` mime-prefix filtering (e.g. \"image/\").",
      inputSchema: {
        type: "object",
        properties: {
          page_id: { type: "string", description: "Confluence page id" },
          media_type: {
            type: "string",
            description: "Optional mime prefix filter (e.g. \"image/\").",
          },
          cursor: {
            type: "string",
            description: "Opaque cursor from a previous response.",
          },
          page: {
            type: "integer",
            minimum: 1,
            description: "1-indexed page number (v1 fallback).",
          },
          pagelen: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Page size (default 25, max 100).",
          },
        },
        required: ["page_id"],
        additionalProperties: false,
      },
      handler: async (rawArgs: unknown) =>
        handleAttachmentsList(rawArgs, ctx),
    },
    {
      name: "attachment_get",
      description:
        "Get metadata for a single Confluence attachment by id. Returns the same shape as items in `attachments_list`.",
      inputSchema: {
        type: "object",
        properties: {
          attachment_id: { type: "string", description: "Confluence attachment id" },
        },
        required: ["attachment_id"],
        additionalProperties: false,
      },
      handler: async (rawArgs: unknown) => handleAttachmentGet(rawArgs, ctx),
    },
  ];
}

export function registerAttachmentTools(
  _server: Server,
  _ctx: AttachmentToolContext,
): void {
  // The shared registration entry point (`tools/register.ts`) wires tools at
  // Phase 4. Sub-agents expose `getAttachmentToolDefinitions(ctx)` for the
  // central registrar to pick up; this function exists for symmetry and for
  // standalone testing. It deliberately performs no `server.setRequestHandler`
  // wiring of its own so it can be composed with other domains' tools without
  // clobbering them. See `getAttachmentToolDefinitions` for the actual surface.
  void getAttachmentToolDefinitions(_ctx);
}

// ---------- handlers ----------

async function handleAttachmentsList(
  rawArgs: unknown,
  ctx: AttachmentToolContext,
): Promise<Result<PaginatedOutput<AttachmentItem>>> {
  const parsed = AttachmentsListInput.safeParse(rawArgs);
  if (!parsed.success) {
    return validationError(
      `Invalid arguments for attachments_list: ${formatZodError(parsed.error)}`,
    );
  }
  const args = parsed.data;
  const pagination = normalisePagination({
    cursor: args.cursor,
    page: args.page,
    pagelen: args.pagelen,
  });
  return listAttachments(
    ctx.client,
    {
      pageId: args.page_id,
      ...(args.media_type !== undefined ? { mediaType: args.media_type } : {}),
      pagination,
    },
    ctx.site,
  );
}

async function handleAttachmentGet(
  rawArgs: unknown,
  ctx: AttachmentToolContext,
): Promise<Result<AttachmentItem>> {
  const parsed = AttachmentGetInput.safeParse(rawArgs);
  if (!parsed.success) {
    return validationError(
      `Invalid arguments for attachment_get: ${formatZodError(parsed.error)}`,
    );
  }
  return getAttachment(
    ctx.client,
    { attachmentId: parsed.data.attachment_id },
    ctx.site,
  );
}

// ---------- helpers ----------

function normalisePagination(input: {
  cursor?: string;
  page?: number;
  pagelen?: number;
}): PaginationInputT {
  return PaginationInput.parse(input);
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
