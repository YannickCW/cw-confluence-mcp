import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAuthCli, type AuthCliDeps } from "../../../src/cli/index.js";
import { clearSecrets } from "../../../src/shared/logger.js";
import type { CredentialsBlob } from "../../../src/auth/keychain.js";

// Unique token used across every flow. The token-leak regression assertion looks
// for this exact string in any stdout/stderr capture and fails if it leaks.
const PROBE_TOKEN = "ATATT3_TEST_TOKEN_XYZ_LEAK_PROBE_42";

interface Harness {
  deps: AuthCliDeps;
  stdout: { write: ReturnType<typeof vi.fn>; buf: string[] };
  stderr: { write: ReturnType<typeof vi.fn>; buf: string[] };
  exit: ReturnType<typeof vi.fn>;
  prompts: ReturnType<typeof vi.fn>;
  fetchImpl: ReturnType<typeof vi.fn>;
  readCreds: ReturnType<typeof vi.fn>;
  writeCreds: ReturnType<typeof vi.fn>;
  deleteCreds: ReturnType<typeof vi.fn>;
}

function makeHarness(initial?: { storedCreds?: CredentialsBlob | null }): Harness {
  const stdoutBuf: string[] = [];
  const stderrBuf: string[] = [];
  const stdoutWrite = vi.fn((chunk: unknown) => {
    stdoutBuf.push(String(chunk));
    return true;
  });
  const stderrWrite = vi.fn((chunk: unknown) => {
    stderrBuf.push(String(chunk));
    return true;
  });

  let stored: CredentialsBlob | null = initial?.storedCreds ?? null;
  const readCreds = vi.fn(() => stored);
  const writeCreds = vi.fn((b: CredentialsBlob) => {
    stored = b;
  });
  const deleteCreds = vi.fn(() => {
    if (stored === null) return false;
    stored = null;
    return true;
  });

  const prompts = vi.fn((_q: unknown) => Promise.resolve({} as Record<string, unknown>));
  const fetchImpl = vi.fn();
  const exit = vi.fn();

  const deps: AuthCliDeps = {
    prompts: prompts as unknown as AuthCliDeps["prompts"],
    readCreds,
    writeCreds,
    deleteCreds,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    stdout: { write: stdoutWrite } as unknown as NodeJS.WriteStream,
    stderr: { write: stderrWrite } as unknown as NodeJS.WriteStream,
    exit,
    now: () => new Date("2026-05-19T10:00:00.000Z"),
  };

  return {
    deps,
    stdout: { write: stdoutWrite, buf: stdoutBuf },
    stderr: { write: stderrWrite, buf: stderrBuf },
    exit,
    prompts,
    fetchImpl,
    readCreds,
    writeCreds,
    deleteCreds,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function allOutput(h: Harness): string {
  return [...h.stdout.buf, ...h.stderr.buf].join("");
}

function assertNoTokenLeak(h: Harness): void {
  const combined = allOutput(h);
  expect(combined).not.toContain(PROBE_TOKEN);
  // Also assert the Basic-auth header form of the token isn't leaked.
  // (Defence in depth — the redactor registers this too.)
  const basicHeader =
    "Basic " + Buffer.from(`y@example.com:${PROBE_TOKEN}`).toString("base64");
  expect(combined).not.toContain(basicHeader);
}

beforeEach(() => {
  clearSecrets();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("auth login", () => {
  it("happy path: prompts → verify (v2) → writeCreds → success message", async () => {
    const h = makeHarness();
    h.prompts.mockResolvedValueOnce({
      site: "cloudwise.atlassian.net",
      email: "y@example.com",
      token: PROBE_TOKEN,
    });
    h.fetchImpl.mockResolvedValueOnce(
      jsonResponse(200, { accountId: "abc", displayName: "Yannick Wensink" }),
    );

    await runAuthCli(["login"], h.deps);

    expect(h.writeCreds).toHaveBeenCalledTimes(1);
    const written = h.writeCreds.mock.calls[0]![0] as CredentialsBlob;
    expect(written).toEqual({
      site: "cloudwise.atlassian.net",
      email: "y@example.com",
      token: PROBE_TOKEN,
      savedAt: "2026-05-19T10:00:00.000Z",
    });
    expect(h.stdout.buf.join("")).toContain(
      "Logged in as Yannick Wensink (y@example.com) on cloudwise.atlassian.net",
    );
    expect(h.exit).toHaveBeenCalledWith(0);
    assertNoTokenLeak(h);
  });

  it("normalises the site (strips scheme + /wiki suffix) before writeCreds", async () => {
    const h = makeHarness();
    h.prompts.mockResolvedValueOnce({
      site: "https://cloudwise.atlassian.net/wiki/",
      email: "y@example.com",
      token: PROBE_TOKEN,
    });
    h.fetchImpl.mockResolvedValueOnce(jsonResponse(200, { displayName: "Yannick" }));

    await runAuthCli(["login"], h.deps);

    expect(h.writeCreds).toHaveBeenCalledTimes(1);
    const written = h.writeCreds.mock.calls[0]![0] as CredentialsBlob;
    expect(written.site).toBe("cloudwise.atlassian.net");

    // The verify call must have hit the normalised URL.
    const url = h.fetchImpl.mock.calls[0]![0] as string;
    expect(url).toBe("https://cloudwise.atlassian.net/wiki/api/v2/users/current");
    assertNoTokenLeak(h);
  });

  it("falls back to v1 /user/current when v2 returns 404", async () => {
    const h = makeHarness();
    h.prompts.mockResolvedValueOnce({
      site: "cloudwise.atlassian.net",
      email: "y@example.com",
      token: PROBE_TOKEN,
    });
    h.fetchImpl
      .mockResolvedValueOnce(jsonResponse(404, { message: "Not Found" }))
      .mockResolvedValueOnce(jsonResponse(200, { displayName: "Yannick V1" }));

    await runAuthCli(["login"], h.deps);

    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(h.fetchImpl.mock.calls[0]![0]).toBe(
      "https://cloudwise.atlassian.net/wiki/api/v2/users/current",
    );
    expect(h.fetchImpl.mock.calls[1]![0]).toBe(
      "https://cloudwise.atlassian.net/wiki/rest/api/user/current",
    );
    expect(h.writeCreds).toHaveBeenCalledTimes(1);
    expect(h.stdout.buf.join("")).toContain("Logged in as Yannick V1");
    expect(h.exit).toHaveBeenCalledWith(0);
    assertNoTokenLeak(h);
  });

  it("does NOT persist credentials when verification returns 401", async () => {
    const h = makeHarness();
    h.prompts.mockResolvedValueOnce({
      site: "cloudwise.atlassian.net",
      email: "y@example.com",
      token: PROBE_TOKEN,
    });
    h.fetchImpl.mockResolvedValueOnce(
      jsonResponse(401, { message: "Unauthorized — bad credentials" }),
    );

    await runAuthCli(["login"], h.deps);

    expect(h.writeCreds).not.toHaveBeenCalled();
    expect(h.stderr.buf.join("")).toMatch(/login failed/i);
    expect(h.exit).toHaveBeenCalledWith(1);
    assertNoTokenLeak(h);
  });

  it("does NOT persist credentials on network failure", async () => {
    const h = makeHarness();
    h.prompts.mockResolvedValueOnce({
      site: "cloudwise.atlassian.net",
      email: "y@example.com",
      token: PROBE_TOKEN,
    });
    h.fetchImpl.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await runAuthCli(["login"], h.deps);

    expect(h.writeCreds).not.toHaveBeenCalled();
    expect(h.exit).toHaveBeenCalledWith(1);
    assertNoTokenLeak(h);
  });

  it("aborts with non-zero exit when the user cancels a prompt (empty answers)", async () => {
    const h = makeHarness();
    h.prompts.mockResolvedValueOnce({}); // user hit Ctrl-C, prompts returns {}

    await runAuthCli(["login"], h.deps);

    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.writeCreds).not.toHaveBeenCalled();
    expect(h.exit).toHaveBeenCalledWith(1);
    assertNoTokenLeak(h);
  });
});

describe("auth logout", () => {
  it("deletes the existing entry and prints 'Logged out.'", async () => {
    const h = makeHarness({
      storedCreds: {
        site: "cloudwise.atlassian.net",
        email: "y@example.com",
        token: PROBE_TOKEN,
        savedAt: "2026-05-18T00:00:00.000Z",
      },
    });

    await runAuthCli(["logout"], h.deps);

    expect(h.deleteCreds).toHaveBeenCalledTimes(1);
    expect(h.stdout.buf.join("")).toContain("Logged out.");
    expect(h.exit).toHaveBeenCalledWith(0);
    assertNoTokenLeak(h);
  });

  it("is idempotent when no entry exists ('Already logged out.')", async () => {
    const h = makeHarness({ storedCreds: null });

    await runAuthCli(["logout"], h.deps);

    expect(h.deleteCreds).toHaveBeenCalledTimes(1);
    expect(h.stdout.buf.join("")).toContain("Already logged out.");
    expect(h.exit).toHaveBeenCalledWith(0);
    assertNoTokenLeak(h);
  });
});

describe("auth status", () => {
  it("prints email + site when logged in, NEVER the token", async () => {
    const h = makeHarness({
      storedCreds: {
        site: "cloudwise.atlassian.net",
        email: "y@example.com",
        token: PROBE_TOKEN,
        savedAt: "2026-05-18T00:00:00.000Z",
      },
    });

    await runAuthCli(["status"], h.deps);

    const out = h.stdout.buf.join("");
    expect(out).toBe("Logged in as y@example.com on cloudwise.atlassian.net\n");
    // Be explicit: no part of the token (or even a 6-char prefix) appears.
    expect(out).not.toContain(PROBE_TOKEN);
    expect(out).not.toContain(PROBE_TOKEN.slice(0, 6));
    expect(h.fetchImpl).not.toHaveBeenCalled(); // status is offline
    expect(h.writeCreds).not.toHaveBeenCalled(); // read-only
    expect(h.deleteCreds).not.toHaveBeenCalled();
    expect(h.exit).toHaveBeenCalledWith(0);
    assertNoTokenLeak(h);
  });

  it("prints 'Not logged in' when no credentials exist (exit 0)", async () => {
    const h = makeHarness({ storedCreds: null });

    await runAuthCli(["status"], h.deps);

    expect(h.stdout.buf.join("")).toContain("Not logged in");
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.exit).toHaveBeenCalledWith(0);
    assertNoTokenLeak(h);
  });
});

describe("auth test", () => {
  it("prints 'Not logged in.' to stderr and exits non-zero when no creds", async () => {
    const h = makeHarness({ storedCreds: null });

    await runAuthCli(["test"], h.deps);

    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.stderr.buf.join("")).toContain(
      'Not logged in. Run "cw-confluence-mcp auth login" first.',
    );
    expect(h.exit).toHaveBeenCalledWith(1);
    assertNoTokenLeak(h);
  });

  it("happy path: verifies and prints success on stdout", async () => {
    const h = makeHarness({
      storedCreds: {
        site: "cloudwise.atlassian.net",
        email: "y@example.com",
        token: PROBE_TOKEN,
        savedAt: "2026-05-18T00:00:00.000Z",
      },
    });
    h.fetchImpl.mockResolvedValueOnce(
      jsonResponse(200, { displayName: "Yannick Wensink" }),
    );

    await runAuthCli(["test"], h.deps);

    expect(h.stdout.buf.join("")).toContain(
      "Credentials valid for Yannick Wensink (y@example.com) on cloudwise.atlassian.net",
    );
    // test is read-only: no writes/deletes.
    expect(h.writeCreds).not.toHaveBeenCalled();
    expect(h.deleteCreds).not.toHaveBeenCalled();
    expect(h.exit).toHaveBeenCalledWith(0);
    assertNoTokenLeak(h);
  });

  it("falls back to v1 on 404 just like login", async () => {
    const h = makeHarness({
      storedCreds: {
        site: "cloudwise.atlassian.net",
        email: "y@example.com",
        token: PROBE_TOKEN,
        savedAt: "2026-05-18T00:00:00.000Z",
      },
    });
    h.fetchImpl
      .mockResolvedValueOnce(jsonResponse(404, { message: "Not Found" }))
      .mockResolvedValueOnce(jsonResponse(200, { displayName: "Yannick" }));

    await runAuthCli(["test"], h.deps);

    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(h.stdout.buf.join("")).toContain("Credentials valid for Yannick");
    expect(h.exit).toHaveBeenCalledWith(0);
    assertNoTokenLeak(h);
  });

  it("prints redacted error to stderr and exits non-zero on 401", async () => {
    const h = makeHarness({
      storedCreds: {
        site: "cloudwise.atlassian.net",
        email: "y@example.com",
        token: PROBE_TOKEN,
        savedAt: "2026-05-18T00:00:00.000Z",
      },
    });
    h.fetchImpl.mockResolvedValueOnce(jsonResponse(401, { message: "Unauthorized" }));

    await runAuthCli(["test"], h.deps);

    expect(h.stderr.buf.join("")).toMatch(/credentials test failed/i);
    expect(h.exit).toHaveBeenCalledWith(1);
    assertNoTokenLeak(h);
  });
});

describe("token leak regression — server-side error includes the token", () => {
  // If the Confluence server were ever to echo the token back in an error body
  // (it shouldn't, but defence in depth matters), the redactor must catch it.
  it("redacts the token if it appears in a server error message during login", async () => {
    const h = makeHarness();
    h.prompts.mockResolvedValueOnce({
      site: "cloudwise.atlassian.net",
      email: "y@example.com",
      token: PROBE_TOKEN,
    });
    h.fetchImpl.mockResolvedValueOnce(
      jsonResponse(401, { message: `Bad token: ${PROBE_TOKEN}` }),
    );

    await runAuthCli(["login"], h.deps);

    expect(h.writeCreds).not.toHaveBeenCalled();
    expect(h.exit).toHaveBeenCalledWith(1);
    // The error went through redact() → the literal token must NOT survive.
    assertNoTokenLeak(h);
  });

  it("redacts the token if it appears in a server error message during test", async () => {
    const h = makeHarness({
      storedCreds: {
        site: "cloudwise.atlassian.net",
        email: "y@example.com",
        token: PROBE_TOKEN,
        savedAt: "2026-05-18T00:00:00.000Z",
      },
    });
    h.fetchImpl.mockResolvedValueOnce(
      jsonResponse(403, { message: `Forbidden — token ${PROBE_TOKEN} expired` }),
    );

    await runAuthCli(["test"], h.deps);

    expect(h.exit).toHaveBeenCalledWith(1);
    assertNoTokenLeak(h);
  });
});
