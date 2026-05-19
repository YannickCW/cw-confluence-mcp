// HTTP client for Confluence Cloud. Wraps `fetch` with Basic auth, JSON parsing,
// redactor wiring, retry on 429/5xx, and error mapping to §4.11.
// Exposes `v1()` and `v2()` for endpoint files; the router itself is dumb.

import type { CredentialsBlob } from "../auth/keychain.js";
import { logger, redact, registerSecret } from "../shared/logger.js";
import { mapHttpError, networkError, type Result } from "./errors.js";

export interface ClientOptions {
  creds: CredentialsBlob;
  /** Optional override for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Max retries on 429/5xx (default 3). */
  maxRetries?: number;
  /** Base for exponential backoff in ms (default 250). Set to 0 in tests to disable sleeping. */
  backoffBaseMs?: number;
}

export interface RequestInit2 {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  query?: Record<string, string | undefined> | string;
  body?: unknown;
  headers?: Record<string, string>;
}

export class ConfluenceClient {
  private readonly creds: CredentialsBlob;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly authHeader: string;

  constructor(opts: ClientOptions) {
    this.creds = opts.creds;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.backoffBaseMs = opts.backoffBaseMs ?? 250;
    this.authHeader = "Basic " + Buffer.from(`${this.creds.email}:${this.creds.token}`).toString("base64");
    registerSecret(this.creds.token);
    registerSecret(this.authHeader);
  }

  /** The Confluence site hostname (e.g. `cloudwise.atlassian.net`). Used by callers
   * that need to fully-qualify relative URLs Confluence returns in `_links`. */
  get site(): string {
    return this.creds.site;
  }

  async v2<T>(path: string, init: RequestInit2 = {}): Promise<Result<T>> {
    return this.request<T>(`https://${this.creds.site}/wiki/api/v2${ensureLeadingSlash(path)}`, init);
  }

  async v1<T>(path: string, init: RequestInit2 = {}): Promise<Result<T>> {
    return this.request<T>(`https://${this.creds.site}/wiki/rest/api${ensureLeadingSlash(path)}`, init);
  }

  // Raw absolute URL — only for cases where Confluence returns a full URL we must follow.
  async absolute<T>(absoluteUrl: string, init: RequestInit2 = {}): Promise<Result<T>> {
    return this.request<T>(absoluteUrl, init);
  }

  private async request<T>(url: string, init: RequestInit2): Promise<Result<T>> {
    const finalUrl = appendQuery(url, init.query);
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: "application/json",
      ...(init.headers ?? {}),
    };
    let body: string | URLSearchParams | undefined;
    if (init.body !== undefined) {
      if (init.body instanceof URLSearchParams || typeof init.body === "string") {
        body = init.body;
      } else {
        body = JSON.stringify(init.body);
        if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
      }
    }

    let attempt = 0;
    for (;;) {
      let response: Response;
      try {
        response = await this.fetchImpl(finalUrl, {
          method: init.method ?? "GET",
          headers,
          ...(body !== undefined ? { body } : {}),
        });
      } catch (err) {
        logger.error(`HTTP ${init.method ?? "GET"} ${redactUrl(finalUrl)} failed (network).`);
        return networkError(err);
      }

      if (response.ok) {
        if (response.status === 204) {
          return { ok: true, data: undefined as unknown as T };
        }
        const text = await response.text();
        if (!text) {
          return { ok: true, data: undefined as unknown as T };
        }
        try {
          return { ok: true, data: JSON.parse(text) as T };
        } catch {
          logger.error(`Non-JSON response from ${redactUrl(finalUrl)}: ${redact(text.slice(0, 200))}`);
          return {
            ok: false,
            error: {
              status: response.status,
              code: "unknown",
              message: "Non-JSON response from Confluence.",
              retryable: false,
            },
          };
        }
      }

      const retryAfter = response.headers.get("Retry-After");
      const errText = await response.text();
      const mapped = mapHttpError(response.status, errText, retryAfter);

      // Retry policy: 429 + 5xx, capped at maxRetries.
      const shouldRetry =
        mapped.error.retryable && attempt < this.maxRetries;
      if (!shouldRetry) {
        return mapped;
      }

      const waitMs = computeBackoff(this.backoffBaseMs, attempt, mapped.error.retry_after);
      attempt += 1;
      logger.warn(
        `HTTP ${response.status} on ${redactUrl(finalUrl)} — retrying in ${waitMs}ms (attempt ${attempt}/${this.maxRetries}).`,
      );
      if (waitMs > 0) await sleep(waitMs);
    }
  }
}

function ensureLeadingSlash(path: string): string {
  if (!path) return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

function appendQuery(url: string, query: RequestInit2["query"]): string {
  if (!query) return url;
  const qs = typeof query === "string" ? query : objectToQuery(query);
  if (!qs) return url;
  return url.includes("?") ? `${url}&${qs}` : `${url}?${qs}`;
}

function objectToQuery(obj: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) params.set(k, v);
  }
  return params.toString();
}

function redactUrl(url: string): string {
  // Defence in depth — URLs shouldn't contain tokens, but redactor handles literal occurrences.
  return redact(url);
}

function computeBackoff(baseMs: number, attempt: number, retryAfter: number | undefined): number {
  if (retryAfter !== undefined) {
    return Math.min(retryAfter * 1000, 60_000);
  }
  if (baseMs <= 0) return 0;
  const exp = baseMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseMs;
  return Math.min(exp + jitter, 30_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
