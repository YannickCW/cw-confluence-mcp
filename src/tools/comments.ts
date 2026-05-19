// MCP tool layer for comments (§4.5).
//
// Six tools: comments_list, comment_get, comment_create, comment_update,
// comment_resolve, comment_reopen. No comment_delete — deletion is a hard
// non-goal (§1).
//
// Each handler validates input with zod, then delegates to
// `endpoints/comments.ts`, returning the canonical `Result<T>` shape from
// `confluence/errors.ts`. Phase-4 wiring converts that into MCP
// `{ content, isError }` envelopes.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";

import {
  createComment,
  getComment,
  listComments,
  reopenComment,
  resolveComment,
  updateComment,
  type CommentDetail,
  type CommentSummary,
} from "../confluence/endpoints/comments.js";
import { fail, type Result } from "../confluence/errors.js";
import type { PaginatedOutput } from "../confluence/pagination.js";
import {
  BodyStorage,
  CommentId,
  CommentType,
  InlineAnchorInput,
  PageId,
  PaginationInput,
} from "../shared/schemas.js";
import type { ToolContext } from "./register.js";

// -- Input schemas ---------------------------------------------------------

const CommentsListInputSchema = z
  .object({
    page_id: PageId,
    type: CommentType.optional(),
    include_resolved: z.boolean().optional(),
  })
  .merge(PaginationInput);

const CommentGetInputSchema = z.object({
  comment_id: CommentId,
});

const CommentCreateInputSchema = z
  .object({
    page_id: PageId,
    body_storage: BodyStorage,
    parent_id: CommentId.optional(),
    inline: InlineAnchorInput.optional(),
  })
  .refine((v) => !(v.parent_id && v.inline), {
    message: "Cannot supply both `parent_id` (reply) and `inline` (new inline thread) on the same call.",
    path: ["inline"],
  });

const CommentUpdateInputSchema = z.object({
  comment_id: CommentId,
  body_storage: BodyStorage,
});

const CommentResolveInputSchema = z.object({
  comment_id: CommentId,
});

const CommentReopenInputSchema = z.object({
  comment_id: CommentId,
});

export type CommentsListInput = z.infer<typeof CommentsListInputSchema>;
export type CommentGetInput = z.infer<typeof CommentGetInputSchema>;
export type CommentCreateInput = z.infer<typeof CommentCreateInputSchema>;
export type CommentUpdateInput = z.infer<typeof CommentUpdateInputSchema>;
export type CommentResolveInput = z.infer<typeof CommentResolveInputSchema>;
export type CommentReopenInput = z.infer<typeof CommentReopenInputSchema>;

// -- JSON Schema (hand-rolled) for MCP tool definitions --------------------

const PAGINATION_JSON_SCHEMA = {
  cursor: { type: "string", description: "Opaque cursor from a previous response." },
  page: { type: "integer", minimum: 1, description: "1-indexed page (v1 fallbacks only)." },
  pagelen: { type: "integer", minimum: 1, maximum: 100, default: 25 },
} as const;

const commentsListJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["page_id"],
  properties: {
    page_id: { type: "string", minLength: 1, description: "Confluence page ID." },
    type: {
      type: "string",
      enum: ["footer", "inline", "both"],
      default: "both",
      description: "Which comment shape(s) to return.",
    },
    include_resolved: {
      type: "boolean",
      default: true,
      description: "Include resolved inline threads (no effect on footer comments).",
    },
    ...PAGINATION_JSON_SCHEMA,
  },
} as const;

const commentGetJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["comment_id"],
  properties: {
    comment_id: { type: "string", minLength: 1, description: "Confluence comment ID." },
  },
} as const;

const commentCreateJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["page_id", "body_storage"],
  properties: {
    page_id: { type: "string", minLength: 1, description: "Confluence page ID." },
    body_storage: {
      type: "string",
      description: "Comment body in Confluence storage format (XHTML).",
    },
    parent_id: {
      type: "string",
      minLength: 1,
      description: "Parent comment ID — supply for replies. Cannot be combined with `inline`.",
    },
    inline: {
      type: "object",
      additionalProperties: false,
      required: ["text_marker"],
      properties: {
        text_marker: {
          type: "string",
          minLength: 1,
          description: "Substring of the page's rendered text that the inline thread anchors to.",
        },
        occurrence: {
          type: "integer",
          minimum: 1,
          description: "1-indexed occurrence if `text_marker` appears multiple times.",
        },
      },
      description:
        "Inline-anchor for creating a NEW inline thread. Cannot be combined with `parent_id`.",
    },
  },
  description:
    "Create a footer or inline comment, or reply to an existing thread. Without `inline`/`parent_id` → footer. With `parent_id` → reply. With `inline.text_marker` → new inline thread.",
} as const;

const commentUpdateJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["comment_id", "body_storage"],
  properties: {
    comment_id: { type: "string", minLength: 1, description: "Confluence comment ID." },
    body_storage: {
      type: "string",
      description: "Replacement body in Confluence storage format (XHTML).",
    },
  },
} as const;

const commentResolveJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["comment_id"],
  properties: {
    comment_id: { type: "string", minLength: 1, description: "Inline comment ID to resolve." },
  },
} as const;

const commentReopenJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["comment_id"],
  properties: {
    comment_id: { type: "string", minLength: 1, description: "Inline comment ID to reopen." },
  },
} as const;

// -- Tool handlers ---------------------------------------------------------

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.length > 0 ? i.path.join(".") + ": " : ""}${i.message}`)
    .join("; ");
}

export async function commentsListHandler(
  ctx: ToolContext,
  rawArgs: unknown,
): Promise<Result<PaginatedOutput<CommentSummary>>> {
  const parsed = CommentsListInputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return fail(0, "validation", formatZodError(parsed.error));
  }
  const { page_id, type, include_resolved, ...pagination } = parsed.data;
  return listComments(ctx.client, {
    page_id,
    ...(type !== undefined ? { type } : {}),
    ...(include_resolved !== undefined ? { include_resolved } : {}),
    pagination,
  });
}

export async function commentGetHandler(
  ctx: ToolContext,
  rawArgs: unknown,
): Promise<Result<CommentDetail>> {
  const parsed = CommentGetInputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return fail(0, "validation", formatZodError(parsed.error));
  }
  return getComment(ctx.client, { comment_id: parsed.data.comment_id });
}

export async function commentCreateHandler(
  ctx: ToolContext,
  rawArgs: unknown,
): Promise<Result<CommentDetail>> {
  const parsed = CommentCreateInputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return fail(0, "validation", formatZodError(parsed.error));
  }
  return createComment(ctx.client, {
    page_id: parsed.data.page_id,
    body_storage: parsed.data.body_storage,
    ...(parsed.data.parent_id !== undefined ? { parent_id: parsed.data.parent_id } : {}),
    ...(parsed.data.inline !== undefined ? { inline: parsed.data.inline } : {}),
  });
}

export async function commentUpdateHandler(
  ctx: ToolContext,
  rawArgs: unknown,
): Promise<Result<CommentDetail>> {
  const parsed = CommentUpdateInputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return fail(0, "validation", formatZodError(parsed.error));
  }
  return updateComment(ctx.client, {
    comment_id: parsed.data.comment_id,
    body_storage: parsed.data.body_storage,
  });
}

export async function commentResolveHandler(
  ctx: ToolContext,
  rawArgs: unknown,
): Promise<Result<CommentDetail>> {
  const parsed = CommentResolveInputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return fail(0, "validation", formatZodError(parsed.error));
  }
  return resolveComment(ctx.client, { comment_id: parsed.data.comment_id });
}

export async function commentReopenHandler(
  ctx: ToolContext,
  rawArgs: unknown,
): Promise<Result<CommentDetail>> {
  const parsed = CommentReopenInputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return fail(0, "validation", formatZodError(parsed.error));
  }
  return reopenComment(ctx.client, { comment_id: parsed.data.comment_id });
}

// -- Tool definitions ------------------------------------------------------

export interface CommentToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
  handler: (ctx: ToolContext, args: unknown) => Promise<Result<unknown>>;
}

export function getCommentToolDefinitions(): CommentToolDefinition[] {
  return [
    {
      name: "comments_list",
      description:
        "List comments on a Confluence page (footer and/or inline), tree-flattened with `parent_id` so threads are reconstructable. " +
        "Inline items include anchor metadata (textSelection, match count/index).",
      inputSchema: commentsListJsonSchema,
      handler: commentsListHandler,
    },
    {
      name: "comment_get",
      description: "Fetch one Confluence comment by id (footer or inline).",
      inputSchema: commentGetJsonSchema,
      handler: commentGetHandler,
    },
    {
      name: "comment_create",
      description:
        "Create a Confluence comment. Without `inline`/`parent_id` → footer comment. With `parent_id` → reply. " +
        "With `inline.text_marker` → new inline thread anchored to a substring of the page body (use `inline.occurrence` if the marker is ambiguous). " +
        "Cannot supply both `parent_id` and `inline` on the same call.",
      inputSchema: commentCreateJsonSchema,
      handler: commentCreateHandler,
    },
    {
      name: "comment_update",
      description:
        "Replace the body of an existing Confluence comment. Only the author can update — Confluence's 403 is surfaced as a `forbidden` error.",
      inputSchema: commentUpdateJsonSchema,
      handler: commentUpdateHandler,
    },
    {
      name: "comment_resolve",
      description:
        "Resolve an inline comment thread. Returns a `validation` error if the comment is footer-type (`comment_resolve` is inline-only).",
      inputSchema: commentResolveJsonSchema,
      handler: commentResolveHandler,
    },
    {
      name: "comment_reopen",
      description:
        "Reopen a previously resolved inline comment thread. Returns a `validation` error if the comment is footer-type.",
      inputSchema: commentReopenJsonSchema,
      handler: commentReopenHandler,
    },
  ];
}

// -- Phase-4 registration entry point --------------------------------------
//
// `tools/register.ts` imports `registerCommentTools` and merges its definitions
// into the MCP `ListTools`/`CallTool` dispatch. We deliberately do **not** call
// `server.setRequestHandler(...)` here so the wiring agent can compose all
// domains into a single dispatcher.

export function registerCommentTools(
  _server: Server,
  _ctx: ToolContext,
): CommentToolDefinition[] {
  // The actual wiring (`ListToolsRequestSchema` / `CallToolRequestSchema`) is
  // Phase 4's job — it sees the full set of definitions from all sub-agents
  // and registers one handler for both requests. We expose our defs here.
  return getCommentToolDefinitions();
}
