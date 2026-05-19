import { describe, expect, it, vi } from "vitest";
import { ConfluenceClient } from "../../../src/confluence/client.js";
import { getPageToolDefinitions } from "../../../src/tools/pages.js";
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
      token: "ATATT_TEST_TOKEN_CCCC",
      savedAt: "now",
    },
    fetchImpl: fetchImpl as unknown as typeof fetch,
    maxRetries: 0,
    backoffBaseMs: 0,
  });
  return { client };
}

function getTool(name: string) {
  const def = [...getPageToolDefinitions(), ...getVersionToolDefinitions()].find(
    (t) => t.name === name,
  );
  if (!def) throw new Error(`Tool not registered: ${name}`);
  return def;
}

// =====================================================================
// page_create
// =====================================================================

describe("page_create", () => {
  it("happy path: resolves space key → id, defaults parent to homepage, creates page", async () => {
    const fetchImpl = vi
      .fn()
      // 1) resolve space key → id
      .mockResolvedValueOnce(
        jsonResponse(200, { results: [{ id: "9001", key: "DEV", homepageId: "home1" }] }),
      )
      // 2) lookup space for homepage (since parent_id not given)
      .mockResolvedValueOnce(jsonResponse(200, { id: "9001", key: "DEV", homepageId: "home1" }))
      // 3) POST /pages
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "newp",
          title: "Created",
          status: "current",
          spaceId: "9001",
          parentId: "home1",
          body: { storage: { value: "<p>hi</p>" } },
          version: { number: 1 },
        }),
      );
    const tool = getTool("page_create");
    const res = await tool.handler(makeCtx(fetchImpl), {
      space: "DEV",
      title: "Created",
      body_storage: "<p>hi</p>",
    });
    expect(res.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const [createUrl, createInit] = fetchImpl.mock.calls[2]!;
    expect(createUrl).toBe("https://x.atlassian.net/wiki/api/v2/pages");
    const init = createInit as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.spaceId).toBe("9001");
    expect(body.status).toBe("current");
    expect(body.title).toBe("Created");
    expect(body.parentId).toBe("home1");
    expect((body.body as Record<string, unknown>).representation).toBe("storage");
  });

  it("uses provided parent_id (no homepage lookup)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { results: [{ id: "9001", key: "DEV" }] }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "newp",
          title: "X",
          status: "current",
          spaceId: "9001",
          parentId: "p99",
          body: { storage: { value: "" } },
          version: { number: 1 },
        }),
      );
    const tool = getTool("page_create");
    const res = await tool.handler(makeCtx(fetchImpl), {
      space: "DEV",
      title: "X",
      body_storage: "",
      parent_id: "p99",
    });
    expect(res.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const body = JSON.parse((fetchImpl.mock.calls[1]![1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(body.parentId).toBe("p99");
  });

  it("labels: applied via v1 POST /content/{id}/label AFTER page creation, in given order", async () => {
    const fetchImpl = vi
      .fn()
      // resolve space
      .mockResolvedValueOnce(jsonResponse(200, { results: [{ id: "9001", key: "DEV" }] }))
      // create page (no homepage call because parent_id given)
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "newp",
          title: "X",
          status: "current",
          spaceId: "9001",
          parentId: "p99",
          body: { storage: { value: "" } },
          version: { number: 1 },
        }),
      )
      // label 1
      .mockResolvedValueOnce(
        jsonResponse(200, { results: [{ name: "alpha", prefix: "global" }] }),
      )
      // label 2
      .mockResolvedValueOnce(
        jsonResponse(200, { results: [{ name: "beta", prefix: "global" }] }),
      );
    const tool = getTool("page_create");
    const res = await tool.handler(makeCtx(fetchImpl), {
      space: "DEV",
      title: "X",
      body_storage: "",
      parent_id: "p99",
      labels: ["alpha", "beta"],
    });
    expect(res.ok).toBe(true);

    // Order: resolve(0) → create(1) → label alpha(2) → label beta(3)
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const [createUrl] = fetchImpl.mock.calls[1]!;
    const [labelUrl1, labelInit1] = fetchImpl.mock.calls[2]!;
    const [labelUrl2, labelInit2] = fetchImpl.mock.calls[3]!;
    expect(createUrl).toContain("/wiki/api/v2/pages");
    expect(labelUrl1).toContain("/wiki/rest/api/content/newp/label");
    expect(labelUrl2).toContain("/wiki/rest/api/content/newp/label");
    expect((labelInit1 as RequestInit).method).toBe("POST");
    const labelBody1 = JSON.parse((labelInit1 as RequestInit).body as string) as Array<{
      name: string;
      prefix: string;
    }>;
    expect(labelBody1[0]?.name).toBe("alpha");
    const labelBody2 = JSON.parse((labelInit2 as RequestInit).body as string) as Array<{
      name: string;
    }>;
    expect(labelBody2[0]?.name).toBe("beta");

    if (res.ok) {
      const d = res.data as { labels: { name: string }[]; labels_warning?: string };
      expect(d.labels.map((l) => l.name)).toContain("alpha");
      expect(d.labels.map((l) => l.name)).toContain("beta");
      expect(d.labels_warning).toBeUndefined();
    }
  });

  it("partial label failure: returns page with labels_warning, does not fail whole create", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { results: [{ id: "9001", key: "DEV" }] }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "newp",
          title: "X",
          status: "current",
          spaceId: "9001",
          parentId: "p99",
          body: { storage: { value: "" } },
          version: { number: 1 },
        }),
      )
      // label 1 ok
      .mockResolvedValueOnce(jsonResponse(200, { results: [{ name: "ok", prefix: "global" }] }))
      // label 2 fails 403
      .mockResolvedValueOnce(jsonResponse(403, { message: "no perms" }));
    const tool = getTool("page_create");
    const res = await tool.handler(makeCtx(fetchImpl), {
      space: "DEV",
      title: "X",
      body_storage: "",
      parent_id: "p99",
      labels: ["ok", "bad"],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const d = res.data as { labels_warning?: string };
      expect(d.labels_warning).toBeDefined();
      expect(d.labels_warning).toContain("bad");
    }
  });

  it("validation: missing title rejected before HTTP", async () => {
    const fetchImpl = vi.fn();
    const tool = getTool("page_create");
    const res = await tool.handler(makeCtx(fetchImpl), {
      space: "DEV",
      body_storage: "<p>hi</p>",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("validation: empty title rejected before HTTP", async () => {
    const fetchImpl = vi.fn();
    const tool = getTool("page_create");
    const res = await tool.handler(makeCtx(fetchImpl), {
      space: "DEV",
      title: "",
      body_storage: "x",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("404 when space not found (during resolution)", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { results: [] }));
    const tool = getTool("page_create");
    const res = await tool.handler(makeCtx(fetchImpl), {
      space: "MISS",
      title: "x",
      body_storage: "y",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation");
  });
});

// =====================================================================
// page_update — the most important suite
// =====================================================================

describe("page_update — forbidden fields (no HTTP)", () => {
  it("rejects `status` with forbidden_field before any HTTP call", async () => {
    const fetchImpl = vi.fn();
    const tool = getTool("page_update");
    const res = await tool.handler(makeCtx(fetchImpl), {
      page_id: "p1",
      title: "T",
      body_storage: "b",
      status: "archived",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("forbidden_field");
      expect(res.error.message).toContain("status");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects `parent_id` with forbidden_field before any HTTP call", async () => {
    const fetchImpl = vi.fn();
    const tool = getTool("page_update");
    const res = await tool.handler(makeCtx(fetchImpl), {
      page_id: "p1",
      title: "T",
      body_storage: "b",
      parent_id: "p99",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("forbidden_field");
      expect(res.error.message).toContain("parent_id");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects `space_key` with forbidden_field before any HTTP call", async () => {
    const fetchImpl = vi.fn();
    const tool = getTool("page_update");
    const res = await tool.handler(makeCtx(fetchImpl), {
      page_id: "p1",
      title: "T",
      body_storage: "b",
      space_key: "DEV",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden_field");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects `version_message` with forbidden_field before any HTTP call", async () => {
    const fetchImpl = vi.fn();
    const tool = getTool("page_update");
    const res = await tool.handler(makeCtx(fetchImpl), {
      page_id: "p1",
      title: "T",
      body_storage: "b",
      version_message: "tweak",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden_field");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects any made-up field with forbidden_field before any HTTP call", async () => {
    const fetchImpl = vi.fn();
    const tool = getTool("page_update");
    const res = await tool.handler(makeCtx(fetchImpl), {
      page_id: "p1",
      title: "T",
      body_storage: "b",
      arbitrary_extra: "nope",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("forbidden_field");
      expect(res.error.message).toContain("arbitrary_extra");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("page_update — auto-version flow", () => {
  it("fetches current version, increments, sends PUT with version.number = current + 1", async () => {
    const fetchImpl = vi
      .fn()
      // GET current page (returns version 4)
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "p1",
          title: "Old",
          status: "current",
          spaceId: "9001",
          version: { number: 4 },
          body: { storage: { value: "<p>old</p>" } },
        }),
      )
      // PUT update
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "p1",
          title: "New",
          status: "current",
          spaceId: "9001",
          body: { storage: { value: "<p>new</p>" } },
          version: { number: 5 },
        }),
      )
      // GET /spaces/{id} for space key
      .mockResolvedValueOnce(jsonResponse(200, { id: "9001", key: "DEV" }));
    const tool = getTool("page_update");
    const res = await tool.handler(makeCtx(fetchImpl), {
      page_id: "p1",
      title: "New",
      body_storage: "<p>new</p>",
    });
    expect(res.ok).toBe(true);

    const [putUrl, putInit] = fetchImpl.mock.calls[1]!;
    expect(putUrl).toContain("/wiki/api/v2/pages/p1");
    expect((putInit as RequestInit).method).toBe("PUT");
    const body = JSON.parse((putInit as RequestInit).body as string) as {
      id: string;
      title: string;
      status: string;
      version: { number: number; message: string };
      body: { representation: string; value: string };
    };
    expect(body.id).toBe("p1");
    expect(body.status).toBe("current");
    expect(body.title).toBe("New");
    expect(body.body.representation).toBe("storage");
    expect(body.body.value).toBe("<p>new</p>");
    expect(body.version.number).toBe(5);
    expect(body.version.message).toBe("");
  });
});

describe("page_update — 409 conflict handling", () => {
  it("409-then-success: re-fetches and retries once", async () => {
    const fetchImpl = vi
      .fn()
      // GET v1 (version 2)
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "p1",
          title: "Old",
          status: "current",
          spaceId: "9001",
          version: { number: 2 },
        }),
      )
      // PUT 409
      .mockResolvedValueOnce(jsonResponse(409, { message: "conflict" }))
      // GET v2 (version 3 — someone else updated it)
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "p1",
          title: "Old2",
          status: "current",
          spaceId: "9001",
          version: { number: 3 },
        }),
      )
      // PUT success
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "p1",
          title: "New",
          status: "current",
          spaceId: "9001",
          body: { storage: { value: "<p>new</p>" } },
          version: { number: 4 },
        }),
      )
      // GET /spaces/{id} for space key
      .mockResolvedValueOnce(jsonResponse(200, { id: "9001", key: "DEV" }));
    const tool = getTool("page_update");
    const res = await tool.handler(makeCtx(fetchImpl), {
      page_id: "p1",
      title: "New",
      body_storage: "<p>new</p>",
    });
    expect(res.ok).toBe(true);
    // Outgoing versions: first PUT was 3 (from v2), second was 4 (from v3).
    const firstPutBody = JSON.parse((fetchImpl.mock.calls[1]![1] as RequestInit).body as string) as {
      version: { number: number };
    };
    const secondPutBody = JSON.parse((fetchImpl.mock.calls[3]![1] as RequestInit).body as string) as {
      version: { number: number };
    };
    expect(firstPutBody.version.number).toBe(3);
    expect(secondPutBody.version.number).toBe(4);
  });

  it("409-then-409: returns version_conflict, retryable=false", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "p1",
          title: "Old",
          status: "current",
          spaceId: "9001",
          version: { number: 2 },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(409, { message: "conflict 1" }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "p1",
          title: "Old2",
          status: "current",
          spaceId: "9001",
          version: { number: 3 },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(409, { message: "conflict 2" }));
    const tool = getTool("page_update");
    const res = await tool.handler(makeCtx(fetchImpl), {
      page_id: "p1",
      title: "New",
      body_storage: "<p>new</p>",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("version_conflict");
      expect(res.error.status).toBe(409);
      expect(res.error.retryable).toBe(false);
    }
    // No third PUT attempt.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("non-409 PUT error is surfaced as-is (e.g. 403)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "p1",
          title: "Old",
          status: "current",
          spaceId: "9001",
          version: { number: 2 },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(403, { message: "no perm" }));
    const tool = getTool("page_update");
    const res = await tool.handler(makeCtx(fetchImpl), {
      page_id: "p1",
      title: "New",
      body_storage: "<p>new</p>",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("page_update — input validation", () => {
  it("rejects empty page_id before HTTP", async () => {
    const fetchImpl = vi.fn();
    const tool = getTool("page_update");
    const res = await tool.handler(makeCtx(fetchImpl), {
      page_id: "",
      title: "x",
      body_storage: "y",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects empty title before HTTP", async () => {
    const fetchImpl = vi.fn();
    const tool = getTool("page_update");
    const res = await tool.handler(makeCtx(fetchImpl), {
      page_id: "p1",
      title: "",
      body_storage: "y",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// =====================================================================
// Hard non-goals (§1) — these tools must NOT be registered.
// =====================================================================

describe("hard non-goals — these are NOT registered tools", () => {
  const registered = new Set([
    ...getPageToolDefinitions().map((t) => t.name),
    ...getVersionToolDefinitions().map((t) => t.name),
  ]);

  it("page_delete is not a registered tool", () => {
    expect(registered.has("page_delete")).toBe(false);
  });

  it("page_move is not a registered tool", () => {
    expect(registered.has("page_move")).toBe(false);
  });

  it("page_archive / page_status_change is not a registered tool", () => {
    expect(registered.has("page_archive")).toBe(false);
    expect(registered.has("page_status_change")).toBe(false);
    expect(registered.has("page_set_status")).toBe(false);
  });

  it("page_version_restore is not a registered tool", () => {
    expect(registered.has("page_version_restore")).toBe(false);
    expect(registered.has("page_restore")).toBe(false);
  });

  it("page_update does not accept `parent_id`, `status`, `space_key`, or `version_message`", () => {
    // The forbidden-field tests above prove the runtime check; this assertion ensures
    // the public tool schema does not advertise these fields either.
    const tool = [...getPageToolDefinitions()].find((t) => t.name === "page_update")!;
    // Sniff out the zod object schema's shape.
    const shape = (tool.inputSchema as unknown as { shape?: Record<string, unknown> }).shape;
    expect(shape).toBeDefined();
    if (shape) {
      expect(Object.keys(shape).sort()).toEqual(["body_storage", "page_id", "title"]);
    }
  });
});
