// Normalised error shape (§4.11). All Confluence errors and client-side validation errors
// pass through here on their way to the MCP client.

import { redact } from "../shared/logger.js";

export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation"
  | "forbidden_field"
  | "marker_not_found"
  | "marker_ambiguous"
  | "version_conflict"
  | "rate_limited"
  | "server_error"
  | "network_error"
  | "unknown";

export interface NormalisedError {
  ok: false;
  error: {
    status: number;
    code: ErrorCode;
    message: string;
    retryable: boolean;
    retry_after?: number;
    details?: Record<string, unknown>;
  };
}

export interface OkResult<T> {
  ok: true;
  data: T;
}

export type Result<T> = OkResult<T> | NormalisedError;

const AUTH_HINT = ' Run "cw-confluence-mcp auth login" if your token is expired.';

export function ok<T>(data: T): OkResult<T> {
  return { ok: true, data };
}

export function fail(
  status: number,
  code: ErrorCode,
  message: string,
  opts: { retryable?: boolean; retry_after?: number; details?: Record<string, unknown> } = {},
): NormalisedError {
  const safeMessage = redact(message);
  return {
    ok: false,
    error: {
      status,
      code,
      message: safeMessage,
      retryable: opts.retryable ?? false,
      ...(opts.retry_after !== undefined ? { retry_after: opts.retry_after } : {}),
      ...(opts.details ? { details: opts.details } : {}),
    },
  };
}

// Map an HTTP status + Confluence error payload → NormalisedError.
export function mapHttpError(
  status: number,
  bodyText: string,
  retryAfterHeader: string | null,
): NormalisedError {
  const message = extractMessage(bodyText) ?? defaultMessageForStatus(status);

  if (status === 401) {
    return fail(401, "unauthorized", `${message}${AUTH_HINT}`);
  }
  if (status === 403) {
    return fail(403, "forbidden", `${message}${AUTH_HINT}`);
  }
  if (status === 404) {
    return fail(404, "not_found", message);
  }
  if (status === 409) {
    return fail(409, "version_conflict", message);
  }
  if (status === 429) {
    const retryAfter = parseRetryAfter(retryAfterHeader);
    return fail(429, "rate_limited", message, {
      retryable: true,
      ...(retryAfter !== undefined ? { retry_after: retryAfter } : {}),
    });
  }
  if (status >= 500 && status < 600) {
    return fail(status, "server_error", message, { retryable: true });
  }
  return fail(status, "unknown", message);
}

function extractMessage(bodyText: string): string | null {
  if (!bodyText) return null;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      // Confluence v2: { errors: [{ title, detail }, ...] }
      if (Array.isArray(obj.errors) && obj.errors.length > 0) {
        const first = obj.errors[0] as Record<string, unknown>;
        const title = typeof first.title === "string" ? first.title : "";
        const detail = typeof first.detail === "string" ? first.detail : "";
        const combined = [title, detail].filter(Boolean).join(": ");
        if (combined) return combined;
      }
      // Confluence v1: { message: "...", reason: "..." }
      if (typeof obj.message === "string") return obj.message;
      if (typeof obj.reason === "string") return obj.reason;
    }
  } catch {
    // fall through to raw text
  }
  // Truncate long raw bodies.
  return bodyText.length > 500 ? bodyText.slice(0, 500) + "…" : bodyText;
}

function defaultMessageForStatus(status: number): string {
  if (status === 401) return "Unauthorized";
  if (status === 403) return "Forbidden";
  if (status === 404) return "Not found";
  if (status === 409) return "Conflict";
  if (status === 429) return "Rate limited";
  if (status >= 500) return "Server error";
  return `HTTP ${status}`;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const n = Number.parseInt(header, 10);
  if (Number.isFinite(n) && n >= 0) return n;
  // Could also be an HTTP-date; we ignore that case for simplicity.
  return undefined;
}

// Common client-side validation factories.
export const validationError = (message: string, details?: Record<string, unknown>) =>
  fail(0, "validation", message, details ? { details } : {});

export const forbiddenFieldError = (field: string) =>
  fail(0, "forbidden_field", `Field "${field}" is not allowed on this operation.`, {
    details: { field },
  });

export const markerNotFoundError = (textMarker: string) =>
  fail(0, "marker_not_found", `Inline anchor text_marker not found in page body.`, {
    details: { text_marker: textMarker },
  });

export const markerAmbiguousError = (textMarker: string, count: number) =>
  fail(
    0,
    "marker_ambiguous",
    `Inline anchor text_marker matched ${count} substrings. Supply "occurrence" (1-indexed) to disambiguate.`,
    { details: { text_marker: textMarker, count } },
  );

export const networkError = (cause: unknown) =>
  fail(0, "network_error", `Network error: ${describe(cause)}`, { retryable: true });

function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}
