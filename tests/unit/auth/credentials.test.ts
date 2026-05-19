import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as KeychainModule from "../../../src/auth/keychain.js";

const mockReadCredentials = vi.fn();

vi.mock("../../../src/auth/keychain.js", async () => {
  const actual = await vi.importActual<typeof KeychainModule>("../../../src/auth/keychain.js");
  return {
    ...actual,
    readCredentials: () => mockReadCredentials(),
  };
});

import { loadCredentials } from "../../../src/auth/credentials.js";

describe("loadCredentials", () => {
  beforeEach(() => {
    mockReadCredentials.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns keychain creds when present", () => {
    mockReadCredentials.mockReturnValueOnce({
      site: "x.atlassian.net",
      email: "a@b.com",
      token: "ATATT_FROM_KEYCHAIN_VALUE",
      savedAt: "now",
    });
    const out = loadCredentials({});
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.source).toBe("keychain");
      expect(out.creds.email).toBe("a@b.com");
    }
  });

  it("falls back to env when CONFLUENCE_MCP_USE_ENV=1 and all vars set", () => {
    mockReadCredentials.mockReturnValueOnce(null);
    const out = loadCredentials({
      CONFLUENCE_MCP_USE_ENV: "1",
      CONFLUENCE_SITE: "https://env.atlassian.net/wiki",
      CONFLUENCE_EMAIL: "u@example.com",
      CONFLUENCE_TOKEN: "ATATT_FROM_ENV_VALUE",
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.source).toBe("env");
      expect(out.creds.site).toBe("env.atlassian.net"); // normalised
    }
  });

  it("returns env_incomplete when flag is set but a var is missing", () => {
    mockReadCredentials.mockReturnValueOnce(null);
    const out = loadCredentials({
      CONFLUENCE_MCP_USE_ENV: "1",
      CONFLUENCE_SITE: "env.atlassian.net",
      CONFLUENCE_EMAIL: "u@example.com",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("env_incomplete");
  });

  it("returns not_logged_in when keychain empty and env not enabled", () => {
    mockReadCredentials.mockReturnValueOnce(null);
    const out = loadCredentials({});
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("not_logged_in");
      expect(out.message).toContain("cw-confluence-mcp auth login");
    }
  });
});
