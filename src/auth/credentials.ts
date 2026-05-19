// Load credentials at server start. Order: keychain → optional env fallback.
// Returns typed creds or a typed "not logged in" error. Never throws for the "not logged in" case.

import { readCredentials, type CredentialsBlob, normaliseSite } from "./keychain.js";

export type LoadResult =
  | { ok: true; creds: CredentialsBlob; source: "keychain" | "env" }
  | { ok: false; reason: "not_logged_in" | "env_incomplete"; message: string };

const HINT = 'Run "cw-confluence-mcp auth login" first.';

export function loadCredentials(env: NodeJS.ProcessEnv = process.env): LoadResult {
  const keychainCreds = readCredentials();
  if (keychainCreds) {
    return { ok: true, creds: keychainCreds, source: "keychain" };
  }

  if (env.CONFLUENCE_MCP_USE_ENV === "1") {
    const site = env.CONFLUENCE_SITE;
    const email = env.CONFLUENCE_EMAIL;
    const token = env.CONFLUENCE_TOKEN;
    if (!site || !email || !token) {
      return {
        ok: false,
        reason: "env_incomplete",
        message:
          "CONFLUENCE_MCP_USE_ENV=1 was set but CONFLUENCE_SITE, CONFLUENCE_EMAIL, or CONFLUENCE_TOKEN is missing.",
      };
    }
    return {
      ok: true,
      source: "env",
      creds: {
        site: normaliseSite(site),
        email,
        token,
        savedAt: new Date().toISOString(),
      },
    };
  }

  return {
    ok: false,
    reason: "not_logged_in",
    message: `No credentials found. ${HINT}`,
  };
}
