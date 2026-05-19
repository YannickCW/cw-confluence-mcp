// Space endpoint wrappers (read-only per §1).
// Three operations: list, get (by id or key), and CQL-driven search.
//
// API routing:
// - `list`  → v2 `GET /spaces` (cursor pagination, filter by type/status).
// - `get`   → v2 `GET /spaces/{id}` when id supplied;
//             else v2 `GET /spaces?keys=<key>&body-format=storage` and pick the first match.
// - `search`→ v1 `GET /content/search?cql=...` because v2 does not currently expose a
//             CQL search endpoint. Documented as a deliberate v1 drop.

import type { ConfluenceClient } from "../client.js";
import { fail, ok, type NormalisedError, type Result } from "../errors.js";
import { buildCql, CqlBuildError } from "../cql.js";
import {
  v1InputFromPagination,
  v1Paginate,
  v1QueryString,
  v2InputFromPagination,
  v2Paginate,
  v2QueryString,
  type PaginatedOutput,
} from "../pagination.js";
import type { PaginationInputT } from "../../shared/schemas.js";

// -- Raw response shapes ---------------------------------------------------

// v2 /spaces and /spaces/{id} item shape (only fields we care about).
interface V2SpaceRaw {
  id: string;
  key: string;
  name: string;
  type?: string;
  status?: string;
  homepageId?: string | null;
  description?: {
    storage?: { value?: string; representation?: string } | null;
    view?: { value?: string; representation?: string } | null;
  } | null;
}

interface V2SpacesListBody {
  results?: V2SpaceRaw[];
  _links?: { next?: string | null };
}

// v1 /content/search returns content rows, including space-type rows.
// We pick id/title/space-key/excerpt for space hits.
interface V1ContentSearchHit {
  id: string;
  type?: string;
  title?: string;
  excerpt?: string;
  space?: { key?: string; name?: string; id?: string | number };
  // Confluence v1 sometimes attaches an excerpt at the top level via `searchResults`,
  // but `/content/search` rows put a plain `excerpt` field when available.
}

interface V1ContentSearchBody {
  results?: V1ContentSearchHit[];
  start?: number;
  limit?: number;
  size?: number;
  _links?: { next?: string | null };
}

// -- Public output shapes --------------------------------------------------

export interface SpaceSummary {
  id: string;
  key: string;
  name: string;
  type: string | null;
  status: string | null;
  homepage_id: string | null;
}

export interface SpaceDetail extends SpaceSummary {
  description_storage: string | null;
}

export interface SpaceSearchHit {
  id: string;
  key: string | null;
  name: string;
  type: string;
  excerpt: string | null;
}

// -- Mapping ---------------------------------------------------------------

function mapSpaceSummary(raw: V2SpaceRaw): SpaceSummary {
  return {
    id: String(raw.id),
    key: raw.key,
    name: raw.name,
    type: raw.type ?? null,
    status: raw.status ?? null,
    homepage_id: raw.homepageId != null ? String(raw.homepageId) : null,
  };
}

function mapSpaceDetail(raw: V2SpaceRaw): SpaceDetail {
  return {
    ...mapSpaceSummary(raw),
    description_storage: raw.description?.storage?.value ?? null,
  };
}

// -- listSpaces ------------------------------------------------------------

export interface ListSpacesArgs {
  type?: "global" | "personal";
  status?: "current" | "archived";
  pagination: PaginationInputT;
}

export async function listSpaces(
  client: ConfluenceClient,
  args: ListSpacesArgs,
): Promise<Result<PaginatedOutput<SpaceSummary>>> {
  const v2input = v2InputFromPagination(args.pagination);
  const qs = v2QueryString(v2input, {
    type: args.type,
    status: args.status ?? "current",
  });
  const res = await client.v2<V2SpacesListBody>(`/spaces?${qs}`);
  if (!res.ok) return res;
  return ok(v2Paginate(res.data, mapSpaceSummary));
}

// -- getSpace --------------------------------------------------------------

export interface GetSpaceArgs {
  id?: string;
  key?: string;
}

export async function getSpace(
  client: ConfluenceClient,
  args: GetSpaceArgs,
): Promise<Result<SpaceDetail>> {
  if (args.id) {
    const qs = new URLSearchParams({ "description-format": "storage" }).toString();
    const res = await client.v2<V2SpaceRaw>(`/spaces/${encodeURIComponent(args.id)}?${qs}`);
    if (!res.ok) return res;
    return ok(mapSpaceDetail(res.data));
  }

  if (args.key) {
    // v2 /spaces supports the `keys` filter (comma-separated) — we pick the first match.
    const qs = new URLSearchParams({
      keys: args.key,
      "description-format": "storage",
      limit: "1",
    }).toString();
    const res = await client.v2<V2SpacesListBody>(`/spaces?${qs}`);
    if (!res.ok) return res;
    const first = res.data.results?.[0];
    if (!first) {
      return fail(404, "not_found", `Space with key "${args.key}" not found.`);
    }
    return ok(mapSpaceDetail(first));
  }

  // Should be caught by the tool-level zod refinement before we get here.
  return fail(0, "validation", "getSpace requires exactly one of `id` or `key`.");
}

// -- searchSpaces ----------------------------------------------------------

export interface SearchSpacesArgs {
  query: string;
  type?: "global" | "personal";
  pagination: PaginationInputT;
}

export async function searchSpaces(
  client: ConfluenceClient,
  args: SearchSpacesArgs,
): Promise<Result<PaginatedOutput<SpaceSearchHit>>> {
  // CQL: type = "space" AND text ~ "<query>". The CQL field `space.type` is not
  // universally honoured for space-type CQL searches, so when `type` is supplied
  // we filter results post-hoc rather than baking it into the CQL.
  let cql: string;
  try {
    cql = buildCql({ type: "space", text: args.query });
  } catch (err) {
    if (err instanceof CqlBuildError) {
      return fail(0, "validation", err.message);
    }
    throw err;
  }

  const v1input = v1InputFromPagination(args.pagination);
  const qs = v1QueryString(v1input, { cql });
  // v2 has no CQL search; we drop to v1 here. Reviewed against §4.1.
  const res = await client.v1<V1ContentSearchBody>(`/content/search?${qs}`);
  if (!res.ok) return res;

  const page = v1Paginate(res.data, mapSearchHit);

  if (args.type) {
    page.values = page.values.filter((v) => v.type === args.type);
  }

  return ok(page);
}

function mapSearchHit(raw: V1ContentSearchHit): SpaceSearchHit {
  // `/content/search` rows for space hits typically carry the space key + name via
  // the embedded `space` object, while `title` mirrors the space name.
  const key = raw.space?.key ?? null;
  const name = raw.title ?? raw.space?.name ?? "";
  // `type` on the raw row from /content/search is the content type — for space
  // results we report the discovered Confluence space "type" if exposed, else
  // fall back to the row type so callers can still discriminate.
  const type = raw.type ?? "space";
  return {
    id: String(raw.id),
    key,
    name,
    type,
    excerpt: raw.excerpt ?? null,
  };
}

// -- Internal helper: re-export error type for tool-layer narrowing --------

export type SpaceEndpointError = NormalisedError;
