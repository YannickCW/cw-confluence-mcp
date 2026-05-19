import { describe, expect, it, vi } from "vitest";
import { ConfluenceClient } from "../../../src/confluence/client.js";
import { getLabelToolDefinitions } from "../../../src/tools/labels.js";

// ---------- Helpers ----------

function makeClient(fetchImpl: ReturnType<typeof vi.fn>) {
  return new ConfluenceClient({
    creds: {
      site: "x.atlassian.net",
      email: "y@example.com",
      token: "ATATT_TEST_TOKEN",
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

function getTool(name: string) {
  const defs = getLabelToolDefinitions();
  const def = defs.find((d) => d.name === name);
  if (!def) throw new Error(`tool ${name} not registered`);
  return def;
}

function parseQs(url: string): URLSearchParams {
  const qi = url.indexOf("?");
  return new URLSearchParams(qi === -1 ? "" : url.slice(qi + 1));
}

// =================================================================
// HARD NON-GOALS (§1)
// =================================================================

describe("labels tools — hard non-goals (§1)", () => {
  it("does NOT register label_add", () => {
    const names = getLabelToolDefinitions().map((d) => d.name);
    expect(names).not.toContain("label_add");
  });

  it("does NOT register label_remove", () => {
    const names = getLabelToolDefinitions().map((d) => d.name);
    expect(names).not.toContain("label_remove");
  });

  it("exposes exactly the two read-only tools", () => {
    const names = getLabelToolDefinitions().map((d) => d.name).sort();
    expect(names).toEqual(["labels_list", "pages_by_label"]);
  });
});

// =================================================================
// labels_list
// =================================================================

describe("labels_list", () => {
  it("happy path: v2 GET /pages/{id}/labels, maps to { id, name, prefix }", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [
          { id: "100", name: "runbook", prefix: "global" },
          { id: "101", name: "team-x", prefix: "team" },
        ],
        _links: { next: null },
      }),
    );
    const client = makeClient(fetchImpl);
    const tool = getTool("labels_list");
    const res = await tool.handler({ page_id: "P1" }, { client });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unexpected fail");
    const data = res.data as { values: Array<{ id?: string; name: string; prefix: string }>; next_cursor: string | null };
    expect(data.values).toEqual([
      { id: "100", name: "runbook", prefix: "global" },
      { id: "101", name: "team-x", prefix: "team" },
    ]);
    expect(data.next_cursor).toBeNull();

    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain("/wiki/api/v2/pages/P1/labels");
    expect(parseQs(url).get("limit")).toBe("25");
  });

  it("URL-encodes the page_id", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { results: [], _links: { next: null } }));
    const client = makeClient(fetchImpl);
    const tool = getTool("labels_list");
    await tool.handler({ page_id: "page id/with space" }, { client });
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain("/pages/page%20id%2Fwith%20space/labels");
  });

  it("validates inputs before any HTTP call (missing page_id)", async () => {
    const fetchImpl = vi.fn();
    const client = makeClient(fetchImpl);
    const tool = getTool("labels_list");
    const res = await tool.handler({}, { client });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unexpected ok");
    expect(res.error.code).toBe("validation");
    expect(res.error.status).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("validates inputs before any HTTP call (empty page_id)", async () => {
    const fetchImpl = vi.fn();
    const client = makeClient(fetchImpl);
    const tool = getTool("labels_list");
    const res = await tool.handler({ page_id: "" }, { client });
    expect(res.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("validates inputs before any HTTP call (pagelen out of range)", async () => {
    const fetchImpl = vi.fn();
    const client = makeClient(fetchImpl);
    const tool = getTool("labels_list");
    const res = await tool.handler({ page_id: "P1", pagelen: 500 }, { client });
    expect(res.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("pagination — first page extracts next_cursor", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [{ id: "1", name: "a", prefix: "global" }],
        _links: { next: "/wiki/api/v2/pages/P1/labels?cursor=NEXT&limit=25" },
      }),
    );
    const client = makeClient(fetchImpl);
    const tool = getTool("labels_list");
    const res = await tool.handler({ page_id: "P1" }, { client });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unexpected fail");
    expect((res.data as { next_cursor: string | null }).next_cursor).toBe("NEXT");
  });

  it("pagination — middle page forwards cursor and extracts next", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [{ id: "2", name: "b", prefix: "global" }],
        _links: { next: "/wiki/api/v2/pages/P1/labels?cursor=NEXT2&limit=25" },
      }),
    );
    const client = makeClient(fetchImpl);
    const tool = getTool("labels_list");
    const res = await tool.handler({ page_id: "P1", cursor: "CUR1", pagelen: 10 }, { client });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unexpected fail");
    const url = fetchImpl.mock.calls[0]![0] as string;
    const qs = parseQs(url);
    expect(qs.get("cursor")).toBe("CUR1");
    expect(qs.get("limit")).toBe("10");
    expect((res.data as { next_cursor: string | null }).next_cursor).toBe("NEXT2");
  });

  it("pagination — last page returns next_cursor=null", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { results: [{ id: "9", name: "z", prefix: "global" }], _links: {} }),
      );
    const client = makeClient(fetchImpl);
    const tool = getTool("labels_list");
    const res = await tool.handler({ page_id: "P1" }, { client });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unexpected fail");
    expect((res.data as { next_cursor: string | null }).next_cursor).toBeNull();
  });

  it("defaults prefix when missing from API payload", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [{ id: "1", name: "no-prefix" }],
        _links: { next: null },
      }),
    );
    const client = makeClient(fetchImpl);
    const tool = getTool("labels_list");
    const res = await tool.handler({ page_id: "P1" }, { client });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unexpected fail");
    const data = res.data as { values: Array<{ prefix: string }> };
    expect(data.values[0]!.prefix).toBe("global");
  });

  it("error mapping — 401 → unauthorized with auth hint", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(401, { message: "bad token" }));
    const client = makeClient(fetchImpl);
    const tool = getTool("labels_list");
    const res = await tool.handler({ page_id: "P1" }, { client });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unexpected ok");
    expect(res.error.code).toBe("unauthorized");
    expect(res.error.status).toBe(401);
    expect(res.error.message).toContain("cw-confluence-mcp auth login");
  });

  it("error mapping — 403 → forbidden", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(403, { message: "denied" }));
    const client = makeClient(fetchImpl);
    const tool = getTool("labels_list");
    const res = await tool.handler({ page_id: "P1" }, { client });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unexpected ok");
    expect(res.error.code).toBe("forbidden");
  });

  it("error mapping — 404 → not_found", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { errors: [{ title: "Not Found" }] }));
    const client = makeClient(fetchImpl);
    const tool = getTool("labels_list");
    const res = await tool.handler({ page_id: "DOES_NOT_EXIST" }, { client });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unexpected ok");
    expect(res.error.code).toBe("not_found");
  });

  it("error mapping — 429 with Retry-After propagates retry_after", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(429, { message: "slow down" }, { "Retry-After": "7" }));
    const client = makeClient(fetchImpl);
    const tool = getTool("labels_list");
    const res = await tool.handler({ page_id: "P1" }, { client });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unexpected ok");
    expect(res.error.code).toBe("rate_limited");
    expect(res.error.retryable).toBe(true);
    expect(res.error.retry_after).toBe(7);
  });

  it("error mapping — 5xx → server_error retryable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(503, { message: "down" }));
    const client = makeClient(fetchImpl);
    const tool = getTool("labels_list");
    const res = await tool.handler({ page_id: "P1" }, { client });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unexpected ok");
    expect(res.error.code).toBe("server_error");
    expect(res.error.retryable).toBe(true);
  });
});

// =================================================================
// pages_by_label
// =================================================================

describe("pages_by_label", () => {
  it("happy path: v1 CQL search; composes label filter", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [
          {
            id: "100",
            title: "Runbook A",
            type: "page",
            status: "current",
            space: { key: "DEV" },
            ancestors: [{ id: "1" }, { id: "50" }],
          },
        ],
        start: 0,
        limit: 25,
        size: 1,
        _links: {},
      }),
    );
    const client = makeClient(fetchImpl);
    const tool = getTool("pages_by_label");
    const res = await tool.handler({ label: "runbook" }, { client });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unexpected fail");
    const data = res.data as {
      values: Array<{ id: string; title: string; space_key?: string; parent_id?: string; status: string }>;
      next_cursor: string | null;
      total?: number;
    };
    expect(data.values).toEqual([
      { id: "100", title: "Runbook A", space_key: "DEV", parent_id: "50", status: "current" },
    ]);
    expect(data.next_cursor).toBeNull();
    expect(data.total).toBe(1);

    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain("/wiki/rest/api/content/search");
    const cql = parseQs(url).get("cql");
    expect(cql).toBe('type = "page" AND label = "runbook"');
  });

  it("composes cql with space filter when provided", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { results: [], start: 0, limit: 25, size: 0, _links: {} }));
    const client = makeClient(fetchImpl);
    const tool = getTool("pages_by_label");
    await tool.handler({ label: "runbook", space: "DEV" }, { client });
    const url = fetchImpl.mock.calls[0]![0] as string;
    const cql = parseQs(url).get("cql");
    expect(cql).toBe('type = "page" AND space = "DEV" AND label = "runbook"');
  });

  it("escapes labels with embedded quotes so cql cannot be injected", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { results: [], start: 0, limit: 25, size: 0, _links: {} }));
    const client = makeClient(fetchImpl);
    const tool = getTool("pages_by_label");
    await tool.handler({ label: 'evil" OR 1=1' }, { client });
    const url = fetchImpl.mock.calls[0]![0] as string;
    const cql = parseQs(url).get("cql");
    expect(cql).toBe('type = "page" AND label = "evil\\" OR 1=1"');
  });

  it("rejects malformed space (newline) before HTTP", async () => {
    const fetchImpl = vi.fn();
    const client = makeClient(fetchImpl);
    const tool = getTool("pages_by_label");
    const res = await tool.handler({ label: "x", space: "DEV\nbad" }, { client });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unexpected ok");
    expect(res.error.code).toBe("validation");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("validates inputs before any HTTP call (missing label)", async () => {
    const fetchImpl = vi.fn();
    const client = makeClient(fetchImpl);
    const tool = getTool("pages_by_label");
    const res = await tool.handler({}, { client });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unexpected ok");
    expect(res.error.code).toBe("validation");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("validates inputs before any HTTP call (empty label)", async () => {
    const fetchImpl = vi.fn();
    const client = makeClient(fetchImpl);
    const tool = getTool("pages_by_label");
    const res = await tool.handler({ label: "" }, { client });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unexpected ok");
    expect(res.error.code).toBe("validation");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("pagination — first page yields next_cursor=v1:25", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [{ id: "1", title: "p1", status: "current", space: { key: "DEV" } }],
        start: 0,
        limit: 25,
        size: 60,
        _links: { next: "/rest/api/content/search?start=25&limit=25" },
      }),
    );
    const client = makeClient(fetchImpl);
    const tool = getTool("pages_by_label");
    const res = await tool.handler({ label: "runbook" }, { client });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unexpected fail");
    const data = res.data as { next_cursor: string | null; total?: number };
    expect(data.next_cursor).toBe("v1:25");
    expect(data.total).toBe(60);

    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(parseQs(url).get("start")).toBe("0");
    expect(parseQs(url).get("limit")).toBe("25");
  });

  it("pagination — middle page forwards v1 cursor into start", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [{ id: "2", title: "p2", status: "current", space: { key: "DEV" } }],
        start: 25,
        limit: 25,
        size: 60,
        _links: { next: "/rest/api/content/search?start=50&limit=25" },
      }),
    );
    const client = makeClient(fetchImpl);
    const tool = getTool("pages_by_label");
    const res = await tool.handler({ label: "runbook", cursor: "v1:25" }, { client });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unexpected fail");
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(parseQs(url).get("start")).toBe("25");
    expect((res.data as { next_cursor: string | null }).next_cursor).toBe("v1:50");
  });

  it("pagination — last page yields next_cursor=null", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [{ id: "3", title: "p3", status: "current", space: { key: "DEV" } }],
        start: 50,
        limit: 25,
        size: 60,
        _links: {},
      }),
    );
    const client = makeClient(fetchImpl);
    const tool = getTool("pages_by_label");
    const res = await tool.handler({ label: "runbook", cursor: "v1:50" }, { client });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unexpected fail");
    expect((res.data as { next_cursor: string | null }).next_cursor).toBeNull();
  });

  it("maps page entries with no ancestors → no parent_id", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [{ id: "5", title: "root", status: "current", space: { key: "DEV" }, ancestors: [] }],
        start: 0,
        limit: 25,
        size: 1,
        _links: {},
      }),
    );
    const client = makeClient(fetchImpl);
    const tool = getTool("pages_by_label");
    const res = await tool.handler({ label: "runbook" }, { client });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unexpected fail");
    const data = res.data as { values: Array<{ id: string; parent_id?: string }> };
    expect(data.values[0]!.parent_id).toBeUndefined();
  });

  it("error mapping — 401 → unauthorized", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(401, { message: "bad" }));
    const client = makeClient(fetchImpl);
    const tool = getTool("pages_by_label");
    const res = await tool.handler({ label: "x" }, { client });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unexpected ok");
    expect(res.error.code).toBe("unauthorized");
  });

  it("error mapping — 403 → forbidden", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(403, { message: "no" }));
    const client = makeClient(fetchImpl);
    const tool = getTool("pages_by_label");
    const res = await tool.handler({ label: "x" }, { client });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unexpected ok");
    expect(res.error.code).toBe("forbidden");
  });

  it("error mapping — 404 → not_found", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(404, { message: "missing" }));
    const client = makeClient(fetchImpl);
    const tool = getTool("pages_by_label");
    const res = await tool.handler({ label: "x" }, { client });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unexpected ok");
    expect(res.error.code).toBe("not_found");
  });

  it("error mapping — 429 with Retry-After", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(429, { message: "slow" }, { "Retry-After": "3" }));
    const client = makeClient(fetchImpl);
    const tool = getTool("pages_by_label");
    const res = await tool.handler({ label: "x" }, { client });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unexpected ok");
    expect(res.error.code).toBe("rate_limited");
    expect(res.error.retry_after).toBe(3);
    expect(res.error.retryable).toBe(true);
  });

  it("error mapping — 5xx → server_error retryable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { message: "boom" }));
    const client = makeClient(fetchImpl);
    const tool = getTool("pages_by_label");
    const res = await tool.handler({ label: "x" }, { client });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unexpected ok");
    expect(res.error.code).toBe("server_error");
    expect(res.error.retryable).toBe(true);
  });
});

// =================================================================
// Tool definitions surface
// =================================================================

describe("getLabelToolDefinitions — surface", () => {
  it("labels_list inputSchema requires page_id", () => {
    const def = getTool("labels_list");
    const schema = def.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
    expect(schema.required).toContain("page_id");
    expect(schema.properties).toHaveProperty("page_id");
    expect(schema.properties).toHaveProperty("pagelen");
  });

  it("pages_by_label inputSchema requires label", () => {
    const def = getTool("pages_by_label");
    const schema = def.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
    expect(schema.required).toContain("label");
    expect(schema.properties).toHaveProperty("label");
    expect(schema.properties).toHaveProperty("space");
  });

  it("descriptions mention read-only intent", () => {
    for (const def of getLabelToolDefinitions()) {
      expect(def.description.toLowerCase()).toContain("read-only");
    }
  });
});
