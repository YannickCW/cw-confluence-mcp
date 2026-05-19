// Attachment endpoint wrappers (read-only metadata — §4.8).
//
// Confluence v2 is used throughout:
//   - GET /pages/{id}/attachments — list attachments on a page.
//   - GET /attachments/{id}      — fetch a single attachment's metadata.
//
// The MCP exposes a `download_url` field but never proxies the binary
// payload — agents fetch via the URL themselves (§1, §4.8).

import type { ConfluenceClient } from "../client.js";
import { ok, validationError, type Result } from "../errors.js";
import {
  v2InputFromPagination,
  v2Paginate,
  v2QueryString,
  type PaginatedOutput,
} from "../pagination.js";
import type { PaginationInputT } from "../../shared/schemas.js";

// ---------- output shape (shared by list + get) ----------

export interface AttachmentItem {
  id: string;
  filename: string;
  mime: string;
  size: number;
  version: number;
  download_url: string;
}

// ---------- raw Confluence v2 shapes (subset) ----------

interface RawV2Attachment {
  id?: string | number;
  title?: string;
  fileId?: string;
  mediaType?: string;
  mediaTypeDescription?: string;
  fileSize?: number;
  version?: { number?: number };
  downloadLink?: string;
  webuiLink?: string;
  _links?: {
    download?: string;
    webui?: string;
    next?: string | null;
  };
}

interface RawV2AttachmentListBody {
  results?: RawV2Attachment[];
  _links?: { next?: string | null };
}

// ---------- public API ----------

export interface ListAttachmentsArgs {
  pageId: string;
  /** Mime prefix filter (e.g. "image/"). Applied post-fetch — Confluence v2 doesn't filter on mime. */
  mediaType?: string;
  pagination: PaginationInputT;
}

export async function listAttachments(
  client: ConfluenceClient,
  args: ListAttachmentsArgs,
  site: string,
): Promise<Result<PaginatedOutput<AttachmentItem>>> {
  if (!args.pageId) {
    return validationError("page_id is required");
  }
  const v2In = v2InputFromPagination(args.pagination);
  const qs = v2QueryString(v2In);

  const res = await client.v2<RawV2AttachmentListBody>(
    `/pages/${encodeURIComponent(args.pageId)}/attachments?${qs}`,
  );
  if (!res.ok) return res;

  const paged = v2Paginate<RawV2Attachment, AttachmentItem>(res.data, (raw) =>
    toAttachmentItem(raw, site),
  );

  const prefix = args.mediaType?.trim();
  if (prefix) {
    paged.values = paged.values.filter((a) => a.mime.startsWith(prefix));
  }
  return ok(paged);
}

export interface GetAttachmentArgs {
  attachmentId: string;
}

export async function getAttachment(
  client: ConfluenceClient,
  args: GetAttachmentArgs,
  site: string,
): Promise<Result<AttachmentItem>> {
  if (!args.attachmentId) {
    return validationError("attachment_id is required");
  }
  const res = await client.v2<RawV2Attachment>(
    `/attachments/${encodeURIComponent(args.attachmentId)}`,
  );
  if (!res.ok) return res;
  return ok(toAttachmentItem(res.data, site));
}

// ---------- mapping ----------

function toAttachmentItem(raw: RawV2Attachment, site: string): AttachmentItem {
  const id = raw.id !== undefined ? String(raw.id) : "";
  const filename = typeof raw.title === "string" ? raw.title : "";
  const mime = typeof raw.mediaType === "string" ? raw.mediaType : "";
  const size = typeof raw.fileSize === "number" ? raw.fileSize : 0;
  const version =
    raw.version && typeof raw.version.number === "number" ? raw.version.number : 0;

  const rawLink =
    (typeof raw.downloadLink === "string" ? raw.downloadLink : undefined) ??
    raw._links?.download ??
    "";
  const downloadUrl = normaliseDownloadUrl(rawLink, site);

  return { id, filename, mime, size, version, download_url: downloadUrl };
}

/**
 * If Confluence returns a relative download link (e.g.
 * "/wiki/download/attachments/.../foo.png?version=1"), prepend "https://<site>"
 * so the agent can fetch directly. Absolute URLs pass through unchanged.
 */
export function normaliseDownloadUrl(link: string, site: string): string {
  if (!link) return "";
  if (/^https?:\/\//i.test(link)) return link;
  if (link.startsWith("//")) return `https:${link}`;
  const cleanSite = site.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const path = link.startsWith("/") ? link : `/${link}`;
  return `https://${cleanSite}${path}`;
}
