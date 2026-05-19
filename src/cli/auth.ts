// Interactive auth CLI: login / logout / status / test.
// Spec: §3 (auth + token storage), §4.11 (error shape on `auth test`), §7 (token never appears in output).
//
// The functions in this file are dependency-injectable so unit tests can drive
// the flows without hitting the real keychain or real network. Each function
// takes a resolved `AuthDeps` (see ./index.ts) and returns the desired exit
// code; the dispatcher in ./index.ts calls `deps.exit()` once at the end.

import type { CredentialsBlob } from "../auth/keychain.js";
import { normaliseSite } from "../auth/keychain.js";
import { ConfluenceClient } from "../confluence/client.js";
import { redact, registerSecret } from "../shared/logger.js";

/**
 * Resolved deps used by every auth flow. `runAuthCli` builds the default deps
 * (real keychain + real fetch + process streams) and lets tests inject fakes.
 */
export interface ResolvedAuthDeps {
  prompts: (questions: PromptQuestion[]) => Promise<Record<string, unknown>>;
  readCreds: () => CredentialsBlob | null;
  writeCreds: (blob: CredentialsBlob) => void;
  deleteCreds: () => boolean;
  fetchImpl: typeof fetch;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  now: () => Date;
}

export interface PromptQuestion {
  type: "text" | "password";
  name: string;
  message: string;
  initial?: string;
  validate?: (value: string) => boolean | string;
}

interface VerifiedUser {
  displayName: string;
  email: string;
  site: string;
}

/** `auth login` — interactive prompts → verify call → write keychain. */
export async function runLogin(deps: ResolvedAuthDeps): Promise<number> {
  const answers = await deps.prompts([
    {
      type: "text",
      name: "site",
      message: "Confluence site (e.g. cloudwise.atlassian.net)",
      initial: "cloudwise.atlassian.net",
      validate: (v) => (v && v.trim().length > 0 ? true : "Site is required."),
    },
    {
      type: "text",
      name: "email",
      message: "Atlassian email",
      validate: (v) => (v && v.includes("@") ? true : "A valid email is required."),
    },
    {
      type: "password",
      name: "token",
      message: "Atlassian API token (input hidden)",
      validate: (v) => (v && v.length > 0 ? true : "Token is required."),
    },
  ]);

  const siteRaw = typeof answers.site === "string" ? answers.site : "";
  const email = typeof answers.email === "string" ? answers.email : "";
  const token = typeof answers.token === "string" ? answers.token : "";

  if (!siteRaw || !email || !token) {
    deps.stderr.write("Login cancelled.\n");
    return 1;
  }

  const site = normaliseSite(siteRaw);

  // Defence in depth — register the token as a secret BEFORE constructing the
  // client (the client also registers it, but we register here so any failure
  // we surface ourselves goes through the redactor too).
  registerSecret(token);

  const creds: CredentialsBlob = {
    site,
    email,
    token,
    savedAt: deps.now().toISOString(),
  };

  const client = new ConfluenceClient({
    creds,
    fetchImpl: deps.fetchImpl,
    backoffBaseMs: 0,
  });

  const verified = await verifyCredentials(client, site, email);
  if (!verified.ok) {
    deps.stderr.write(`Login failed: ${redact(verified.message)}\n`);
    // Do NOT persist creds on failure.
    return 1;
  }

  // Only persist on a successful verification round-trip.
  deps.writeCreds(creds);

  deps.stdout.write(
    `Logged in as ${verified.user.displayName} (${verified.user.email}) on ${verified.user.site}\n`,
  );
  return 0;
}

/** `auth logout` — idempotent delete. */
export function runLogout(deps: ResolvedAuthDeps): number {
  const existed = deps.deleteCreds();
  if (existed) {
    deps.stdout.write("Logged out.\n");
  } else {
    deps.stdout.write("Already logged out.\n");
  }
  return 0;
}

/** `auth status` — read-only. Never prints the token. */
export function runStatus(deps: ResolvedAuthDeps): number {
  const creds = deps.readCreds();
  if (creds) {
    // Intentionally print email + site only. The token (or any prefix of it) is never logged.
    deps.stdout.write(`Logged in as ${creds.email} on ${creds.site}\n`);
  } else {
    deps.stdout.write("Not logged in\n");
  }
  return 0;
}

/** `auth test` — re-runs the verify call against stored creds. */
export async function runTest(deps: ResolvedAuthDeps): Promise<number> {
  const creds = deps.readCreds();
  if (!creds) {
    deps.stderr.write('Not logged in. Run "cw-confluence-mcp auth login" first.\n');
    return 1;
  }

  registerSecret(creds.token);

  const client = new ConfluenceClient({
    creds,
    fetchImpl: deps.fetchImpl,
    backoffBaseMs: 0,
  });

  const verified = await verifyCredentials(client, creds.site, creds.email);
  if (!verified.ok) {
    deps.stderr.write(`Credentials test failed: ${redact(verified.message)}\n`);
    return 1;
  }

  deps.stdout.write(
    `Credentials valid for ${verified.user.displayName} (${verified.user.email}) on ${verified.user.site}\n`,
  );
  return 0;
}

// -----------------------------------------------------------------------------
// Verify call
// -----------------------------------------------------------------------------

interface VerifyOk {
  ok: true;
  user: VerifiedUser;
}
interface VerifyFail {
  ok: false;
  message: string;
}
type VerifyResult = VerifyOk | VerifyFail;

interface UsersCurrentV2 {
  accountId?: string;
  publicName?: string;
  displayName?: string;
  email?: string;
}

interface UserCurrentV1 {
  accountId?: string;
  publicName?: string;
  displayName?: string;
  email?: string;
  username?: string;
}

async function verifyCredentials(
  client: ConfluenceClient,
  site: string,
  email: string,
): Promise<VerifyResult> {
  // Primary: v1 /user/current. Confluence Cloud v2 has no current-user endpoint —
  // /wiki/api/v2/users/current routes through a content-type handler that parses
  // "users" as a content-type slug and 400s. v1 has been stable for years.
  const v1Res = await client.v1<UserCurrentV1>("/user/current");
  if (v1Res.ok) {
    return {
      ok: true,
      user: {
        displayName: pickDisplayName(v1Res.data) ?? email,
        email,
        site,
      },
    };
  }

  // Defensive fallback: if a future tenant ever deprecates v1, try v2.
  // Kept narrow (404 only) so we don't mask real auth errors with a confusing v2 retry.
  if (v1Res.error.status === 404) {
    const v2Res = await client.v2<UsersCurrentV2>("/users/current");
    if (v2Res.ok) {
      return {
        ok: true,
        user: {
          displayName: pickDisplayName(v2Res.data) ?? email,
          email,
          site,
        },
      };
    }
    return { ok: false, message: v2Res.error.message };
  }

  return { ok: false, message: v1Res.error.message };
}

function pickDisplayName(u: { displayName?: string; publicName?: string } | undefined): string | undefined {
  if (!u) return undefined;
  if (typeof u.displayName === "string" && u.displayName.length > 0) return u.displayName;
  if (typeof u.publicName === "string" && u.publicName.length > 0) return u.publicName;
  return undefined;
}
