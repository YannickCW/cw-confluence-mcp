// Comment endpoint wrappers — footer + inline (§4.5, §4.6).
//
// Confluence Cloud has two comment shapes:
// - footer (page-level) — `v2 /footer-comments`
// - inline (anchored to a text range) — `v2 /inline-comments`
//
// API routing:
// - list   → v2 `GET /pages/{id}/footer-comments` + `GET /pages/{id}/inline-comments`
//            (combined, mapped, then sorted by created_at — pagination is union-aware).
// - get    → v2 `GET /footer-comments/{id}`, fall back to `GET /inline-comments/{id}` on 404.
// - create → v2 `POST /footer-comments` (and `/inline-comments` for new inline threads,
//            with `inlineCommentProperties` derived from the text-marker anchor).
// - update → v2 `PUT /footer-comments/{id}` or `PUT /inline-comments/{id}` (version-bump pattern,
//            no retry on 409 — surface the conflict).
// - resolve / reopen → v1 `PUT /content/{id}/resolve` / `/reopen` because v2 does not
//   expose inline-comment lifecycle as of design date. Documented as deliberate v1 drops.

import type { ConfluenceClient } from "../client.js";
import { fail, ok, validationError, markerNotFoundError, markerAmbiguousError, type Result } from "../errors.js";
import {
  v2InputFromPagination,
  v2Paginate,
  v2QueryString,
  type PaginatedOutput,
} from "../pagination.js";
import { resolveAnchor } from "../anchor.js";
import type { PaginationInputT } from "../../shared/schemas.js";

// -- Raw response shapes ---------------------------------------------------

interface V2CommentBodyView {
  storage?: { value?: string; representation?: string } | null;
  view?: { value?: string; representation?: string } | null;
  atlas_doc_format?: { value?: string; representation?: string } | null;
}

interface V2CommentVersion {
  number?: number;
  createdAt?: string;
  message?: string;
  authorId?: string;
}

interface V2CommentRaw {
  id: string;
  pageId?: string | null;
  parentCommentId?: string | null;
  status?: string | null;
  title?: string | null;
  version?: V2CommentVersion | null;
  body?: V2CommentBodyView | null;
  resolutionStatus?: string | null;
  /** Inline-only — anchor metadata returned by Confluence v2. */
  properties?: {
    "inline-marker-ref"?: string;
    "inline-original-selection"?: string;
  } | null;
  inlineCommentProperties?: {
    textSelection?: string;
    textSelectionMatchCount?: number;
    textSelectionMatchIndex?: number;
    resolutionStatus?: string;
    resolutionLastModifierId?: string;
    resolutionLastModifiedAt?: string;
  } | null;
  _links?: { webui?: string; self?: string; next?: string | null };
}

interface V2CommentsListBody {
  results?: V2CommentRaw[];
  _links?: { next?: string | null };
}

// -- Public output shapes --------------------------------------------------

export interface CommentSummary {
  id: string;
  page_id: string | null;
  parent_id: string | null;
  /** "footer" | "inline" — derived from the source endpoint. */
  type: "footer" | "inline";
  body_storage: string | null;
  version: number | null;
  created_at: string | null;
  author_id: string | null;
  /** Inline anchor metadata (only populated when `type === "inline"`). */
  inline: InlineAnchorMeta | null;
  /** "open" | "resolved" | null — only meaningful for inline comments. */
  resolution_status: string | null;
}

export interface InlineAnchorMeta {
  text_selection: string | null;
  match_count: number | null;
  match_index: number | null;
}

// -- Mapping ---------------------------------------------------------------

function mapComment(raw: V2CommentRaw, type: "footer" | "inline"): CommentSummary {
  const inline: InlineAnchorMeta | null =
    type === "inline"
      ? {
          text_selection: raw.inlineCommentProperties?.textSelection ?? null,
          match_count: raw.inlineCommentProperties?.textSelectionMatchCount ?? null,
          match_index: raw.inlineCommentProperties?.textSelectionMatchIndex ?? null,
        }
      : null;
  const resolutionStatus =
    raw.inlineCommentProperties?.resolutionStatus ?? raw.resolutionStatus ?? null;
  return {
    id: String(raw.id),
    page_id: raw.pageId != null ? String(raw.pageId) : null,
    parent_id: raw.parentCommentId != null ? String(raw.parentCommentId) : null,
    type,
    body_storage: raw.body?.storage?.value ?? null,
    version: raw.version?.number ?? null,
    created_at: raw.version?.createdAt ?? null,
    author_id: raw.version?.authorId ?? null,
    inline,
    resolution_status: resolutionStatus,
  };
}

// -- listComments ----------------------------------------------------------

export interface ListCommentsArgs {
  page_id: string;
  type?: "footer" | "inline" | "both";
  include_resolved?: boolean;
  pagination: PaginationInputT;
}

export async function listComments(
  client: ConfluenceClient,
  args: ListCommentsArgs,
): Promise<Result<PaginatedOutput<CommentSummary>>> {
  const want = args.type ?? "both";
  const includeResolved = args.include_resolved ?? true;
  const v2input = v2InputFromPagination(args.pagination);

  // We fetch each comment-collection's slice independently. The pagination cursor
  // we hand back covers the footer collection by default; when both are requested,
  // we surface the *footer* next-cursor if it exists, else the inline next-cursor.
  // Each list endpoint already obeys the requested `limit`.

  const wantFooter = want === "footer" || want === "both";
  const wantInline = want === "inline" || want === "both";

  const footer: CommentSummary[] = [];
  const inline: CommentSummary[] = [];
  let footerNext: string | null = null;
  let inlineNext: string | null = null;

  if (wantFooter) {
    const qs = v2QueryString(v2input, { "body-format": "storage" });
    const res = await client.v2<V2CommentsListBody>(
      `/pages/${encodeURIComponent(args.page_id)}/footer-comments?${qs}`,
    );
    if (!res.ok) return res;
    const page = v2Paginate(res.data, (r) => mapComment(r, "footer"));
    footer.push(...page.values);
    footerNext = page.next_cursor;
  }

  if (wantInline) {
    const qs = v2QueryString(v2input, { "body-format": "storage" });
    const res = await client.v2<V2CommentsListBody>(
      `/pages/${encodeURIComponent(args.page_id)}/inline-comments?${qs}`,
    );
    if (!res.ok) return res;
    const page = v2Paginate(res.data, (r) => mapComment(r, "inline"));
    inline.push(...page.values);
    inlineNext = page.next_cursor;
  }

  let combined = [...footer, ...inline];

  if (!includeResolved) {
    combined = combined.filter((c) => c.resolution_status !== "resolved");
  }

  // Stable sort: by created_at ascending (null/empty last), then by id for determinism.
  combined.sort((a, b) => {
    const at = a.created_at ?? "";
    const bt = b.created_at ?? "";
    if (at !== bt) return at < bt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // Pick a single next-cursor — prefer footer's if present, else inline's.
  const nextCursor = footerNext ?? inlineNext;

  return ok({ values: combined, next_cursor: nextCursor });
}

// -- getComment ------------------------------------------------------------

export interface GetCommentArgs {
  comment_id: string;
}

export type CommentDetail = CommentSummary;

export async function getComment(
  client: ConfluenceClient,
  args: GetCommentArgs,
): Promise<Result<CommentDetail>> {
  const id = encodeURIComponent(args.comment_id);
  // Try footer first; on 404 fall back to inline.
  const footerRes = await client.v2<V2CommentRaw>(`/footer-comments/${id}?body-format=storage`);
  if (footerRes.ok) {
    return ok(mapComment(footerRes.data, "footer"));
  }
  if (footerRes.error.code !== "not_found") {
    return footerRes;
  }
  const inlineRes = await client.v2<V2CommentRaw>(`/inline-comments/${id}?body-format=storage`);
  if (inlineRes.ok) {
    return ok(mapComment(inlineRes.data, "inline"));
  }
  return inlineRes;
}

// -- createComment ---------------------------------------------------------

export interface CreateCommentArgs {
  page_id: string;
  body_storage: string;
  /** For replies — also valid for replying inside an inline thread. */
  parent_id?: string;
  /** For new inline threads. Cannot be combined with `parent_id`. */
  inline?: {
    text_marker: string;
    occurrence?: number;
  };
}

export async function createComment(
  client: ConfluenceClient,
  args: CreateCommentArgs,
): Promise<Result<CommentDetail>> {
  if (args.parent_id && args.inline) {
    return validationError(
      "Cannot supply both `parent_id` (reply) and `inline` (new inline thread) on the same call.",
    );
  }

  // No inline anchor — this is either a footer create (no parent) or a reply.
  if (!args.inline) {
    // Footer create (no parent) goes straight to /footer-comments.
    if (!args.parent_id) {
      const body = {
        pageId: args.page_id,
        body: { representation: "storage", value: args.body_storage },
      };
      const res = await client.v2<V2CommentRaw>(`/footer-comments`, { method: "POST", body });
      if (!res.ok) return res;
      return ok(mapComment(res.data, "footer"));
    }

    // Reply path — we need to know whether the parent is a footer or inline comment so
    // the reply lands in the right collection. `getComment` already handles the
    // footer→inline fallback, so we delegate.
    const parent = await getComment(client, { comment_id: args.parent_id });
    if (!parent.ok) return parent;
    const body = {
      parentCommentId: args.parent_id,
      body: { representation: "storage", value: args.body_storage },
    };
    const path = parent.data.type === "inline" ? `/inline-comments` : `/footer-comments`;
    const res = await client.v2<V2CommentRaw>(path, { method: "POST", body });
    if (!res.ok) return res;
    return ok(mapComment(res.data, parent.data.type));
  }

  // Inline-create path — must resolve the text marker against the page body first.
  const pageRes = await client.v2<{ body?: { storage?: { value?: string } } }>(
    `/pages/${encodeURIComponent(args.page_id)}?body-format=storage`,
  );
  if (!pageRes.ok) return pageRes;
  const bodyStorage = pageRes.data.body?.storage?.value ?? "";

  const anchor = resolveAnchor(bodyStorage, args.inline.text_marker, args.inline.occurrence);
  if (anchor.status === "not_found") {
    return markerNotFoundError(args.inline.text_marker);
  }
  if (anchor.status === "ambiguous") {
    return markerAmbiguousError(args.inline.text_marker, anchor.count);
  }

  // anchor.status === "found"
  const inlineProps = {
    textSelection: anchor.text_marker,
    textSelectionMatchCount: anchor.total_matches,
    textSelectionMatchIndex: anchor.occurrence - 1, // 0-based for Confluence
  };

  const body = {
    pageId: args.page_id,
    body: { representation: "storage", value: args.body_storage },
    inlineCommentProperties: inlineProps,
  };
  const res = await client.v2<V2CommentRaw>(`/inline-comments`, { method: "POST", body });
  if (!res.ok) return res;
  return ok(mapComment(res.data, "inline"));
}

// -- updateComment ---------------------------------------------------------

export interface UpdateCommentArgs {
  comment_id: string;
  body_storage: string;
}

export async function updateComment(
  client: ConfluenceClient,
  args: UpdateCommentArgs,
): Promise<Result<CommentDetail>> {
  const id = encodeURIComponent(args.comment_id);

  // Determine which collection owns this comment so we can target the right PUT.
  // (v2 footer/inline are separate resources.)
  const footerRes = await client.v2<V2CommentRaw>(`/footer-comments/${id}?body-format=storage`);
  let kind: "footer" | "inline";
  let current: V2CommentRaw;
  if (footerRes.ok) {
    kind = "footer";
    current = footerRes.data;
  } else if (footerRes.error.code === "not_found") {
    const inlineRes = await client.v2<V2CommentRaw>(`/inline-comments/${id}?body-format=storage`);
    if (!inlineRes.ok) return inlineRes;
    kind = "inline";
    current = inlineRes.data;
  } else {
    return footerRes;
  }

  const currentVersion = current.version?.number;
  if (typeof currentVersion !== "number") {
    return fail(0, "unknown", "Comment is missing version metadata; cannot update.");
  }

  const targetPath =
    kind === "footer" ? `/footer-comments/${id}` : `/inline-comments/${id}`;

  // v2 update: PUT with required fields including the new version number.
  // No retry on 409 (per spec) — surface conflict.
  const body = {
    version: { number: currentVersion + 1 },
    body: { representation: "storage", value: args.body_storage },
  };
  const putRes = await client.v2<V2CommentRaw>(targetPath, { method: "PUT", body });
  if (!putRes.ok) return putRes;
  return ok(mapComment(putRes.data, kind));
}

// -- resolveComment --------------------------------------------------------

export interface ResolveCommentArgs {
  comment_id: string;
}

export async function resolveComment(
  client: ConfluenceClient,
  args: ResolveCommentArgs,
): Promise<Result<CommentDetail>> {
  const id = encodeURIComponent(args.comment_id);

  // Step 1: fetch the comment to confirm it's inline (resolve is inline-only).
  const detail = await getComment(client, { comment_id: args.comment_id });
  if (!detail.ok) return detail;
  if (detail.data.type !== "inline") {
    return validationError("comment_resolve is inline-only.");
  }

  // Step 2: v1 resolve (v2 lacks an inline-resolve endpoint as of design date).
  const res = await client.v1<unknown>(`/inline-comments/${id}/resolve`, { method: "PUT" });
  if (!res.ok) {
    // Some Confluence Cloud tenants expose the resolver under /content/{id}/.../inline-resolve;
    // we surface whatever v1 returns rather than guessing.
    return res;
  }
  // Re-fetch the comment so the caller gets the new state.
  return getComment(client, { comment_id: args.comment_id });
}

// -- reopenComment ---------------------------------------------------------

export interface ReopenCommentArgs {
  comment_id: string;
}

export async function reopenComment(
  client: ConfluenceClient,
  args: ReopenCommentArgs,
): Promise<Result<CommentDetail>> {
  const id = encodeURIComponent(args.comment_id);

  // resolve / reopen are inline-only — assert and surface a friendly validation error.
  const detail = await getComment(client, { comment_id: args.comment_id });
  if (!detail.ok) return detail;
  if (detail.data.type !== "inline") {
    return validationError("comment_reopen is inline-only.");
  }

  // v1 reopen (v2 lacks the endpoint).
  const res = await client.v1<unknown>(`/inline-comments/${id}/reopen`, { method: "PUT" });
  if (!res.ok) return res;
  return getComment(client, { comment_id: args.comment_id });
}
