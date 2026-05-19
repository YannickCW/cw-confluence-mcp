import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockEntries, storage } = vi.hoisted(() => ({
  mockEntries: new Map<
    string,
    {
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
      del: ReturnType<typeof vi.fn>;
    }
  >(),
  storage: { value: null as string | null },
}));

vi.mock("@napi-rs/keyring", () => {
  return {
    Entry: class {
      service: string;
      account: string;
      constructor(service: string, account: string) {
        this.service = service;
        this.account = account;
        const key = `${service}/${account}`;
        if (!mockEntries.has(key)) {
          mockEntries.set(key, {
            get: vi.fn(() => storage.value),
            set: vi.fn((v: string) => {
              storage.value = v;
            }),
            del: vi.fn(() => {
              if (storage.value === null) return false;
              storage.value = null;
              return true;
            }),
          });
        }
      }
      getPassword() {
        return mockEntries.get(`${this.service}/${this.account}`)!.get();
      }
      setPassword(v: string) {
        mockEntries.get(`${this.service}/${this.account}`)!.set(v);
      }
      deletePassword() {
        return mockEntries.get(`${this.service}/${this.account}`)!.del();
      }
    },
  };
});

import {
  deleteCredentials,
  normaliseSite,
  readCredentials,
  writeCredentials,
} from "../../../src/auth/keychain.js";

describe("keychain", () => {
  beforeEach(() => {
    mockEntries.clear();
    storage.value = null;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("readCredentials returns null when keychain is empty", () => {
    expect(readCredentials()).toBeNull();
  });

  it("write → read round-trips a credentials blob", () => {
    writeCredentials({
      site: "cloudwise.atlassian.net",
      email: "y@example.com",
      token: "ATATT3xFfGF0_test_token_value_12345",
      savedAt: "2026-05-18T12:00:00.000Z",
    });
    const got = readCredentials();
    expect(got).toEqual({
      site: "cloudwise.atlassian.net",
      email: "y@example.com",
      token: "ATATT3xFfGF0_test_token_value_12345",
      savedAt: "2026-05-18T12:00:00.000Z",
    });
  });

  it("readCredentials returns null when stored JSON is malformed", () => {
    // Manually inject garbage via the mock.
    const entries = Array.from(mockEntries.values());
    if (entries.length === 0) {
      // Trigger creation of an entry via a write, then overwrite.
      writeCredentials({ site: "x.atlassian.net", email: "a@b", token: "1234", savedAt: "now" });
    }
    const handlers = Array.from(mockEntries.values())[0]!;
    handlers.get.mockReturnValueOnce("not-json");
    expect(readCredentials()).toBeNull();
  });

  it("readCredentials returns null when JSON is the wrong shape", () => {
    writeCredentials({ site: "x.atlassian.net", email: "a@b", token: "1234", savedAt: "now" });
    const handlers = Array.from(mockEntries.values())[0]!;
    handlers.get.mockReturnValueOnce(JSON.stringify({ site: "x" })); // missing fields
    expect(readCredentials()).toBeNull();
  });

  it("readCredentials rethrows non-missing errors from the keychain", () => {
    // Force the entry's getPassword to throw something that is NOT a 'missing entry' error.
    writeCredentials({ site: "x.atlassian.net", email: "a@b", token: "1234abcd", savedAt: "now" });
    const handlers = Array.from(mockEntries.values())[0]!;
    handlers.get.mockImplementationOnce(() => {
      throw new Error("disk on fire");
    });
    expect(() => readCredentials()).toThrow(/disk on fire/);
  });

  it("readCredentials returns null when the keychain reports the entry is missing", () => {
    writeCredentials({ site: "x.atlassian.net", email: "a@b", token: "1234abcd", savedAt: "now" });
    const handlers = Array.from(mockEntries.values())[0]!;
    handlers.get.mockImplementationOnce(() => {
      throw new Error("No matching entry found in the secure storage");
    });
    expect(readCredentials()).toBeNull();
  });

  it("deleteCredentials returns false when keychain reports missing", () => {
    writeCredentials({ site: "x.atlassian.net", email: "a@b", token: "1234abcd", savedAt: "now" });
    const handlers = Array.from(mockEntries.values())[0]!;
    handlers.del.mockImplementationOnce(() => {
      throw new Error("no password found");
    });
    expect(deleteCredentials()).toBe(false);
  });

  it("deleteCredentials returns true when an entry exists, false when not", () => {
    expect(deleteCredentials()).toBe(false);
    writeCredentials({
      site: "x.atlassian.net",
      email: "a@b.com",
      token: "ATATT3xFfGF0_token_value",
      savedAt: "now",
    });
    expect(deleteCredentials()).toBe(true);
    expect(readCredentials()).toBeNull();
  });
});

describe("normaliseSite", () => {
  it("strips https:// scheme", () => {
    expect(normaliseSite("https://cloudwise.atlassian.net")).toBe("cloudwise.atlassian.net");
  });
  it("strips http:// scheme", () => {
    expect(normaliseSite("http://cloudwise.atlassian.net")).toBe("cloudwise.atlassian.net");
  });
  it("strips trailing slash", () => {
    expect(normaliseSite("cloudwise.atlassian.net/")).toBe("cloudwise.atlassian.net");
  });
  it("strips /wiki suffix", () => {
    expect(normaliseSite("https://cloudwise.atlassian.net/wiki/")).toBe(
      "cloudwise.atlassian.net",
    );
  });
  it("trims whitespace", () => {
    expect(normaliseSite("   cloudwise.atlassian.net   ")).toBe("cloudwise.atlassian.net");
  });
  it("is idempotent", () => {
    const once = normaliseSite("https://cloudwise.atlassian.net/wiki/");
    expect(normaliseSite(once)).toBe(once);
  });
});
