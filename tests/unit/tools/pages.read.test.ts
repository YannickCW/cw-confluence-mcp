import { describe, expect, it, vi } from "vitest";
import { ConfluenceClient } from "../../../src/confluence/client.js";
import { getPageToolDefinitions } from "../../../src/tools/pages.js";

// Helpers ---------------------------------------------------------------

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function makeCtx(fetchImpl: ReturnType<typeof vi.fn>) {
  const client = new ConfluenceClient({
    creds: {
      site: "x.atlassian.net",
      email: "y@example.com",
      token: "ATATT_TEST_TOKEN_BBBB",
      savedAt: "now",
    },
    fetchImpl: fetchImpl as unknown as typeof fetch,
    maxRetries: 0,
    backoffBaseMs: 0,
  });
  return { client };
}

function getTool(name: string) {
  const def = getPageToolDefinitions().find((t) => t.name === name);
  if (!def) throw new Error(`Tool not registered: ${name}`);
  return def;
}

// =====================================================================
// page_list
// =====================================================================

describe("page_list", () => {
  it("happy path: resolves space key → id, fetches /spaces/{id}/pages", async () => {
    const fetchImpl = vi
      .fn()
      // 1) resolve space key → id
      .mockResolvedValueOnce(
        jsonResponse(200, { results: [{ id: "9001", key: "DEV", name: "Dev" }] }),
      )
      // 2) /spaces/9001/pages
      .mockResolvedValueOnce(
        jsonResponse(200, {
          results: [
            { id: "p1", title: "Page One", parentId: "p0", status: "current", spaceId: "9001" },
          ],
          _links: { next: null },
        }),
      );
    const tool = getTool("page_list");
    const res = await tool.handler(makeCtx(fetchImpl), { space: "DEV", pagelen: 25 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { values: { id: string; space_key?: string }[] };
      expect(data.values[0]?.id).toBe("p1");
      expect(data.values[0]?.space_key).toBe("DEV");
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url0] = fetchImpl.mock.calls[0]!;
    expect(url0).toContain("/wiki/api/v2/spaces");
    expect(url0).toContain("keys=DEV");
    const [url1] = fetchImpl.mock.calls[1]!;
    expect(url1).toContain("/wiki/api/v2/spaces/9001/pages");
    expect(url1).toContain("limit=25");
    expect(url1).toContain("status=current");
  });

  it("treats numeric space as id directly (skips key resolution)", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, { results: [], _links: { next: null } }),
    );
    const tool = getTool("page_list");
    const res = await tool.handler(makeCtx(fetchImpl), { space: "12345", pagelen: 25 });
    expect(res.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toContain("/wiki/api/v2/spaces/12345/pages");
  });

  it("propagates parent_id and sort", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { results: [{ id: "9001", key: "DEV" }] }))
      .mockResolvedValueOnce(jsonResponse(200, { results: [], _links: { next: null } }));
    const tool = getTool("page_list");
    await tool.handler(makeCtx(fetchImpl), {
      space: "DEV",
      parent_id: "p99",
      sort: "title",
      pagelen: 10,
    });
    const url = fetchImpl.mock.calls[1]![0] as string;
    expect(url).toContain("parent-id=p99");
    expect(url).toContain("sort=title");
    expect(url).toContain("limit=10");
  });

  it("with label filter, drops to v1 /content/search with composed CQL", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { results: [{ id: "9001", key: "DEV" }] }))
      .mockResolvedValueOnce(jsonResponse(200, { results: [], _links: { next: null } }))
      // v1 fallback for label filter
      .mockResolvedValueOnce(
        jsonResponse(200, {
          results: [
            {
              id: "p7",
              title: "Tagged",
              space: { id: 9001, key: "DEV" },
              status: "current",
            },
          ],
          start: 0,
          limit: 25,
          size: 1,
          _links: {},
        }),
      );
    const tool = getTool("page_list");
    const res = await tool.handler(makeCtx(fetchImpl), {
      space: "DEV",
      label: "runbook",
      pagelen: 25,
    });
    expect(res.ok).toBe(true);
    // The third call is the v1 search.
    const url = fetchImpl.mock.calls[2]![0] as string;
    expect(url).toContain("/wiki/rest/api/content/search");
    const qs = new URLSearchParams(url.split("?")[1] ?? "");
    const cql = qs.get("cql") ?? "";
    expect(cql).toContain('type = "page"');
    expect(cql).toContain('label = "runbook"');
    expect(cql).toContain('space = "DEV"');
  });

  it("404 on space resolution maps to not_found", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { errors: [{ title: "Not found" }] }));
    const tool = getTool("page_list");
    const res = await tool.handler(makeCtx(fetchImpl), { space: "MISS" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });

  it("validation rejects missing space before HTTP", async () => {
    const fetchImpl = vi.fn();
    const tool = getTool("page_list");
    const res = await tool.handler(makeCtx(fetchImpl), {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("pagination — first/middle/last cursor handling", async () => {
    // last page: next_cursor null
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { results: [{ id: "9001", key: "DEV" }] }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          results: [{ id: "p1", title: "x", status: "current", spaceId: "9001" }],
          _links: { next: null },
        }),
      );
    const tool = getTool("page_list");
    const res = await tool.handler(makeCtx(fetchImpl), { space: "DEV", pagelen: 25 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { next_cursor: string | null };
      expect(data.next_cursor).toBeNull();
    }
  });

  it("pagination — passes cursor through", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { results: [{ id: "9001", key: "DEV" }] }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          results: [{ id: "p2", title: "x", status: "current", spaceId: "9001" }],
          _links: { next: "/wiki/api/v2/spaces/9001/pages?cursor=NEXT&limit=25" },
        }),
      );
    const tool = getTool("page_list");
    const res = await tool.handler(makeCtx(fetchImpl), {
      space: "DEV",
      cursor: "PREV",
      pagelen: 25,
    });
    expect(res.ok).toBe(true);
    const pageListUrl = fetchImpl.mock.calls[1]![0] as string;
    expect(pageListUrl).toContain("cursor=PREV");
    if (res.ok) {
      const data = res.data as { next_cursor: string | null };
      expect(data.next_cursor).toBe("NEXT");
    }
  });
});

// =====================================================================
// page_get
// =====================================================================

describe("page_get", () => {
  it("happy path — v2 GET /pages/{id} with body-format=storage and include-labels", async () => {
    const fetchImpl = vi
      .fn()
      // 1) /pages/{id}
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "p1",
          title: "Hello",
          status: "current",
          spaceId: "9001",
          parentId: "p0",
          body: { storage: { value: "<p>hi</p>", representation: "storage" } },
          version: { number: 3, createdAt: "2026-05-01T00:00:00Z", authorId: "u1" },
          labels: { results: [{ name: "runbook", prefix: "global" }] },
          _links: { webui: "/x" },
        }),
      )
      // 2) /spaces/{spaceId} for space key
      .mockResolvedValueOnce(jsonResponse(200, { id: "9001", key: "DEV" }));
    const tool = getTool("page_get");
    const res = await tool.handler(makeCtx(fetchImpl), { page_id: "p1" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const d = res.data as {
        id: string;
        title: string;
        space_key: string | null;
        body_storage: string;
        version: { number: number };
        labels: { name: string; prefix?: string }[];
      };
      expect(d.id).toBe("p1");
      expect(d.title).toBe("Hello");
      expect(d.space_key).toBe("DEV");
      expect(d.body_storage).toBe("<p>hi</p>");
      expect(d.version.number).toBe(3);
      expect(d.labels[0]?.name).toBe("runbook");
    }
    const url0 = fetchImpl.mock.calls[0]![0] as string;
    expect(url0).toContain("/wiki/api/v2/pages/p1");
    expect(url0).toContain("body-format=storage");
    expect(url0).toContain("include-labels=true");
  });

  it("historical version drops to v1 /content/{id}?version=N", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        id: "p1",
        title: "Old",
        status: "current",
        space: { id: 9001, key: "DEV" },
        body: { storage: { value: "<p>old</p>" } },
        version: { number: 2, when: "2026-04-01T00:00:00Z" },
        ancestors: [{ id: "root" }, { id: "p0" }],
      }),
    );
    const tool = getTool("page_get");
    const res = await tool.handler(makeCtx(fetchImpl), { page_id: "p1", version: 2 });
    expect(res.ok).toBe(true);
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain("/wiki/rest/api/content/p1");
    expect(url).toContain("version=2");
    if (res.ok) {
      const d = res.data as { parent_id: string | null; version: { number: number } };
      // v1 ancestors: closest ancestor is the LAST item.
      expect(d.parent_id).toBe("p0");
      expect(d.version.number).toBe(2);
    }
  });

  it("404 → not_found", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(404, { message: "nope" }));
    const tool = getTool("page_get");
    const res = await tool.handler(makeCtx(fetchImpl), { page_id: "missing" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });

  it("401 → unauthorized with auth hint", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(401, { message: "bad" }));
    const tool = getTool("page_get");
    const res = await tool.handler(makeCtx(fetchImpl), { page_id: "p1" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("unauthorized");
      expect(res.error.message).toContain("auth login");
    }
  });

  it("validation rejects empty page_id before HTTP", async () => {
    const fetchImpl = vi.fn();
    const tool = getTool("page_get");
    const res = await tool.handler(makeCtx(fetchImpl), { page_id: "" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// =====================================================================
// page_get_children
// =====================================================================

describe("page_get_children", () => {
  it("happy path — v2 GET /pages/{id}/children", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [
          { id: "c1", title: "Child", status: "current" },
          { id: "c2", title: "Child2", status: "current" },
        ],
        _links: { next: null },
      }),
    );
    const tool = getTool("page_get_children");
    const res = await tool.handler(makeCtx(fetchImpl), { page_id: "p1" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const d = res.data as { values: { id: string }[]; next_cursor: string | null };
      expect(d.values.length).toBe(2);
      expect(d.next_cursor).toBeNull();
    }
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain("/wiki/api/v2/pages/p1/children");
  });

  it("middle page passes cursor and exposes next_cursor", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [{ id: "c1", title: "x", status: "current" }],
        _links: { next: "/wiki/api/v2/pages/p1/children?cursor=NXT&limit=25" },
      }),
    );
    const tool = getTool("page_get_children");
    const res = await tool.handler(makeCtx(fetchImpl), { page_id: "p1", cursor: "CUR" });
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain("cursor=CUR");
    if (res.ok) {
      const d = res.data as { next_cursor: string | null };
      expect(d.next_cursor).toBe("NXT");
    }
  });

  it("validation: missing page_id rejected before HTTP", async () => {
    const fetchImpl = vi.fn();
    const tool = getTool("page_get_children");
    const res = await tool.handler(makeCtx(fetchImpl), {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("403 → forbidden with auth hint", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(403, { message: "denied" }));
    const tool = getTool("page_get_children");
    const res = await tool.handler(makeCtx(fetchImpl), { page_id: "p1" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("forbidden");
      expect(res.error.message).toContain("auth login");
    }
  });
});

// =====================================================================
// page_get_ancestors
// =====================================================================

describe("page_get_ancestors", () => {
  it("returns ordered ancestor chain (not paginated)", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [
          { id: "p0", title: "Parent", status: "current" },
          { id: "root", title: "Root", status: "current" },
        ],
      }),
    );
    const tool = getTool("page_get_ancestors");
    const res = await tool.handler(makeCtx(fetchImpl), { page_id: "p1" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const d = res.data as { values: { id: string }[] };
      expect(d.values.map((v) => v.id)).toEqual(["p0", "root"]);
    }
  });

  it("404 → not_found", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(404, { message: "nope" }));
    const tool = getTool("page_get_ancestors");
    const res = await tool.handler(makeCtx(fetchImpl), { page_id: "missing" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });

  it("validation: empty page_id", async () => {
    const fetchImpl = vi.fn();
    const tool = getTool("page_get_ancestors");
    const res = await tool.handler(makeCtx(fetchImpl), { page_id: "" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// =====================================================================
// page_search
// =====================================================================

describe("page_search", () => {
  it("composes CQL from structured args (type=page + text + space + label)", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [
          {
            id: "p1",
            title: "Hit",
            status: "current",
            space: { id: 9001, key: "DEV" },
            excerpt: "kafka pipeline...",
            version: { number: 5, when: "2026-05-10T00:00:00Z" },
            _links: { webui: "/x" },
          },
        ],
        start: 0,
        limit: 25,
        size: 1,
        _links: {},
      }),
    );
    const tool = getTool("page_search");
    const res = await tool.handler(makeCtx(fetchImpl), {
      query: "kafka",
      space: "DEV",
      label: "runbook",
      pagelen: 25,
    });
    expect(res.ok).toBe(true);
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain("/wiki/rest/api/content/search");
    const qs = new URLSearchParams(url.split("?")[1] ?? "");
    const cql = qs.get("cql") ?? "";
    expect(cql).toContain('type = "page"');
    expect(cql).toContain('text ~ "kafka"');
    expect(cql).toContain('space = "DEV"');
    expect(cql).toContain('label = "runbook"');
    expect(cql).toContain(" AND ");
    if (res.ok) {
      const d = res.data as { values: { excerpt?: string; version?: { number: number } }[] };
      expect(d.values[0]?.excerpt).toBe("kafka pipeline...");
      expect(d.values[0]?.version?.number).toBe(5);
    }
  });

  it("composes CQL with title + updated_since + creator + status", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, { results: [], start: 0, limit: 25, size: 0, _links: {} }),
    );
    const tool = getTool("page_search");
    await tool.handler(makeCtx(fetchImpl), {
      title: "Runbook",
      updated_since: "2026-05-01",
      creator: "user-account-id-abc",
      status: "current",
    });
    const url = fetchImpl.mock.calls[0]![0] as string;
    const qs = new URLSearchParams(url.split("?")[1] ?? "");
    const cql = qs.get("cql") ?? "";
    expect(cql).toContain('title ~ "Runbook"');
    expect(cql).toContain('lastmodified >= "2026-05-01"');
    expect(cql).toContain('creator = "user-account-id-abc"');
    expect(cql).toContain('status = "current"');
  });

  it("rejects bad updated_since via validation (no HTTP)", async () => {
    const fetchImpl = vi.fn();
    const tool = getTool("page_search");
    const res = await tool.handler(makeCtx(fetchImpl), { updated_since: "not-a-date" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("escapes user input safely (no CQL injection via text)", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, { results: [], start: 0, limit: 25, size: 0, _links: {} }),
    );
    const tool = getTool("page_search");
    const res = await tool.handler(makeCtx(fetchImpl), { query: 'foo" OR ""="' });
    expect(res.ok).toBe(true);
    const url = fetchImpl.mock.calls[0]![0] as string;
    const qs = new URLSearchParams(url.split("?")[1] ?? "");
    const cql = qs.get("cql") ?? "";
    // The injected double quote must be escaped as \" inside the CQL literal.
    expect(cql).toContain('text ~ "foo\\" OR \\"\\"=\\""');
  });

  it("middle page: passes start (v1 cursor) and returns next_cursor", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [{ id: "p1", title: "x", status: "current", space: { id: 9001, key: "DEV" } }],
        start: 25,
        limit: 25,
        size: 60,
        _links: { next: "/rest/api/content/search?start=50&limit=25" },
      }),
    );
    const tool = getTool("page_search");
    const res = await tool.handler(makeCtx(fetchImpl), {
      query: "kafka",
      cursor: "v1:25",
      pagelen: 25,
    });
    expect(res.ok).toBe(true);
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain("start=25");
    if (res.ok) {
      const d = res.data as { next_cursor: string | null; total?: number };
      expect(d.next_cursor).toBe("v1:50");
      expect(d.total).toBe(60);
    }
  });

  it("last page → next_cursor=null", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [{ id: "p1", title: "x", status: "current", space: { id: 9001, key: "DEV" } }],
        start: 50,
        limit: 25,
        size: 51,
        _links: {},
      }),
    );
    const tool = getTool("page_search");
    const res = await tool.handler(makeCtx(fetchImpl), { query: "k" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const d = res.data as { next_cursor: string | null };
      expect(d.next_cursor).toBeNull();
    }
  });

  it("429 with Retry-After surfaces rate_limited", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { message: "slow" }, { "Retry-After": "7" }));
    const tool = getTool("page_search");
    const res = await tool.handler(makeCtx(fetchImpl), { query: "x" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("rate_limited");
      expect(res.error.retry_after).toBe(7);
      expect(res.error.retryable).toBe(true);
    }
  });

  it("5xx surfaces server_error and retryable=true", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(503, { message: "down" }));
    const tool = getTool("page_search");
    const res = await tool.handler(makeCtx(fetchImpl), { query: "x" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("server_error");
      expect(res.error.retryable).toBe(true);
    }
  });
});
