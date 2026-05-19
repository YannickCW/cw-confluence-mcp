// OS-native keychain access for the cw-confluence-mcp credentials blob.
// Service: cw-confluence-mcp / Account: default. Stored value is JSON-stringified.

import { Entry } from "@napi-rs/keyring";

export const KEYCHAIN_SERVICE = "cw-confluence-mcp";
export const KEYCHAIN_ACCOUNT = "default";

export interface CredentialsBlob {
  site: string;
  email: string;
  token: string;
  savedAt: string;
}

function entry(): Entry {
  return new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
}

export function readCredentials(): CredentialsBlob | null {
  let raw: string | null;
  try {
    raw = entry().getPassword();
  } catch (err) {
    // @napi-rs/keyring throws when the entry is missing — treat that as "not logged in".
    if (isKeychainMissingError(err)) return null;
    throw err;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isCredentialsBlob(parsed)) return null;
    return parsed;
  } catch {
    // Malformed JSON in the keychain blob — treat as no creds rather than crashing.
    return null;
  }
}

export function writeCredentials(blob: CredentialsBlob): void {
  entry().setPassword(JSON.stringify(blob));
}

export function deleteCredentials(): boolean {
  try {
    return entry().deletePassword();
  } catch (err) {
    if (isKeychainMissingError(err)) return false;
    throw err;
  }
}

function isCredentialsBlob(value: unknown): value is CredentialsBlob {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.site === "string" &&
    v.site.length > 0 &&
    typeof v.email === "string" &&
    v.email.length > 0 &&
    typeof v.token === "string" &&
    v.token.length > 0 &&
    typeof v.savedAt === "string"
  );
}

function isKeychainMissingError(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message : String(err);
  return /no matching entry|not found|no password|no entry/i.test(message);
}

// Site normalisation: strip scheme, trailing slash, and `/wiki` suffix.
export function normaliseSite(input: string): string {
  let s = input.trim();
  s = s.replace(/^https?:\/\//i, "");
  s = s.replace(/\/+$/g, "");
  s = s.replace(/\/wiki$/i, "");
  return s;
}
