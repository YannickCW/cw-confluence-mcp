import { describe, expect, it, vi } from "vitest";

import { ConfluenceClient } from "../../../src/confluence/client.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import {
  getSpaceToolDefinitions,
  registerSpaceTools,
  spaceGetHandler,
  spaceListHandler,
  spaceSearchHandler,
} from "../../../src/tools/spaces.js";

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

// ---- Tool registration ---------------------------------------------------

describe("registerSpaceTools / getSpaceToolDefinitions", () => {
  it("exposes exactly the three read-only space tools", () => {
    const defs = getSpaceToolDefinitions();
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual(["space_get", "space_list", "space_search"]);
  });

  it("registerSpaceTools returns the same definitions (Phase-4 contract)", () => {
    const fakeServer = {} as Server;
    const ctx = makeCtx(vi.fn());
    const defs = registerSpaceTools(fakeServer, ctx);
    expect(defs.map((d) => d.name).sort()).toEqual(["space_get", "space_list", "space_search"]);
  });

  it("each definition has a description and inputSchema", () => {
    for (const def of getSpaceToolDefinitions()) {
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.inputSchema).toBeTruthy();
      expect(typeof def.handler).toBe("function");
    }
  });

  it("does NOT register destructive space tools (§1 non-goals)", () => {
    const names = getSpaceToolDefinitions().map((d) => d.name);
    for (const forbidden of ["space_create", "space_delete", "space_archive", "space_update"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

// ---- space_list ----------------------------------------------------------

describe("space_list", () => {
  it("happy path: builds v2 /spaces request and maps the response", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [
          {
            id: "100",
            key: "DEV",
            name: "Development",
            type: "global",
            status: "current",
            homepageId: "200",
          },
          {
            id: "101",
            key: "OPS",
            name: "Operations",
            type: "global",
            status: "current",
            homepageId: null,
          },
        ],
        _links: { next: "/wiki/api/v2/spaces?cursor=NEXT&limit=25" },
      }),
    );
    const ctx = makeCtx(fetchImpl);

    const res = await spaceListHandler(ctx, { type: "global", pagelen: 25 });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.values).toEqual([
      {
        id: "100",
        key: "DEV",
        name: "Development",
        type: "global",
        status: "current",
        homepage_id: "200",
      },
      {
        id: "101",
        key: "OPS",
        name: "Operations",
        type: "global",
        status: "current",
        homepage_id: null,
      },
    ]);
    expect(res.data.next_cursor).toBe("NEXT");

    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toContain("/wiki/api/v2/spaces");
    expect(url).toContain("limit=25");
    expect(url).toContain("type=global");
    expect(url).toContain("status=current");
  });

  it("defaults status=current when not supplied", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { results: [], _links: { next: null } }));
    const ctx = makeCtx(fetchImpl);

    await spaceListHandler(ctx, {});

    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toContain("status=current");
  });

  it("returns next_cursor=null on the last page", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { results: [{ id: "1", key: "A", name: "A" }], _links: { next: null } }));
    const ctx = makeCtx(fetchImpl);

    const res = await spaceListHandler(ctx, {});

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.next_cursor).toBeNull();
  });

  it("round-trips a cursor through the request", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          results: [],
          _links: { next: "/wiki/api/v2/spaces?cursor=NEXTNEXT&limit=10" },
        }),
      );
    const ctx = makeCtx(fetchImpl);

    await spaceListHandler(ctx, { cursor: "MIDDLE", pagelen: 10 });

    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toContain("cursor=MIDDLE");
    expect(url).toContain("limit=10");
  });

  it("rejects pagelen > 100 with validation error and makes no HTTP call", async () => {
    const fetchImpl = vi.fn();
    const ctx = makeCtx(fetchImpl);

    const res = await spaceListHandler(ctx, { pagelen: 250 });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("validation");
      expect(res.error.status).toBe(0);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects unknown status with validation error", async () => {
    const fetchImpl = vi.fn();
    const ctx = makeCtx(fetchImpl);

    const res = await spaceListHandler(ctx, { status: "bogus" });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps 401 → unauthorized", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(401, { message: "no" }));
    const ctx = makeCtx(fetchImpl);

    const res = await spaceListHandler(ctx, {});

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("unauthorized");
      expect(res.error.status).toBe(401);
    }
  });

  it("maps 403 → forbidden", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(403, { message: "nope" }));
    const ctx = makeCtx(fetchImpl);

    const res = await spaceListHandler(ctx, {});

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden");
  });

  it("maps 404 → not_found", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { errors: [{ title: "Not Found" }] }));
    const ctx = makeCtx(fetchImpl);

    const res = await spaceListHandler(ctx, {});

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });

  it("maps 429 → rate_limited with retry_after from header", async () => {
    // maxRetries: 0 on the test client → the first 429 surfaces directly.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { message: "slow down" }, { "Retry-After": "7" }));
    const ctx = makeCtx(fetchImpl);

    const res = await spaceListHandler(ctx, {});

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("rate_limited");
      expect(res.error.retry_after).toBe(7);
      expect(res.error.retryable).toBe(true);
    }
  });

  it("maps 5xx → server_error retryable=true", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(503, { message: "down" }));
    const ctx = makeCtx(fetchImpl);

    const res = await spaceListHandler(ctx, {});

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("server_error");
      expect(res.error.retryable).toBe(true);
    }
  });
});

// ---- space_get -----------------------------------------------------------

describe("space_get", () => {
  it("by id: hits /spaces/{id} with description-format=storage and maps result", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        id: "100",
        key: "DEV",
        name: "Development",
        type: "global",
        status: "current",
        homepageId: "200",
        description: { storage: { value: "<p>Hello</p>", representation: "storage" } },
      }),
    );
    const ctx = makeCtx(fetchImpl);

    const res = await spaceGetHandler(ctx, { id: "100" });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual({
      id: "100",
      key: "DEV",
      name: "Development",
      type: "global",
      status: "current",
      homepage_id: "200",
      description_storage: "<p>Hello</p>",
    });
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toContain("/wiki/api/v2/spaces/100");
    expect(url).toContain("description-format=storage");
  });

  it("by key: hits /spaces?keys=<key> and picks the first match", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [
          {
            id: "100",
            key: "DEV",
            name: "Development",
            type: "global",
            status: "current",
            homepageId: "200",
            description: { storage: { value: "" } },
          },
        ],
        _links: { next: null },
      }),
    );
    const ctx = makeCtx(fetchImpl);

    const res = await spaceGetHandler(ctx, { key: "DEV" });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.key).toBe("DEV");
    expect(res.data.id).toBe("100");
    expect(res.data.description_storage).toBe("");

    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toContain("/wiki/api/v2/spaces");
    expect(url).toContain("keys=DEV");
    expect(url).toContain("description-format=storage");
  });

  it("by key with no match → not_found, no extra HTTP call", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { results: [], _links: { next: null } }));
    const ctx = makeCtx(fetchImpl);

    const res = await spaceGetHandler(ctx, { key: "GHOST" });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("not_found");
      expect(res.error.status).toBe(404);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects when neither id nor key supplied", async () => {
    const fetchImpl = vi.fn();
    const ctx = makeCtx(fetchImpl);

    const res = await spaceGetHandler(ctx, {});

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects when both id and key supplied", async () => {
    const fetchImpl = vi.fn();
    const ctx = makeCtx(fetchImpl);

    const res = await spaceGetHandler(ctx, { id: "1", key: "DEV" });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes Confluence 404 (when looking up by id) straight through", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { errors: [{ title: "Not Found" }] }));
    const ctx = makeCtx(fetchImpl);

    const res = await spaceGetHandler(ctx, { id: "999" });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });

  it("maps 401 on by-id lookup", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(401, { message: "bad" }));
    const ctx = makeCtx(fetchImpl);

    const res = await spaceGetHandler(ctx, { id: "1" });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("unauthorized");
  });
});

// ---- space_search --------------------------------------------------------

describe("space_search", () => {
  it("composes CQL `type = \"space\" AND text ~ \"<q>\"` and uses v1 /content/search", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [
          {
            id: "100",
            type: "space",
            title: "Platform",
            excerpt: "All things platform",
            space: { key: "PLT", name: "Platform" },
          },
        ],
        start: 0,
        limit: 25,
        size: 1,
        _links: {},
      }),
    );
    const ctx = makeCtx(fetchImpl);

    const res = await spaceSearchHandler(ctx, { query: "platform" });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.values).toEqual([
      {
        id: "100",
        key: "PLT",
        name: "Platform",
        type: "space",
        excerpt: "All things platform",
      },
    ]);
    expect(res.data.next_cursor).toBeNull();
    expect(res.data.total).toBe(1);

    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toContain("/wiki/rest/api/content/search");

    // Decode and verify the outgoing CQL is exactly what we expect.
    const parsed = new URL(url as string);
    const cql = parsed.searchParams.get("cql");
    expect(cql).toBe('type = "space" AND text ~ "platform"');
  });

  it("escapes embedded quotes in the query (no CQL injection)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { results: [], _links: {} }));
    const ctx = makeCtx(fetchImpl);

    await spaceSearchHandler(ctx, { query: 'foo " OR text ~ "bar' });

    const [url] = fetchImpl.mock.calls[0]!;
    const parsed = new URL(url as string);
    const cql = parsed.searchParams.get("cql");
    // Inner double quotes must be escaped — re-parsed CQL is still one literal.
    expect(cql).toBe('type = "space" AND text ~ "foo \\" OR text ~ \\"bar"');
  });

  it("type filter is applied post-hoc and CQL is unchanged", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [
          { id: "1", type: "global", title: "Glob", space: { key: "G" } },
          { id: "2", type: "personal", title: "Pers", space: { key: "P" } },
        ],
        start: 0,
        limit: 25,
        size: 2,
        _links: {},
      }),
    );
    const ctx = makeCtx(fetchImpl);

    const res = await spaceSearchHandler(ctx, { query: "anything", type: "global" });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.values).toHaveLength(1);
    expect(res.data.values[0]?.key).toBe("G");

    const [url] = fetchImpl.mock.calls[0]!;
    const cql = new URL(url as string).searchParams.get("cql");
    // CQL doesn't carry the type filter — kept simple, per file-level comment.
    expect(cql).toBe('type = "space" AND text ~ "anything"');
  });

  it("middle page: round-trips v1 cursor and produces a next cursor", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [{ id: "9", type: "space", title: "X", space: { key: "X" } }],
        start: 25,
        limit: 25,
        size: 100,
        _links: { next: "/rest/api/content/search?start=50&limit=25" },
      }),
    );
    const ctx = makeCtx(fetchImpl);

    const res = await spaceSearchHandler(ctx, { query: "x", cursor: "v1:25", pagelen: 25 });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.next_cursor).toBe("v1:50");
    expect(res.data.total).toBe(100);

    const [url] = fetchImpl.mock.calls[0]!;
    const parsed = new URL(url as string);
    expect(parsed.searchParams.get("start")).toBe("25");
    expect(parsed.searchParams.get("limit")).toBe("25");
  });

  it("last page: next_cursor is null", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [{ id: "1", type: "space", title: "A", space: { key: "A" } }],
        start: 0,
        limit: 25,
        size: 1,
        _links: {},
      }),
    );
    const ctx = makeCtx(fetchImpl);

    const res = await spaceSearchHandler(ctx, { query: "a" });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.next_cursor).toBeNull();
  });

  it("rejects empty query with validation error and no HTTP call", async () => {
    const fetchImpl = vi.fn();
    const ctx = makeCtx(fetchImpl);

    const res = await spaceSearchHandler(ctx, { query: "" });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects missing query", async () => {
    const fetchImpl = vi.fn();
    const ctx = makeCtx(fetchImpl);

    const res = await spaceSearchHandler(ctx, {});

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps 401 → unauthorized", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(401, { message: "no" }));
    const ctx = makeCtx(fetchImpl);

    const res = await spaceSearchHandler(ctx, { query: "x" });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("unauthorized");
  });

  it("maps 429 with retry_after", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { message: "wait" }, { "Retry-After": "3" }));
    const ctx = makeCtx(fetchImpl);

    const res = await spaceSearchHandler(ctx, { query: "x" });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("rate_limited");
      expect(res.error.retry_after).toBe(3);
    }
  });

  it("maps 5xx → server_error retryable=true", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(502, { message: "bad gateway" }));
    const ctx = makeCtx(fetchImpl);

    const res = await spaceSearchHandler(ctx, { query: "x" });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("server_error");
      expect(res.error.retryable).toBe(true);
    }
  });
});
