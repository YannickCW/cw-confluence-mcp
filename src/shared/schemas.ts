import { z } from "zod";

// Confluence v2 returns IDs as strings even when numeric — we keep them as strings end-to-end.
export const PageId = z.string().min(1, "page_id must not be empty");
export const CommentId = z.string().min(1, "comment_id must not be empty");
export const SpaceId = z.string().min(1, "space_id must not be empty");
export const AttachmentId = z.string().min(1, "attachment_id must not be empty");
export const VersionId = z.string().min(1, "version_id must not be empty");

// Space keys are short (typically uppercase) — we accept any non-empty string and let Confluence validate.
export const SpaceKey = z
  .string()
  .min(1, "space must not be empty")
  .max(255, "space too long");

// Storage-format XHTML body. We do not validate XHTML structure here — Confluence renders.
export const BodyStorage = z.string().min(0); // empty body is technically valid for Confluence (rare but allowed).

// Pagination input convention (see §4.10).
export const PaginationInput = z.object({
  cursor: z.string().optional(),
  page: z.number().int().min(1).optional(),
  pagelen: z.number().int().min(1).max(100).default(25),
});

export type PaginationInputT = z.infer<typeof PaginationInput>;

// Status values used across the surface.
export const PageStatus = z.enum(["current", "archived", "draft"]);
export const SpaceStatus = z.enum(["current", "archived"]);
export const SpaceType = z.enum(["global", "personal"]);
export const CommentType = z.enum(["footer", "inline", "both"]);

// Normalised label entry.
export const LabelSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  prefix: z.string().optional(),
});

// Inline-comment anchor input (see §4.6).
export const InlineAnchorInput = z.object({
  text_marker: z.string().min(1, "text_marker must not be empty"),
  occurrence: z.number().int().min(1).optional(),
});

// User reference (compact).
export const UserRef = z.object({
  account_id: z.string().optional(),
  display_name: z.string().optional(),
  email: z.string().optional(),
});

// ISO timestamp string.
export const IsoTimestamp = z.string();

// Version metadata.
export const VersionMeta = z.object({
  number: z.number().int(),
  created_at: IsoTimestamp.optional(),
  created_by: UserRef.optional(),
  message: z.string().optional(),
  minor_edit: z.boolean().optional(),
});
