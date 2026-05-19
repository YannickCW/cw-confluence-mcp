// Pagination convention (§4.10). Input: { cursor?, page?, pagelen }. Output: { values, next_cursor, total? }.
// Normalises v1 (offset/limit) and v2 (cursor) Confluence pagination into a single shape so
// endpoint files never branch on API version.

import type { PaginationInputT } from "../shared/schemas.js";

export interface PaginatedOutput<T> {
  values: T[];
  next_cursor: string | null;
  total?: number;
}

// ---- v2 (cursor-based) ----
// Confluence v2 returns `_links.next` as a relative URL with `?cursor=...` (and other query params).
// We extract the `cursor` parameter from that URL and re-issue it on subsequent calls.

export interface V2Input {
  cursor?: string;
  limit: number;
}

export function v2InputFromPagination(p: PaginationInputT): V2Input {
  return {
    ...(p.cursor !== undefined ? { cursor: p.cursor } : {}),
    limit: p.pagelen,
  };
}

export function v2QueryString(input: V2Input, extra: Record<string, string | undefined> = {}): string {
  const params = new URLSearchParams();
  params.set("limit", String(input.limit));
  if (input.cursor) params.set("cursor", input.cursor);
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined) params.set(k, v);
  }
  return params.toString();
}

export function v2ExtractNextCursor(nextLink: string | undefined | null): string | null {
  if (!nextLink) return null;
  // The link is typically a relative URL like "/wiki/api/v2/pages?cursor=ABC&limit=25".
  // We parse out the `cursor` query param.
  try {
    const url = new URL(nextLink, "https://placeholder.invalid/");
    const cursor = url.searchParams.get("cursor");
    return cursor ?? null;
  } catch {
    // Some responses give back just `?cursor=ABC` — handle that too.
    const idx = nextLink.indexOf("cursor=");
    if (idx === -1) return null;
    const rest = nextLink.slice(idx + "cursor=".length);
    const end = rest.search(/[&#]/);
    return end === -1 ? decodeURIComponent(rest) : decodeURIComponent(rest.slice(0, end));
  }
}

export function v2Paginate<TRaw, TOut>(
  body: { results?: TRaw[]; _links?: { next?: string | null } },
  mapItem: (raw: TRaw) => TOut,
): PaginatedOutput<TOut> {
  const values = (body.results ?? []).map(mapItem);
  const nextCursor = v2ExtractNextCursor(body._links?.next ?? null);
  return { values, next_cursor: nextCursor };
}

// ---- v1 (offset/limit / start/limit) ----
// Confluence v1 returns `start`, `limit`, `size`, and `_links.next` for the next page.
// We synthesise an opaque "cursor" string that round-trips the next offset back into the input.

export interface V1Input {
  start: number;
  limit: number;
}

const V1_CURSOR_PREFIX = "v1:";

export function v1InputFromPagination(p: PaginationInputT): V1Input {
  // Cursor takes precedence if it's a recognised v1 cursor.
  if (p.cursor && p.cursor.startsWith(V1_CURSOR_PREFIX)) {
    const offset = Number.parseInt(p.cursor.slice(V1_CURSOR_PREFIX.length), 10);
    if (Number.isFinite(offset) && offset >= 0) {
      return { start: offset, limit: p.pagelen };
    }
  }
  // Fall back to `page` (1-indexed) — page N starts at offset (N-1) * pagelen.
  if (typeof p.page === "number" && p.page >= 1) {
    return { start: (p.page - 1) * p.pagelen, limit: p.pagelen };
  }
  return { start: 0, limit: p.pagelen };
}

export function v1QueryString(input: V1Input, extra: Record<string, string | undefined> = {}): string {
  const params = new URLSearchParams();
  params.set("start", String(input.start));
  params.set("limit", String(input.limit));
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined) params.set(k, v);
  }
  return params.toString();
}

export function v1Paginate<TRaw, TOut>(
  body: { results?: TRaw[]; size?: number; start?: number; limit?: number; _links?: { next?: string | null } },
  mapItem: (raw: TRaw) => TOut,
): PaginatedOutput<TOut> {
  const values = (body.results ?? []).map(mapItem);
  const hasNext = Boolean(body._links?.next);
  let nextCursor: string | null = null;
  if (hasNext) {
    const start = typeof body.start === "number" ? body.start : 0;
    const limit = typeof body.limit === "number" ? body.limit : values.length;
    nextCursor = `${V1_CURSOR_PREFIX}${start + limit}`;
  }
  return {
    values,
    next_cursor: nextCursor,
    ...(typeof body.size === "number" ? { total: body.size } : {}),
  };
}
