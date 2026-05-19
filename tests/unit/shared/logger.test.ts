import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSecrets, logger, redact, redactValue, registerSecret } from "../../../src/shared/logger.js";

describe("logger / redactor", () => {
  afterEach(() => {
    clearSecrets();
    vi.restoreAllMocks();
  });

  it("redacts literal occurrences of a registered secret", () => {
    registerSecret("ATATT3xFfGF0_test_token_value");
    expect(redact("token=ATATT3xFfGF0_test_token_value end")).toBe("token=[REDACTED] end");
  });

  it("does not register secrets shorter than 4 chars", () => {
    registerSecret("abc");
    expect(redact("abc")).toBe("abc");
  });

  it("ignores null / undefined / empty secrets", () => {
    registerSecret(null);
    registerSecret(undefined);
    registerSecret("");
    expect(redact("nothing to redact")).toBe("nothing to redact");
  });

  it("clearSecrets removes all registered secrets", () => {
    registerSecret("ATATT3xFfGF0_secret_1");
    registerSecret("ATATT3xFfGF0_secret_2");
    clearSecrets();
    expect(redact("ATATT3xFfGF0_secret_1 and ATATT3xFfGF0_secret_2")).toBe(
      "ATATT3xFfGF0_secret_1 and ATATT3xFfGF0_secret_2",
    );
  });

  it("redactValue recursively redacts strings within objects and arrays", () => {
    registerSecret("SECRET_TOKEN_AAAA");
    const input = {
      url: "https://x/?t=SECRET_TOKEN_AAAA",
      nested: { token: "SECRET_TOKEN_AAAA", count: 3, flag: true },
      list: ["pre SECRET_TOKEN_AAAA post", "clean"],
    };
    expect(redactValue(input)).toEqual({
      url: "https://x/?t=[REDACTED]",
      nested: { token: "[REDACTED]", count: 3, flag: true },
      list: ["pre [REDACTED] post", "clean"],
    });
  });

  it("logger.info writes redacted line to stderr", () => {
    registerSecret("AAAA_HIDDEN_VALUE_BBBB");
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    logger.info("got AAAA_HIDDEN_VALUE_BBBB back");
    expect(write).toHaveBeenCalled();
    const writtenArg = (write.mock.calls[0]?.[0] ?? "") as string;
    expect(writtenArg).toContain("[REDACTED]");
    expect(writtenArg).not.toContain("AAAA_HIDDEN_VALUE_BBBB");
  });

  it("logger.debug is silent unless CONFLUENCE_MCP_DEBUG=1", () => {
    const original = process.env.CONFLUENCE_MCP_DEBUG;
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      delete process.env.CONFLUENCE_MCP_DEBUG;
      logger.debug("invisible");
      expect(write).not.toHaveBeenCalled();

      process.env.CONFLUENCE_MCP_DEBUG = "1";
      logger.debug("visible");
      expect(write).toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env.CONFLUENCE_MCP_DEBUG;
      else process.env.CONFLUENCE_MCP_DEBUG = original;
    }
  });

  it("redact handles literal token inside JSON-stringified body", () => {
    registerSecret("ATATT3xFfGF0_in_body_token");
    const body = JSON.stringify({ auth: "Basic dXNlckBleC5jb206QVRBVFQzeEZmR0YwX2luX2JvZHlfdG9rZW4=", reason: "ATATT3xFfGF0_in_body_token" });
    const out = redact(body);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("ATATT3xFfGF0_in_body_token");
  });
});
