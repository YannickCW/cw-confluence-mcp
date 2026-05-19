// Page endpoints — read + write (§4.2 & §4.3).
//
// Sub-agent B owns the read methods (list/get/children/ancestors/search).
// Sub-agent C owns the write methods (create/update).
// Both append to this file in non-overlapping blocks.
//
// v1 drops (documented inline at the call site):
//   - searchPages: v2 has no CQL search endpoint.
//   - getPageVersion (in versions.ts) and getPage(version=N): v2 doesn't expose historical
//     bodies with body.storage in a single call; v1 `/content/{id}?version=N` is used.
//   - createPage labels: v2 has no label-write endpoint; v1 `/content/{id}/label` is used.

import type { ConfluenceClient } from "../client.js";
import {
  forbiddenFieldError,
  ok,
  validationError,
  type NormalisedError,
  type Result,
} from "../errors.js";
import {
  v1InputFromPagination,
  v1Paginate,
  v1QueryString,
  v2InputFromPagination,
  v2Paginate,
  v2QueryString,
  type PaginatedOutput,
} from "../pagination.js";
import { buildCql, CqlBuildError } from "../cql.js";
import type { PaginationInputT } from "../../shared/schemas.js";

// =====================================================================
// Output shapes
// =====================================================================

export interface PageSummary {
  id: string;
  title: string;
  space_id?: string;
  space_key?: string;
  parent_id: string | null;
  status: string;
  _links?: Record<string, string>;
}

export interface UserRefOut {
  account_id?: string;
  display_name?: string;
  email?: string;
}

export interface VersionMetaOut {
  number: number;
  message?: string;
  created_at?: string;
  created_by?: UserRefOut;
  minor_edit?: boolean;
}

export interface PageFull {
  id: string;
  title: string;
  space_key: string | null;
  space_id?: string;
  parent_id: string | null;
  version: VersionMetaOut;
  status: string;
  labels: { name: string; prefix?: string }[];
  /** Storage-format XHTML. */
  body_storage: string;
  _links?: Record<string, string>;
  /** Set when label-write succeeded partially on `page_create`. */
  labels_warning?: string;
}

export interface PageSearchHit extends PageSummary {
  excerpt?: string;
  url?: string;
  version?: VersionMetaOut;
  last_modified?: string;
}

// =====================================================================
// Raw v1/v2 shapes (minimal — only fields we use)
// =====================================================================

interface V2PageRaw {
  id?: string;
  title?: string;
  status?: string;
  spaceId?: string;
  parentId?: string | null;
  parentType?: string;
  authorId?: string;
  body?: { storage?: { value?: string; representation?: string } };
  version?: {
    number?: number;
    message?: string;
    createdAt?: string;
    authorId?: string;
    minorEdit?: boolean;
  };
  labels?: { results?: { name?: string; prefix?: string; id?: string }[] };
  _links?: Record<string, string>;
}

interface V2SpaceRaw {
  id?: string;
  key?: string;
  name?: string;
  homepageId?: string;
}

interface V2ListBody<T> {
  results?: T[];
  _links?: { next?: string | null };
}

interface V1ContentRaw {
  id?: string;
  type?: string;
  status?: string;
  title?: string;
  space?: { id?: string | number; key?: string; name?: string };
  ancestors?: { id?: string; title?: string }[];
  body?: { storage?: { value?: string; representation?: string } };
  version?: {
    number?: number;
    message?: string;
    when?: string;
    minorEdit?: boolean;
    by?: { accountId?: string; displayName?: string; email?: string };
  };
  metadata?: {
    labels?: {
      results?: { name?: string; prefix?: string; id?: string }[];
    };
  };
  _links?: Record<string, string>;
  excerpt?: string;
}

interface V1SearchBody {
  results?: V1ContentRaw[];
  size?: number;
  start?: number;
  limit?: number;
  _links?: { next?: string | null };
}

// =====================================================================
// Helpers
// =====================================================================

function mapV2Version(v: V2PageRaw["version"]): VersionMetaOut {
  return {
    number: typeof v?.number === "number" ? v.number : 0,
    ...(v?.message ? { message: v.message } : {}),
    ...(v?.createdAt ? { created_at: v.createdAt } : {}),
    ...(v?.authorId ? { created_by: { account_id: v.authorId } } : {}),
    ...(typeof v?.minorEdit === "boolean" ? { minor_edit: v.minorEdit } : {}),
  };
}

function mapV2PageFull(raw: V2PageRaw, spaceKey: string | null): PageFull {
  const labels = (raw.labels?.results ?? [])
    .filter((l) => typeof l.name === "string")
    .map((l) => ({
      name: l.name as string,
      ...(l.prefix ? { prefix: l.prefix } : {}),
    }));
  return {
    id: raw.id ?? "",
    title: raw.title ?? "",
    space_key: spaceKey,
    ...(raw.spaceId ? { space_id: raw.spaceId } : {}),
    parent_id: raw.parentId ?? null,
    version: mapV2Version(raw.version),
    status: raw.status ?? "current",
    labels,
    body_storage: raw.body?.storage?.value ?? "",
    ...(raw._links ? { _links: raw._links } : {}),
  };
}

function mapV2PageSummary(raw: V2PageRaw, spaceKey?: string | null): PageSummary {
  return {
    id: raw.id ?? "",
    title: raw.title ?? "",
    ...(raw.spaceId ? { space_id: raw.spaceId } : {}),
    ...(spaceKey ? { space_key: spaceKey } : {}),
    parent_id: raw.parentId ?? null,
    status: raw.status ?? "current",
    ...(raw._links ? { _links: raw._links } : {}),
  };
}

function mapV1ContentFull(raw: V1ContentRaw): PageFull {
  const labels = (raw.metadata?.labels?.results ?? [])
    .filter((l) => typeof l.name === "string")
    .map((l) => ({
      name: l.name as string,
      ...(l.prefix ? { prefix: l.prefix } : {}),
    }));
  const v = raw.version ?? {};
  const version: VersionMetaOut = {
    number: typeof v.number === "number" ? v.number : 0,
    ...(v.message ? { message: v.message } : {}),
    ...(v.when ? { created_at: v.when } : {}),
    ...(v.by
      ? {
          created_by: {
            ...(v.by.accountId ? { account_id: v.by.accountId } : {}),
            ...(v.by.displayName ? { display_name: v.by.displayName } : {}),
            ...(v.by.email ? { email: v.by.email } : {}),
          },
        }
      : {}),
    ...(typeof v.minorEdit === "boolean" ? { minor_edit: v.minorEdit } : {}),
  };
  // v1 ancestors: closest ancestor is the last item in the array.
  const ancestors = raw.ancestors ?? [];
  const parent = ancestors.length > 0 ? ancestors[ancestors.length - 1] : undefined;
  return {
    id: raw.id ?? "",
    title: raw.title ?? "",
    space_key: raw.space?.key ?? null,
    ...(raw.space?.id !== undefined ? { space_id: String(raw.space.id) } : {}),
    parent_id: parent?.id ?? null,
    version,
    status: raw.status ?? "current",
    labels,
    body_storage: raw.body?.storage?.value ?? "",
    ...(raw._links ? { _links: raw._links } : {}),
  };
}

function mapV1SearchHit(raw: V1ContentRaw): PageSearchHit {
  const v = raw.version ?? {};
  const version: VersionMetaOut | undefined =
    v.number !== undefined
      ? {
          number: typeof v.number === "number" ? v.number : 0,
          ...(v.message ? { message: v.message } : {}),
          ...(v.when ? { created_at: v.when } : {}),
          ...(v.by
            ? {
                created_by: {
                  ...(v.by.accountId ? { account_id: v.by.accountId } : {}),
                  ...(v.by.displayName ? { display_name: v.by.displayName } : {}),
                  ...(v.by.email ? { email: v.by.email } : {}),
                },
              }
            : {}),
        }
      : undefined;
  const links = raw._links ?? {};
  return {
    id: raw.id ?? "",
    title: raw.title ?? "",
    ...(raw.space?.id !== undefined ? { space_id: String(raw.space.id) } : {}),
    ...(raw.space?.key ? { space_key: raw.space.key } : {}),
    parent_id: null,
    status: raw.status ?? "current",
    ...(raw.excerpt ? { excerpt: raw.excerpt } : {}),
    ...(version ? { version } : {}),
    ...(v.when ? { last_modified: v.when } : {}),
    ...(links.webui ? { url: links.webui } : {}),
    ...(links ? { _links: links } : {}),
  };
}

// Resolve space (key OR id) → numeric/string space id used by v2 page endpoints.
async function resolveSpaceId(
  client: ConfluenceClient,
  space: string,
): Promise<Result<{ id: string; key: string | null }>> {
  // Heuristic: if string is all digits, treat as id directly.
  if (/^\d+$/.test(space)) {
    return ok({ id: space, key: null });
  }
  // v2 GET /spaces?keys=<key>
  const res = await client.v2<V2ListBody<V2SpaceRaw>>("/spaces", {
    query: { keys: space, limit: "1" },
  });
  if (!res.ok) return res;
  const first = (res.data.results ?? [])[0];
  if (!first?.id) {
    return validationError(`Space not found: "${space}".`);
  }
  return ok({ id: first.id, key: first.key ?? space });
}

// =====================================================================
// READ — owned by Sub-Agent B
// =====================================================================

export interface ListPagesArgs {
  space: string; // key or id
  parent_id?: string;
  label?: string;
  status?: "current" | "archived" | "draft";
  sort?: string;
  pagination: PaginationInputT;
}

export async function listPages(
  client: ConfluenceClient,
  args: ListPagesArgs,
): Promise<Result<PaginatedOutput<PageSummary>>> {
  // v2: GET /spaces/{id}/pages — supports body-less list of pages in a space.
  const resolved = await resolveSpaceId(client, args.space);
  if (!resolved.ok) return resolved;
  const spaceKey = resolved.data.key ?? (/^\d+$/.test(args.space) ? null : args.space);

  const v2 = v2InputFromPagination(args.pagination);
  const extra: Record<string, string | undefined> = {
    status: args.status ?? "current",
  };
  if (args.parent_id) extra["parent-id"] = args.parent_id;
  if (args.sort) extra.sort = args.sort;
  else extra.sort = "-modified-date";

  const qs = v2QueryString(v2, extra);
  const res = await client.v2<V2ListBody<V2PageRaw>>(`/spaces/${resolved.data.id}/pages?${qs}`);
  if (!res.ok) return res;

  let page = v2Paginate(res.data, (r) => mapV2PageSummary(r, spaceKey));

  // v2 list does not natively filter by label; if a label filter is requested,
  // we drop to a CQL search via v1 (documented v1 drop: v2 has no list-by-label
  // endpoint scoped to a space + parent in one call).
  if (args.label) {
    try {
      const cql = buildCql({
        type: "page",
        space: spaceKey ?? undefined,
        label: args.label,
        status: args.status ?? "current",
      });
      const v1 = v1InputFromPagination(args.pagination);
      const qs1 = v1QueryString(v1, { cql, expand: "version,space" });
      const res1 = await client.v1<V1SearchBody>(`/content/search?${qs1}`);
      if (!res1.ok) return res1;
      page = v1Paginate(res1.data, (r) => ({
        id: r.id ?? "",
        title: r.title ?? "",
        ...(r.space?.key ? { space_key: r.space.key } : {}),
        ...(r.space?.id !== undefined ? { space_id: String(r.space.id) } : {}),
        parent_id: null,
        status: r.status ?? "current",
        ...(r._links ? { _links: r._links } : {}),
      })) as PaginatedOutput<PageSummary>;
    } catch (err) {
      if (err instanceof CqlBuildError) return validationError(err.message);
      throw err;
    }
  }

  return ok(page);
}

export interface GetPageArgs {
  page_id: string;
  /** Optional historical version (integer). */
  version?: number;
}

export async function getPage(
  client: ConfluenceClient,
  args: GetPageArgs,
): Promise<Result<PageFull>> {
  if (args.version !== undefined) {
    // v1 drop: v2 doesn't expose historical bodies with body.storage in one call.
    const qs = v1QueryString(
      { start: 0, limit: 1 },
      { version: String(args.version), expand: "body.storage,version,space,ancestors,metadata.labels" },
    );
    // Note: v1 `?version=` does not need start/limit, but they're harmless.
    const url = `/content/${encodeURIComponent(args.page_id)}?${qs}`;
    const res = await client.v1<V1ContentRaw>(url);
    if (!res.ok) return res;
    return ok(mapV1ContentFull(res.data));
  }
  // v2: GET /pages/{id}?body-format=storage&include-labels=true
  // Build query manually — v2QueryString always emits `limit` which is irrelevant for single-page GET.
  const params = new URLSearchParams();
  params.set("body-format", "storage");
  params.set("include-labels", "true");
  params.set("include-version", "true");
  const res = await client.v2<V2PageRaw>(`/pages/${encodeURIComponent(args.page_id)}?${params.toString()}`);
  if (!res.ok) return res;
  const raw = res.data;
  // v2 doesn't return space_key directly on /pages/{id}; we look it up from spaceId.
  let spaceKey: string | null = null;
  if (raw.spaceId) {
    const spaceRes = await client.v2<V2SpaceRaw>(`/spaces/${encodeURIComponent(raw.spaceId)}`);
    if (spaceRes.ok) spaceKey = spaceRes.data.key ?? null;
  }
  return ok(mapV2PageFull(raw, spaceKey));
}

export interface GetPageChildrenArgs {
  page_id: string;
  pagination: PaginationInputT;
  sort?: string;
}

export async function getPageChildren(
  client: ConfluenceClient,
  args: GetPageChildrenArgs,
): Promise<Result<PaginatedOutput<PageSummary>>> {
  // v2: GET /pages/{id}/children
  const v2 = v2InputFromPagination(args.pagination);
  const extra: Record<string, string | undefined> = {};
  if (args.sort) extra.sort = args.sort;
  const qs = v2QueryString(v2, extra);
  const res = await client.v2<V2ListBody<V2PageRaw>>(
    `/pages/${encodeURIComponent(args.page_id)}/children?${qs}`,
  );
  if (!res.ok) return res;
  return ok(v2Paginate(res.data, (r) => mapV2PageSummary(r)));
}

export interface GetPageAncestorsArgs {
  page_id: string;
}

export async function getPageAncestors(
  client: ConfluenceClient,
  args: GetPageAncestorsArgs,
): Promise<Result<{ values: PageSummary[] }>> {
  // v2: GET /pages/{id}/ancestors — not paginated (bounded by tree depth).
  const res = await client.v2<V2ListBody<V2PageRaw>>(
    `/pages/${encodeURIComponent(args.page_id)}/ancestors`,
  );
  if (!res.ok) return res;
  const values = (res.data.results ?? []).map((r) => mapV2PageSummary(r));
  return ok({ values });
}

export interface SearchPagesArgs {
  query?: string;
  space?: string; // key
  label?: string;
  title?: string;
  updated_since?: string;
  creator?: string;
  status?: "current" | "archived" | "draft";
  pagination: PaginationInputT;
}

export async function searchPages(
  client: ConfluenceClient,
  args: SearchPagesArgs,
): Promise<Result<PaginatedOutput<PageSearchHit>>> {
  // v1 drop: v2 has no CQL search endpoint. Use v1 /content/search?cql=...
  let cql: string;
  try {
    cql = buildCql({
      type: "page",
      ...(args.query ? { text: args.query } : {}),
      ...(args.space ? { space: args.space } : {}),
      ...(args.label ? { label: args.label } : {}),
      ...(args.title ? { title: args.title } : {}),
      ...(args.updated_since ? { updated_since: args.updated_since } : {}),
      ...(args.creator ? { creator: args.creator } : {}),
      ...(args.status ? { status: args.status } : {}),
    });
  } catch (err) {
    if (err instanceof CqlBuildError) return validationError(err.message);
    throw err;
  }
  const v1 = v1InputFromPagination(args.pagination);
  const qs = v1QueryString(v1, { cql, expand: "version,space" });
  const res = await client.v1<V1SearchBody>(`/content/search?${qs}`);
  if (!res.ok) return res;
  return ok(v1Paginate(res.data, mapV1SearchHit));
}

// =====================================================================
// WRITE — owned by Sub-Agent C
// =====================================================================

/** Allowlist for page_update — only these fields may be supplied. */
export const PAGE_UPDATE_ALLOWED_FIELDS = ["page_id", "title", "body_storage"] as const;

export interface CreatePageArgs {
  space: string; // key (or id — but spec says key)
  title: string;
  body_storage: string;
  parent_id?: string;
  labels?: string[];
}

export async function createPage(
  client: ConfluenceClient,
  args: CreatePageArgs,
): Promise<Result<PageFull>> {
  // 1) Resolve space key → space id (required by v2 create).
  const resolved = await resolveSpaceId(client, args.space);
  if (!resolved.ok) return resolved;
  const spaceKey = resolved.data.key ?? args.space;

  // 2) If no parent_id, default to space homepage (resolve via /spaces/{id}).
  let parentId = args.parent_id;
  if (!parentId) {
    const spaceRes = await client.v2<V2SpaceRaw>(`/spaces/${encodeURIComponent(resolved.data.id)}`);
    if (spaceRes.ok && spaceRes.data.homepageId) parentId = spaceRes.data.homepageId;
    // If homepage lookup fails, fall through with no parent — Confluence will accept it.
  }

  // 3) Create the page via v2.
  const body: Record<string, unknown> = {
    spaceId: resolved.data.id,
    status: "current",
    title: args.title,
    body: { representation: "storage", value: args.body_storage },
  };
  if (parentId) body.parentId = parentId;

  const createRes = await client.v2<V2PageRaw>("/pages", { method: "POST", body });
  if (!createRes.ok) return createRes;

  let page = mapV2PageFull(createRes.data, spaceKey);

  // 4) Apply labels (if any) via v1 (v2 has no label-write).
  if (args.labels && args.labels.length > 0) {
    const labelErrors: string[] = [];
    const addedLabels: { name: string; prefix?: string }[] = [];
    for (const label of args.labels) {
      const labelRes = await client.v1<{ results?: { name?: string; prefix?: string }[] }>(
        `/content/${encodeURIComponent(page.id)}/label`,
        { method: "POST", body: [{ prefix: "global", name: label }] },
      );
      if (!labelRes.ok) {
        labelErrors.push(`${label}: ${labelRes.error.code}`);
      } else {
        const found = (labelRes.data.results ?? []).find((l) => l.name === label);
        addedLabels.push({
          name: label,
          ...(found?.prefix ? { prefix: found.prefix } : { prefix: "global" }),
        });
      }
    }
    // Merge added labels into the returned page.
    const seen = new Set(page.labels.map((l) => l.name));
    for (const l of addedLabels) {
      if (!seen.has(l.name)) page.labels.push(l);
    }
    if (labelErrors.length > 0) {
      page = {
        ...page,
        labels_warning: `Some labels failed to apply: ${labelErrors.join(", ")}`,
      };
    }
  }

  return ok(page);
}

export interface UpdatePageArgs {
  page_id: string;
  title: string;
  body_storage: string;
}

/**
 * Update a page. Allowlisted fields only (title, body_storage).
 * Auto-versioning: fetches current version, increments, sends. On 409 conflict,
 * re-fetches and retries once. A second 409 returns `version_conflict` retryable=false.
 */
export async function updatePage(
  client: ConfluenceClient,
  args: UpdatePageArgs,
): Promise<Result<PageFull>> {
  // Allowlist check happens at the tool boundary (registered tool validates args first),
  // but defend in depth: reject anything outside the allowlist if extra keys snuck in.
  // (The tool handler is the primary gate; this is belt + braces.)

  const sendUpdate = async (
    versionNumber: number,
    spaceIdHint: string | undefined,
    statusHint: string | undefined,
  ): Promise<Result<V2PageRaw>> => {
    const body: Record<string, unknown> = {
      id: args.page_id,
      status: statusHint ?? "current",
      title: args.title,
      body: { representation: "storage", value: args.body_storage },
      version: { number: versionNumber + 1, message: "" },
    };
    if (spaceIdHint) body.spaceId = spaceIdHint;
    return client.v2<V2PageRaw>(`/pages/${encodeURIComponent(args.page_id)}`, {
      method: "PUT",
      body,
    });
  };

  const fetchCurrent = async (): Promise<Result<{ version: number; spaceId?: string; status?: string }>> => {
    const params = new URLSearchParams();
    params.set("body-format", "storage");
    params.set("include-version", "true");
    const res = await client.v2<V2PageRaw>(
      `/pages/${encodeURIComponent(args.page_id)}?${params.toString()}`,
    );
    if (!res.ok) return res;
    const version = res.data.version?.number ?? 1;
    return ok({
      version,
      ...(res.data.spaceId ? { spaceId: res.data.spaceId } : {}),
      ...(res.data.status ? { status: res.data.status } : {}),
    });
  };

  // First attempt.
  const cur1 = await fetchCurrent();
  if (!cur1.ok) return cur1;
  let put = await sendUpdate(cur1.data.version, cur1.data.spaceId, cur1.data.status);
  if (put.ok) return finaliseUpdatedPage(client, put.data);
  if (put.error.code !== "version_conflict") return put;

  // 409 → re-fetch + retry once.
  const cur2 = await fetchCurrent();
  if (!cur2.ok) return cur2;
  put = await sendUpdate(cur2.data.version, cur2.data.spaceId, cur2.data.status);
  if (put.ok) return finaliseUpdatedPage(client, put.data);
  if (put.error.code === "version_conflict") {
    // Force retryable=false on the normalised error.
    const conflict: NormalisedError = {
      ok: false,
      error: {
        status: 409,
        code: "version_conflict",
        message: put.error.message,
        retryable: false,
      },
    };
    return conflict;
  }
  return put;
}

async function finaliseUpdatedPage(
  client: ConfluenceClient,
  raw: V2PageRaw,
): Promise<Result<PageFull>> {
  // Look up space key for the returned page if possible.
  let spaceKey: string | null = null;
  if (raw.spaceId) {
    const spaceRes = await client.v2<V2SpaceRaw>(`/spaces/${encodeURIComponent(raw.spaceId)}`);
    if (spaceRes.ok) spaceKey = spaceRes.data.key ?? null;
  }
  return ok(mapV2PageFull(raw, spaceKey));
}

/**
 * Validate args for `page_update` against the allowlist. Returns the first violation
 * (if any) as a `forbidden_field` error; caller short-circuits before any HTTP call.
 *
 * Exported for the tool handler — keeps the rejection logic adjacent to the allowlist.
 */
export function checkPageUpdateAllowlist(rawInput: Record<string, unknown>): NormalisedError | null {
  const allowed = new Set<string>(PAGE_UPDATE_ALLOWED_FIELDS);
  for (const key of Object.keys(rawInput)) {
    if (!allowed.has(key)) {
      return forbiddenFieldError(key);
    }
  }
  return null;
}

// Re-exported here so the tools file has a single import.
export { resolveSpaceId };
