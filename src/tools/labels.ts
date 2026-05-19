// Label tools (read-only). Wires `labels_list` and `pages_by_label` into the MCP surface.
// See §4.7 of the design spec. Hard non-goal (§1): NO `label_add` / `label_remove`.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";

import { validationError, type Result } from "../confluence/errors.js";
import { listPageLabels, searchPagesByLabel } from "../confluence/endpoints/labels.js";
import { PageId, PaginationInput, SpaceKey } from "../shared/schemas.js";
import type { ToolContext } from "./register.js";

// ---------- Tool argument schemas ----------

const LabelsListArgsSchema = z
  .object({
    page_id: PageId,
  })
  .merge(PaginationInput);

const PagesByLabelArgsSchema = z
  .object({
    label: z.string().min(1, "label must not be empty"),
    space: SpaceKey.optional(),
  })
  .merge(PaginationInput);

// ---------- Public types ----------

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown, ctx: ToolContext) => Promise<Result<unknown>>;
}

// ---------- Handlers ----------

async function labelsListHandler(args: unknown, ctx: ToolContext): Promise<Result<unknown>> {
  const parsed = LabelsListArgsSchema.safeParse(args);
  if (!parsed.success) {
    return validationError(parsed.error.issues.map((i) => i.message).join("; "));
  }
  const { page_id, ...pagination } = parsed.data;
  return listPageLabels(ctx.client, page_id, pagination);
}

async function pagesByLabelHandler(args: unknown, ctx: ToolContext): Promise<Result<unknown>> {
  const parsed = PagesByLabelArgsSchema.safeParse(args);
  if (!parsed.success) {
    return validationError(parsed.error.issues.map((i) => i.message).join("; "));
  }
  const { label, space, ...pagination } = parsed.data;
  return searchPagesByLabel(ctx.client, {
    label,
    ...(space !== undefined ? { space } : {}),
    pagination,
  });
}

// ---------- JSON schemas for tool definitions ----------
// Hand-rolled to keep dependencies minimal (no zod-to-json-schema).

const paginationProps = {
  cursor: {
    type: "string",
    description: "Opaque cursor from a previous response's next_cursor.",
  },
  page: {
    type: "integer",
    minimum: 1,
    description: "1-indexed page number (for v1 fallback endpoints).",
  },
  pagelen: {
    type: "integer",
    minimum: 1,
    maximum: 100,
    default: 25,
    description: "Page size (default 25, max 100).",
  },
} as const;

const LABELS_LIST_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    page_id: {
      type: "string",
      minLength: 1,
      description: "Confluence page ID.",
    },
    ...paginationProps,
  },
  required: ["page_id"],
  additionalProperties: false,
};

const PAGES_BY_LABEL_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    label: {
      type: "string",
      minLength: 1,
      description: "Label name to filter by (without prefix).",
    },
    space: {
      type: "string",
      minLength: 1,
      maxLength: 255,
      description: "Optional space key to scope the search.",
    },
    ...paginationProps,
  },
  required: ["label"],
  additionalProperties: false,
};

// ---------- Tool definitions ----------

export function getLabelToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "labels_list",
      description:
        "List labels attached to a Confluence page. Returns each label's name and prefix (global | team | my | system). Read-only.",
      inputSchema: LABELS_LIST_INPUT_SCHEMA,
      handler: labelsListHandler,
    },
    {
      name: "pages_by_label",
      description:
        "Find pages tagged with a given label. Optionally scope by space. Returns lightweight page metadata. Read-only.",
      inputSchema: PAGES_BY_LABEL_INPUT_SCHEMA,
      handler: pagesByLabelHandler,
    },
  ];
}

// ---------- Phase-4 registration entry point ----------
//
// `tools/register.ts` (Phase 4) imports `registerLabelTools` to obtain this domain's
// tool definitions, then merges them with other sub-agents' defs into a single pair
// of MCP `ListTools` / `CallTool` request handlers. We deliberately do NOT call
// `server.setRequestHandler(...)` here — doing so would clobber other domains.

export function registerLabelTools(_server: Server, _ctx: ToolContext): ToolDefinition[] {
  return getLabelToolDefinitions();
}
