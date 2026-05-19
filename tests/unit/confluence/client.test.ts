import { describe, expect, it, vi } from "vitest";
import { ConfluenceClient } from "../../../src/confluence/client.js";
import { clearSecrets, redact } from "../../../src/shared/logger.js";

function makeClient(fetchImpl: ReturnType<typeof vi.fn>) {
  return new ConfluenceClient({
    creds: {
      site: "x.atlassian.net",
      email: "y@example.com",
      token: "ATATT_TEST_TOKEN_AAAA",
      savedAt: "now",
    },
    fetchImpl: fetchImpl as unknown as typeof fetch,
    maxRetries: 3,
    backoffBaseMs: 0,
  });
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("ConfluenceClient — request flow", () => {
  it("sends Basic auth header to v2 path with correct URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const client = makeClient(fetchImpl);

    const res = await client.v2<{ ok: boolean }>("/pages/123");
    expect(res.ok).toBe(true);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://x.atlassian.net/wiki/api/v2/pages/123");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Basic /);
    expect(headers.Accept).toBe("application/json");
  });

  it("v1 helper hits /wiki/rest/api/...", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const client = makeClient(fetchImpl);
    await client.v1("/content/123/restriction/byOperation");
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://x.atlassian.net/wiki/rest/api/content/123/restriction/byOperation");
  });

  it("serialises JSON body and sets Content-Type", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const client = makeClient(fetchImpl);
    await client.v2("/pages", { method: "POST", body: { title: "Hi" } });
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ title: "Hi" }));
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("appends a query object", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { results: [] }));
    const client = makeClient(fetchImpl);
    await client.v2("/pages", { query: { limit: "25", "space-id": "ABC" } });
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain("limit=25");
    expect(url).toContain("space-id=ABC");
  });

  it("handles 204 No Content", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = makeClient(fetchImpl);
    const res = await client.v2("/anything");
    expect(res.ok).toBe(true);
  });

  it("maps 404 → not_found", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { errors: [{ title: "Not Found", detail: "page" }] }));
    const client = makeClient(fetchImpl);
    const res = await client.v2("/pages/missing");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("not_found");
      expect(res.error.status).toBe(404);
    }
  });

  it("retries on 429 with Retry-After then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { message: "slow down" }, { "Retry-After": "0" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const client = makeClient(fetchImpl);
    const res = await client.v2<{ ok: boolean }>("/x");
    expect(res.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries on 5xx then surfaces final 5xx after max attempts", async () => {
    const fetchImpl = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse(503, { message: "down" })),
    );
    const client = makeClient(fetchImpl);
    const res = await client.v2("/x");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("server_error");
      expect(res.error.retryable).toBe(true);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it("does not retry on 4xx (non-429)", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(401, { message: "bad" }));
    const client = makeClient(fetchImpl);
    const res = await client.v2("/x");
    expect(res.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("network error is mapped to network_error and retryable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const client = makeClient(fetchImpl);
    const res = await client.v2("/x");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("network_error");
      expect(res.error.message).toContain("ECONNRESET");
    }
  });

  it("non-JSON success body is reported as `unknown` (not crash)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("oops not json", { status: 200, headers: { "Content-Type": "text/plain" } }));
    const client = makeClient(fetchImpl);
    const res = await client.v2("/x");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("unknown");
  });

  it("registers token + auth header as secrets (logger redactor sees them)", () => {
    clearSecrets();
    makeClient(vi.fn());
    expect(redact("token=ATATT_TEST_TOKEN_AAAA")).toBe("token=[REDACTED]");
    // Basic header: Buffer.from("y@example.com:ATATT_TEST_TOKEN_AAAA").toString("base64")
    const expectedHeader = "Basic " + Buffer.from("y@example.com:ATATT_TEST_TOKEN_AAAA").toString("base64");
    expect(redact(`auth=${expectedHeader}`)).toBe("auth=[REDACTED]");
    clearSecrets();
  });
});
