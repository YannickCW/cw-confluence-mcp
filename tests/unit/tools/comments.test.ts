import { describe, expect, it, vi } from "vitest";

import { ConfluenceClient } from "../../../src/confluence/client.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import {
  commentCreateHandler,
  commentGetHandler,
  commentReopenHandler,
  commentResolveHandler,
  commentUpdateHandler,
  commentsListHandler,
  getCommentToolDefinitions,
  registerCommentTools,
} from "../../../src/tools/comments.js";

// ---- Test helpers --------------------------------------------------------

function makeClient(fetchImpl: ReturnType<typeof vi.fn>) {
  return new ConfluenceClient({
    creds: {
      site: "x.atlassian.net",
      email: "y@example.com",
      token: "ATATT_TEST_TOKEN_AAAA",
      savedAt: "now",
    },
    fetchImpl: fetchImpl as unknown as typeof fetch,
    maxRetries: 0,
    backoffBaseMs: 0,
  });
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function makeCtx(fetchImpl: ReturnType<typeof vi.fn>) {
  return { client: makeClient(fetchImpl) };
}

function v2FooterComment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "1001",
    pageId: "777",
    parentCommentId: null,
    status: "current",
    version: { number: 1, createdAt: "2026-05-18T10:00:00Z", authorId: "u-1" },
    body: { storage: { value: "<p>Hi</p>", representation: "storage" } },
    ...overrides,
  };
}

function v2InlineComment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "2002",
    pageId: "777",
    parentCommentId: null,
    status: "current",
    version: { number: 1, createdAt: "2026-05-18T10:05:00Z", authorId: "u-2" },
    body: { storage: { value: "<p>Inline thought</p>", representation: "storage" } },
    inlineCommentProperties: {
      textSelection: "kafka consumer",
      textSelectionMatchCount: 1,
      textSelectionMatchIndex: 0,
      resolutionStatus: "open",
    },
    ...overrides,
  };
}

// ---- Tool registration ---------------------------------------------------

describe("registerCommentTools / getCommentToolDefinitions", () => {
  it("exposes exactly the six comment tools", () => {
    const defs = getCommentToolDefinitions();
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual([
      "comment_create",
      "comment_get",
      "comment_reopen",
      "comment_resolve",
      "comment_update",
      "comments_list",
    ]);
  });

  it("registerCommentTools returns the same definitions (Phase-4 contract)", () => {
    const fakeServer = {} as Server;
    const ctx = makeCtx(vi.fn());
    const defs = registerCommentTools(fakeServer, ctx);
    expect(defs.map((d) => d.name).sort()).toEqual([
      "comment_create",
      "comment_get",
      "comment_reopen",
      "comment_resolve",
      "comment_update",
      "comments_list",
    ]);
  });

  it("each definition has a description, inputSchema and handler", () => {
    for (const def of getCommentToolDefinitions()) {
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.inputSchema).toBeTruthy();
      expect(typeof def.handler).toBe("function");
    }
  });

  // Hard non-goal (§1): deletion is out of scope. Explicit assertion that
  // comment_delete is NOT a registered tool.
  it("does NOT register comment_delete (§1 hard non-goal)", () => {
    const names = getCommentToolDefinitions().map((d) => d.name);
    expect(names).not.toContain("comment_delete");
  });
});

// ---- comments_list -------------------------------------------------------

describe("comments_list", () => {
  it("happy path: combines footer + inline collections, sorts by created_at, exposes inline metadata", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          results: [
            v2FooterComment({
              id: "F1",
              version: { number: 1, createdAt: "2026-05-18T10:00:00Z", authorId: "u-1" },
            }),
            v2FooterComment({
              id: "F2",
              version: { number: 1, createdAt: "2026-05-18T11:00:00Z", authorId: "u-1" },
            }),
          ],
          _links: { next: "/wiki/api/v2/pages/777/footer-comments?cursor=NXT&limit=25" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          results: [
            v2InlineComment({
              id: "I1",
              version: { number: 1, createdAt: "2026-05-18T09:00:00Z", authorId: "u-2" },
            }),
          ],
        }),
      );

    const ctx = makeCtx(fetchImpl);
    const res = await commentsListHandler(ctx, { page_id: "777" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const [url1] = fetchImpl.mock.calls[0]!;
    const [url2] = fetchImpl.mock.calls[1]!;
    expect(url1 as string).toContain("/pages/777/footer-comments");
    expect(url1 as string).toContain("body-format=storage");
    expect(url2 as string).toContain("/pages/777/inline-comments");

    // Sort: I1 (09:00) < F1 (10:00) < F2 (11:00)
    expect(res.data.values.map((v) => v.id)).toEqual(["I1", "F1", "F2"]);
    expect(res.data.values[0]!.type).toBe("inline");
    expect(res.data.values[0]!.inline).toEqual({
      text_selection: "kafka consumer",
      match_count: 1,
      match_index: 0,
    });
    expect(res.data.values[1]!.type).toBe("footer");
    expect(res.data.values[1]!.inline).toBeNull();
    // Footer next cursor preferred when both exist
    expect(res.data.next_cursor).toBe("NXT");
  });

  it("type=footer skips the inline-comments fetch", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [v2FooterComment({ id: "F1" })],
      }),
    );
    const ctx = makeCtx(fetchImpl);
    const res = await commentsListHandler(ctx, { page_id: "777", type: "footer" });
    expect(res.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0] as string).toContain("/footer-comments");
  });

  it("type=inline skips the footer-comments fetch", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [v2InlineComment({ id: "I1" })],
      }),
    );
    const ctx = makeCtx(fetchImpl);
    const res = await commentsListHandler(ctx, { page_id: "777", type: "inline" });
    expect(res.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0] as string).toContain("/inline-comments");
  });

  it("include_resolved=false filters out resolved inline threads", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { results: [] }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          results: [
            v2InlineComment({
              id: "I1",
              inlineCommentProperties: {
                textSelection: "x",
                textSelectionMatchCount: 1,
                textSelectionMatchIndex: 0,
                resolutionStatus: "resolved",
              },
            }),
            v2InlineComment({
              id: "I2",
              inlineCommentProperties: {
                textSelection: "y",
                textSelectionMatchCount: 1,
                textSelectionMatchIndex: 0,
                resolutionStatus: "open",
              },
            }),
          ],
        }),
      );
    const ctx = makeCtx(fetchImpl);
    const res = await commentsListHandler(ctx, { page_id: "777", include_resolved: false });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.values.map((v) => v.id)).toEqual(["I2"]);
  });

  it("last page: both endpoints empty next → next_cursor is null", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { results: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { results: [] }));
    const ctx = makeCtx(fetchImpl);
    const res = await commentsListHandler(ctx, { page_id: "777" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.next_cursor).toBeNull();
    expect(res.data.values).toEqual([]);
  });

  it("forwards cursor + pagelen into the v2 limit/cursor query", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { results: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { results: [] }));
    const ctx = makeCtx(fetchImpl);
    await commentsListHandler(ctx, { page_id: "777", cursor: "CUR", pagelen: 50 });
    const [url1] = fetchImpl.mock.calls[0]!;
    expect(url1 as string).toContain("limit=50");
    expect(url1 as string).toContain("cursor=CUR");
  });

  it("rejects malformed args before making an HTTP call", async () => {
    const fetchImpl = vi.fn();
    const ctx = makeCtx(fetchImpl);
    const res = await commentsListHandler(ctx, { page_id: "" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("validation");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects unknown type enum value", async () => {
    const fetchImpl = vi.fn();
    const ctx = makeCtx(fetchImpl);
    const res = await commentsListHandler(ctx, { page_id: "777", type: "nope" });
    expect(res.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps 404 from footer-comments to not_found", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { errors: [{ title: "Page not found" }] }));
    const ctx = makeCtx(fetchImpl);
    const res = await commentsListHandler(ctx, { page_id: "missing" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("not_found");
  });

  it("maps 401 to unauthorized with auth hint", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(401, { message: "bad token" }));
    const ctx = makeCtx(fetchImpl);
    const res = await commentsListHandler(ctx, { page_id: "777" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("unauthorized");
    expect(res.error.message).toContain("auth login");
  });

  it("maps 429 to rate_limited with retry_after", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { message: "slow down" }, { "Retry-After": "12" }));
    const ctx = makeCtx(fetchImpl);
    const res = await commentsListHandler(ctx, { page_id: "777" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("rate_limited");
    expect(res.error.retry_after).toBe(12);
  });

  it("maps 5xx to server_error", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(503, { message: "down" }));
    const ctx = makeCtx(fetchImpl);
    const res = await commentsListHandler(ctx, { page_id: "777" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("server_error");
    expect(res.error.retryable).toBe(true);
  });
});

// ---- comment_get ---------------------------------------------------------

describe("comment_get", () => {
  it("happy path: finds footer comment on first try", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, v2FooterComment({ id: "1001" })));
    const ctx = makeCtx(fetchImpl);
    const res = await commentGetHandler(ctx, { comment_id: "1001" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.id).toBe("1001");
    expect(res.data.type).toBe("footer");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0] as string).toContain("/footer-comments/1001");
  });

  it("falls back to inline-comments on 404 from footer-comments", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { errors: [{ title: "Not found" }] }))
      .mockResolvedValueOnce(jsonResponse(200, v2InlineComment({ id: "2002" })));
    const ctx = makeCtx(fetchImpl);
    const res = await commentGetHandler(ctx, { comment_id: "2002" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.type).toBe("inline");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]![0] as string).toContain("/inline-comments/2002");
  });

  it("returns not_found when both endpoints 404", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { errors: [{ title: "Not found" }] }))
      .mockResolvedValueOnce(jsonResponse(404, { errors: [{ title: "Not found" }] }));
    const ctx = makeCtx(fetchImpl);
    const res = await commentGetHandler(ctx, { comment_id: "missing" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("not_found");
  });

  it("does NOT fall back on non-404 errors from footer-comments", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(403, { message: "nope" }));
    const ctx = makeCtx(fetchImpl);
    const res = await commentGetHandler(ctx, { comment_id: "1001" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("forbidden");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects empty comment_id", async () => {
    const fetchImpl = vi.fn();
    const ctx = makeCtx(fetchImpl);
    const res = await commentGetHandler(ctx, { comment_id: "" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("validation");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ---- comment_create (footer + reply) -------------------------------------

describe("comment_create — footer paths", () => {
  it("creates a footer comment (no inline, no parent)", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, v2FooterComment({ id: "F1" })));
    const ctx = makeCtx(fetchImpl);
    const res = await commentCreateHandler(ctx, {
      page_id: "777",
      body_storage: "<p>Hi</p>",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.type).toBe("footer");

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url as string).toContain("/footer-comments");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toEqual({
      pageId: "777",
      body: { representation: "storage", value: "<p>Hi</p>" },
    });
  });

  it("creates a footer reply when parent_id points at a footer comment", async () => {
    const fetchImpl = vi
      .fn()
      // 1: parent lookup (footer GET succeeds)
      .mockResolvedValueOnce(jsonResponse(200, v2FooterComment({ id: "F1" })))
      // 2: POST /footer-comments
      .mockResolvedValueOnce(jsonResponse(200, v2FooterComment({ id: "F2", parentCommentId: "F1" })));
    const ctx = makeCtx(fetchImpl);
    const res = await commentCreateHandler(ctx, {
      page_id: "777",
      body_storage: "<p>Reply</p>",
      parent_id: "F1",
    });
    expect(res.ok).toBe(true);

    const [postUrl, postInit] = fetchImpl.mock.calls[1]!;
    expect(postUrl as string).toContain("/footer-comments");
    expect((postInit as RequestInit).method).toBe("POST");
    const body = JSON.parse((postInit as RequestInit).body as string) as Record<string, unknown>;
    expect(body.parentCommentId).toBe("F1");
    expect(body.pageId).toBeUndefined();
  });

  it("creates an inline reply when parent_id points at an inline comment", async () => {
    const fetchImpl = vi
      .fn()
      // 1: parent lookup — footer GET returns 404 (not a footer comment)
      .mockResolvedValueOnce(jsonResponse(404, { errors: [{ title: "no" }] }))
      // 2: parent lookup — inline GET succeeds
      .mockResolvedValueOnce(jsonResponse(200, v2InlineComment({ id: "I1" })))
      // 3: POST /inline-comments with parentCommentId
      .mockResolvedValueOnce(jsonResponse(200, v2InlineComment({ id: "I2", parentCommentId: "I1" })));
    const ctx = makeCtx(fetchImpl);
    const res = await commentCreateHandler(ctx, {
      page_id: "777",
      body_storage: "<p>Reply</p>",
      parent_id: "I1",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.type).toBe("inline");

    const [postUrl, postInit] = fetchImpl.mock.calls[2]!;
    expect(postUrl as string).toContain("/inline-comments");
    expect((postInit as RequestInit).method).toBe("POST");
    const body = JSON.parse((postInit as RequestInit).body as string) as Record<string, unknown>;
    expect(body.parentCommentId).toBe("I1");
  });

  it("reply path: parent lookup 404 propagates not_found, no POST", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { errors: [{ title: "no" }] }))
      .mockResolvedValueOnce(jsonResponse(404, { errors: [{ title: "no" }] }));
    const ctx = makeCtx(fetchImpl);
    const res = await commentCreateHandler(ctx, {
      page_id: "777",
      body_storage: "<p>Reply</p>",
      parent_id: "missing",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("not_found");
    // Only the two parent-lookup GETs happened — no POST was issued.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects when both parent_id and inline are supplied", async () => {
    const fetchImpl = vi.fn();
    const ctx = makeCtx(fetchImpl);
    const res = await commentCreateHandler(ctx, {
      page_id: "777",
      body_storage: "<p>x</p>",
      parent_id: "F1",
      inline: { text_marker: "foo" },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("validation");
    expect(res.error.message.toLowerCase()).toContain("cannot supply both");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects empty body_storage? — actually empty body is allowed by spec, but missing field fails", async () => {
    const fetchImpl = vi.fn();
    const ctx = makeCtx(fetchImpl);
    const res = await commentCreateHandler(ctx, { page_id: "777" });
    expect(res.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps 403 from create to forbidden", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(403, { message: "no" }));
    const ctx = makeCtx(fetchImpl);
    const res = await commentCreateHandler(ctx, { page_id: "777", body_storage: "<p>x</p>" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("forbidden");
  });
});

// ---- comment_create — inline anchor flow ---------------------------------

describe("comment_create — inline anchor flow (§4.6)", () => {
  function pageWithBody(value: string): Record<string, unknown> {
    return {
      id: "777",
      body: { storage: { value, representation: "storage" } },
    };
  }

  it("marker found exactly once → posts inlineCommentProperties with matchCount=1, matchIndex=0", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, pageWithBody("<p>Run kafka consumer now.</p>")))
      .mockResolvedValueOnce(
        jsonResponse(
          200,
          v2InlineComment({
            id: "I1",
            inlineCommentProperties: {
              textSelection: "kafka consumer",
              textSelectionMatchCount: 1,
              textSelectionMatchIndex: 0,
              resolutionStatus: "open",
            },
          }),
        ),
      );
    const ctx = makeCtx(fetchImpl);
    const res = await commentCreateHandler(ctx, {
      page_id: "777",
      body_storage: "<p>thought</p>",
      inline: { text_marker: "kafka consumer" },
    });
    expect(res.ok).toBe(true);

    // First call: fetch page body in storage format.
    const [urlFetch] = fetchImpl.mock.calls[0]!;
    expect(urlFetch as string).toContain("/pages/777");
    expect(urlFetch as string).toContain("body-format=storage");

    // Second call: POST /inline-comments with proper anchor payload.
    const [urlPost, init] = fetchImpl.mock.calls[1]!;
    expect(urlPost as string).toContain("/inline-comments");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string) as {
      pageId: string;
      body: { value: string };
      inlineCommentProperties: {
        textSelection: string;
        textSelectionMatchCount: number;
        textSelectionMatchIndex: number;
      };
    };
    expect(body.pageId).toBe("777");
    expect(body.inlineCommentProperties.textSelection).toBe("kafka consumer");
    expect(body.inlineCommentProperties.textSelectionMatchCount).toBe(1);
    expect(body.inlineCommentProperties.textSelectionMatchIndex).toBe(0);
  });

  it("marker NOT found → returns marker_not_found, no POST", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, pageWithBody("<p>Some other content here.</p>")));
    const ctx = makeCtx(fetchImpl);
    const res = await commentCreateHandler(ctx, {
      page_id: "777",
      body_storage: "<p>thought</p>",
      inline: { text_marker: "kafka consumer" },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("marker_not_found");

    // Only the page-body fetch happened; no create POST.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0] as string).toContain("/pages/777");
  });

  it("marker ambiguous, no occurrence → marker_ambiguous with count populated, no POST", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, pageWithBody("<p>kafka kafka kafka everywhere.</p>")),
      );
    const ctx = makeCtx(fetchImpl);
    const res = await commentCreateHandler(ctx, {
      page_id: "777",
      body_storage: "<p>x</p>",
      inline: { text_marker: "kafka" },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("marker_ambiguous");
    expect(res.error.details?.count).toBe(3);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("marker ambiguous, occurrence=1 → uses first match (matchIndex=0)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, pageWithBody("<p>kafka kafka kafka.</p>")))
      .mockResolvedValueOnce(jsonResponse(200, v2InlineComment()));
    const ctx = makeCtx(fetchImpl);
    const res = await commentCreateHandler(ctx, {
      page_id: "777",
      body_storage: "<p>x</p>",
      inline: { text_marker: "kafka", occurrence: 1 },
    });
    expect(res.ok).toBe(true);

    const init = fetchImpl.mock.calls[1]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      inlineCommentProperties: {
        textSelectionMatchCount: number;
        textSelectionMatchIndex: number;
      };
    };
    expect(body.inlineCommentProperties.textSelectionMatchCount).toBe(3);
    expect(body.inlineCommentProperties.textSelectionMatchIndex).toBe(0);
  });

  it("marker ambiguous, occurrence=2 → uses second match (matchIndex=1)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, pageWithBody("<p>kafka kafka kafka.</p>")))
      .mockResolvedValueOnce(jsonResponse(200, v2InlineComment()));
    const ctx = makeCtx(fetchImpl);
    const res = await commentCreateHandler(ctx, {
      page_id: "777",
      body_storage: "<p>x</p>",
      inline: { text_marker: "kafka", occurrence: 2 },
    });
    expect(res.ok).toBe(true);

    const init = fetchImpl.mock.calls[1]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      inlineCommentProperties: {
        textSelectionMatchCount: number;
        textSelectionMatchIndex: number;
      };
    };
    expect(body.inlineCommentProperties.textSelectionMatchCount).toBe(3);
    expect(body.inlineCommentProperties.textSelectionMatchIndex).toBe(1);
  });

  it("marker ambiguous, occurrence=last → uses last match (matchIndex=count-1)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, pageWithBody("<p>kafka kafka kafka.</p>")))
      .mockResolvedValueOnce(jsonResponse(200, v2InlineComment()));
    const ctx = makeCtx(fetchImpl);
    const res = await commentCreateHandler(ctx, {
      page_id: "777",
      body_storage: "<p>x</p>",
      inline: { text_marker: "kafka", occurrence: 3 },
    });
    expect(res.ok).toBe(true);

    const init = fetchImpl.mock.calls[1]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      inlineCommentProperties: {
        textSelectionMatchCount: number;
        textSelectionMatchIndex: number;
      };
    };
    expect(body.inlineCommentProperties.textSelectionMatchCount).toBe(3);
    expect(body.inlineCommentProperties.textSelectionMatchIndex).toBe(2);
  });

  it("marker spans element boundaries → resolved against the text projection", async () => {
    // The XHTML body has `<strong>` tag inside the run — projection collapses
    // tags so the plain-text marker still matches.
    const xhtml = "<p>Run <strong>kafka</strong> consumer.</p>";
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, pageWithBody(xhtml)))
      .mockResolvedValueOnce(jsonResponse(200, v2InlineComment()));
    const ctx = makeCtx(fetchImpl);
    const res = await commentCreateHandler(ctx, {
      page_id: "777",
      body_storage: "<p>x</p>",
      inline: { text_marker: "kafka consumer" },
    });
    expect(res.ok).toBe(true);

    const init = fetchImpl.mock.calls[1]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      inlineCommentProperties: {
        textSelection: string;
        textSelectionMatchCount: number;
        textSelectionMatchIndex: number;
      };
    };
    expect(body.inlineCommentProperties.textSelection).toBe("kafka consumer");
    expect(body.inlineCommentProperties.textSelectionMatchCount).toBe(1);
    expect(body.inlineCommentProperties.textSelectionMatchIndex).toBe(0);
  });

  it("page fetch fails (404) → propagates not_found, no POST", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { errors: [{ title: "Page gone" }] }));
    const ctx = makeCtx(fetchImpl);
    const res = await commentCreateHandler(ctx, {
      page_id: "missing",
      body_storage: "<p>x</p>",
      inline: { text_marker: "kafka" },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("not_found");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects inline.text_marker = '' via zod before any HTTP call", async () => {
    const fetchImpl = vi.fn();
    const ctx = makeCtx(fetchImpl);
    const res = await commentCreateHandler(ctx, {
      page_id: "777",
      body_storage: "<p>x</p>",
      inline: { text_marker: "" },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("validation");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ---- comment_update ------------------------------------------------------

describe("comment_update", () => {
  it("happy path (footer): GETs current, PUTs with version+1", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, v2FooterComment({ id: "F1", version: { number: 4 } })))
      .mockResolvedValueOnce(jsonResponse(200, v2FooterComment({ id: "F1", version: { number: 5 } })));
    const ctx = makeCtx(fetchImpl);
    const res = await commentUpdateHandler(ctx, {
      comment_id: "F1",
      body_storage: "<p>edited</p>",
    });
    expect(res.ok).toBe(true);

    const [, init] = fetchImpl.mock.calls[1]!;
    expect((init as RequestInit).method).toBe("PUT");
    const body = JSON.parse((init as RequestInit).body as string) as {
      version: { number: number };
      body: { value: string };
    };
    expect(body.version.number).toBe(5);
    expect(body.body.value).toBe("<p>edited</p>");
  });

  it("happy path (inline): footer GET 404s → fetches inline → PUTs inline endpoint", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { errors: [{ title: "no" }] }))
      .mockResolvedValueOnce(jsonResponse(200, v2InlineComment({ id: "I1", version: { number: 2 } })))
      .mockResolvedValueOnce(jsonResponse(200, v2InlineComment({ id: "I1", version: { number: 3 } })));
    const ctx = makeCtx(fetchImpl);
    const res = await commentUpdateHandler(ctx, {
      comment_id: "I1",
      body_storage: "<p>edited</p>",
    });
    expect(res.ok).toBe(true);

    const [putUrl, putInit] = fetchImpl.mock.calls[2]!;
    expect(putUrl as string).toContain("/inline-comments/I1");
    expect((putInit as RequestInit).method).toBe("PUT");
    const body = JSON.parse((putInit as RequestInit).body as string) as {
      version: { number: number };
    };
    expect(body.version.number).toBe(3);
  });

  it("PUT 409 → surfaces version_conflict (no retry per spec)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, v2FooterComment({ id: "F1", version: { number: 4 } })))
      .mockResolvedValueOnce(jsonResponse(409, { message: "stale" }));
    const ctx = makeCtx(fetchImpl);
    const res = await commentUpdateHandler(ctx, {
      comment_id: "F1",
      body_storage: "<p>edited</p>",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("version_conflict");
    expect(res.error.retryable).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // no retry
  });

  it("PUT 403 → forbidden (author-only check surfaces Confluence's error)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, v2FooterComment({ id: "F1", version: { number: 4 } })))
      .mockResolvedValueOnce(jsonResponse(403, { message: "not your comment" }));
    const ctx = makeCtx(fetchImpl);
    const res = await commentUpdateHandler(ctx, {
      comment_id: "F1",
      body_storage: "<p>edited</p>",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("forbidden");
  });

  it("both footer and inline GET return 404 → not_found, no PUT", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { errors: [{ title: "no" }] }))
      .mockResolvedValueOnce(jsonResponse(404, { errors: [{ title: "no" }] }));
    const ctx = makeCtx(fetchImpl);
    const res = await commentUpdateHandler(ctx, {
      comment_id: "gone",
      body_storage: "<p>x</p>",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("not_found");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects empty comment_id before any HTTP call", async () => {
    const fetchImpl = vi.fn();
    const ctx = makeCtx(fetchImpl);
    const res = await commentUpdateHandler(ctx, {
      comment_id: "",
      body_storage: "<p>x</p>",
    });
    expect(res.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ---- comment_resolve -----------------------------------------------------

describe("comment_resolve", () => {
  it("happy path: fetches comment (inline), PUTs v1 resolve, re-fetches comment", async () => {
    // get(comment) — try footer (404) then inline (ok)
    // -> v1 resolve PUT
    // -> get(comment) again — footer 404 then inline (ok, resolved)
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { errors: [{ title: "no" }] })) // footer get 1
      .mockResolvedValueOnce(jsonResponse(200, v2InlineComment({ id: "I1" }))) // inline get 1
      .mockResolvedValueOnce(jsonResponse(200, {})) // v1 PUT resolve
      .mockResolvedValueOnce(jsonResponse(404, { errors: [{ title: "no" }] })) // footer get 2
      .mockResolvedValueOnce(
        jsonResponse(
          200,
          v2InlineComment({
            id: "I1",
            inlineCommentProperties: {
              textSelection: "x",
              textSelectionMatchCount: 1,
              textSelectionMatchIndex: 0,
              resolutionStatus: "resolved",
            },
          }),
        ),
      );
    const ctx = makeCtx(fetchImpl);
    const res = await commentResolveHandler(ctx, { comment_id: "I1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.resolution_status).toBe("resolved");

    const putCall = fetchImpl.mock.calls[2]!;
    expect(putCall[0] as string).toContain("/wiki/rest/api/");
    expect(putCall[0] as string).toContain("/inline-comments/I1/resolve");
    expect((putCall[1] as RequestInit).method).toBe("PUT");
  });

  it("rejects footer comment with validation error, no PUT", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, v2FooterComment({ id: "F1" })));
    const ctx = makeCtx(fetchImpl);
    const res = await commentResolveHandler(ctx, { comment_id: "F1" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("validation");
    expect(res.error.message.toLowerCase()).toContain("inline-only");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("propagates 404 from initial fetch", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { errors: [{ title: "no" }] }))
      .mockResolvedValueOnce(jsonResponse(404, { errors: [{ title: "no" }] }));
    const ctx = makeCtx(fetchImpl);
    const res = await commentResolveHandler(ctx, { comment_id: "missing" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("not_found");
  });

  it("rejects empty comment_id before any HTTP call", async () => {
    const fetchImpl = vi.fn();
    const ctx = makeCtx(fetchImpl);
    const res = await commentResolveHandler(ctx, { comment_id: "" });
    expect(res.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ---- comment_reopen ------------------------------------------------------

describe("comment_reopen", () => {
  it("happy path: fetches comment (inline), PUTs v1 reopen, re-fetches comment", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { errors: [{ title: "no" }] }))
      .mockResolvedValueOnce(jsonResponse(200, v2InlineComment({ id: "I1" })))
      .mockResolvedValueOnce(jsonResponse(200, {}))
      .mockResolvedValueOnce(jsonResponse(404, { errors: [{ title: "no" }] }))
      .mockResolvedValueOnce(jsonResponse(200, v2InlineComment({ id: "I1" })));
    const ctx = makeCtx(fetchImpl);
    const res = await commentReopenHandler(ctx, { comment_id: "I1" });
    expect(res.ok).toBe(true);

    const putCall = fetchImpl.mock.calls[2]!;
    expect(putCall[0] as string).toContain("/wiki/rest/api/");
    expect(putCall[0] as string).toContain("/inline-comments/I1/reopen");
    expect((putCall[1] as RequestInit).method).toBe("PUT");
  });

  it("rejects footer comment with validation error", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, v2FooterComment({ id: "F1" })));
    const ctx = makeCtx(fetchImpl);
    const res = await commentReopenHandler(ctx, { comment_id: "F1" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("validation");
    expect(res.error.message.toLowerCase()).toContain("inline-only");
  });

  it("rejects empty comment_id before any HTTP call", async () => {
    const fetchImpl = vi.fn();
    const ctx = makeCtx(fetchImpl);
    const res = await commentReopenHandler(ctx, { comment_id: "" });
    expect(res.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
