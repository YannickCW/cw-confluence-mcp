// Page version endpoints (§4.4) — read only. No restore (out of scope).
//
// v1 drop (documented inline):
//   - getPageVersion: v2 doesn't expose the body.storage for a specific historical version
//     in a single call; v1 `/content/{id}?version=N&expand=body.storage,...` is used.

import type { ConfluenceClient } from "../client.js";
import { ok, type Result } from "../errors.js";
import {
  v2InputFromPagination,
  v2Paginate,
  v2QueryString,
  type PaginatedOutput,
} from "../pagination.js";
import type { PaginationInputT } from "../../shared/schemas.js";
import { getPage, type PageFull, type UserRefOut, type VersionMetaOut } from "./pages.js";

interface V2VersionRaw {
  number?: number;
  message?: string;
  createdAt?: string;
  authorId?: string;
  minorEdit?: boolean;
}

interface V2VersionListBody {
  results?: V2VersionRaw[];
  _links?: { next?: string | null };
}

function mapVersion(raw: V2VersionRaw): VersionMetaOut {
  const created_by: UserRefOut | undefined = raw.authorId ? { account_id: raw.authorId } : undefined;
  return {
    number: typeof raw.number === "number" ? raw.number : 0,
    ...(raw.message ? { message: raw.message } : {}),
    ...(raw.createdAt ? { created_at: raw.createdAt } : {}),
    ...(created_by ? { created_by } : {}),
    ...(typeof raw.minorEdit === "boolean" ? { minor_edit: raw.minorEdit } : {}),
  };
}

export interface ListPageVersionsArgs {
  page_id: string;
  pagination: PaginationInputT;
}

export async function listPageVersions(
  client: ConfluenceClient,
  args: ListPageVersionsArgs,
): Promise<Result<PaginatedOutput<VersionMetaOut>>> {
  // v2: GET /pages/{id}/versions
  const v2 = v2InputFromPagination(args.pagination);
  const qs = v2QueryString(v2);
  const res = await client.v2<V2VersionListBody>(
    `/pages/${encodeURIComponent(args.page_id)}/versions?${qs}`,
  );
  if (!res.ok) return res;
  return ok(v2Paginate(res.data, mapVersion));
}

export interface GetPageVersionArgs {
  page_id: string;
  version: number;
}

export async function getPageVersion(
  client: ConfluenceClient,
  args: GetPageVersionArgs,
): Promise<Result<PageFull>> {
  // Delegates to getPage with `version` — v1 drop already documented there.
  return getPage(client, { page_id: args.page_id, version: args.version });
}
