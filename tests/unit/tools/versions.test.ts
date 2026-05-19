import { describe, expect, it, vi } from "vitest";
import { ConfluenceClient } from "../../../src/confluence/client.js";
import { getVersionToolDefinitions } from "../../../src/tools/versions.js";

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
      token: "ATATT_TEST_TOKEN_DDDD",
      savedAt: "now",
    },
    fetchImpl: fetchImpl as unknown as typeof fetch,
    maxRetries: 0,
    backoffBaseMs: 0,
  });
  return { client };
}

function getTool(name: string) {
  const def = getVersionToolDefinitions().find((t) => t.name === name);
  if (!def) throw new Error(`Tool not registered: ${name}`);
  return def;
}

// =====================================================================
// page_versions_list
// =====================================================================

describe("page_versions_list", () => {
  it("happy path: v2 GET /pages/{id}/versions, maps fields", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [
          {
            number: 3,
            createdAt: "2026-05-10T00:00:00Z",
            authorId: "user-a",
            message: "tweak",
            minorEdit: false,
          },
          {
            number: 2,
            createdAt: "2026-05-09T00:00:00Z",
            authorId: "user-b",
            minorEdit: true,
          },
        ],
        _links: { next: null },
      }),
    );
    const tool = getTool("page_versions_list");
    const res = await tool.handler(makeCtx(fetchImpl), { page_id: "p1" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const d = res.data as {
        values: { number: number; created_at?: string; message?: string; minor_edit?: boolean }[];
        next_cursor: string | null;
      };
      expect(d.values.length).toBe(2);
      expect(d.values[0]?.number).toBe(3);
      expect(d.values[0]?.message).toBe("tweak");
      expect(d.values[0]?.minor_edit).toBe(false);
      expect(d.next_cursor).toBeNull();
    }
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain("/wiki/api/v2/pages/p1/versions");
    expect(url).toContain("limit=25");
  });

  it("middle page passes cursor and returns next_cursor", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        results: [{ number: 1, createdAt: "2026-05-01T00:00:00Z", authorId: "user-a" }],
        _links: { next: "/wiki/api/v2/pages/p1/versions?cursor=NXT&limit=25" },
      }),
    );
    const tool = getTool("page_versions_list");
    const res = await tool.handler(makeCtx(fetchImpl), {
      page_id: "p1",
      cursor: "PREV",
    });
    expect(res.ok).toBe(true);
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain("cursor=PREV");
    if (res.ok) {
      const d = res.data as { next_cursor: string | null };
      expect(d.next_cursor).toBe("NXT");
    }
  });

  it("404 → not_found", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(404, { message: "nope" }));
    const tool = getTool("page_versions_list");
    const res = await tool.handler(makeCtx(fetchImpl), { page_id: "missing" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });

  it("401 → unauthorized with auth hint", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(401, { message: "bad" }));
    const tool = getTool("page_versions_list");
    const res = await tool.handler(makeCtx(fetchImpl), { page_id: "p1" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("unauthorized");
      expect(res.error.message).toContain("auth login");
    }
  });

  it("403 → forbidden", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(403, { message: "denied" }));
    const tool = getTool("page_versions_list");
    const res = await tool.handler(makeCtx(fetchImpl), { page_id: "p1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden");
  });

  it("429 with Retry-After surfaces rate_limited", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { message: "slow" }, { "Retry-After": "12" }));
    const tool = getTool("page_versions_list");
    const res = await tool.handler(makeCtx(fetchImpl), { page_id: "p1" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("rate_limited");
      expect(res.error.retry_after).toBe(12);
      expect(res.error.retryable).toBe(true);
    }
  });

  it("5xx → server_error retryable", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(503, { message: "down" }));
    const tool = getTool("page_versions_list");
    const res = await tool.handler(makeCtx(fetchImpl), { page_id: "p1" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("server_error");
      expect(res.error.retryable).toBe(true);
    }
  });

  it("validation: missing page_id rejected before HTTP", async () => {
    const fetchImpl = vi.fn();
    const tool = getTool("page_versions_list");
    const res = await tool.handler(makeCtx(fetchImpl), {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// =====================================================================
// page_version_get
// =====================================================================

describe("page_version_get", () => {
  it("happy path: v1 /content/{id}?version=N with body.storage expand", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        id: "p1",
        title: "Snapshot",
        status: "current",
        space: { id: 9001, key: "DEV" },
        body: { storage: { value: "<p>v2 content</p>" } },
        version: {
          number: 2,
          when: "2026-04-01T00:00:00Z",
          by: { accountId: "user-x", displayName: "User X" },
        },
        ancestors: [{ id: "root" }, { id: "p0" }],
      }),
    );
    const tool = getTool("page_version_get");
    const res = await tool.handler(makeCtx(fetchImpl), { page_id: "p1", version: 2 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const d = res.data as {
        id: string;
        body_storage: string;
        version: { number: number; created_by?: { account_id?: string } };
        space_key: string | null;
      };
      expect(d.id).toBe("p1");
      expect(d.body_storage).toBe("<p>v2 content</p>");
      expect(d.version.number).toBe(2);
      expect(d.version.created_by?.account_id).toBe("user-x");
      expect(d.space_key).toBe("DEV");
    }
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain("/wiki/rest/api/content/p1");
    expect(url).toContain("version=2");
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain("body.storage");
  });

  it("404 → not_found", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(404, { message: "no version" }));
    const tool = getTool("page_version_get");
    const res = await tool.handler(makeCtx(fetchImpl), { page_id: "p1", version: 99 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });

  it("validation: version must be ≥ 1", async () => {
    const fetchImpl = vi.fn();
    const tool = getTool("page_version_get");
    const res = await tool.handler(makeCtx(fetchImpl), { page_id: "p1", version: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("validation: page_id required", async () => {
    const fetchImpl = vi.fn();
    const tool = getTool("page_version_get");
    const res = await tool.handler(makeCtx(fetchImpl), { version: 2 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
