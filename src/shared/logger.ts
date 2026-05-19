// Token-redacting logger. Writes to stderr only (stdout is reserved for MCP traffic).
// The redactor masks any literal occurrence of the registered secret strings.

const REDACTED = "[REDACTED]";

let secrets: string[] = [];

export function registerSecret(secret: string | undefined | null): void {
  if (!secret) return;
  if (secret.length < 4) return; // never redact tiny strings (false positives)
  if (!secrets.includes(secret)) secrets.push(secret);
}

export function clearSecrets(): void {
  secrets = [];
}

export function redact(input: string): string {
  if (!input || secrets.length === 0) return input;
  let out = input;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

export function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redact(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = redactValue(v);
    }
    return result;
  }
  return value;
}

export const logger = {
  info(message: string, meta?: Record<string, unknown>): void {
    write("info", message, meta);
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    write("warn", message, meta);
  },
  error(message: string, meta?: Record<string, unknown>): void {
    write("error", message, meta);
  },
  debug(message: string, meta?: Record<string, unknown>): void {
    if (process.env.CONFLUENCE_MCP_DEBUG === "1") {
      write("debug", message, meta);
    }
  },
};

function write(level: string, message: string, meta?: Record<string, unknown>): void {
  const safeMessage = redact(message);
  const line = meta
    ? `[${level}] ${safeMessage} ${JSON.stringify(redactValue(meta))}`
    : `[${level}] ${safeMessage}`;
  process.stderr.write(line + "\n");
}
