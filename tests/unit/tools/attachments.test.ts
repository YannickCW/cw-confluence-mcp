import { describe, expect, it, vi } from "vitest";

import { ConfluenceClient } from "../../../src/confluence/client.js";
import { normaliseDownloadUrl } from "../../../src/confluence/endpoints/attachments.js";
import {
  getAttachmentToolDefinitions,
  type AttachmentToolContext,
} from "../../../src/tools/attachments.js";

// ---------- helpers ----------

const SITE = "x.atlassian.net";

function makeClient(fetchImpl: ReturnType<typeof vi.fn>): ConfluenceClient {
  return new ConfluenceClient({
    creds: {
      site: SITE,
      email: "y@example.com",
      token: "ATATT_TEST_TOKEN_AAAA",
      savedAt: "now",
    },
    fetchImpl: fetchImpl as unknown as typeof fetch,
    maxRetries: 3,
    backoffBaseMs: 0,
  });
}

function makeCtx(fetchImpl: ReturnType<typeof vi.fn>): AttachmentToolContext {
  return { client: makeClient(fetchImpl), site: SITE };
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function rawAttachment(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "att-1",
    title: "screenshot.png",
    mediaType: "image/png",
    fileSize: 12345,
    version: { number: 2 },
    _links: {
      download:
        "/wiki/download/attachments/123/screenshot.png?version=2&modificationDate=0&api=v2",
    },
    ...overrides,
  };
}

function findTool(ctx: AttachmentToolContext, name: string) {
  const defs = getAttachmentToolDefinitions(ctx);
  const def = defs.find((d) => d.name === name);
  if (!def) throw new Error(`Tool definition not found: ${name}`);
  return def;
}

// ---------- normaliseDownloadUrl ----------

describe("normaliseDownloadUrl", () => {
  it("prepends https://<site> to a relative path", () => {
    const out = normaliseDownloadUrl(
      "/wiki/download/attachments/123/foo.png?version=1",
      SITE,
    );
    expect(out).toBe(
      "https://x.atlassian.net/wiki/download/attachments/123/foo.png?version=1",
    );
  });

  it("passes absolute https URLs through unchanged", () => {
    const url = "https://other.example.com/some/path?x=1";
    expect(normaliseDownloadUrl(url, SITE)).toBe(url);
  });

  it("upgrades protocol-relative URLs to https", () => {
    expect(normaliseDownloadUrl("//cdn.example.com/foo.png", SITE)).toBe(
      "https://cdn.example.com/foo.png",
    );
  });

  it("returns empty string for empty input", () => {
    expect(normaliseDownloadUrl("", SITE)).toBe("");
  });

  it("strips scheme/trailing slashes from site when prepending", () => {
    expect(normaliseDownloadUrl("/p", "https://x.atlassian.net/")).toBe(
      "https://x.atlassian.net/p",
    );
  });
});

// ---------- attachments_list ----------

describe("attachments_list", () => {
  it("happy path — returns mapped attachments", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [
          rawAttachment({ id: "a", title: "a.png", mediaType: "image/png", fileSize: 100 }),
          rawAttachment({ id: "b", title: "b.pdf", mediaType: "application/pdf", fileSize: 200 }),
        ],
        _links: {},
      }),
    );
    const ctx = makeCtx(fetchImpl);
    const tool = findTool(ctx, "attachments_list");
    const res = (await tool.handler({ page_id: "123" })) as
      | { ok: true; data: { values: unknown[]; next_cursor: string | null } }
      | { ok: false; error: unknown };
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.values).toEqual([
        {
          id: "a",
          filename: "a.png",
          mime: "image/png",
          size: 100,
          version: 2,
          download_url:
            "https://x.atlassian.net/wiki/download/attachments/123/screenshot.png?version=2&modificationDate=0&api=v2",
        },
        {
          id: "b",
          filename: "b.pdf",
          mime: "application/pdf",
          size: 200,
          version: 2,
          download_url:
            "https://x.atlassian.net/wiki/download/attachments/123/screenshot.png?version=2&modificationDate=0&api=v2",
        },
      ]);
      expect(res.data.next_cursor).toBeNull();
    }
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain("/wiki/api/v2/pages/123/attachments");
    expect(url).toContain("limit=25");
  });

  it("filters by media_type prefix — image/", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [
          rawAttachment({ id: "a", title: "a.png", mediaType: "image/png" }),
          rawAttachment({ id: "b", title: "b.jpg", mediaType: "image/jpeg" }),
          rawAttachment({ id: "c", title: "c.pdf", mediaType: "application/pdf" }),
        ],
        _links: {},
      }),
    );
    const ctx = makeCtx(fetchImpl);
    const tool = findTool(ctx, "attachments_list");
    const res = (await tool.handler({ page_id: "123", media_type: "image/" })) as {
      ok: true;
      data: { values: Array<{ id: string; mime: string }> };
    };
    expect(res.ok).toBe(true);
    expect(res.data.values.map((v) => v.id)).toEqual(["a", "b"]);
    expect(res.data.values.every((v) => v.mime.startsWith("image/"))).toBe(true);
  });

  it("filters by media_type prefix — application/", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [
          rawAttachment({ id: "a", title: "a.png", mediaType: "image/png" }),
          rawAttachment({ id: "b", title: "b.jpg", mediaType: "image/jpeg" }),
          rawAttachment({ id: "c", title: "c.pdf", mediaType: "application/pdf" }),
        ],
        _links: {},
      }),
    );
    const ctx = makeCtx(fetchImpl);
    const tool = findTool(ctx, "attachments_list");
    const res = (await tool.handler({ page_id: "123", media_type: "application/" })) as {
      ok: true;
      data: { values: Array<{ id: string; mime: string }> };
    };
    expect(res.ok).toBe(true);
    expect(res.data.values.map((v) => v.id)).toEqual(["c"]);
  });

  it("returns all attachments when media_type filter is absent", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [
          rawAttachment({ id: "a", mediaType: "image/png" }),
          rawAttachment({ id: "b", mediaType: "image/jpeg" }),
          rawAttachment({ id: "c", mediaType: "application/pdf" }),
        ],
        _links: {},
      }),
    );
    const ctx = makeCtx(fetchImpl);
    const tool = findTool(ctx, "attachments_list");
    const res = (await tool.handler({ page_id: "123" })) as {
      ok: true;
      data: { values: Array<{ id: string }> };
    };
    expect(res.ok).toBe(true);
    expect(res.data.values).toHaveLength(3);
  });

  it("normalises a relative download_url to a fully qualified URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [
          rawAttachment({
            id: "att-1",
            title: "screenshot.png",
            mediaType: "image/png",
            _links: {
              download:
                "/wiki/download/attachments/456/screenshot.png?version=1&api=v2",
            },
          }),
        ],
        _links: {},
      }),
    );
    const ctx = makeCtx(fetchImpl);
    const tool = findTool(ctx, "attachments_list");
    const res = (await tool.handler({ page_id: "456" })) as {
      ok: true;
      data: { values: Array<{ download_url: string }> };
    };
    expect(res.ok).toBe(true);
    expect(res.data.values[0]!.download_url).toBe(
      "https://x.atlassian.net/wiki/download/attachments/456/screenshot.png?version=1&api=v2",
    );
  });

  it("passes through an absolute download_url unchanged", async () => {
    const absolute =
      "https://cdn.atlassian.net/wiki/download/attachments/789/foo.png?token=opaque";
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [
          rawAttachment({
            _links: { download: absolute },
          }),
        ],
        _links: {},
      }),
    );
    const ctx = makeCtx(fetchImpl);
    const tool = findTool(ctx, "attachments_list");
    const res = (await tool.handler({ page_id: "789" })) as {
      ok: true;
      data: { values: Array<{ download_url: string }> };
    };
    expect(res.ok).toBe(true);
    expect(res.data.values[0]!.download_url).toBe(absolute);
  });

  it("maps 401 → unauthorized with auth hint", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { message: "bad creds" }));
    const ctx = makeCtx(fetchImpl);
    const tool = findTool(ctx, "attachments_list");
    const res = (await tool.handler({ page_id: "123" })) as
      | { ok: false; error: { code: string; status: number; message: string } }
      | { ok: true };
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("unauthorized");
      expect(res.error.status).toBe(401);
      expect(res.error.message).toContain("cw-confluence-mcp auth login");
    }
  });

  it("maps 403 → forbidden", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(403, { message: "nope" }));
    const ctx = makeCtx(fetchImpl);
    const tool = findTool(ctx, "attachments_list");
    const res = (await tool.handler({ page_id: "123" })) as
      | { ok: false; error: { code: string; status: number } }
      | { ok: true };
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("forbidden");
      expect(res.error.status).toBe(403);
    }
  });

  it("maps 404 → not_found", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { errors: [{ title: "Not Found" }] }));
    const ctx = makeCtx(fetchImpl);
    const tool = findTool(ctx, "attachments_list");
    const res = (await tool.handler({ page_id: "missing" })) as
      | { ok: false; error: { code: string; status: number } }
      | { ok: true };
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("not_found");
      expect(res.error.status).toBe(404);
    }
  });

  it("maps 429 with Retry-After → rate_limited (after retries)", async () => {
    // Sustained 429s exceed max retries and surface rate_limited.
    // Retry-After "0" keeps the test fast (the client still honours the header).
    const fetchImpl = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse(429, { message: "slow down" }, { "Retry-After": "0" })),
    );
    const ctx = makeCtx(fetchImpl);
    const tool = findTool(ctx, "attachments_list");
    const res = (await tool.handler({ page_id: "123" })) as
      | { ok: false; error: { code: string; status: number; retry_after?: number; retryable: boolean } }
      | { ok: true };
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("rate_limited");
      expect(res.error.status).toBe(429);
      expect(res.error.retry_after).toBe(0);
      expect(res.error.retryable).toBe(true);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it("retries on transient 429 then recovers on success", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(429, { message: "slow" }, { "Retry-After": "0" }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { results: [], _links: {} }));
    const ctx = makeCtx(fetchImpl);
    const tool = findTool(ctx, "attachments_list");
    const res = (await tool.handler({ page_id: "123" })) as
      | { ok: true; data: { values: unknown[] } }
      | { ok: false };
    expect(res.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("maps 503 → server_error after retries", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse(503, { message: "down" })));
    const ctx = makeCtx(fetchImpl);
    const tool = findTool(ctx, "attachments_list");
    const res = (await tool.handler({ page_id: "123" })) as
      | { ok: false; error: { code: string; status: number; retryable: boolean } }
      | { ok: true };
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("server_error");
      expect(res.error.status).toBe(503);
      expect(res.error.retryable).toBe(true);
    }
  });

  it("rejects missing page_id before any HTTP call (input validation)", async () => {
    const fetchImpl = vi.fn();
    const ctx = makeCtx(fetchImpl);
    const tool = findTool(ctx, "attachments_list");
    const res = (await tool.handler({})) as
      | { ok: false; error: { code: string; status: number } }
      | { ok: true };
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("validation");
      expect(res.error.status).toBe(0);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects empty page_id before any HTTP call", async () => {
    const fetchImpl = vi.fn();
    const ctx = makeCtx(fetchImpl);
    const tool = findTool(ctx, "attachments_list");
    const res = (await tool.handler({ page_id: "" })) as
      | { ok: false; error: { code: string } }
      | { ok: true };
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects out-of-range pagelen before any HTTP call", async () => {
    const fetchImpl = vi.fn();
    const ctx = makeCtx(fetchImpl);
    const tool = findTool(ctx, "attachments_list");
    const res = (await tool.handler({ page_id: "123", pagelen: 999 })) as
      | { ok: false; error: { code: string } }
      | { ok: true };
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects non-string media_type before any HTTP call", async () => {
    const fetchImpl = vi.fn();
    const ctx = makeCtx(fetchImpl);
    const tool = findTool(ctx, "attachments_list");
    const res = (await tool.handler({ page_id: "123", media_type: 5 })) as
      | { ok: false; error: { code: string } }
      | { ok: true };
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("pagination — first page exposes next_cursor when _links.next is present", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [rawAttachment({ id: "a" })],
        _links: {
          next: "/wiki/api/v2/pages/123/attachments?cursor=NEXT_TOKEN&limit=25",
        },
      }),
    );
    const ctx = makeCtx(fetchImpl);
    const tool = findTool(ctx, "attachments_list");
    const res = (await tool.handler({ page_id: "123" })) as {
      ok: true;
      data: { next_cursor: string | null };
    };
    expect(res.ok).toBe(true);
    expect(res.data.next_cursor).toBe("NEXT_TOKEN");
  });

  it("pagination — passes cursor on subsequent calls", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [rawAttachment({ id: "b" })],
        _links: {
          next: "/wiki/api/v2/pages/123/attachments?cursor=THIRD&limit=25",
        },
      }),
    );
    const ctx = makeCtx(fetchImpl);
    const tool = findTool(ctx, "attachments_list");
    await tool.handler({ page_id: "123", cursor: "SECOND" });
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain("cursor=SECOND");
    expect(url).toContain("limit=25");
  });

  it("pagination — last page returns next_cursor: null", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [rawAttachment({ id: "last" })],
        _links: {},
      }),
    );
    const ctx = makeCtx(fetchImpl);
    const tool = findTool(ctx, "attachments_list");
    const res = (await tool.handler({ page_id: "123" })) as {
      ok: true;
      data: { next_cursor: string | null };
    };
    expect(res.ok).toBe(true);
    expect(res.data.next_cursor).toBeNull();
  });

  it("respects custom pagelen in the query string", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { results: [], _links: {} }));
    const ctx = makeCtx(fetchImpl);
    const tool = findTool(ctx, "attachments_list");
    await tool.handler({ page_id: "123", pagelen: 50 });
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain("limit=50");
  });
});

// ---------- attachment_get ----------

describe("attachment_get", () => {
  it("happy path — returns mapped attachment", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(
        200,
        rawAttachment({
          id: "single",
          title: "diagram.svg",
          mediaType: "image/svg+xml",
          fileSize: 4096,
          version: { number: 7 },
          _links: { download: "/wiki/download/attachments/9/diagram.svg?version=7" },
        }),
      ),
    );
    const ctx = makeCtx(fetchImpl);
    const tool = findTool(ctx, "attachment_get");
    const res = (await tool.handler({ attachment_id: "single" })) as
      | { ok: true; data: { id: string; filename: string; mime: string; size: number; version: number; download_url: string } }
      | { ok: false };
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        id: "single",
        filename: "diagram.svg",
        mime: "image/svg+xml",
        size: 4096,
        version: 7,
        download_url:
          "https://x.atlassian.net/wiki/download/attachments/9/diagram.svg?version=7",
      });
    }
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toBe(
      "https://x.atlassian.net/wiki/api/v2/attachments/single",
    );
  });

  it("maps 401 → unauthorized", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { message: "bad" }));
    const ctx = makeCtx(fetchImpl);
    const tool = findTool(ctx, "attachment_get");
    const res = (await tool.handler({ attachment_id: "x" })) as
      | { ok: false; error: { code: string; status: number; message: string } }
      | { ok: true };
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("unauthorized");
      expect(res.error.message).toContain("cw-confluence-mcp auth login");
    }
  });

  it("maps 403 → forbidden", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(403, { message: "nope" }));
    const ctx = makeCtx(fetchImpl);
    const tool = findTool(ctx, "attachment_get");
    const res = (await tool.handler({ attachment_id: "x" })) as
      | { ok: false; error: { code: string; status: number } }
      | { ok: true };
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden");
  });

  it("maps 404 → not_found", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { errors: [{ title: "Not Found" }] }));
    const ctx = makeCtx(fetchImpl);
    const tool = findTool(ctx, "attachment_get");
    const res = (await tool.handler({ attachment_id: "missing" })) as
      | { ok: false; error: { code: string; status: number } }
      | { ok: true };
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("not_found");
      expect(res.error.status).toBe(404);
    }
  });

  it("maps 429 with Retry-After → rate_limited", async () => {
    // Retry-After "0" so the client retries quickly; the surfaced error
    // still carries retry_after parsed from the header.
    const fetchImpl = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse(429, { message: "slow" }, { "Retry-After": "0" })),
    );
    const ctx = makeCtx(fetchImpl);
    const tool = findTool(ctx, "attachment_get");
    const res = (await tool.handler({ attachment_id: "x" })) as
      | { ok: false; error: { code: string; retry_after?: number; retryable: boolean } }
      | { ok: true };
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("rate_limited");
      expect(res.error.retry_after).toBe(0);
      expect(res.error.retryable).toBe(true);
    }
  });

  it("maps 500 → server_error and retryable", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse(500, { message: "boom" })));
    const ctx = makeCtx(fetchImpl);
    const tool = findTool(ctx, "attachment_get");
    const res = (await tool.handler({ attachment_id: "x" })) as
      | { ok: false; error: { code: string; status: number; retryable: boolean } }
      | { ok: true };
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("server_error");
      expect(res.error.retryable).toBe(true);
    }
  });

  it("rejects missing attachment_id before any HTTP call", async () => {
    const fetchImpl = vi.fn();
    const ctx = makeCtx(fetchImpl);
    const tool = findTool(ctx, "attachment_get");
    const res = (await tool.handler({})) as
      | { ok: false; error: { code: string; status: number } }
      | { ok: true };
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("validation");
      expect(res.error.status).toBe(0);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects empty attachment_id before any HTTP call", async () => {
    const fetchImpl = vi.fn();
    const ctx = makeCtx(fetchImpl);
    const tool = findTool(ctx, "attachment_get");
    const res = (await tool.handler({ attachment_id: "" })) as
      | { ok: false; error: { code: string } }
      | { ok: true };
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ---------- hard non-goals (§1) ----------

describe("attachment tools — hard non-goals (§1)", () => {
  it("does not register upload / update / delete tools", () => {
    const fetchImpl = vi.fn();
    const ctx = makeCtx(fetchImpl);
    const defs = getAttachmentToolDefinitions(ctx);
    const names = defs.map((d) => d.name);
    expect(names).not.toContain("attachment_upload");
    expect(names).not.toContain("attachment_update");
    expect(names).not.toContain("attachment_overwrite");
    expect(names).not.toContain("attachment_delete");
    expect(names).not.toContain("attachment_create");
  });

  it("only registers the two read-only tools", () => {
    const fetchImpl = vi.fn();
    const ctx = makeCtx(fetchImpl);
    const defs = getAttachmentToolDefinitions(ctx);
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual(["attachment_get", "attachments_list"]);
  });

  it("none of the registered tools issue write HTTP verbs in their happy paths", async () => {
    // Defence in depth: even if a future change introduces a write call,
    // catch it via the outgoing method.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { results: [], _links: {} }));
    const ctx = makeCtx(fetchImpl);

    const list = findTool(ctx, "attachments_list");
    await list.handler({ page_id: "123" });

    const get = findTool(ctx, "attachment_get");
    fetchImpl.mockResolvedValueOnce(jsonResponse(200, rawAttachment()));
    await get.handler({ attachment_id: "x" });

    for (const call of fetchImpl.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      const method = (init?.method ?? "GET").toUpperCase();
      expect(method).toBe("GET");
    }
  });
});
