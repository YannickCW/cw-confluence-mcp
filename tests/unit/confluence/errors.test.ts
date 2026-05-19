import { describe, expect, it } from "vitest";
import {
  fail,
  mapHttpError,
  forbiddenFieldError,
  markerAmbiguousError,
  markerNotFoundError,
  networkError,
  ok,
  validationError,
} from "../../../src/confluence/errors.js";

describe("errors", () => {
  it("ok wraps data", () => {
    expect(ok({ a: 1 })).toEqual({ ok: true, data: { a: 1 } });
  });

  it("fail wraps message with default retryable=false", () => {
    const e = fail(404, "not_found", "missing");
    expect(e).toEqual({
      ok: false,
      error: { status: 404, code: "not_found", message: "missing", retryable: false },
    });
  });

  it("mapHttpError 401 includes auth hint", () => {
    const e = mapHttpError(401, JSON.stringify({ message: "bad token" }), null);
    expect(e.error.code).toBe("unauthorized");
    expect(e.error.message).toContain("bad token");
    expect(e.error.message).toContain('cw-confluence-mcp auth login');
    expect(e.error.retryable).toBe(false);
  });

  it("mapHttpError 403 includes auth hint", () => {
    const e = mapHttpError(403, JSON.stringify({ message: "denied" }), null);
    expect(e.error.code).toBe("forbidden");
    expect(e.error.message).toContain("cw-confluence-mcp auth login");
  });

  it("mapHttpError 404 → not_found", () => {
    const e = mapHttpError(404, JSON.stringify({ message: "no page" }), null);
    expect(e.error.code).toBe("not_found");
    expect(e.error.retryable).toBe(false);
  });

  it("mapHttpError 409 → version_conflict (retryable=false at the boundary)", () => {
    const e = mapHttpError(409, JSON.stringify({ message: "conflict" }), null);
    expect(e.error.code).toBe("version_conflict");
    expect(e.error.retryable).toBe(false);
  });

  it("mapHttpError 429 → rate_limited with retry_after parsed from header", () => {
    const e = mapHttpError(429, JSON.stringify({ message: "slow down" }), "30");
    expect(e.error.code).toBe("rate_limited");
    expect(e.error.retryable).toBe(true);
    expect(e.error.retry_after).toBe(30);
  });

  it("mapHttpError 429 without Retry-After header still marked retryable", () => {
    const e = mapHttpError(429, "", null);
    expect(e.error.code).toBe("rate_limited");
    expect(e.error.retryable).toBe(true);
    expect(e.error.retry_after).toBeUndefined();
  });

  it("mapHttpError 5xx → server_error retryable", () => {
    const e = mapHttpError(503, "internal", null);
    expect(e.error.code).toBe("server_error");
    expect(e.error.retryable).toBe(true);
  });

  it("mapHttpError extracts v2 errors[].title + detail", () => {
    const body = JSON.stringify({ errors: [{ title: "BadRequest", detail: "invalid id" }] });
    const e = mapHttpError(400, body, null);
    expect(e.error.message).toContain("BadRequest");
    expect(e.error.message).toContain("invalid id");
  });

  it("mapHttpError truncates very long raw bodies", () => {
    const body = "x".repeat(2000);
    const e = mapHttpError(418, body, null);
    expect(e.error.message.length).toBeLessThan(600);
    expect(e.error.message.endsWith("…")).toBe(true);
  });

  it("mapHttpError handles non-JSON body gracefully", () => {
    const e = mapHttpError(418, "<html>oops</html>", null);
    expect(e.error.message).toContain("<html>oops</html>");
  });

  it("validationError factory produces code=validation", () => {
    expect(validationError("bad input").error.code).toBe("validation");
  });

  it("forbiddenFieldError carries field in details", () => {
    const e = forbiddenFieldError("status");
    expect(e.error.code).toBe("forbidden_field");
    expect(e.error.details).toEqual({ field: "status" });
  });

  it("markerNotFoundError + markerAmbiguousError carry expected details", () => {
    const nf = markerNotFoundError("Hello");
    expect(nf.error.code).toBe("marker_not_found");
    expect(nf.error.details).toEqual({ text_marker: "Hello" });

    const amb = markerAmbiguousError("Hello", 3);
    expect(amb.error.code).toBe("marker_ambiguous");
    expect(amb.error.details).toEqual({ text_marker: "Hello", count: 3 });
  });

  it("networkError is retryable", () => {
    const e = networkError(new Error("ECONNRESET"));
    expect(e.error.code).toBe("network_error");
    expect(e.error.retryable).toBe(true);
    expect(e.error.message).toContain("ECONNRESET");
  });
});
