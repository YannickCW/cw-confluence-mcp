// Label endpoints (read-only). See §4.7 of the design spec.
//
// `listPageLabels` uses v2 `GET /pages/{id}/labels` — returns `{ id, name, prefix }` per label.
// `searchPagesByLabel` uses v1 `GET /content/search` with a CQL `label = "..."` filter.
//   Rationale: v2 does not yet expose a stable "pages by label" listing across all spaces; the v1
//   CQL search is the same path used by `page_search`, which keeps the implementation consistent.

import type { ConfluenceClient } from "../client.js";
import { buildCql } from "../cql.js";
import { type Result, validationError } from "../errors.js";
import {
  type PaginatedOutput,
  v1InputFromPagination,
  v1Paginate,
  v1QueryString,
  v2InputFromPagination,
  v2Paginate,
  v2QueryString,
} from "../pagination.js";
import type { PaginationInputT } from "../../shared/schemas.js";

// ---------- Types returned to the tool layer ----------

export interface LabelEntry {
  id?: string;
  name: string;
  prefix: string;
}

export interface PageByLabelEntry {
  id: string;
  title: string;
  space_key?: string;
  parent_id?: string;
  status: string;
}

// ---------- listPageLabels (v2) ----------

interface V2LabelRaw {
  id?: string | number;
  name?: string;
  prefix?: string;
}

interface V2LabelsBody {
  results?: V2LabelRaw[];
  _links?: { next?: string | null };
}

export async function listPageLabels(
  client: ConfluenceClient,
  pageId: string,
  pagination: PaginationInputT,
): Promise<Result<PaginatedOutput<LabelEntry>>> {
  const input = v2InputFromPagination(pagination);
  const qs = v2QueryString(input);
  const res = await client.v2<V2LabelsBody>(`/pages/${encodeURIComponent(pageId)}/labels?${qs}`);
  if (!res.ok) return res;

  const out = v2Paginate<V2LabelRaw, LabelEntry>(res.data, (raw) => ({
    ...(raw.id !== undefined ? { id: String(raw.id) } : {}),
    name: String(raw.name ?? ""),
    prefix: String(raw.prefix ?? "global"),
  }));
  return { ok: true, data: out };
}

// ---------- searchPagesByLabel (v1 CQL) ----------

interface V1ContentRaw {
  id?: string | number;
  title?: string;
  status?: string;
  type?: string;
  space?: { key?: string };
  ancestors?: Array<{ id?: string | number }>;
}

interface V1SearchBody {
  results?: V1ContentRaw[];
  size?: number;
  start?: number;
  limit?: number;
  _links?: { next?: string | null };
}

export interface SearchPagesByLabelArgs {
  label: string;
  space?: string;
  pagination: PaginationInputT;
}

export async function searchPagesByLabel(
  client: ConfluenceClient,
  args: SearchPagesByLabelArgs,
): Promise<Result<PaginatedOutput<PageByLabelEntry>>> {
  if (!args.label || args.label.trim() === "") {
    return validationError("label must be a non-empty string.");
  }

  let cql: string;
  try {
    cql = buildCql({
      type: "page",
      label: args.label,
      ...(args.space !== undefined ? { space: args.space } : {}),
    });
  } catch (err) {
    return validationError(err instanceof Error ? err.message : String(err));
  }

  const input = v1InputFromPagination(args.pagination);
  const qs = v1QueryString(input, { cql });
  const res = await client.v1<V1SearchBody>(`/content/search?${qs}`);
  if (!res.ok) return res;

  const out = v1Paginate<V1ContentRaw, PageByLabelEntry>(res.data, (raw) => {
    const ancestors = raw.ancestors ?? [];
    const lastAncestor = ancestors.length > 0 ? ancestors[ancestors.length - 1] : undefined;
    const parentId =
      lastAncestor && lastAncestor.id !== undefined ? String(lastAncestor.id) : undefined;
    return {
      id: String(raw.id ?? ""),
      title: String(raw.title ?? ""),
      ...(raw.space?.key ? { space_key: raw.space.key } : {}),
      ...(parentId !== undefined ? { parent_id: parentId } : {}),
      status: String(raw.status ?? "current"),
    };
  });
  return { ok: true, data: out };
}
